# Contributing to pixel-serve-server

Thanks for your interest in improving `pixel-serve-server`. This document
captures the local development workflow, the coverage and code-style bar that
every PR is expected to meet, and the conventions the project follows for
issues and pull requests.

## Code of Conduct

Be respectful, assume good intent, and keep technical disagreements technical.
Personal attacks, harassment, and off-topic discussion are not welcome.
Maintainers may close issues and PRs that violate these expectations.

## Project Layout

```text
pixel-serve-server/
├── src/                    # Source (TypeScript, strict mode)
├── dist/                   # Build output (committed only at release)
├── coverage/               # Vitest coverage reports (git-ignored)
├── CHANGELOG.md            # Dated entries per release
├── MIGRATION.md            # Cross-major migration guide (1.x → 2.x)
├── README.md               # User-facing documentation
├── SECURITY.md             # Disclosure policy
└── CONTRIBUTING.md         # This file
```

Source files of note:

- `src/index.ts` — public exports (entry point).
- `src/pixel.ts` — `registerServe` + `serveImage` middleware pipeline.
- `src/functions.ts` — `isValidPath`, `fetchImage`, `fetchFromNetwork`, plus
  SSRF helpers (`isPrivateIp`, `isPublicHost`, `resolvePinnedAddress`,
  `buildPinnedAgents`).
- `src/schema.ts` — Zod schemas (`optionsSchema`, `userDataSchema`).
- `src/renders.ts` — input validation wrappers + dimension clamping.
- `src/variables.ts` — constants and bundled fallback images.

## Local Development

### Prerequisites

- **Node.js >= 20** (Node 18 reached end-of-life on 2025-04-30; Sharp 0.34 and
  Vitest 4 require Node 20+).
- A working C/C++ toolchain for Sharp's native bindings (the prebuilt binaries
  cover most platforms; see [Sharp's install guide](https://sharp.pixelplumbing.com/install)
  if you hit a compilation error).

### Setup

```bash
git clone https://github.com/Hiprax/pixel-serve-server.git
cd pixel-serve-server
npm install
```

### Daily Loop

```bash
npm run test:watch     # Vitest in watch mode (run while editing)
npm run lint           # ESLint
npm run format         # Prettier (check mode — use --write locally if needed)
npm run type-check     # tsc --noEmit
npm run build          # tsup → dist/
```

### Pre-Submit Checklist

Before opening a PR, run the full suite. Every check must pass:

```bash
npm run build
npm test
npm run lint
npm run type-check
```

`npm test` runs Vitest with coverage and enforces the thresholds below.

## Coverage Expectations

`vitest.config.ts` enforces hard thresholds on every run:

| Metric     | Threshold |
| ---------- | --------- |
| Lines      | 95%       |
| Functions  | 95%       |
| Statements | 95%       |
| Branches   | 90%       |

A PR that drops coverage below these thresholds will not pass CI. When you
add a code path, add at least one test that exercises it; when you remove a
code path, remove the now-orphaned test rather than leaving dead assertions
behind.

## Code Style

- **TypeScript strict mode** is mandatory. Do not introduce `any` without a
  comment explaining why; prefer `unknown` and narrow with type guards.
- **ESLint + Prettier** rule the day. Run `npm run lint` and
  `npx prettier --write src/` before committing. The ESLint config requires
  explicit function return types and prohibits floating promises.
- **No new runtime dependencies** without discussion. The package's value
  proposition includes a small dependency surface.
- **Zod schemas stay strict** — unknown fields are rejected. New options
  belong in `optionsSchema` or `userDataSchema` with appropriate refinements.
- **Graceful degradation.** Every error path must end in a valid fallback
  image. The middleware does not surface stack traces or system paths to
  clients.
- **Observability hooks must be best-effort.** Throws inside user-supplied
  callbacks (`onError`, `onComplete`, `idHandler`, `getUserFolder`) are
  swallowed by the framework.

## Commit Style

There is no strict Conventional Commits enforcement, but commits should be
self-contained and have a meaningful subject line. Prefer:

```
schema: lowercase-normalise allowedNetworkList entries

The WHATWG URL parser always lowercases url.hostname, so configured
allowlists like ["CDN.Example.com"] silently never matched. Normalize at
schema-parse time so the runtime check stays a flat Array.includes.
```

over

```
fix bug
```

## Pull Request Guidelines

Before opening the PR, please confirm:

- [ ] All four `npm run` checks pass locally (`build`, `test`, `lint`,
      `type-check`).
- [ ] Coverage thresholds are still met (Vitest will fail the run otherwise).
- [ ] `CHANGELOG.md` has a new dated entry summarising the change with
      affected file paths.
- [ ] `README.md` is updated for any user-facing change (new option, new
      behavior, new security feature).
- [ ] `MIGRATION.md` is updated if you are introducing a breaking change for
      the next major release.
- [ ] New tests cover both the happy path and at least one failure path.
- [ ] No new runtime dependencies, or a justification in the PR description.

A good PR description includes:

1. **What** changed (the diff in plain English).
2. **Why** the change is needed (linked issue, bug report, or design rationale).
3. **How** the change was verified (the tests added, edge cases considered).
4. **Risk** — what could break and what the rollback story is.

Reviews focus on correctness, security, and clarity in roughly that order. A
PR that ships a feature but lacks tests or has a Vitest-only happy path will
be sent back.

## Sign-off / DCO

This project does **not** currently require a Developer Certificate of Origin
(DCO) sign-off. Submitting a PR implies you have the right to contribute the
code under the project's MIT license. If the project later adopts DCO, this
section will be updated.

## Reporting Bugs

Open a GitHub issue at
[github.com/Hiprax/pixel-serve-server/issues](https://github.com/Hiprax/pixel-serve-server/issues)
with:

- Version of `pixel-serve-server`, Node.js, Sharp, and Express.
- A minimal reproduction (request URL, configuration, expected vs. actual
  response).
- Stack trace or log output if applicable.

**Security issues should go through the disclosure channels in
[`SECURITY.md`](./SECURITY.md), not the public issue tracker.**

## Releasing (Maintainers Only)

1. Land all PRs targeting the release.
2. Confirm `CHANGELOG.md` has an entry for the new version.
3. Bump `package.json` via `npm version patch|minor|major` (this creates a
   git tag).
4. Run the full pre-submit checklist one more time.
5. `npm publish` against the public registry.
6. Push tags: `git push --follow-tags`.
7. Publish the corresponding GitHub release with the changelog entry pasted
   into the body.

## Thank You

Every issue triaged, test added, doc tightened, and PR reviewed pushes the
package forward. Welcome aboard.
