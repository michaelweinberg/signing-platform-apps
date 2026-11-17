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

## Pull request checks

`.github/workflows/ci.yml` runs install, lint, typecheck, a check that the generated types are up to date, unit tests, and integration tests (against Docker Compose in the runner) on every pull request. It deploys nothing and needs no AWS access.
