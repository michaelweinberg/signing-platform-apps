# signing-platform-apps

The apps monorepo for the signing platform. Specs live in
[signing-platform-documentation](https://github.com/michaelweinberg/signing-platform-documentation).

## Requirements

- Node.js 24 (see `.node-version`)
- pnpm (the version in `package.json`'s `packageManager` field)

## Commands

| Command | Does |
|---|---|
| `pnpm install` | Installs every workspace package |
| `pnpm lint` | Lints all packages with ESLint |
| `pnpm typecheck` | Typechecks all packages with `tsc` |
| `pnpm generate` | Regenerates TypeScript types from the `.avsc` files |
| `pnpm test` | Runs unit tests with Vitest |
| `pnpm test:integration` | Runs integration tests against the local infrastructure |
| `pnpm dev` | Deploys your personal dev stage and runs it in SST live mode |

## Local infrastructure

Integration tests need Kafka, a schema registry, and DynamoDB Local. Docker Compose runs all three:

```sh
docker compose up -d --wait   # start, and wait until healthy
pnpm test:integration
docker compose down           # stop and discard all data
```

## Events

The Avro schemas in `packages/shared/schemas/<topic>/<RecordName>.avsc` are the source of truth for every event. `packages/shared/src/generated/events.ts` is generated from them and committed; after changing a schema, run `pnpm generate` and commit the result. Never edit the generated file by hand.

## Layout

| Path | Holds |
|---|---|
| `packages/*` | Code shared between apps |
| `apps/*` | Deployable services (added in later steps) |

## Infrastructure and stages

`sst.config.ts` declares all infrastructure with [SST](https://sst.dev): for now the one shared API Gateway (HTTP API), the Cognito user pool, and a throwaway `GET /hello` route. Every stage deploys to `us-west-2`.

| Stage | Deployed by | How |
|---|---|---|
| Personal dev (named after your OS user) | You, from a laptop | `pnpm dev` |
| `demo` | The deploy workflow only | Merge to `main` |

`pnpm dev` deploys your stage and then runs your functions locally in live mode: requests to the deployed gateway are served by the code on your laptop, and edits apply without a redeploy. `pnpm sst remove` deletes your stage.

SST needs AWS credentials for the account. It cannot read the credentials that `aws login` stores, so if you sign in that way, export them into the shell first (they are short-lived; repeat when they expire):

```sh
eval "$(aws configure export-credentials --format env)"
pnpm dev
```

`sst.config.ts` is excluded from `tsc` and ESLint, because SST's generated types do not compile under this repo's compiler options. Your editor still type-checks it once `.sst/` exists (any `sst` command creates it).

Do not name a route `/ping`: API Gateway reserves that path for its own health check and never forwards it.

## Authentication and permissions

Every route on the gateway requires an access token from the stage's Cognito user pool. `sst.config.ts` sets the JWT authorizer as the default for every route; a route opts out only with `auth: false`. A missing, expired, or foreign token gets `401` at the gateway and no Lambda runs.

Permissions are checked in the handler by the guard in `packages/shared/src/guard.ts`. A handler declares the permission it needs, never a group or a scope:

```ts
export const handler = requirePermission('agreements.read', async (event, caller) => { ... });
```

A valid token without the permission gets `403`. The guard also sets the caller's subject (`enduser.id`) and client ID (`oauth.client_id`) on the current OpenTelemetry span. Code that is not a plain Lambda handler can call `authorize(claims, permission)` directly.

`packages/shared/src/permissions.ts` is the one file that says who may do what: which permissions each Cognito group grants, and which each machine client holds. `sst.config.ts` reads the same file to create the groups, the `signing-api` scopes, and each machine client's scopes, so to add a role or change a caller's access, edit that file and deploy.

| Caller | App client | Gets permissions from |
|---|---|---|
| Dashboard user | `dashboard` (public; authorization code with PKCE) | Their groups: `viewer`, `operator` |
| Salesforce | `salesforce` (client credentials) | The client's `signing-api/...` scopes |
| Smoke test | `smoke-test` (client credentials) | The client's `signing-api/...` scopes |

Users are created by hand in the Cognito console (there is no self sign-up) and must be added to a group; a user in no group gets `403` everywhere. They enrol a TOTP authenticator app at first sign-in.

To call your dev stage from a terminal, fetch a token as the `smoke-test` client. The IDs and URLs are in `.sst/outputs.json` after a deploy:

```sh
out=.sst/outputs.json
pool="$(jq -r .userPoolId $out)" client="$(jq -r .smokeTestClientId $out)"
secret="$(aws cognito-idp describe-user-pool-client --region us-west-2 --user-pool-id "$pool" \
  --client-id "$client" --query UserPoolClient.ClientSecret --output text)"
token="$(curl -s -u "$client:$secret" -d grant_type=client_credentials \
  "$(jq -r .authUrl $out)/oauth2/token" | jq -r .access_token)"
curl -H "Authorization: Bearer $token" "$(jq -r .apiUrl $out)/hello"
```

Each machine client is billed monthly by Cognito for as long as it exists, on every stage. `pnpm sst remove` on a dev stage you are not using stops that.

## Pull request checks

`.github/workflows/ci.yml` runs install, lint, typecheck, a check that the generated types are up to date, unit tests, and integration tests (against Docker Compose in the runner) on every pull request. It deploys nothing and needs no AWS access.

## Deploy

`.github/workflows/deploy.yml` runs on every merge to `main`. It runs the same checks as a pull request (it calls `ci.yml`), then runs `sst deploy --stage demo` and requests the throwaway route on the deployed gateway: once without a token, expecting `401`, and once with a token fetched as the `smoke-test` client, expecting `200`.

- The deploy job runs in the `demo` GitHub environment and assumes the AWS role in that environment's `AWS_ROLE_ARN` variable through OIDC. No AWS key is stored in GitHub.
- The token check reads the `smoke-test` client's ID and secret from the `demo` environment secrets `SMOKE_TEST_CLIENT_ID` and `SMOKE_TEST_CLIENT_SECRET`. Cognito generates them on the first deploy that creates the client, so that one run fails at the check; copy both from the Cognito console (user pool → App clients → `smoke-test`) into the environment secrets and re-run the job. They change only if the client is replaced.
- Deploys never run in parallel. A run that starts while another is in progress waits for it to finish.
