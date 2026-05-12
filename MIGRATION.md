# Migrating from 1.x to 2.x

`pixel-serve-server` 2.0.0 is a security-driven major release. It removes one
output format that was never functional, relaxes the input schema in a way
that changes which code path serves the fallback, and adds several new
security-hardening options that default to safe values. Most consumers can
upgrade with **no code changes**, but the surprises that do exist are listed
below in priority order with before/after snippets.

If you skipped intermediate releases, see the full
[`CHANGELOG.md`](./CHANGELOG.md) for the complete history. The bullets below
cover everything that is *behaviorally* breaking between the 1.x line and
the 2.0.0 baseline; subsequent 2.x releases (2.1, 2.2, 2.3, 2.4, 2.5, 2.6,
2.7) are additive and backward-compatible.

---

## 1. SVG removed as an output format

**Why.** Sharp / libvips does not implement an SVG encoder. In 1.x, any
`?format=svg` request silently downgraded to the configured default
(JPEG) without diagnostic. The 2.0.0 schema makes the unsupported status
explicit.

**What changed.**

- `ImageFormat` no longer includes `"svg"`.
- `userDataSchema.format` no longer accepts `"svg"` and discards it during
  the schema's `.transform()` — the parsed value is `undefined`, which the
  pipeline then resolves to the default JPEG output.
- `allowedFormats` and `mimeTypes` no longer reference SVG.

**Observable effect.** Requests with `?format=svg` continue to return a
valid image, but the response Content-Type is `image/jpeg` (the default
format), not `image/svg+xml`. **There is no clean error** — the schema
silently rejects the format value before the pipeline runs — so consumers
who relied on receiving SVG output will need to update their callers.

### Before (1.x)

```http
GET /api/v1/pixel/serve?src=/icons/logo.svg&format=svg
```

```http
HTTP/1.1 200 OK
Content-Type: image/jpeg          # was already JPEG; the silent downgrade
                                  # has been in place since 1.x
```

### After (2.x)

```http
GET /api/v1/pixel/serve?src=/icons/logo.svg&format=svg
```

```http
HTTP/1.1 200 OK
Content-Type: image/jpeg          # same shape, but now the schema explicitly
                                  # discards `format=svg` rather than relying
                                  # on a downstream codepath.
```

### Migration

If you need vector output, do one of the following:

- **Downgrade to 1.x.** The behavior was no different; the type system was
  just less honest.
- **Pre-render server-side.** Convert the SVG to PNG/WebP/AVIF at build
  time and store the raster source, then point `?src=` at it.
- **Serve the SVG directly without Pixel Serve.** Express's
  `express.static()` middleware will happily serve `.svg` files with the
  correct MIME type if you do not need format conversion.

```ts
// Bypass Pixel Serve for SVGs by mounting a static handler ahead of it:
app.use("/static/icons", express.static(path.join(__dirname, "icons")));
app.get("/api/v1/pixel/serve", registerServe({ baseDir }));
```

---

## 2. `userDataSchema.src` no longer defaults

**Why.** In 1.x the schema defaulted `src` to `/placeholder/noimage.jpg`,
which forced an empty request like `GET /api/v1/pixel/serve` down a
disk-read path against a hard-coded placeholder file. That coupling broke
two reasonable workflows: it produced a `ZodError` (and therefore an
`onError` event under `phase: "validation"`) when the placeholder file
was absent, and it prevented consumers from observing "src was missing"
distinctly from "src pointed at a missing file".

In 2.x the schema accepts `""`, `undefined`, and totally-absent `src`
keys without throwing. `pixel.ts` handles the empty case in a single
well-defined branch (`if (!userData.src)`) that serves the appropriate
fallback image based on the requested `type`.

**Observable effects.**

- A request with no `src` still returns a valid fallback image (response
  shape unchanged).
- The `onError` hook **no longer** fires `phase: "validation"` or
  `phase: "schema"` for the missing-`src` case. If your monitoring keyed
  off those events, you will see them disappear.
- The fallback image is the **bundled placeholder** for the requested
  `type`, not the file at `/placeholder/noimage.jpg` under your `baseDir`.

### Before (1.x)

```ts
// userDataSchema.src was effectively required (defaulted to a placeholder
// path); the pipeline always tried to read that file from disk.
const parsed = userDataSchema.parse({});
// parsed.src === "/placeholder/noimage.jpg"
```

```http
GET /api/v1/pixel/serve

# 1.x pipeline:
#   1. Schema defaults src to "/placeholder/noimage.jpg"
#   2. readLocalImage attempts disk read
#   3. If the file is missing → onError fires with phase: "fs"
#   4. Outer catch serves the bundled fallback
```

### After (2.x)

```ts
const parsed = userDataSchema.parse({});
// parsed.src === undefined
```

```http
GET /api/v1/pixel/serve

# 2.x pipeline:
#   1. Schema returns src === undefined (no throw)
#   2. `if (!userData.src)` branch serves the bundled fallback directly
#   3. No disk read, no onError event for the missing-src case
```

### Migration

- If your monitoring counted `phase: "validation"` events from missing-src
  requests, **remove that signal** — it is now silent on the happy path.
- If you had a `/placeholder/noimage.jpg` file under `baseDir` that was
  serving as your custom default placeholder, **move it into your own
  middleware** ahead of `registerServe`, or pass an explicit `src` value
  from the client.
- The `fallbackSrc` prop on `pixel-serve-client` is a per-request override
  if you want a custom placeholder image without touching the server.

```ts
// Restoring the 1.x "default to a placeholder" behavior at the client
// layer (recommended over re-introducing it on the server):
<Pixel src={userImage ?? "/placeholders/avatar.png"} type="avatar" />
```

---

## 3. New security defaults (no action required, but auditable)

These options were introduced in 2.0.0 and default to safe values. If you
relied on the absent-guard behavior in 1.x you will need to opt out
explicitly.

### `maxRedirects` (default `3`, range `0..10`)

In 1.x, axios followed up to 5 redirects automatically with no per-hop
validation, so an allowed host could redirect to a private IP (e.g., the
AWS IMDS endpoint). In 2.x, redirects are **never auto-followed**: a
manual loop revalidates the protocol, the `allowedNetworkList`, and the
public-IP DNS check on every hop, and the loop is capped by
`maxRedirects`.

```ts
registerServe({
  baseDir,
  maxRedirects: 5,   // restore the 1.x budget (still per-hop validated)
});
```

### `maxInputPixels` (default `16_000 * 16_000` = 256 MP)

In 1.x, Sharp was instantiated with only `failOn: "truncated"` and no
`limitInputPixels`, so a small encoded payload could decompress to
billions of pixels and OOM the worker. 2.x enforces a pixel budget via
Sharp plus a pre-decode `metadata()` check.

```ts
registerServe({
  baseDir,
  maxInputPixels: 64_000 * 64_000, // raise the cap if you serve very
                                   // large source images
});
```

### `allowSvgInput` (default `false`)

In 1.x, SVG **inputs** (different from SVG outputs above) were passed
through to libvips/librsvg with no special handling, exposing the
classic SVG attack surface (XML bombs, billion-laughs, nested `<use>`).
In 2.x, SVG inputs are detected via a magic-byte sniffer
(`looksLikeSvg`) and rejected before reaching libvips unless explicitly
allowed.

```ts
registerServe({
  baseDir,
  allowSvgInput: true,   // ONLY if the source pipeline is fully trusted
});
```

### `getUserFolderRootDir` (default `undefined`)

Introduced in 2.3.0 (still inside the 2.x line). When set, the framework
validates that the path returned by `getUserFolder` resolves inside this
directory and falls back to `baseDir` if it escapes. In 1.x and in
2.0.0–2.2.x this validation did not exist — the caller was fully
responsible for sanitizing `userId` inside their own callback.

Setting `getUserFolderRootDir` is a **defense-in-depth** add and is
recommended for any deployment that exposes `folder=private`. Leaving it
unset preserves the 1.x contract.

---

## 4. Output Content-Disposition is now RFC 5987

Added in 2.2.0 (inside the 2.x line). Responses now carry **both** an
ASCII-quoted `filename=` parameter and a percent-encoded
`filename*=UTF-8''<encoded>` parameter so unicode filenames (Arabic, CJK)
round-trip cleanly. The 1.x version only emitted the ASCII parameter.

**Migration.** None required — clients and proxies that supported the old
format continue to read `filename=`; clients that prefer
`filename*=UTF-8''…` now get clean unicode. If your downstream parser
was strict-mode and explicitly rejected the second parameter (rare), it
will need to be updated.

---

## 5. Newly exported helpers (additive)

Eight helpers that were previously deep-imported via `pixel-serve-server/dist/pixel.mjs`
(undeclared in `package.json#exports`) are now first-class named exports
from the package entry point:

```ts
import {
  // From pixel.ts:
  buildFilename,
  buildSourceIdentifier,
  buildDeterministicEtag,
  isInsideRoot,
  looksLikeSvg,
  // From functions.ts:
  isPrivateIp,
  isPublicHost,
  stripApiPrefix,
} from "pixel-serve-server";
```

If you had been deep-importing these helpers, update the import path to
the package root.

---

## 6. Observability surface

2.x introduces two optional hooks for APM integrations:

- `onError(err, { phase, src?, userId? })` — fired at every catch site
  in the pipeline. The pipeline always continues to serve a fallback
  image; the hook is purely for logs / metrics. Best-effort: throws are
  swallowed.
- `onComplete({ src?, userId?, format, outputBytes, cached, durationMs })` —
  fired after a successful 200 response or a 304 cached short-circuit.
  Use this to derive per-request latency, cache-hit ratios, and bytes-out
  without scraping HTTP access logs.

Both are optional and have no effect when not configured.

---

## 7. Engine pin: Node >= 20

2.7.1 raised the `engines.node` field from `>=18` to `>=20`. Node 18
reached end-of-life on 2025-04-30 and the toolchain (Sharp 0.34, Vitest
4) requires Node 20+. Running on Node 18 will now emit an
`EBADENGINE` warning during `npm install`. There is no soft-failure for
runtime behavior — Sharp itself will refuse to load on Node < 20.

---

## Quick Compatibility Matrix

| Concern                                      | 1.x                              | 2.x                                           |
| -------------------------------------------- | -------------------------------- | --------------------------------------------- |
| `?format=svg`                                | Silent downgrade to JPEG         | Schema discards, silent downgrade to JPEG     |
| Empty / missing `src`                        | Schema default to disk read      | `if (!src)` branch → bundled fallback         |
| Redirect budget                              | 5 (axios default), no validation | 3 (configurable), every hop revalidated       |
| Pixel budget                                 | Unbounded                        | 256 MP default                                |
| SVG input                                    | Allowed                          | Rejected by default                           |
| `getUserFolder` containment                  | Caller's responsibility          | Opt-in via `getUserFolderRootDir`             |
| `Content-Disposition` unicode filenames      | ASCII only                       | RFC 5987 dual-parameter                       |
| Observability                                | None                             | `onError`, `onComplete`                       |
| Minimum Node                                 | `>=18`                           | `>=20`                                        |
| Deep imports of helpers                      | Required                         | Replaced by top-level named exports           |

---

## Need help upgrading?

Open an issue at
[github.com/Hiprax/pixel-serve-server/issues](https://github.com/Hiprax/pixel-serve-server/issues)
with the 1.x → 2.x diff you are stuck on and the relevant snippet of your
`registerServe(...)` configuration.
