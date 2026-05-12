# Changelog

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.8.7] - 2026-05-12

### Security

- **Replace SHA-1 with SHA-256 in the deterministic ETag.** CodeQL `js/weak-cryptographic-algorithm` (alert #2) flagged the SHA-1 hash on user-controlled fields (`parsedUserId`, `src`) in `buildDeterministicEtag`, plus the fallback buffer ETag computed when no source identifier is available. SHA-1 collisions do not break ETag correctness in practice (a forgery would still have to match the resource bytes), but the modern hash closes the static-analysis finding and removes any theoretical concern that a third party could produce a matching ETag for a different request. Clients with cached SHA-1 ETags will see one 200 response per resource on the first request after upgrade (cache miss → re-cache with the new ETag), then return to 304s as before. (`src/pixel.ts`)
- **Eliminate polynomial-ReDoS regex in `buildFilename`.** CodeQL `js/polynomial-redos` (alert #3) flagged `.replace(/^_+|_+$/g, "")` even though the preceding `.replace(/_+/g, "_")` collapse already guarantees a single underscore in a row, meaning the polynomial worst-case never actually fires. Replaced the trim regex with two direct `startsWith` / `endsWith` + `slice` calls — same behavior, no backtracking risk, and the alert is gone. (`src/pixel.ts`)
- **Plug incomplete-sanitization in CHANGELOG section regex.** CodeQL `js/incomplete-sanitization` (alert #1) flagged `pkg.version.replace(/\./g, "\\.")` in `scripts/release-tag.mjs` because it escapes `.` but not the backslash itself — a future pre-release tag could in principle smuggle a partial escape past us. Switched to a full regex-metachar escape `/[\\^$.*+?()[\]{}|]/g, "\\$&"`. (`scripts/release-tag.mjs`)
- **Dismiss intentional test ReDoS literals as "used in tests".** Two test cases in `src/schema.test.ts` build deliberately pathological regexes (`^(a+)+\/$` and `^(a+)+b$`) to verify the schema layer *never* executes them. CodeQL flagged them as `js/redos` (alerts #4 and #5). The literals are the *fixture* the test exercises — they're stored in the schema but never matched against any string — so the right resolution is the standard `used in tests` dismissal reason. A `new RegExp("…")` wrapper was tried first but does not change anything: CodeQL's dataflow follows the string into the constructor. The inline test comment now explains this. (`src/schema.test.ts`, GitHub Code Scanning)

### Added

- **Origin-remote sanity check in `release-tag.mjs`.** Verifies `package.json#name` matches the second segment of the `origin` remote slug before creating the tag, so an accidental `release:tag` invocation from the wrong working directory cannot push a mis-versioned tag to the wrong repo. Catches the failure mode where the previous release run accidentally pushed `v1.1.8` (the client's version) to the server repo — the release workflow correctly refused to publish, but the failed CI run cluttered the server's run history. (`scripts/release-tag.mjs`)

### Documentation

- **Remove libraries.io "Dependencies" badge.** Removed `[![Dependencies](https://img.shields.io/librariesio/release/npm/pixel-serve-server)](https://libraries.io/npm/pixel-serve-server)` from the README so the status row only shows badges this project directly controls or that reflect first-party CI signal (CI, CodeQL, Codecov, npm provenance). (`README.md`)

### Tests

- **Pin SHA-256 ETag shape.** Added an explicit assertion that `buildDeterministicEtag` emits a 64-hex-char value (quoted per RFC 7232) so a future regression that flips back to a weaker hash fails the test suite before it ships. (`src/pixel.test.ts`)
- **Cover the `buildFilename` underscore-strip path.** Added a case for the explicit `startsWith` / `endsWith` + `slice` logic that replaced the polynomial-flagged regex. (`src/pixel.test.ts`)

## [2.8.6] - 2026-05-12

### Documentation

- **Replace broken npm-provenance shield with a static "built & signed" badge.** The v2.8.3-era badge URL `https://img.shields.io/npm/sigstore/pixel-serve-server?label=provenance` rendered as `404 badge not found` because shields.io has no `/npm/sigstore/` endpoint (verified by probing `/npm/provenance`, `/npm/has-provenance`, `/sigstore/npm`, `/npm/attestation`, `/npm/sig` — all return the same 404). Swapped in a static `img.shields.io/badge/npm%20provenance-built%20%26%20signed-success?logo=npm&logoColor=white` shield that links through to `npmjs.com/package/pixel-serve-server`, where the real "Built and signed on GitHub Actions" attestation UI lives. Functionally the badge now communicates the same thing without depending on a non-existent endpoint. (`README.md`)

### Notes

- Patch bump (`2.8.5` → `2.8.6`): docs-only — no runtime API changes, no schema changes, no exports added or removed. Re-publishing pushes the corrected README to the npm package page so `https://www.npmjs.com/package/pixel-serve-server` no longer renders the broken badge.

## [2.8.5] - 2026-05-12

### Tests

- **Align `isInsideRoot` symlink-escape test with the v2.8.4 fix.** The Linux leg of CI surfaced a follow-up: the existing test `"isInsideRoot rejects symlink escapes from the candidate side via path.relative (Task 7)"` was asserting `true` for a symlink-inside-root-pointing-outside scenario, documenting the *old* lexical-only design where symlink escapes were deferred to `isValidPath`. With v2.8.4 making the containment check realpath the candidate as well (the safer default), that scenario must return `false`. Renamed the test to `"… via fs.realpath"`, flipped the assertion to `toBe(false)`, and rewrote the comment to describe the realpath behavior. Also tightened the `isInsideRoot` JSDoc in `src/pixel.ts` to describe the realpath-both-sides design. (`src/pixel.test.ts`, `src/pixel.ts`)

### Notes

- Patch bump (`2.8.4` → `2.8.5`): test + docs alignment to the same hardening landed in v2.8.4. Both v2.8.3 and v2.8.4 tags exist on GitHub but their `release.yml` runs failed at the Test step before publishing, so `v2.8.5` is the first version on npm carrying the CI/release scaffold (originally targeted for v2.8.3), the symlink-containment fix (originally targeted for v2.8.4), and this test alignment. The orphan v2.8.3 / v2.8.4 GitHub tags can be deleted later via the GitHub UI without affecting npm.

## [2.8.4] - 2026-05-12

### Security

- **Fix symlink escape in `getUserFolderRootDir` containment.** The Linux leg of the new CI matrix surfaced a latent bug in `isInsideRoot`: the **root** side was resolved via `fs.realpath`, but the **candidate** side was only resolved lexically through `path.resolve`. That meant a `getUserFolder` result whose final segment was a symlink pointing outside the configured root would still satisfy the lexical-prefix check (because the symlink's *own* path lives inside the root) and be accepted. The fix realpaths the candidate as well, falling back to the lexical resolve only when the candidate doesn't exist on disk yet (the descendant `isValidPath()` still realpaths the final file before reading). Tested with a real symlink (`fs.symlink(outsideDir, linkPath, "dir")`) — the containment check now fires `onError` with `phase: "getUserFolder"` and the response falls back to the public `baseDir`. The Windows test path remains a soft skip because the platform requires admin / developer mode to create symlinks. (`src/pixel.ts`)

### Notes

- Patch bump (`2.8.3` → `2.8.4`): single security fix; no API changes, no exports added or removed, no schema changes. The previous `v2.8.3` git tag exists on GitHub but its `release.yml` run failed at the Test step before the publish step ran, so no `v2.8.3` was ever published to npm — `v2.8.4` is the first version on npm carrying the CI/release scaffold from `v2.8.3` *plus* this symlink fix.

## [2.8.3] - 2026-05-12

### Added

- **GitHub Actions CI matrix.** New `.github/workflows/ci.yml` runs on push to `main` and on every PR across Node 20.x / 22.x / 24.x. The matrix step builds, runs `attw --pack` for export-shape validation, type-checks, lints, format-checks, and runs the full Vitest suite with coverage. The Node 22.x leg uploads `coverage/lcov.info` to Codecov (`Hiprax/pixel-serve-server`). Concurrency group `ci-${workflow}-${ref}` cancels superseded pushes; `permissions: contents: read` enforces least-privilege; runners cap at 15 minutes; `actions/checkout@v6` runs with `persist-credentials: false`. (`.github/workflows/ci.yml`)
- **Tag-triggered release workflow.** New `.github/workflows/release.yml` runs on push of any `v*.*.*` tag (and via `workflow_dispatch` with an optional tag input). It re-runs all quality gates, verifies the tag version matches `package.json#version` (refusing to publish on mismatch), runs `npm pack --dry-run` to surface tarball issues, then executes `npm publish --provenance --access public` using `secrets.NPM_TOKEN` and OIDC (`id-token: write`). On success it extracts the matching `## [VERSION]` block from `CHANGELOG.md` via awk and creates a GitHub Release with `softprops/action-gh-release@v3`. (`.github/workflows/release.yml`)
- **CodeQL static analysis.** New `.github/workflows/codeql.yml` runs on push to `main`, PR to `main`, and weekly cron (`0 6 * * 1`). Uses `github/codeql-action@v4` with the `security-and-quality` query suite on the `javascript-typescript` language. Caps at 30 minutes; grants only `security-events: write` + read scopes. (`.github/workflows/codeql.yml`)
- **Dual-build types fix surfaced by attw.** Switched the `exports[".".import|require]` map to the nested-types shape (`types` + `default` under each condition, with `.d.mts` for the ESM half) so resolvers under `node16`/`nodenext` no longer report "🎭 Masquerading as CJS". `attw --pack .` is now green across `node10`, `node16` (CJS), `node16` (ESM), and `bundler`. Top-level `main` / `module` / `types` remain for legacy resolvers. (`package.json`)
- **Cross-platform release scripts.** Six zero-dependency Node scripts under `scripts/`: `_lib.mjs` (shared git/IO/prompt helpers), `verify.mjs` (sequential build → attw → type-check → lint → format → test gate runner with PASS/FAIL summary), `new-branch.mjs` (conventional `feat/`, `fix/`, etc. branches from fresh `origin/main`), `sync-main.mjs` (`fetch --prune` + fast-forward pull + safe cleanup of branches whose remotes were deleted on GitHub), `release-prepare.mjs` (pre-flight checks, version bump, `[Unreleased]` → `[X.Y.Z] - <date>` promotion, commit + push to `release/vX.Y.Z` branch), `release-tag.mjs` (verifies the merged release commit is current on `main`, then creates and pushes the annotated `vX.Y.Z` tag that triggers the release workflow). Wired as `npm run verify | branch | sync | release:prepare | release:tag`. (`scripts/*`, `package.json#scripts`)
- **Issue / PR / contact templates.** `.github/PULL_REQUEST_TEMPLATE.md` with the standard checklist (build, test, lint, type-check, `check-types-pack`, CHANGELOG), `.github/ISSUE_TEMPLATE/bug_report.yml` (package version, Node version, OS, `registerServe` options, triggering request, expected/actual, `onError` phase capture), `.github/ISSUE_TEMPLATE/feature_request.yml`, and `.github/ISSUE_TEMPLATE/config.yml` that disables blank issues and routes security reports to GitHub Security Advisories. (`.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/*`)
- **`@arethetypeswrong/cli` dev dependency.** Pinned at `^0.18.2` and wired as `npm run check-types-pack` (`attw --pack .`). Surfaced and helped fix the masquerading-as-CJS export-shape issue noted above. (`package.json#devDependencies`, `package.json#scripts`)
- **README badges.** Added five new status badges: CI (`actions/workflows/ci.yml/badge.svg`), CodeQL (`actions/workflows/codeql.yml/badge.svg`), Codecov (`codecov.io/gh/.../branch/main/graph/badge.svg`), Dependencies (`shields.io/librariesio/release/npm/...` — flags outdated runtime/dev deps via the libraries.io index), and npm provenance (`shields.io/npm/sigstore/...?label=provenance` — surfaces the sigstore signature attached by `npm publish --provenance` on the latest published version). Bumped the stale `TypeScript-5.9.3` shield to `TypeScript-6.0.3` to match the current toolchain. (`README.md`)
- **CHANGELOG `[Unreleased]` section.** Added the Keep a Changelog header and a placeholder `## [Unreleased]` heading so `release:prepare` has a target to promote on the next bump. (`CHANGELOG.md`)

### Notes

- Patch bump (`2.8.2` → `2.8.3`): tooling-only — no runtime API changes, no schema changes, no exports added or removed. The `exports` map keeps the same conditional resolution it had before for both ESM and CJS consumers; the change is the nested `types`/`default` shape, which is purely additive in terms of resolver behavior. All `npm run build`, `npm test`, `npm run lint`, `npm run format`, `npm run type-check`, and `npm run check-types-pack` pass with 351/351 tests still green.

## [2.8.2] - 2026-05-12

### Dependencies

- **TypeScript 5.9.3 → 6.0.3.** Major bump. The project's existing `tsconfig.json` already pins every option that TypeScript 6 changed defaults for (`strict: true`, `module: ESNext`, `target: ES2022`, `moduleResolution: Bundler`, `types: [...]`), so no source changes were required. Added `ignoreDeprecations: "6.0"` to `tsconfig.json` to silence the `baseUrl` deprecation warning surfaced by `tsup`/`rollup-plugin-dts` (which sets `baseUrl` internally for declaration emission) — the escape hatch is officially supported until TypeScript 7.0. (`tsconfig.json`, `package.json`)
- **ESLint 9.39.1 → 10.3.0.** Major bump. Minimum Node engine raised by upstream to `v20.19.0+ || v22.13.0+ || >=24`. Added `@eslint/js@^10.0.1` as an explicit dev dependency — it was previously transitively available and is now required as a direct dep by ESLint 10. The flat-config file was renamed `eslint.config.js` → `eslint.config.mjs` to satisfy ESLint 10's stricter module-type detection (the project ships dual ESM/CJS so we can't set `"type": "module"` in `package.json`). The three new default rules (`no-unassigned-vars`, `no-useless-assignment`, `preserve-caught-error`) and the new JSX reference tracking did not surface any violations in the existing codebase. (`eslint.config.mjs`, `package.json`)
- **`typescript-eslint` 8.56 → 8.59.3** (matched on `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser`). No source changes required. (`package.json`)
- **Vitest 4.0.15 → 4.1.6** (matched on `@vitest/coverage-v8`). No source changes required; all 351 tests still pass with coverage well above thresholds. (`package.json`)
- **zod 4.1.13 → 4.4.3.** Minor bump within the v4 line. No schema-API changes required. (`package.json`)
- **Prettier 3.7.4 → 3.8.3.** Added `.prettierrc.json` pinning `endOfLine: "auto"` so the repo accepts both CRLF (Windows checkout default) and LF without re-flowing the entire file each commit. Ran `prettier --write` to apply the v3.0+ `trailingComma: "all"` default to two function-parameter sites in `src/types.ts` (and incidental whitespace normalization across the test files). No behavior changes. (`.prettierrc.json`, `src/types.ts`, `src/**/*.test.ts`)
- **Smaller bumps:** `supertest` 7.1.4 → 7.2.2, `@types/supertest` 6.0.3 → 7.2.0 (aligns with supertest 7's reshuffled `Test`/`SuperTest` exports — no test-file changes required), `@types/node` 24.10.1 → 25.7.0. (`package.json`)

### Notes

- Patch bump (`2.8.1` → `2.8.2`): dev-dependency-only update plus one minor runtime-dep bump (`zod 4.1 → 4.4`, fully backward compatible). No public API changes, no schema changes, no exports added or removed. All `npm run build`, `npm test`, `npm run lint`, `npm run format`, and `npm run type-check` pass with 351/351 tests and 97.12% line coverage.

## [2.8.1] - 2026-05-12

### Documentation

- **`onComplete` observability hook documented in README (Task 1).** The hook shipped with version 2.7.0 but was missing from every documentation surface. The README "Configuration Options" table now includes an `onComplete` row mirroring the `onError` row format, the "Advanced Setup with All Options" example demonstrates a console-logging hook alongside `onError`, and the "Observability" section is split into `onError` (failure pings) and `onComplete` (success + cache-hit pings) subsections. The `onComplete` example shows how to wire `durationMs` into a latency histogram and `cached` into a cache-hit / cache-miss counter. The README types-import block also now lists `PixelServeOnError`, `PixelServeErrorContext`, `PixelServeErrorPhase`, `PixelServeOnComplete`, and `PixelServeCompletionContext`, all of which were already exported from `src/index.ts` via the `export * from "./types"`. (`README.md`)
- **Helpers section added under Exports (Task 2).** The README "Exports" section previously listed only `registerServe`, the option/data types, the Zod schemas, and `isValidPath`, even though `src/index.ts` exports eleven additional helpers. A new "Helpers" subsection now documents all eleven, grouped by purpose: security/SSRF helpers (`isPrivateIp`, `isPublicHost`, `resolvePinnedAddress`, `buildPinnedAgents`, `isInsideRoot`, `resolveRootDir`, `looksLikeSvg`), ETag helpers (`buildSourceIdentifier`, `buildDeterministicEtag`), and path / API helpers (`stripApiPrefix`, `buildFilename`). Each entry gets a one-sentence description covering signature and intended use case (precomputing ETags for offline cache priming, sharing SSRF primitives with custom middleware, sniffing SVG inputs before Sharp, etc.). A code block at the end shows the full import surface for consumers who want to copy/paste. (`README.md`)
- **`onComplete` documented in `CLAUDE.md` (Task 1).** New row added to the `PixelServeOptions` table mirroring the `onError` row. New step 11 added to the "Image Processing Pipeline" describing when the hook fires (after the 200 happy path and the 304 short-circuit, with `cached: true` to distinguish). The "Observability" bullet under "Security Features" now lists both hooks side by side. (`CLAUDE.md`)
- **Coverage-threshold comments corrected in `CLAUDE.md` (Task 3).** Two `npm run test         #` comment lines (one in the server package section, one in the client package section) previously read `85% branches`, which contradicted both the live `vitest.config.ts` files in each package (`branches: 90`) and the dedicated "Coverage Thresholds" section further down in `CLAUDE.md`. Both comments now read `90% branches`, restoring documentation/source-of-truth alignment. (`CLAUDE.md`)

### Notes

- Patch bump (`2.8.0` → `2.8.1`): documentation-only changes. No runtime API changes, no schema changes, no exports added or removed. All `npm run build`, `npm test`, `npm run lint`, and `npm run type-check` pass.

## [2.8.0] - 2026-05-12

### Changed

- **`renderOptions` runs once at factory time, not per request (Task 4).** `registerServe` now validates the `PixelServeOptions` payload through `optionsSchema.parse` exactly **once** when the middleware is constructed and threads the resulting `ParsedOptions` into every `serveImage` invocation. Previously each request re-ran the entire Zod schema (strict-mode unknown-key check, `websiteURL` regex match, `refine()` callbacks for `minWidth <= maxWidth` / `minHeight <= maxHeight`, `allowedNetworkList.transform(trim → lowercase)`, function-type custom validators), allocated a fresh parsed-options object, and re-bound `onError` / `onComplete` to themselves. The hot path is now arithmetic: the schema cost — including any user-supplied regex — is bounded to startup. Operator misconfiguration is surfaced loudly: the schema parse fires `onError` with `phase: "schema"` and re-throws synchronously from `registerServe` so a bad deployment fails fast rather than silently serving fallback images forever. The public API is unchanged — `registerServe(options)` still returns the middleware function — and successful configurations continue to work identically. (`src/pixel.ts`)
- **`buildFilename` no longer truncates mid-percent-encoded byte (Task 5).** The `filename*=UTF-8''...` RFC 5987 parameter value used `encodedBase.slice(0, maxBase)` directly, which could land inside a `%XX` triplet for long unicode source names (e.g., `'中'.repeat(40)` produced trailing `%E4%B`, which is malformed and rejected by strict RFC 3986 / RFC 5987 parsers). The truncation now walks back from the slice boundary to the nearest `%` and drops any incomplete trailing triplet, then walks back past any trailing UTF-8 lead byte that lost its continuation bytes (a complete percent-encoded byte like `%E4` is still invalid UTF-8 on its own — it is the lead byte of a 3-byte sequence). The result decodes cleanly under strict UTF-8 parsers and the overall length cap is still respected. Plain ASCII names are unaffected. (`src/pixel.ts`)
- **`websiteURL` validation regex replaced with a ReDoS-safe pattern (Task 6).** The schema previously used `/^(?![-.])([\w]+[-.]?)*[\w]+$/` whose nested quantifier `([\w]+[-.]?)*` followed by a required `[\w]+$` exhibited catastrophic backtracking on inputs like `"a".repeat(50) + "!"` (a pathological misconfiguration would hang the entire startup before Task 4 — and previously hung every request). The replacement `/^(?!-)[A-Za-z0-9-]{1,63}(\.(?!-)[A-Za-z0-9-]{1,63})*$/` is anchored with no nested repetition: each label is 1-63 alphanumeric/hyphen chars, labels are dot-separated, and no label may start with `-`. Linear-time matching is now guaranteed. Backward compatible for every well-formed hostname — `example.com`, `localhost`, `sub.example.com`, `www.example.com` all still validate, and URLs like `https://example.com/path` continue to flow through the `z.url()` branch of the union. The previous regex's `\w`-driven underscore acceptance is dropped because RFC 1123 hostnames do not include `_`. After Task 4, the regex only runs once at factory time, but the safe pattern still removes the operator-controlled footgun entirely. (`src/schema.ts`)

### Tests

- **Task 4 — new pixel.test.ts case `does not re-run optionsSchema.parse on subsequent requests`.** Spies on `optionsSchema.parse` AFTER `registerServe` returns its middleware, fires three GET requests through `supertest`, and asserts the spy was never invoked. Pins the factory-time contract so any future regression that pushes the Zod parse back onto the hot path is caught immediately. (`src/pixel.test.ts`)
- **Task 4 — existing `phase=schema` test updated to assert synchronous throw.** The previous test asserted that an invalid `baseDir: ""` produced a `200` fallback because the schema parse happened lazily inside the per-request `serveImage` outer catch. After Task 4 the factory itself rejects the misconfiguration: the updated test asserts `registerServe({ baseDir: "" })` throws synchronously and that `onError` still fires with `phase: "schema"` before the throw. (`src/pixel.test.ts`)
- **Task 5 — new `buildFilename does not truncate mid-percent-encoded byte for long CJK names`.** Builds a 40-character CJK source, asserts the encoded portion of the RFC 5987 filename has no trailing `%`, no trailing `%X`, that every `%` is followed by two hex digits, decodes cleanly under `decodeURIComponent`, and that the decoded prefix is a non-empty prefix of the original input. Length cap is still respected. (`src/pixel.test.ts`)
- **Task 6 — five new schema.test.ts cases under `websiteURL ReDoS hardening`:** (1) accepts every previously-valid hostname form (single-label, FQDN, subdomain, URL form); (2) rejects hostnames with a leading hyphen on any label; (3) rejects empty labels (leading/trailing/doubled dots); (4) **ReDoS budget assertion** — `"a".repeat(50) + "!"` rejects in under 50 ms; (5) rejects labels longer than 63 characters. (`src/schema.test.ts`)

### Notes

- Minor bump (`2.7.2` → `2.8.0`): Task 4 is a per-request performance improvement (eliminating the Zod schema, regex, and refine() costs from the hot path); Task 5 is a bug fix for RFC 5987 conformance on long unicode filenames; Task 6 is a security hardening that removes a ReDoS footgun from the operator-controlled config surface. All three are fully backward compatible — the public `registerServe(options)` signature is unchanged, valid configurations still work, and the only observable behavior change is that invalid configurations now fail loudly at factory time instead of returning fallback images per request. All `npm run build`, `npm test`, `npm run lint`, and `npm run type-check` pass.

## [2.7.2] - 2026-05-12

### Documentation

- **`SECURITY.md` added (Task 10).** New disclosure-policy document covering: supported versions table (`2.x` active, `1.x` security-only, `<1.0` unsupported), reporting channels (GitHub Security Advisories preferred, private email fallback), response targets (5 day ack, 10 day assessment, 30 day fix for High/Critical), the 90-day coordinated-disclosure embargo policy, and detailed in-scope / out-of-scope vulnerability classes. Dev-dependency advisories and integration-app issues are explicitly out of scope; the SSRF, path-traversal, decompression-bomb, header-injection, ReDoS, and schema-bypass surfaces are explicitly in scope. (`SECURITY.md`)
- **`CONTRIBUTING.md` added (Task 10).** New contributor guide covering project layout, prerequisites (Node 20+ and Sharp native bindings), the daily development loop (`npm run test:watch`/`lint`/`format`/`type-check`/`build`), the pre-submit checklist mirroring the project guidelines, the coverage thresholds (95% lines/functions/statements, 90% branches), code style requirements (TypeScript strict, ESLint+Prettier, no new runtime deps without discussion, Zod strict schemas, graceful degradation), commit message style, a PR checklist, the maintainer-only release procedure, and a note that the project does **not** currently require DCO sign-off. (`CONTRIBUTING.md`)
- **`MIGRATION.md` added (Task 11).** New 1.x → 2.x upgrade guide with seven sections: (1) SVG removed as an output format — schema now silently discards `?format=svg` rather than relying on a downstream codepath, (2) `userDataSchema.src` no longer defaults to `/placeholder/noimage.jpg` — empty/missing `src` now hits a single `if (!userData.src)` branch and serves the bundled placeholder without firing `onError` with `phase: "validation"`, (3) the new security defaults (`maxRedirects`, `maxInputPixels`, `allowSvgInput`, `getUserFolderRootDir`), (4) RFC 5987 / RFC 6266 `Content-Disposition` upgrade, (5) the newly first-class helper exports (`buildFilename`, `looksLikeSvg`, `isPrivateIp`, `isPublicHost`, `stripApiPrefix`, etc.) replacing deep imports, (6) the `onError` / `onComplete` observability surface, (7) the Node 20 engine pin. Includes before/after request snippets, code samples for opting back into 1.x behavior where possible, and a quick compatibility matrix. (`MIGRATION.md`)
- **README — `Versioning and Migration` section added.** Points readers at `MIGRATION.md` for the 1.x → 2.x walkthrough and `CHANGELOG.md` for the full history. (`README.md`)
- **README — `Security` and `Contributing` sections updated** to point at the new `SECURITY.md` and `CONTRIBUTING.md` files. The existing GitHub-issues link in `Contributing` was preserved; `Security` explicitly warns against opening public issues for security reports. (`README.md`)
- **CHANGELOG — 2.0.0 entry now links to `MIGRATION.md`.** Added a "Migration guide" note under the 2.0.0 release so anyone scanning the changelog for the breaking-change entry finds the upgrade walkthrough one click away. (`CHANGELOG.md`)

### Engineering

- **`package.json#files` includes `SECURITY.md` (Task 10).** The npm publish whitelist now ships the disclosure policy alongside `dist/`. `CONTRIBUTING.md` and `MIGRATION.md` remain repository-only — they are not included in the published tarball because they are workflow documents, not consumer-facing API references. (`package.json`)

### Notes

- Patch bump (`2.7.1` → `2.7.2`): documentation-only changes. No runtime API changes. All `npm run build`, `npm test`, `npm run lint`, and `npm run type-check` pass.

## [2.7.1] - 2026-05-12

### Changed

- **`allowedNetworkList` entry validation hardened (Task 9).** The Zod schema for `optionsSchema.allowedNetworkList` now requires each entry to be a non-empty string matching `/^[a-z0-9.-]+$/i` (hostname characters only). Previously the schema accepted `[""]` and `["  "]` verbatim, and after the Task 2 `trim().toLowerCase()` normalisation those would collapse to `""` and silently match `url.hostname === ""` for malformed inputs like `http:///path`. The validation runs BEFORE the lowercase transform, so the order of operations stays "reject garbage → normalise survivors". Backward compatible for any reasonable production config — every well-formed hostname (single-label, FQDN, IPv4 literal, punycode IDN label) still parses. (`src/schema.ts`)

### Tests

- **Task 9 — 6 new schema tests under `allowedNetworkList entry validation (Task 9)`:** (1) rejects an empty-string entry with the `cannot be empty` message; (2) rejects a whitespace-only entry with the `not a valid hostname` message (because the regex sees the raw value before the trim transform); (3) rejects a mixed `["", "  "]` array; (4) rejects an entry containing internal whitespace (`"cdn .example.com"`); (5) rejects an entry containing protocol or path characters (`"https://cdn.example.com"`); (6) regression confirming the Task 2 lowercase + trim transform still runs after validation succeeds (`["CDN.Example.com", "Images.Test"]` → `["cdn.example.com", "images.test"]`). (`src/schema.test.ts`)

### Engineering

- **Node engine pinned to `>=20` (Task 12).** `package.json#engines.node` updated from `>=18` to `>=20`. Node 18 reached end-of-life on 2025-04-30, and the existing toolchain (Sharp 0.34, Vitest 4) already requires Node 20+. README `Installation` and `Requirements` sections updated to call out the Node 20 minimum, and the README badge bumped from `Node.js-18+` to `Node.js-20+`. (`package.json`, `README.md`)

### Notes

- Patch bump (`2.7.0` → `2.7.1`): Task 9 adds defence-in-depth validation that rejects entries no production config should ever supply (empty strings, whitespace, URL fragments). Task 12 updates the engines field to match the toolchain that has shipped since iteration 1. No runtime API changes. All `npm run build`, `npm test`, `npm run lint`, and `npm run type-check` pass.

## [2.7.0] - 2026-05-12

### Added

- **`onComplete` observability hook (Task 6).** New optional `PixelServeOptions.onComplete?: (context) => void` callback fired after the response has been flushed on the happy path (200 + image bytes) and after the 304 cached short-circuit. The context object carries `src`, `userId`, `format`, `outputBytes`, `cached`, and `durationMs`. `durationMs` is measured via `process.hrtime.bigint()` checkpoints so the value is monotonic and immune to wall-clock jumps. The hook complements the existing `onError` surface so APM integrations can derive per-request latency, cache-hit ratios, and bytes-out without scraping HTTP access logs. Best-effort dispatch: throws from the hook are swallowed by the new `safeOnComplete` dispatcher (mirroring the `reportError`/`safeOnError` contract) so a buggy logger cannot crash a request. Hook does NOT fire when the pipeline falls through to the outer fallback catch — that failure surface continues to flow through `onError` alone. (`src/types.ts`, `src/schema.ts`, `src/pixel.ts`)
- **`PixelServeCompletionContext` and `PixelServeOnComplete` type exports.** Both surface from `src/types.ts` and are picked up by the package entry point via the existing `export * from "./types"`. (`src/types.ts`, `src/index.ts`)
- **`resolveRootDir` helper (Task 8).** New exported helper in `src/pixel.ts` that resolves a configured `getUserFolderRootDir` to its canonical realpath, falling back to lexical `path.resolve` when the directory does not yet exist on disk. Used by `registerServe` to cache the resolved root once at middleware-factory time. (`src/pixel.ts`, `src/index.ts`)

### Changed

- **`isInsideRoot` now accepts not-yet-created candidates (Task 7).** Previously the helper required BOTH `rootDir` and `candidate` to resolve via `fs.realpath`, so legitimate first-time requests to lazy per-user dirs silently failed the containment check and fell back to the public `baseDir`. The helper now runs a **lexical** containment check on the candidate side: `path.relative(realRoot, path.resolve(candidate))` rejects `..`-prefixed and absolute relative paths but otherwise accepts a candidate that does not yet exist on disk. Symlink escapes from the candidate side (a link inside the root pointing outward) are still caught later by `isValidPath`'s realpath check inside `readLocalImage`. The root side continues to be normalized via `fs.realpath` when possible (with a lexical fallback when the root itself is unreadable). Backward compatible — existing containment-pass and symlink-escape tests still pass. (`src/pixel.ts`)
- **`isInsideRoot` accepts an optional `preResolvedRoot` parameter (Tasks 7, 8).** When supplied, the helper treats it as the already-resolved root path and skips the per-call `fs.realpath` on the root side. `registerServe` now feeds the cached value through `serveImage`. The third parameter is optional so direct callers of the helper see no breaking change. (`src/pixel.ts`)
- **`registerServe` caches `realpath(getUserFolderRootDir)` once per middleware instance (Task 8).** The factory resolves the configured root on the first request that needs it (via the new `resolveRootDir` helper) and reuses the cached value for every subsequent request. Concurrent first-request resolutions are coalesced so a burst of N concurrent requests produces exactly one `realpath` syscall against the root rather than N. The candidate-side realpath check remains per-request because every candidate is different; only the root-side cost is amortised. Behavior unchanged — only the syscall count drops. (`src/pixel.ts`)

### Tests

- **Task 6 — 4 new `onComplete` tests in `src/pixel.test.ts`:** (1) fires after a successful 200 with `format`, `outputBytes`, and `durationMs` matching the response body length and a non-negative latency; (2) fires with `cached: true` and `outputBytes: 0` on the 304 cached short-circuit; (3) swallows throws from the hook so the response remains correct (best-effort dispatch contract); (4) does NOT fire on the outer fallback path (forced via `vi.spyOn(sharp.prototype, "toBuffer")`) — failure surface stays on `onError` alone. (`src/pixel.test.ts`)
- **Task 7 — 4 new lazy-create / lexical-containment tests in `src/pixel.test.ts`:** (1) direct `isInsideRoot` assertions that a not-yet-created candidate whose parent is the configured root passes the lexical check, and that lexical escapes are still rejected; (2) regression test that existing root + descendant still resolve `true`; (3) symlink-from-candidate-side coverage (POSIX only) confirms the lexical pass-through delegation contract; (4) end-to-end middleware test where `getUserFolder` returns a path that does not yet exist on disk and the framework does not fire an `onError` ping for `phase: "getUserFolder"`. The existing "isInsideRoot rejects sibling directories and non-existent paths" test was renamed to "isInsideRoot rejects sibling directories and empty inputs (Task 7 lexical containment)" and updated to expect a non-existent inside-root candidate to now return `true` — the documented Task 7 behavior. (`src/pixel.test.ts`)
- **Task 8 — 2 new realpath-cache tests in `src/pixel.test.ts`:** (1) installs a counting wrapper around `node:fs/promises` via `vi.doMock` + `importActual`, re-imports the middleware against the mocked module graph, fires five sequential requests through `registerServe`, and asserts EXACTLY one `realpath` call against the configured root — proving the factory-level cache holds; (2) confirms the factory tolerates a not-yet-created `getUserFolderRootDir` at registration time (no throw) and that the lexical fallback path keeps Task 7's lazy-tree containment intact. (`src/pixel.test.ts`)

### Notes

- Minor bump (`2.6.0` → `2.7.0`): the `onComplete` hook is additive (existing consumers see no behavior change unless they opt in). Task 7 relaxes the containment check on the candidate side — non-existent candidates inside the configured root are now accepted, which only INCREASES the set of inputs that pass containment (no previously-accepted path is now rejected). Task 8 is a per-request realpath syscall optimization with no observable behavior change. The factory exposes `serveImage` with an optional `cachedRealRoot` parameter; all prior call sites continue to work without modification. All `npm run build`, `npm test`, `npm run lint`, and `npm run type-check` pass.

## [2.6.0] - 2026-05-12

### Security

- **DNS rebinding mitigation via pinned `lookup` (Task 3).** `fetchFromNetwork` previously called `isPublicHost` (which itself runs `dns.lookup`) and then immediately handed the URL to `axios.get`, which performed its OWN kernel-resolver lookup. Between the two lookups, an attacker-controlled authoritative name server could answer the framework's validation with a public IP and respond to axios's lookup microseconds later with `127.0.0.1`/`169.254.169.254` — the canonical DNS-rebinding exploit. The middleware now resolves the hostname once via the new `resolvePinnedAddress` helper, validates every returned address against `isPrivateIp`, then constructs a per-request pair of `http.Agent`/`https.Agent` whose `lookup` function is pinned to that exact `{ address, family }` pair via `buildPinnedAgents`. Axios receives those agents via `httpAgent`/`httpsAgent` so the TCP socket is guaranteed to connect to the IP the framework validated. Each redirect hop in the manual loop independently re-resolves and re-pins, so chained rebinding attempts are also defeated. Backward compatible: no API surface change, no new option. (`src/functions.ts`, `src/functions.test.ts`, `README.md`)

### Changed

- **`looksLikeSvg` hardened (Task 4).** The SVG magic-byte sniffer previously inspected only offset 0 (or offset 3 after a UTF-8 BOM) over a 1 KiB latin1 window, leaving three bypasses: a single 0x20 byte before the UTF-8 BOM (BOM check fired only at offset 0), UTF-16 BE/LE BOM-prefixed SVGs (`toString("latin1")` produced garbage that never matched `<svg`), and pathologically large XML prologs (`<?xml ...?>` plus comments) that pushed `<svg` past the 1 KiB inspection window. The hardened detector now (1) skips leading ASCII whitespace (tab, LF, CR, space) BEFORE the BOM check, (2) recognises UTF-16 BE (`0xFE 0xFF`) and UTF-16 LE (`0xFF 0xFE`) BOMs by re-decoding the head as UTF-16 (byte-swapping for BE) and re-running the heuristic, (3) handles UTF-8 BOM after any leading whitespace, and (4) widens the latin1 inspection window from 1 KiB to 4 KiB so longer XML prologs cannot push `<svg` out of view. Sharp's `meta.format === "svg"` post-decode check remains in place as belt-and-suspenders. (`src/pixel.ts`, `src/pixel.test.ts`)
- **`res.headersSent` guard in outer fallback catch (Task 5).** The outer `catch` in `serveImage` previously called `res.type / res.setHeader / res.send` unconditionally, assuming no bytes had been flushed yet. Today the happy path only flushes via `res.send` at the very end, so the catch was reachable only with no headers sent — but a future streaming refactor (e.g., `res.write` ahead of `res.send`) would silently make the catch unsafe and produce `ERR_HTTP_HEADERS_SENT`. The catch now checks `res.headersSent` BEFORE attempting the fallback. When true, it fires `onError` with `phase: "fs"` and `Error("response already flushed")`, then routes to `next(err)` so Express tears the connection down cleanly. (`src/pixel.ts`, `src/pixel.test.ts`, `README.md`)

### Added

- **`resolvePinnedAddress` helper (Task 3).** New exported function in `src/functions.ts` that resolves a hostname once via `dns.lookup({ all: true, verbatim: true })`, validates every address with `isPrivateIp`, and returns `{ address, family }` for the first safe address (or `null` when the host is private/unresolvable/empty). IP literals short-circuit DNS entirely. (`src/functions.ts`)
- **`buildPinnedAgents` helper (Task 3).** New exported function in `src/functions.ts` that returns a per-request `{ httpAgent, httpsAgent }` pair whose internal `lookup` function is pinned to a single `{ address, family }`. Used by `fetchFromNetwork` to force axios to connect to the pre-validated IP. (`src/functions.ts`)

### Tests

- **Task 3 — 9 new DNS-pinning tests in `src/functions.test.ts`:** `resolvePinnedAddress` returns the validated address for a public hostname, returns null when any address is private, returns null on DNS failure, returns null for empty hostname, returns null for a private IP literal without DNS, returns the IP verbatim for a public IPv4 literal, returns family=6 for a public IPv6 literal, axios is invoked with a custom `httpsAgent` whose `lookup` is pinned to the resolved IP (load-bearing assertion — directly invokes the agent's `lookup` callback and confirms it returns the pinned IP for any hostname), short-circuits before axios when DNS returns a private IP, and rebuilds/pins a fresh agent pair per redirect hop. (`src/functions.test.ts`)
- **Task 4 — 7 new `looksLikeSvg` hardening tests in `src/pixel.test.ts`:** SVG after leading whitespace before a UTF-8 BOM, SVG behind leading whitespace only (no BOM), UTF-16 LE BOM-prefixed SVG, UTF-16 BE BOM-prefixed SVG, UTF-16 LE BOM-prefixed SVG with an XML prolog, non-SVG UTF-16 BE content is NOT flagged, and SVG behind a 2 KiB comment-padded XML prolog (window-extension test). Includes a negative regression test for a long XML prolog with `<root>` instead of `<svg>`. (`src/pixel.test.ts`)
- **Task 5 — 2 new headersSent-guard tests in `src/pixel.test.ts`:** plant an upstream middleware that calls `res.flushHeaders()` to flip `res.headersSent` to true, then force `sharp.toBuffer` to throw so the outer catch fires. The first test asserts the Express error handler receives the `Error("response already flushed")` signal; the second asserts `onError` fires with `phase: "fs"` and the same error message. (`src/pixel.test.ts`)

### Documentation

- **README — DNS rebinding mitigation documented in the SSRF Redirect Protection section.** New bullet explains the resolve-once-pin-the-IP approach, how each redirect hop independently re-pins, and the threat model (attacker-controlled authoritative DNS answering the validation lookup with a public IP and the connect-time lookup with a private IP). (`README.md`)
- **README — new "Error Handling" section** under Observability. Documents the always-fallback contract on the happy path and the `res.headersSent` escape hatch that routes to `next(err)` when bytes have already been flushed, so a future streaming refactor cannot silently leak `ERR_HTTP_HEADERS_SENT` failures. (`README.md`)

### Notes

- Minor bump (`2.5.0` → `2.6.0`): DNS pinning is a new internal behavior (axios now receives `httpAgent`/`httpsAgent` per request) but the public API surface is unchanged. Two new exported helpers (`resolvePinnedAddress`, `buildPinnedAgents`) — additive only. `looksLikeSvg` and the `res.headersSent` guard are internal hardening. Fully backward compatible. All `npm run build`, `npm test`, `npm run lint`, and `npm run type-check` pass.

## [2.5.0] - 2026-05-12

### Added

- **Re-exported public helpers from `src/index.ts` (Task 1).** Eight previously deep-only helpers are now first-class named exports of the package entry point: `buildFilename`, `buildSourceIdentifier`, `buildDeterministicEtag`, `isInsideRoot`, `looksLikeSvg` (from `./pixel`), plus `isPrivateIp`, `isPublicHost`, and `stripApiPrefix` (from `./functions`). Consumers can now `import { isPublicHost } from "pixel-serve-server"` directly under both ESM and CJS without reaching into the (undeclared) deep `dist/pixel.mjs` path. The compiled `dist/index.d.ts` advertises all eight new declarations and the existing `registerServe`, `isValidPath`, `optionsSchema`, and `userDataSchema` surface. (`src/index.ts`)
- **Top-level imports in `src/pixel.test.ts` (Task 1).** Replaced six `await import("./pixel")` calls (for `looksLikeSvg`, `isInsideRoot`, `buildSourceIdentifier`, and `buildFilename`) with static `import` statements at the top of the file. The test surface now exercises the exact public-import shape consumers will use. (`src/pixel.test.ts`)

### Changed

- **`allowedNetworkList` is now normalised at schema-parse time (Task 2).** The Zod `optionsSchema` for `allowedNetworkList` now applies `.transform((arr) => arr.map((host) => host.trim().toLowerCase()))` before defaulting. The WHATWG URL parser always lowercases `url.hostname`, so an operator who configured `allowedNetworkList: ["CDN.Example.com"]` previously had their allowlist silently never match. Entries with surrounding whitespace (common in env-file-supplied hosts) are also trimmed. The runtime `isHostAllowed` check remains a flat `Array.includes` — only the input side changed. Backward compatible: already-lowercased entries are unaffected. (`src/schema.ts`)
- **README documents the case-insensitive contract.** The options table row for `allowedNetworkList` now spells out the trim + lowercase normalisation rule, and the Network Image Security section calls out that the contract is enforced at schema-parse time regardless of how the option was supplied. (`README.md`)

### Tests

- **Regression test for case-insensitive `allowedNetworkList` matching (Task 2).** New `describe("allowedNetworkList case-insensitive matching (Task 2)")` block in `src/functions.test.ts` asserts (1) `optionsSchema.parse({ allowedNetworkList: ["CDN.Example.com", "  Images.Test  "] })` returns `["cdn.example.com", "images.test"]`, and (2) the normalised array drives a successful `fetchImage` against a `https://cdn.example.com/x.jpg` URL whose hostname is already lowercased by the URL parser. Without the schema transform the request silently falls back to the placeholder image. (`src/functions.test.ts`)

### Notes

- Minor bump (`2.4.2` → `2.5.0`): the eight new named exports from `index.ts` are additive — every prior import path continues to resolve to the same value. `allowedNetworkList` normalisation is also backward compatible (already-lowercased entries are unchanged). All `npm run build`, `npm test`, `npm run lint`, and `npm run type-check` pass.

## [2.4.2] - 2026-05-12

### Documentation

- **`maxDownloadBytes` scope clarified (Task 26).** The options table now states that the limit applies to **both network fetches and local filesystem reads** — local files are stat-checked before `fs.readFile` is invoked, so an oversized image on disk falls back the same way an oversized remote response does. The inline comment in the Advanced Setup example was updated to match. (`README.md`)
- **Advanced Setup example backfilled (Task 26).** Added inline examples (with explanatory comments) for `getUserFolderRootDir`, `idHandlerTimeoutMs`, `maxRedirects`, `maxInputPixels`, `allowSvgInput`, and `onError` so every option that exists in the table also appears in runnable code. Clarified that `getUserFolder` returns `string | Promise<string>` (no `null`) so empty-string is the documented way to keep `baseDir`. (`README.md`)
- **ESM vs CJS `__dirname` note (Task 32).** Added a callout under the Basic Setup example showing that `__dirname` is a built-in only in CommonJS; in ESM it must be derived from `import.meta.url` via `fileURLToPath` + `dirname`. Both code styles are shown side-by-side. (`README.md`)
- **Performance section added (Task 29).** New "Performance" section documents the per-request memory footprint (`~= source_buffer_size + processed_buffer_size + transient_etag_buffer`), explains that Sharp's decode → rotate → resize → re-encode pipeline is CPU-bound, and lists the three primary cost-mitigation levers: aggressive `cacheControl`, a CDN in front of the middleware, and the deterministic ETag short-circuit that returns `304 Not Modified` before any Sharp work runs when `If-None-Match` matches. Notes that streaming Sharp's output to `res` is currently out of scope because the deterministic ETag is the preferred cacheability lever. (`README.md`)

### Notes

- Patch bump (`2.4.1` → `2.4.2`): documentation-only changes. No runtime API changes. All `npm run build`, `npm test`, `npm run lint`, and `npm run type-check` pass.

## [2.4.1] - 2026-05-12

### Tests

- **Added behavioral coverage for previously untested input edge cases (Task 14).** Five new pixel.test.ts integration tests under the `input edge cases (Task 14)` describe block: src exceeding 4096 characters (verifies graceful fallback + `phase: "fs"` onError ping), src containing complex query strings + fragments (verifies `buildFilename` strips both before deriving the basename), non-ASCII unicode src (Arabic + CJK, verifies RFC 5987 `filename*=UTF-8''…` encoding round-trips), `getUserFolder` returning a path outside `baseDir` when `getUserFolderRootDir` is unset (confirms the framework does not block proactively but a subsequent `isValidPath` failure fires `phase: "fs"`), and Sharp encountering a deliberately truncated PNG buffer (verifies the `failOn: "warning"` policy bails to fallback with `phase: "sharp"`). (`src/pixel.test.ts`)
- **Added six new functions.test.ts tests under `fetchImage edge cases (Task 14)`:** redirect chain hitting exactly `maxRedirects` (boundary check, 1 initial + N follows), `Number.MAX_SAFE_INTEGER` as `maxBytes` (verifies no overflow in the size guard comparison), negative `maxBytes` (documents that any size > -1 trips the guard and returns fallback), `javascript:` URL rejection at the protocol guard (no axios call made), malformed bracketed-IPv6 URL `http://[not-an-ipv6` (catches `new URL(...)` throw in the outer try), and empty-hostname URL `http:///just-a-path` (caught by the same outer try). (`src/functions.test.ts`)
- **Added two new schema.test.ts tests under `apiRegex performance (Task 14)`:** confirms `optionsSchema.parse` stores the user-supplied regex without executing it (pathological `/^(a+)+\/$/` parses in <50ms), and validates that the schema never feeds a giant input to the regex during parse (50k-character closure reference present but the regex is never run). Pins the ReDoS-safe schema contract. (`src/schema.test.ts`)
- **Added six new renders.test.ts tests under `quality propagation outside defaultQuality (Task 14)`:** schema rejects `quality=150` before render-time clamping ever runs, rejects `quality=0` / negative, accepts the boundary values `1` and `100` verbatim, and documents that the `bounds.defaultQuality` field is a SECOND-tier fallback (the schema default of 80 fires first when caller omits quality). (`src/renders.test.ts`)

### Changed

- **Coverage threshold raised (Task 31).** `vitest.config.ts` `branches` threshold lifted from `85` to `90` after the Task 14 additions pushed actual aggregate branch coverage to 92.74%. Lines / functions / statements thresholds unchanged at 95. (`vitest.config.ts`)

### Notes

- Patch bump (`2.4.0` → `2.4.1`): test-only changes plus the coverage-threshold tightening. No runtime API changes. All `npm run build`, `npm test`, `npm run lint`, and `npm run type-check` pass.

## [2.4.0] - 2026-05-12

### Added

- **`apiPrefix` option for literal-string prefix stripping (Task 15).** New optional `PixelServeOptions.apiPrefix?: string` provides a ReDoS-free alternative to `apiRegex`. When set, internal URL pathnames are stripped with `pathname.startsWith(apiPrefix) ? pathname.slice(apiPrefix.length) : pathname` — a plain string check with no regex evaluation. `apiPrefix` **takes precedence over `apiRegex`** when both are supplied, so a misconfigured custom regex cannot reach the request path. Backward compatible: defaults to `undefined` and existing `apiRegex` consumers see no change. (`src/types.ts`, `src/schema.ts`, `src/functions.ts`, `src/pixel.ts`)
- **Exported helper `stripApiPrefix`.** Surfaced from `src/functions.ts` so consumers can unit-test the precedence + prefix-matching logic without spinning up Express. (`src/functions.ts`)

### Changed

- **`src` schema relaxation (Task 13).** `userDataSchema.src` no longer carries a `.min(1)` constraint or a `.default("/placeholder/noimage.jpg")`. The schema accepts `""` and `undefined` without throwing; `pixel.ts` handles the empty/missing case via its existing `if (!userData.src)` branch, so the fallback path is now reached from a single well-defined call site instead of from a schema rejection landing in the outer catch. The new behavior is observable via the `onError` hook: empty / missing `src` requests no longer fire `phase: "validation"` events. Existing callers that rely on the request returning a fallback image continue to work — only the *reason* (and the absence of an `onError` ping) changes. (`src/schema.ts`)

### Documentation

- **ReDoS warning on `apiRegex`.** Documented in both the JSDoc on `PixelServeOptions.apiRegex` and the new "API Prefix and ReDoS Safety" README section that `apiRegex` is a user-supplied `RegExp` evaluated against client-controlled `url.pathname` values, and that vulnerable patterns (nested quantifiers, ambiguous alternation) enable catastrophic-backtracking denial of service. The default `/^\/api\/v1\//` is anchored and literal and is safe. Recommended `apiPrefix` for consumers who only need to strip a literal prefix. (`src/types.ts`, `README.md`)
- **`apiPrefix` documented** alongside `apiRegex` in the options table, the Advanced Setup code example, and the new dedicated section. (`README.md`)

### Security / Dependencies

- **`npm audit fix` applied (Task 30).** Resolved high-severity advisories in transitive dependencies of `pixel-serve-server`: `axios` (16 advisories — SSRF, prototype-pollution, CRLF injection, no_proxy bypass, etc.), `follow-redirects` (cross-domain header leak), `path-to-regexp` (ReDoS via sequential optional groups and multi-wildcards), `qs` (arrayLimit bypass DoS). All four packages updated to non-vulnerable versions via `npm audit fix`. The same `path-to-regexp` and `qs` advisories were also resolved in `pixel-serve-test/server` via the same command. `pixel-serve-client` and `pixel-serve-test/client` had zero advisories. (`package-lock.json`)

### Tests

- Added 3 new schema tests in `src/schema.test.ts` covering Task 13 src optionality: schema accepts `src = ""` without throwing, schema accepts `src = undefined` without throwing, schema accepts a totally absent src key without throwing. Updated 1 existing test that asserted the old `/placeholder/noimage.jpg` default.
- Added 1 updated assertion in `src/renders.test.ts` reflecting that `renderUserData({})` now leaves `src` undefined.
- Added 2 new pixel.test.ts integration tests that confirm the empty-src fallback path fires from `pixel.ts` (NOT from schema rejection), verified by asserting the `onError` hook does **not** receive a `phase: "validation"` or `phase: "schema"` event for `src=""` and totally-absent-`src` requests.
- Added 5 new schema tests in `src/schema.test.ts` covering Task 15 `apiPrefix` defaults / validation: undefined-by-default backward compat, literal string accepted, empty string rejected, non-string rejected, coexists with custom `apiRegex`.
- Added 5 new `stripApiPrefix` unit tests in `src/functions.test.ts` covering matching / non-matching prefixes, fallback to `apiRegex` when `apiPrefix` is undefined, precedence assertion (apiPrefix beats apiRegex), and empty-pathname edge case.
- Added 2 new ReDoS resistance tests for the default `apiRegex`: pathological 50,000-character near-match input completes in <100ms; 1,000,000-character non-matching input completes in <100ms. Catches future regressions if someone changes the default to a backtracking pattern.
- Added 3 new fetchImage integration tests covering `apiPrefix` strip, precedence over `apiRegex`, and fallback to `apiRegex` when `apiPrefix` is unset.

### Notes

- Minor bump (`2.3.0` → `2.4.0`): additive `apiPrefix` option + new exported helper + new exported test surface. Backward compatible — `apiPrefix` defaults to `undefined`, the `src` schema relaxation only changes *which* code path serves the fallback (the response stays a valid image), and all dependency updates landed via `npm audit fix` without `--force`.

## [2.3.0] - 2026-05-12

### Added

- **`getUserFolderRootDir` containment option.** New optional `PixelServeOptions.getUserFolderRootDir?: string`. When set, the framework validates that the path returned by `getUserFolder` resolves (via `fs.realpath` + `path.relative`) to a descendant of the configured root. Paths that escape (e.g., the user-supplied callback joined a malicious `userId` to `path.join(PRIVATE_DIR, "../etc")`, or a symlink redirects outside the tree) are treated as a `getUserFolder` failure: `onError` fires with `phase: "getUserFolder"` and the request falls back to the public `baseDir`. When the option is unset, the framework preserves the prior behavior — the caller is fully responsible for sanitizing `userId` inside their own `getUserFolder` implementation. (`src/types.ts`, `src/schema.ts`, `src/pixel.ts`)
- **Exported helper `isInsideRoot`.** Surfaced from `src/pixel.ts` so consumers can unit-test their own containment logic and reuse the realpath + relative containment check outside the middleware. (`src/pixel.ts`)

### Security / Robustness

- **`isValidPath` hardening (Task 8).** The path validator now (1) rejects `\x7F` (DEL) alongside the existing `\x00`–`\x1F` control characters, fixing a silent inconsistency with the `Content-Disposition` sanitizer which already stripped DEL; (2) rejects backslash unconditionally on every platform so cross-platform behavior cannot diverge — on POSIX `\\` is a legal filename byte, on Windows it is a separator usable for traversal; (3) caps `specifiedPath` to 4096 characters before issuing any `fs.realpath` syscall to prevent pathological large allocations; (4) requires the resolved path to be a regular file (rejects directories) so attackers cannot reference the root of `baseDir` to short-circuit fallback logic. The TOCTOU caveat between `realpath` and the subsequent `fs.readFile` is now documented explicitly in JSDoc. (`src/functions.ts`)
- **Schema-level rejection of `?src[]=…` arrays (Task 25).** The `userDataSchema.src` preprocess now explicitly rejects non-string, non-undefined values (arrays, objects, numbers, booleans) with a clear `src must be a string (received <type>)` message instead of relying on the default Zod "expected string" error. Express parses `?src[]=a&src[]=b` into an array; previously such requests still produced a `ZodError` but with a less actionable shape. The new behavior keeps the existing fallback contract — the outer pipeline catch still serves a fallback image — while surfacing a meaningful `onError` payload under `phase: "validation"`. (`src/schema.ts`)

### Changed

- **Cast cleanup in `pixel.ts` (Task 25).** Removed unsafe `as Partial<UserData>` cast on `req.query` — the Zod schema now consumes `unknown` directly and handles the loose Express `ParsedQs` shape. Removed `as ImageType` and `as ImageFormat` casts everywhere the schema already produces the correct narrowed type. Introduced `RenderedUserData` (a refinement of `ParsedUserData`) so `renderUserData()` returns a `format: ImageFormat` and `quality: number` without callers needing to re-narrow. Runtime behavior is unchanged. (`src/pixel.ts`, `src/renders.ts`, `src/schema.ts`)

### Tests

- Added 7 new `isValidPath` edge-case tests in `src/functions.test.ts`: UNC-style backslash prefixes, single-backslash anywhere in the path, `\x7F` DEL, redundant forward slashes, paths that resolve to a directory (file vs. directory containment), > 4096-character pathological paths, leading whitespace + tab, and trailing-slash directory references (platform-tolerant assertion).
- Added 7 new `getUserFolderRootDir` containment tests in `src/pixel.test.ts`: paths inside the root are allowed, `../etc`-style escapes fall back to public `baseDir` with a `getUserFolder` `onError`, symlinks that point outside the root fall back, backward-compat behavior when the option is unset, and direct unit coverage for the exported `isInsideRoot` helper (root equals candidate, descendant, siblings, non-existent paths, empty arguments).
- Added 5 new schema tests in `src/schema.test.ts` covering `getUserFolderRootDir` defaults / validation and src-array / src-object / src-number / src-boolean / src-null rejection paths.
- Added 2 new `pixel.test.ts` integration tests covering `?src[]=…` array and `?src[key]=…` nested-object request shapes — both produce a fallback image, both fire `onError` with `phase: "validation"`.

### Documentation

- Documented `getUserFolderRootDir` in the options table and the Private Folder Access section of the README. Updated the `getUserFolder` example to recommend opt-in containment and clarified that the framework cannot enforce containment without the new option. The example also dropped the misleading `return null` (the type signature only accepts `string | Promise<string>` — empty strings keep the public `baseDir`). (`README.md`)

### Notes

- Minor bump (`2.2.0` → `2.3.0`): additive option + new exported helper. Backward compatible — `getUserFolderRootDir` defaults to `undefined`, all cast-cleanup changes are runtime no-ops, and existing tests continue to pass without modification.

## [2.2.0] - 2026-05-12

### Added

- **Deterministic ETag (pre-Sharp short-circuit).** ETags are now built from a stable cache key (`src`, `width`, `height`, `format`, `quality`, `type`, `folder`, post-`idHandler` `userId`) plus a source identifier (`mtimeMs:size` for local files, the resolved URL for remote sources) **before** Sharp is invoked. An `If-None-Match` request that hits a known ETag now returns `304 Not Modified` without ever decoding, resizing, or re-encoding the image. Falls back to the historical buffer-hash ETag only when no deterministic source identifier is available (e.g., missing file paths that resolve to a placeholder image). (`src/pixel.ts`)
- **RFC 5987 / RFC 6266 `Content-Disposition`.** Responses now emit **both** an ASCII-safe quoted `filename=` parameter and a percent-encoded `filename*=UTF-8''<encoded>` parameter so unicode filenames (Arabic, CJK, etc.) round-trip cleanly through clients and proxies. Query strings and URL fragments are stripped before deriving the basename, only-punctuation basenames fall back to `image`, and very long names are truncated so the response header stays bounded under ~200 bytes. (`src/pixel.ts`)
- **`Vary: Accept-Encoding` header.** Added to both successful and fallback responses for downstream-cache correctness. (`src/pixel.ts`)
- **`onError` observability hook.** New `PixelServeOptions.onError?: (err, { phase, src?, userId? }) => void` callback fired at every catch site in the request pipeline. Phases include `"sharp"`, `"fetch"`, `"fs"`, `"idHandler"`, `"getUserFolder"`, `"schema"`, and `"validation"`; the `phase` field is typed as a string so new identifiers can be introduced without a breaking change. The hook is best-effort — throws from the hook are swallowed so a buggy logger cannot crash the request. (`src/types.ts`, `src/schema.ts`, `src/pixel.ts`, `src/functions.ts`)
- **Exported helpers `buildFilename`, `buildDeterministicEtag`, `buildSourceIdentifier`.** Internal utilities surfaced as exports from `src/pixel.ts` so users can pre-compute ETags on the client (e.g., for warm-cache priming) and unit-test their own filename derivation logic without spinning up Express. (`src/pixel.ts`)

### Changed

- `idHandler` failures (synchronous throws, async rejections, non-string returns, and timeouts) now also fire the `onError` hook with `phase: "idHandler"` before falling back to the raw `userId`. (`src/pixel.ts`)
- `getUserFolder` invocation is wrapped in `Promise.resolve().then(...)` so synchronous throws are routed through the same timeout race + `onError` hook as async rejections. Previously, a synchronous throw escaped the inner try/catch and was only caught by the outer middleware-level handler. (`src/pixel.ts`)
- Network fetch failures (DNS-resolves-to-private-IP, host-not-in-allowlist, non-2xx status, disallowed content-type, redirect-without-Location, redirect-loop exhaustion, non-http(s) protocol) now feed into the `onError` hook with `phase: "fetch"`. (`src/functions.ts`)
- Local filesystem errors (invalid path, oversized file, `fs.readFile` failures) now feed into the `onError` hook with `phase: "fs"`. (`src/functions.ts`)

### Tests

- Added 7 deterministic-ETag tests in `src/pixel.test.ts`: pre-computed `If-None-Match` returns 304 without invoking Sharp (verified via `vi.spyOn(sharp.prototype, "toBuffer")`), first-request-then-If-None-Match round-trip, ETag sensitivity to width/height/quality/format, file-mtime invalidation, `buildSourceIdentifier` URL/local/missing branches, and buffer-hash fallback when no deterministic source identifier is available.
- Added 8 Content-Disposition / filename tests: Arabic (`صورة.jpg`) and CJK (`图片.png`) unicode round-trip via `filename*=`, query-string + fragment stripping (`http://example.com/img.jpg?v=2#frag`), only-punctuation basenames, 2000-character source caps, `Vary: Accept-Encoding` on both happy and fallback paths, and a direct `buildFilename` unit suite.
- Added 13 `onError` hook tests in `src/pixel.test.ts` covering every documented phase (`sharp`, `fetch`, `fs`, `idHandler`, `getUserFolder`, `schema`, `validation`), the throw-swallowing contract, the no-error happy-path silence guarantee, and the synchronous-throw routing for `getUserFolder`. Two extra tests in `src/functions.test.ts` cover the network-redirect `safeOnError` paths (malformed `Location`, protocol-switch redirects).
- Updated the two existing Content-Disposition assertions to match the new RFC 5987 dual-parameter format.

### Documentation

- Documented `onError`, the deterministic ETag short-circuit, the new RFC 5987 / RFC 6266 `Content-Disposition` shape, and the `Vary: Accept-Encoding` header. (`README.md`)

### Notes

- Minor bump (`2.1.0` → `2.2.0`): additive options + new observability surface. Backward compatible — existing consumers automatically benefit from the deterministic ETag short-circuit and the RFC-correct filename header without any configuration change. `onError` is optional.

## [2.1.0] - 2026-05-12

### Added

- **`type-check` npm script.** Added `"type-check": "tsc --noEmit"` so the documented pre-completion checklist can be honored. `tsup` strips types with esbuild and does not type-check; this script wires the existing `tsconfig.json` (`noEmit: true`) into a first-class verification step. (`package.json`)
- **Async `idHandler` support.** `PixelServeOptions.idHandler` may now return either `string` or `Promise<string>`. Async handlers are awaited under a per-call timeout. The public type widened from `(id: string) => string` to `(id: string) => string | Promise<string>`; the change is additive — existing sync handlers continue to work without modification. (`src/types.ts`, `src/schema.ts`)
- **`idHandlerTimeoutMs` option.** New optional `PixelServeOptions.idHandlerTimeoutMs` (positive integer, defaults to `requestTimeoutMs`) caps how long the framework will await an async `idHandler` before falling back to the raw `userId`. (`src/types.ts`, `src/schema.ts`, `src/pixel.ts`)

### Security / Robustness

- **`idHandler` error protection.** `idHandler` invocations are now wrapped in try/catch and bounded by a timeout race. Synchronous throws, async rejections, non-string return values (e.g., a number or `undefined` slipping past the typed signature), and slow promises that exceed `idHandlerTimeoutMs` all fall back to the raw `userData.userId` instead of crashing the request or producing `"[object Promise]"` as the user identifier downstream. The `getUserFolder` callback always receives a `string | undefined`. (`src/pixel.ts`)

### Tests

- Added 6 new `idHandler` tests in `src/pixel.test.ts` covering synchronous throws, non-string returns, async resolution, async rejection, slow promise + `idHandlerTimeoutMs` timeout, and the `requestTimeoutMs` fallback when `idHandlerTimeoutMs` is unset. Each verifies the downstream `getUserFolder` receives the expected `userId` and the response still resolves with a valid image. (`src/pixel.test.ts`)
- Added an EXIF auto-orient integration test that builds a portrait JPEG, re-encodes it with `orientation=6` ("rotate 90 CW"), runs it through the middleware with a 100x100 square resize, and asserts the output reads as 100x100 with the orientation tag stripped — confirming `.rotate()` runs before `.resize()` so the cover crop operates on the post-rotated raster. (`src/pixel.test.ts`)

### Notes

- Minor bump (2.0.0 → 2.1.0): additive features (async `idHandler`, `idHandlerTimeoutMs`, `type-check` script) and a hardened error path. No breaking changes; existing sync handlers and configurations continue to work unchanged.

## [2.0.0] - 2026-05-12

### Breaking Changes

- **SVG removed from supported output formats.** Sharp/libvips does not support SVG encoding; previously any `format=svg` request silently fell back. The format is now explicitly excluded from the `ImageFormat` union, dropped from `allowedFormats`, and `mimeTypes` no longer maps `svg`. Consumers sending `format=svg` will receive the default `jpeg` output instead. (`src/types.ts`, `src/variables.ts`, `src/pixel.ts`, `src/renders.ts`, `README.md`)

### Security

- **SSRF mitigation for HTTP redirects (Critical).** `fetchFromNetwork` previously let axios auto-follow up to five redirects with no per-hop validation. An allowed host could redirect to private/loopback/link-local addresses such as the AWS IMDS endpoint (`169.254.169.254`), internal Redis (`127.0.0.1:6379`), or any RFC1918 range. The implementation now sets `maxRedirects: 0` on axios and runs a manual redirect loop (default budget: 3 hops, capped at 10). Every hop re-checks the protocol, the `allowedNetworkList`, and a DNS-based public-IP guard. (`src/functions.ts`)
- **Public-host helpers.** Added `isPrivateIp(ip)` and `isPublicHost(hostname)`. `isPrivateIp` rejects RFC1918, loopback, link-local (incl. IPv6 `fe80::/10`), unique-local (`fc00::/7`), multicast (`ff00::/8`), `0.0.0.0`, IPv4-mapped private IPv6, and invalid addresses. `isPublicHost` short-circuits for IP literals and otherwise resolves the hostname via `dns.lookup({ all: true })` and rejects when any returned address is private. (`src/functions.ts`)
- **New `maxRedirects` option** in `PixelServeOptions` (default `3`, range `0..10`). Backward compatible. (`src/types.ts`, `src/schema.ts`)
- **Decompression-bomb protection for Sharp (Critical).** Sharp was instantiated with only `failOn: "truncated"` and no `limitInputPixels`. A small encoded payload could decompress to billions of pixels and OOM the worker. Sharp is now constructed with `{ failOn: "warning", limitInputPixels, sequentialRead: true, unlimited: false }`, and the pipeline peeks `image.metadata()` before any heavy decode, bailing when `width * height > maxInputPixels`. (`src/pixel.ts`)
- **SVG input rejection.** Added a magic-byte SVG sniffer (`looksLikeSvg`) that flags buffers starting with `<svg`, `<?xml ... <svg`, a UTF-8 BOM + `<svg`, or `<!-- ... <svg`. When `allowSvgInput` is false (the default), SVG inputs are rejected before reaching libvips/librsvg, preventing XML-bomb / billion-laughs / nested-`<use>` attacks. (`src/pixel.ts`)
- **New `maxInputPixels` option** in `PixelServeOptions` (default `16_000 * 16_000` = 256 megapixels). (`src/types.ts`, `src/schema.ts`)
- **New `allowSvgInput` option** in `PixelServeOptions` (default `false`). (`src/types.ts`, `src/schema.ts`)

### Tests

- Added 16 new SSRF tests in `src/functions.test.ts` covering private IP detection (IPv4 + IPv6, link-local, unique-local, multicast, IPv4-mapped), DNS-based public-host validation, redirect chain length limits, redirects to private IPs, redirects to AWS IMDS, redirects to unlisted hosts, malformed `Location` headers, missing `Location`, protocol-switch redirects, axios error responses with attached `response`, and the `validateStatus` closure. (`src/functions.test.ts`)
- Added Sharp pixel-bomb / SVG-input tests in `src/pixel.test.ts` covering: SVG buffer rejection (magic-byte + Sharp `metadata.format`), `maxInputPixels` short-circuit, `looksLikeSvg` across all input shapes (BOM-prefixed, comment-prefixed, XML-prolog, empty, null), schema-level `format=svg` rejection, and `allowSvgInput=true` opt-in. (`src/pixel.test.ts`)
- Added schema tests for the new options' defaults, overrides, and validation bounds. (`src/schema.test.ts`)
- Updated `src/variables.test.ts` and `src/renders.test.ts` to reflect the SVG removal and to assert it explicitly.

### Documentation

- Documented the new `maxRedirects`, `maxInputPixels`, and `allowSvgInput` options in the `PixelServeOptions` table. (`README.md`)
- Added "SSRF Redirect Protection", "Decompression-Bomb Protection", and "SVG Input Rejection" subsections under "Security Features", describing the manual per-hop revalidation, Sharp pixel-bomb guard, and SVG magic-byte sniffer. (`README.md`)

### Internal

- Tightened `isPrivateIp` IPv6 handling: malformed IPv4-mapped IPv6 literals (e.g. `::ffff:0.0.0`) are now treated as unsafe instead of falling through, and removed the redundant `lower.startsWith("fe8"/...)` fallback chain that duplicated the link-local regex. (`src/functions.ts`)
- Tightened typing of the `dns.lookup` test mocks so `tsc --noEmit` is clean: replaced misplaced `@ts-expect-error` directives with a typed `setDnsLookup` helper. (`src/functions.test.ts`, `src/pixel.test.ts`)

### Notes

- Bumped to `2.0.0` to flag the breaking SVG-output removal.
- New options default to safe values, so existing consumers automatically receive the SSRF and decompression-bomb mitigations without any configuration change.
- **Migration guide:** see [`MIGRATION.md`](./MIGRATION.md) for the full 1.x → 2.x upgrade walkthrough with before/after snippets covering the SVG output removal, the relaxed `userDataSchema.src` contract, and the new security defaults (`maxRedirects`, `maxInputPixels`, `allowSvgInput`).

## [1.0.3] - 2026-02-22

### Fixed

- **Content-Disposition header injection** — Sanitized filenames in the `Content-Disposition` header by replacing quotes, backslashes, and control characters with underscores to prevent header malformation. (`src/pixel.ts`)
- **Loose HTTP protocol check** — Changed `src.startsWith("http")` to explicit `startsWith("http://") || startsWith("https://")` to prevent strings like `httpfoo` from being incorrectly treated as URLs. (`src/pixel.ts`)
- **Removed misleading coverage comment** — Removed `/* c8 ignore next */` from a catch block that is covered by existing tests. (`src/pixel.ts`)
- **Lint errors** — Fixed all pre-existing lint errors revealed after adding `typescript-eslint` dependency: added explicit return types, removed unused catch parameters, and added eslint-disable comments for intentional control character regexes. (`src/pixel.ts`, `src/functions.ts`, `src/renders.ts`, `src/pixel.test.ts`)

### Added

- **getUserFolder timeout protection** — Added `Promise.race` timeout wrapper around the `getUserFolder` callback using `requestTimeoutMs`, preventing hanging requests when the callback never resolves. (`src/pixel.ts`)
- **Missing `typescript-eslint` dependency** — Added the `typescript-eslint` package to devDependencies, fixing `npm run lint` which previously failed due to the missing import. (`package.json`)
- **New tests** — Added tests for Content-Disposition sanitization with special characters, getUserFolder timeout behavior, `httpfoo` edge case handling, and `http://`/`https://` blocked host verification. (`src/pixel.test.ts`)

## [1.0.2] - 2026-02-22

### Fixed

- **Removed duplicate ETag test** — Deleted duplicate "returns 304 when etag matches" test that was a copy of the earlier "returns 304 when ETag matches" test. (`src/pixel.test.ts`)

### Improved

- **Strengthened weak test assertions** — Replaced `result.length > 0` checks with proper fallback buffer comparison (`result.equals(fallback)`) in multiple tests across `pixel.test.ts` and `functions.test.ts` for more precise validation.
- **Strengthened dimension clamping test** — Added Sharp metadata verification to confirm output image dimensions do not exceed configured max bounds. (`src/pixel.test.ts`)

### Added

- **New pixel.test.ts tests** — Added 9 new tests: deterministic ETag generation, different ETag for different quality, Content-Disposition header verification, Content-Length matching body size, getUserFolder returning empty string, avatar fallback on processing error, custom cacheControl value, format-only processing without resize, and cross-format conversion. (`src/pixel.test.ts`)
- **New functions.test.ts tests** — Added 6 new tests: URL-encoded traversal path rejection, backslash traversal rejection, avatar fallback on directory read failure, uppercase content-type handling, content-type with multiple parameters, custom apiRegex for internal URLs, and maxBytes of 0 behavior. (`src/functions.test.ts`)

## [1.0.1] - 2026-02-22

### Fixed

- **Content-Type charset stripping** — MIME validation now strips charset and other parameters from the `Content-Type` header before comparison (e.g., `image/jpeg; charset=utf-8` is now correctly accepted). (`src/functions.ts`)
- **Internal host detection with ports** — Changed `url.host` to `url.hostname` for `websiteURL` comparison so internal URLs with explicit ports (e.g., `localhost:3001`) are correctly recognized. (`src/functions.ts`)
- **Fallback image type in error handler** — The outer catch block in `serveImage()` now uses the requested image type (`avatar` or `normal`) instead of always falling back to `normal`. (`src/pixel.ts`)
- **Local file size validation** — `readLocalImage()` now accepts an optional `maxBytes` parameter and checks file size via `fs.stat()` before reading, preventing potential DoS from oversized local files. (`src/functions.ts`, `src/pixel.ts`)

### Added

- **Schema dimension validation** — Added `.refine()` checks to `optionsSchema` ensuring `minWidth <= maxWidth` and `minHeight <= maxHeight`. (`src/schema.ts`)
- **Stricter websiteURL regex** — Tightened the `websiteURL` validation regex to reject invalid hostname patterns like leading/trailing dots or dashes. (`src/schema.ts`)
- **Flexible network allowlist matching** — `allowedNetworkList` now checks both `url.hostname` and `url.host`, supporting entries with or without ports. (`src/functions.ts`)
