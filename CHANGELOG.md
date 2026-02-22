# Changelog

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
