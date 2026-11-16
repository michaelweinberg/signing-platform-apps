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
| `pnpm test` | Runs unit tests with Vitest |

## Layout

| Path | Holds |
|---|---|
| `packages/*` | Code shared between apps |
| `apps/*` | Deployable services (added in later steps) |

## Pull request checks

`.github/workflows/ci.yml` runs install, lint, typecheck, and unit tests on every pull request. It deploys nothing and needs no AWS access.
