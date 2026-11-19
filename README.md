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

`sst.config.ts` declares all infrastructure with [SST](https://sst.dev): for now the one shared API Gateway (HTTP API) and a throwaway `GET /hello` route. Every stage deploys to `us-west-2`.

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

## Pull request checks

`.github/workflows/ci.yml` runs install, lint, typecheck, a check that the generated types are up to date, unit tests, and integration tests (against Docker Compose in the runner) on every pull request. It deploys nothing and needs no AWS access.

## Deploy

`.github/workflows/deploy.yml` runs on every merge to `main`. It runs the same checks as a pull request (it calls `ci.yml`), then runs `sst deploy --stage demo` and requests the throwaway route on the deployed gateway. There is no manual step.

- The deploy job runs in the `demo` GitHub environment and assumes the AWS role in that environment's `AWS_ROLE_ARN` variable through OIDC. No AWS key is stored in GitHub.
- Deploys never run in parallel. A run that starts while another is in progress waits for it to finish.
