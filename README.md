# Pixel Serve Server

**A modern, type-safe middleware** for processing, resizing, and serving images in Node.js applications. Built with **TypeScript**, powered by **Sharp**, and designed for secure production use with ESM & CJS bundles.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/pixel-serve-server)](https://www.npmjs.com/package/pixel-serve-server)
[![CI](https://github.com/Hiprax/pixel-serve-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Hiprax/pixel-serve-server/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Hiprax/pixel-serve-server/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Hiprax/pixel-serve-server/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/Hiprax/pixel-serve-server/branch/main/graph/badge.svg)](https://codecov.io/gh/Hiprax/pixel-serve-server)
[![Dependencies](https://img.shields.io/librariesio/release/npm/pixel-serve-server)](https://libraries.io/npm/pixel-serve-server)
[![npm provenance](https://img.shields.io/npm/sigstore/pixel-serve-server?label=provenance)](https://www.npmjs.com/package/pixel-serve-server)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0.3-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-blue.svg)](https://nodejs.org/)

## Features

- 🖼️ **Dynamic resizing & formatting**: `jpeg`, `png`, `webp`, `gif`, `tiff`, `avif` with configurable width/height bounds and quality limits (SVG is **not** supported as an output format — libvips/Sharp cannot encode SVG)
- 🌐 **Secure source resolution**: Strict path validation, domain allowlists, and MIME type checks for network fetches
- 🔒 **Fallbacks & private folders**: Built-in placeholder images plus async `getUserFolder` for private assets
- ⚡ **Caching ready**: ETag + Cache-Control headers out of the box
- 🧪 **Type-safe & tested**: 100% TypeScript with Vitest coverage and exported Zod schemas
- ♻️ **Dual builds**: Works in both ESM and CommonJS environments

## Installation

Requires **Node.js 20 or newer** (Node 18 reached end-of-life on 2025-04-30; the build/test toolchain — Sharp 0.34, Vitest 4, ESLint 10 — now requires Node 20+).

```bash
npm install pixel-serve-server
```

## Quick Start

### Basic Setup (Express)

```typescript
import express from "express";
import { registerServe } from "pixel-serve-server";
import path from "node:path";

const app = express();

const serveImage = registerServe({
  baseDir: path.join(__dirname, "../assets/images/public"),
});

app.get("/api/v1/pixel/serve", serveImage);

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
```

> **ESM vs CJS — `__dirname`.** The example above uses `__dirname`, which is a
> built-in only in **CommonJS** (`"type": "commonjs"` in `package.json`, or no
> `type` field). In **ECMAScript Modules** (`"type": "module"` or `.mjs` files)
> `__dirname` does **not** exist and the example will throw `ReferenceError:
> __dirname is not defined`. Derive it from `import.meta.url` instead:
>
> ```ts
> // CJS — works out of the box, no extra code needed:
> // __dirname is a built-in module-scoped variable.
>
> // ESM — derive it from import.meta.url:
> import { fileURLToPath } from "node:url";
> import { dirname } from "node:path";
> const __dirname = dirname(fileURLToPath(import.meta.url));
> ```
>
> Both forms produce the same string. Place the ESM derivation at the top of
> the entry file (before the `path.join(__dirname, …)` call).

### Advanced Setup with All Options

```typescript
import express from "express";
import { registerServe } from "pixel-serve-server";
import path from "node:path";

const app = express();

const serveImage = registerServe({
  // Required: Base directory for public images
  baseDir: path.join(__dirname, "../assets/images/public"),

  // Custom user ID handler
  idHandler: (id: string) => `user-${id}`,

  // Async function to resolve private folder paths.
  // Returning an empty string (`""`) keeps the public `baseDir` — the type
  // signature is `string | Promise<string>` (no `null`).
  getUserFolder: async (req, userId) => {
    // Your logic to resolve user-specific folder
    return `/private/users/${userId}`;
  },

  // Optional containment root. When set, the framework verifies that the
  // path returned by `getUserFolder` resolves inside this directory and
  // falls back to `baseDir` if it escapes (defense-in-depth realpath check).
  getUserFolderRootDir: "/private/users",

  // Your website's base URL (for treating internal URLs as local)
  websiteURL: "example.com",

  // Literal-string prefix stripped from internal URL pathnames. When set,
  // it takes precedence over `apiRegex` and uses a plain startsWith + slice
  // (recommended — see "API Prefix and ReDoS Safety" below).
  apiPrefix: "/api/v1/",

  // Regex stripped from internal URL pathnames (ignored when `apiPrefix` is
  // set). Must be a safe (non-ReDoS) regex.
  apiRegex: /^\/api\/v1\//,

  // Allowed remote hosts for fetching network images
  allowedNetworkList: ["cdn.example.com", "images.example.com"],

  // Custom Cache-Control header
  cacheControl: "public, max-age=86400, stale-while-revalidate=604800",

  // Enable/disable ETag generation
  etag: true,

  // Image dimension bounds
  minWidth: 50,
  maxWidth: 4000,
  minHeight: 50,
  maxHeight: 4000,

  // Default JPEG/WebP/AVIF quality
  defaultQuality: 80,

  // Network fetch timeout (ms)
  requestTimeoutMs: 5000,

  // Optional timeout (ms) applied when awaiting an async `idHandler`.
  // Defaults to `requestTimeoutMs` when unset.
  idHandlerTimeoutMs: 2000,

  // Maximum image size in bytes — applies to both network fetches AND
  // local filesystem reads (oversized local files fall back the same way
  // oversized remote responses do).
  maxDownloadBytes: 5_000_000,

  // Max HTTP redirects to follow during network fetches. Each hop is
  // re-validated against `allowedNetworkList`, the http/https protocol
  // guard, and the public-IP DNS check (SSRF protection). Range 0..10.
  maxRedirects: 3,

  // Max input pixels enforced by Sharp. Defaults to 256 megapixels.
  // Protects against decompression bombs (small encoded payload that
  // decompresses to billions of pixels).
  maxInputPixels: 16_000 * 16_000,

  // Reject SVG inputs by default. SVG decoding has historically been a
  // vector for XML-bomb / billion-laughs / nested `<use>` exploits.
  allowSvgInput: false,

  // Optional observability hook fired at every catch site. The framework
  // always continues to serve a fallback image — the hook is purely for
  // logs / metrics / APM. Throws from the hook are swallowed.
  onError: (err, ctx) => {
    // ctx: { phase: "sharp" | "fetch" | "fs" | "idHandler"
    //       | "getUserFolder" | "schema" | "validation" | string,
    //        src?: string, userId?: string }
    console.warn("pixel-serve error", ctx.phase, err);
  },

  // Optional observability hook fired after a successful response (200)
  // and after the 304 cached short-circuit. Use this to ship per-request
  // latency metrics or count cache-hit ratios. Throws are swallowed.
  onComplete: (ctx) => {
    // ctx: { src?: string, userId?: string, format: ImageFormat,
    //        outputBytes: number, cached: boolean, durationMs: number }
    console.log("pixel-serve completed", ctx.format, ctx.durationMs, "ms",
      ctx.cached ? "(304 cached)" : `${ctx.outputBytes} bytes`);
  },
});

app.get("/api/v1/pixel/serve", serveImage);

app.listen(3000);
```

## Configuration Options

| Option               | Type                                      | Default            | Description                                                             |
| -------------------- | ----------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `baseDir`            | `string`                                  | **required**       | Base directory for local images                                         |
| `idHandler`          | `(id: string) => string \| Promise<string>` | `id => id`       | Transform user IDs before lookup. May be sync or async. Throws, rejections, non-string returns, and slow promises that exceed `idHandlerTimeoutMs` are caught — the request falls back to the raw `userId` instead of failing. |
| `getUserFolder`      | `(req, id?) => string \| Promise<string>` | `undefined`        | Resolve private folder path when `folder=private`                       |
| `getUserFolderRootDir` | `string`                                | `undefined`        | Optional containment root for `getUserFolder` results. When set, the framework validates that the returned path resolves (via `fs.realpath` + `path.relative`) inside this directory; escapes (`../etc`, symlink redirection, etc.) trigger `onError` with `phase: "getUserFolder"` and the request falls back to the public `baseDir`. When unset, the caller must sanitize `userId` themselves inside `getUserFolder`. |
| `websiteURL`         | `string`                                  | `undefined`        | If set, internal URLs pointing to this host are treated as local assets |
| `apiRegex`           | `RegExp`                                  | `/^\/api\/v1\//`   | Regex stripped from internal URL pathnames before local lookup. **Must be a safe (non-ReDoS) regex** — see [API Prefix and ReDoS Safety](#api-prefix-and-redos-safety) below. Ignored when `apiPrefix` is set. |
| `apiPrefix`          | `string`                                  | `undefined`        | Optional literal-string prefix stripped from internal URL pathnames. When set, **takes precedence over `apiRegex`** and uses a plain `startsWith` + `slice`, sidestepping the ReDoS risk of a user-supplied regex. Recommended whenever you only need to strip a literal path prefix. |
| `allowedNetworkList` | `string[]`                                | `[]`               | Allowed remote hosts. Others immediately fall back. **Entries are trimmed and lowercased at schema-parse time**, so `["CDN.Example.com"]` matches a request URL whose hostname the WHATWG URL parser has lowercased to `cdn.example.com`. |
| `cacheControl`       | `string`                                  | `undefined`        | Cache-Control header value                                              |
| `etag`               | `boolean`                                 | `true`             | Emit ETag and honor If-None-Match                                       |
| `minWidth`           | `number`                                  | `50`               | Minimum accepted width                                                  |
| `maxWidth`           | `number`                                  | `4000`             | Maximum accepted width                                                  |
| `minHeight`          | `number`                                  | `50`               | Minimum accepted height                                                 |
| `maxHeight`          | `number`                                  | `4000`             | Maximum accepted height                                                 |
| `defaultQuality`     | `number`                                  | `80`               | Default JPEG/WebP/AVIF quality                                          |
| `requestTimeoutMs`   | `number`                                  | `5000`             | Network fetch timeout                                                   |
| `idHandlerTimeoutMs` | `number`                                  | `requestTimeoutMs` | Maximum time (ms) to await an async `idHandler` before bailing to the raw `userId`. |
| `maxDownloadBytes`   | `number`                                  | `5_000_000`        | Maximum image size in bytes. Applies to **both network fetches and local filesystem reads** — local files are stat-checked before `fs.readFile` is invoked, so an oversized image on disk falls back the same way an oversized remote response does. |
| `maxRedirects`       | `number`                                  | `3`                | Maximum HTTP redirects followed during network fetches. Each hop is re-validated against the allowlist, the http/https protocol guard, and the public-IP DNS check. Range `0..10`. |
| `maxInputPixels`     | `number`                                  | `16_000 * 16_000`  | Maximum input image pixel count enforced by Sharp. Protects against decompression bombs (small encoded buffer that decodes to billions of pixels). Defaults to 256 megapixels. |
| `allowSvgInput`      | `boolean`                                 | `false`            | Allow SVG inputs through to Sharp/libvips. Defaults to `false` — SVGs can contain malicious payloads (XML bombs, billion-laughs, nested `<use>`) parsed by libvips/librsvg. Detected via magic-byte sniffing and rejected unless this flag is explicitly enabled. |
| `onError`            | `(err, { phase, src?, userId? }) => void` | `undefined`        | Optional observability hook. Invoked at every catch site so you can ship structured logs / metrics / APM events. Phases include `"sharp"`, `"fetch"`, `"fs"`, `"idHandler"`, `"getUserFolder"`, `"schema"`, and `"validation"`. The hook is best-effort: throws from the hook are suppressed and never break the response. |
| `onComplete`         | `(ctx: { src?, userId?, format, outputBytes, cached, durationMs }) => void` | `undefined`        | Optional observability hook invoked after the response has been flushed on the happy path (200 with image bytes) and on the 304 cached short-circuit. `format` is the output format actually used; `outputBytes` is the response body size in bytes (0 for 304s); `cached` is `true` when the response was served as 304 Not Modified; `durationMs` is the monotonic end-to-end latency captured via `process.hrtime.bigint()`. Use this hook to ship per-request latency metrics, count cache-hit ratios, or feed structured logs into your APM. The hook is best-effort: throws from the hook are suppressed and never escape the middleware. |

## Query Parameters

| Parameter | Type                    | Default     | Description                                                         |
| --------- | ----------------------- | ----------- | ------------------------------------------------------------------- |
| `src`     | `string`                | _required_  | Path or URL to the image source                                     |
| `format`  | `ImageFormat`           | `jpeg`      | Output format (`jpeg`, `png`, `webp`, `gif`, `tiff`, `avif`). SVG is not supported as an output format. |
| `width`   | `number`                | `undefined` | Desired output width (px)                                           |
| `height`  | `number`                | `undefined` | Desired output height (px)                                          |
| `quality` | `number`                | `80`        | Image quality (1-100)                                               |
| `folder`  | `'public' \| 'private'` | `public`    | Image folder type                                                   |
| `userId`  | `string`                | `undefined` | User ID for private folder access                                   |
| `type`    | `'normal' \| 'avatar'`  | `normal`    | Image type (affects fallback image)                                 |

## Example Requests

### Local Image with Resize

```bash
GET /api/v1/pixel/serve?src=uploads/photo.jpg&width=800&height=600&format=webp
```

### Network Image

```bash
GET /api/v1/pixel/serve?src=https://cdn.example.com/image.jpg&format=avif&quality=90
```

### Private User Image

```bash
GET /api/v1/pixel/serve?src=avatar.jpg&folder=private&userId=12345&type=avatar
```

## Integration with Pixel Serve Client

This package is designed to work seamlessly with [`pixel-serve-client`](https://www.npmjs.com/package/pixel-serve-client), a React component that automatically generates the correct query parameters.

```tsx
// Client-side (React)
import Pixel from "pixel-serve-client";

<Pixel
  src="/uploads/photo.jpg"
  width={800}
  height={600}
  backendUrl="/api/v1/pixel/serve"
/>;
```

## Security Features

### Path Traversal Protection

All local paths are validated to prevent directory traversal attacks:

- Rejects paths with `..`
- Rejects absolute paths
- Validates resolved paths stay within `baseDir`
- Rejects null bytes and control characters

### Network Image Security

- Only fetches from explicitly allowed domains (`allowedNetworkList`). Allowlist entries are normalised (trimmed + lowercased) at schema-parse time so the case-insensitive matching contract is enforced regardless of how the option was supplied (env file, JSON config, etc.).
- Validates MIME type of responses
- Configurable timeout and size limits
- Rejects non-HTTP/HTTPS protocols

### SSRF Redirect Protection

- HTTP redirects are **never auto-followed**. Axios is invoked with `maxRedirects: 0` and the middleware runs a manual redirect loop (default budget: 3 hops, capped at 10 via `maxRedirects`).
- **Every hop is re-validated**: protocol must be `http`/`https`, host must be in `allowedNetworkList`, and the destination hostname must resolve to a public IP.
- **Private/loopback/link-local IPs are blocked** even when the host is allowlisted — this stops redirects to RFC1918 ranges, `127.0.0.0/8` loopback, `169.254.0.0/16` link-local (including the AWS IMDS endpoint `169.254.169.254`), IPv6 loopback (`::1`), unique-local (`fc00::/7`), and IPv4-mapped private IPv6.
- **DNS rebinding mitigation (pinned `lookup`).** Every hop resolves the destination hostname **once** via `dns.lookup`, validates the resolved address is public, then passes axios a per-request `httpAgent`/`httpsAgent` whose `lookup` function is pinned to that exact `{ address, family }` pair. The TCP socket is therefore guaranteed to connect to the IP the framework validated, rather than whatever the kernel resolver returns microseconds later. This closes the classic DNS-rebinding TOCTOU window where an attacker-controlled authoritative server answers the validation lookup with a public IP and the subsequent connect-time lookup with `127.0.0.1` / `169.254.169.254`. Each redirect hop re-resolves and re-pins so chained rebinding attempts are also defeated.

### Decompression-Bomb Protection

- Sharp is constructed with `{ failOn: "warning", limitInputPixels: maxInputPixels, sequentialRead: true, unlimited: false }`, so malformed or oversized inputs fail fast.
- Before the full decode, the pipeline performs a `metadata()` peek and rejects any image whose `width * height` exceeds `maxInputPixels` (default 256MP). This blocks small encoded payloads that would decompress to billions of pixels and OOM the worker.

### SVG Input Rejection

- SVG inputs are rejected by default. The middleware uses a magic-byte sniffer that detects `<svg`, `<?xml ... <svg`, UTF-8 BOM-prefixed SVG, and comment-prefixed SVG, then bails to the fallback image before reaching libvips/librsvg.
- This guards against XML bombs, billion-laughs attacks, and nested `<use>` exploits historically parsed during SVG decoding.
- Set `allowSvgInput: true` to opt in — only do so when the source pipeline is fully trusted.

### API Prefix and ReDoS Safety

Internal URLs (those matching `websiteURL`) are stripped of an API path prefix before being resolved against `baseDir`. Two options control this:

- **`apiPrefix` (recommended).** A literal string prefix. The middleware does a plain `pathname.startsWith(apiPrefix)` check followed by `pathname.slice(apiPrefix.length)`. No regex evaluation, so it cannot be made vulnerable.

  ```ts
  const serveImage = registerServe({
    baseDir: "/public/images",
    websiteURL: "example.com",
    apiPrefix: "/api/v1/", // strips "/api/v1/photo.jpg" → "photo.jpg"
  });
  ```

- **`apiRegex` (legacy / advanced).** A regex applied via `String.prototype.replace`. Only use this when you need wildcards or alternations. **`apiRegex` accepts an arbitrary user-supplied `RegExp` and runs it against client-controlled `url.pathname` values, so a vulnerable pattern (`/^(a+)+\/$/`, nested quantifiers, ambiguous alternation) opens the deployment to catastrophic-backtracking denial-of-service (ReDoS).** The default `/^\/api\/v1\//` is anchored and literal and is not vulnerable; audit any custom pattern with a tool like [safe-regex](https://www.npmjs.com/package/safe-regex) before shipping.

  ```ts
  const serveImage = registerServe({
    baseDir: "/public/images",
    websiteURL: "example.com",
    apiRegex: /^\/api\/v[12]\//, // safe: anchored, no nested quantifiers
  });
  ```

**Precedence.** When both options are supplied, `apiPrefix` wins — the regex is not evaluated at all, so a misconfigured `apiRegex` cannot reach the request path. Unset `apiPrefix` to opt back into regex behavior.

### Private Folder Access

Use `getUserFolder` to implement your own authentication/authorization logic:

```typescript
const serveImage = registerServe({
  baseDir: "/public/images",
  // Optional but recommended: when set, the framework verifies the path
  // returned by `getUserFolder` resolves inside this directory and falls
  // back to `baseDir` if it escapes (e.g., a malicious `userId` that joins
  // to `../etc` or a symlink that points outside the tree).
  getUserFolderRootDir: "/private/users",
  getUserFolder: async (req, userId) => {
    const user = await verifyToken(req.headers.authorization);
    if (!user || user.id !== userId) {
      return ""; // Empty/falsy result keeps `baseDir`
    }
    return `/private/users/${userId}`;
  },
});
```

> **Without `getUserFolderRootDir`, the framework cannot enforce containment.**
> You are responsible for sanitizing `userId` inside your own callback (forbid
> `..`, slashes, backslashes, and control characters). Setting
> `getUserFolderRootDir` adds a defense-in-depth realpath check that runs
> after your callback returns so a buggy implementation cannot expand the
> filesystem surface area beyond an opt-in root.

## Caching

### Deterministic ETag (pre-Sharp short-circuit)

When `etag: true` (the default), the middleware builds a SHA-1 ETag from a deterministic key combining `src`, `width`, `height`, `format`, `quality`, `type`, `folder`, the post-`idHandler` `userId`, and a source identifier (`mtimeMs:size` for local files, the resolved URL for remote sources). The key is computed **before** any Sharp work, so an `If-None-Match` request that hits a known ETag returns `304 Not Modified` immediately — no decode, no resize, no re-encode.

When a deterministic key cannot be derived (e.g., the source file is missing and the pipeline falls back to a placeholder image), the framework computes a SHA-1 over the processed buffer instead, preserving the historical ETag contract for fallback responses.

### Content-Disposition and `Vary` Header

Responses include an RFC 6266 / RFC 5987 `Content-Disposition` header with **both** a quoted ASCII `filename=` parameter and a percent-encoded `filename*=UTF-8''<encoded>` parameter, so unicode filenames (Arabic, CJK, etc.) round-trip cleanly through clients and proxies. Query strings and fragments are stripped before the filename is derived, only-punctuation basenames fall back to `image`, and very long names are truncated so the response header stays bounded.

Every successful response also carries `Vary: Accept-Encoding` for downstream cache correctness.

## Observability

Two optional best-effort hooks let you wire the middleware into your logging, metrics, and APM stack. Both run synchronously after the response has been handled, and both swallow throws — a buggy logger can never break the response.

### `onError` — failure pings

Fired at every catch site in the request pipeline. The middleware always continues to serve a fallback image; the hook is purely for logs / metrics / APM:

```typescript
const serveImage = registerServe({
  baseDir: "/public/images",
  onError: (err, ctx) => {
    // ctx: { phase: "sharp" | "fetch" | "fs" | "idHandler"
    //       | "getUserFolder" | "schema" | "validation" | string,
    //        src?: string, userId?: string }
    logger.warn({ err, ...ctx }, "pixel-serve error");
    metrics.increment(`pixel_serve.errors.${ctx.phase}`);
  },
});
```

### `onComplete` — success + cache-hit pings

Fired after the response has been flushed on the happy path (200 with image bytes) **and** on the 304 cached short-circuit. The `cached` flag distinguishes the two paths, so a single hook can drive both latency histograms and cache-hit ratios:

```typescript
const serveImage = registerServe({
  baseDir: "/public/images",
  onComplete: (ctx) => {
    // ctx: { src?: string, userId?: string, format: ImageFormat,
    //        outputBytes: number, cached: boolean, durationMs: number }
    metrics.histogram("pixel_serve.latency_ms", ctx.durationMs, {
      format: ctx.format,
      cached: String(ctx.cached),
    });
    metrics.increment(
      ctx.cached ? "pixel_serve.cache_hit" : "pixel_serve.cache_miss"
    );
    if (!ctx.cached) {
      metrics.histogram("pixel_serve.output_bytes", ctx.outputBytes, {
        format: ctx.format,
      });
    }
  },
});
```

`durationMs` is captured via `process.hrtime.bigint()` for monotonic precision, so it is safe to feed directly into a latency histogram. `outputBytes` is the size of the response body in bytes (`0` for a 304, the encoded image size for a 200). `format` is the output format actually produced by the response — useful for slicing metrics by AVIF / WebP / JPEG.

Throws from either hook are swallowed.

## Error Handling

Every catch site in the pipeline (Sharp, network fetch, filesystem read, `idHandler`, `getUserFolder`, schema, validation) serves a fallback image without exposing stack traces or system paths, then notifies `onError` if configured. The middleware itself never invokes Express's `next(error)` on the happy path.

There is one exception: if the response was already partially flushed (`res.headersSent === true`) at the moment the outer catch fires, the middleware cannot recover into a fresh fallback without tripping `ERR_HTTP_HEADERS_SENT`. In that case it surfaces an `Error("response already flushed")` via `next(err)` and fires `onError` with `phase: "fs"` so the connection is torn down cleanly. The current happy path only flushes via `res.send` at the very end of the pipeline, so this guard is defence-in-depth for future streaming refactors that may write headers earlier.

## Performance

### Per-Request Memory Footprint

The current pipeline materializes intermediate buffers rather than streaming Sharp's output to the response. As a rough rule of thumb the in-flight memory cost of a single request is:

```text
~= source_buffer_size      (≤ maxDownloadBytes; default 5 MB)
 + processed_buffer_size   (decoded → resized → re-encoded output)
 + transient_etag_buffer   (SHA-1 over the processed buffer, fallback path only)
```

For most photo workloads the processed buffer is smaller than the source (re-encoding shrinks the payload), but pathological inputs (e.g., a 4 MB AVIF that decodes to a 50 MP raster which then re-encodes to a larger PNG) can push the high-water mark above twice the source size. Sharp decoding itself also requires a libvips work buffer proportional to `width × height × channels` outside the Node.js heap, which is bounded by `maxInputPixels` (default 256 MP).

Practical guidance:

- **Set `maxDownloadBytes`** tightly for your traffic profile — every running request can hold up to this many bytes for the source alone.
- **Set `maxInputPixels`** to the largest output you actually need. Decompression bombs are blocked, but a generous limit (e.g., 256 MP) still allocates libvips work memory proportional to the decoded raster.
- **Cap concurrency at the reverse proxy or process manager.** Sharp processing is **CPU-intensive** — the per-CPU concurrency is what bounds total memory under load, not Node's default request concurrency.

### CPU and the Cacheability Win

Sharp's decode → rotate → resize → re-encode pipeline is CPU-bound and dominates request latency for cold cache hits. To minimize cost:

- **Use `cacheControl` aggressively.** Setting `Cache-Control: public, max-age=…, stale-while-revalidate=…` lets browsers and intermediate caches serve the image without ever round-tripping back to the middleware.
- **Put a CDN in front.** Cloudflare, CloudFront, Fastly, etc. honor `Cache-Control` and `ETag` headers and can shield the origin from repeated processing entirely.
- **Lean on the deterministic ETag short-circuit.** When `etag: true` (the default), the middleware computes a SHA-1 ETag from a stable cache key (`src` + `width` + `height` + `format` + `quality` + `type` + `folder` + post-`idHandler` `userId` + source identifier) **before** any Sharp work. An `If-None-Match` request that matches a known ETag returns `304 Not Modified` immediately — **no decode, no resize, no re-encode, no allocation of the processed buffer**. This is the cheapest possible response the middleware can produce and is the primary reason origin CPU stays bounded under repeated traffic for the same image variant.

> Streaming Sharp's output directly to `res` (instead of materializing the processed buffer) would further reduce the per-request high-water mark, but it is **not** currently supported — emitting a deterministic ETag requires either the buffer hash or the deterministic key, and the framework prefers the latter precisely because it preserves cacheability without forcing the full pipeline to run.

## Fallback Images

The package includes built-in fallback images for:

- **Normal images**: Displayed when an image cannot be loaded
- **Avatars**: Displayed when an avatar image cannot be loaded

These are automatically served when:

- The requested image doesn't exist
- Path validation fails
- Network fetch fails or returns invalid data
- Image processing fails

## Exports

```typescript
// Main middleware factory
import { registerServe } from "pixel-serve-server";

// Types
import type {
  PixelServeOptions,
  UserData,
  ImageFormat,
  ImageType,
  PixelServeOnError,
  PixelServeErrorContext,
  PixelServeErrorPhase,
  PixelServeOnComplete,
  PixelServeCompletionContext,
} from "pixel-serve-server";

// Zod schemas for validation
import { optionsSchema, userDataSchema } from "pixel-serve-server";

// Utility function
import { isValidPath } from "pixel-serve-server";
```

### Helpers

Eleven additional helper functions are exported for downstream tooling — precomputing ETags for offline cache priming, sharing the SSRF/containment primitives with custom middleware, sniffing SVG inputs before they reach Sharp, and so on. They are part of the supported public API and have JSDoc + test coverage.

**Security helpers (SSRF / containment)**

- `isPrivateIp(address: string): boolean` — Returns `true` for any address in an IANA-reserved range that should never be reachable over the public internet (RFC 1918, loopback, link-local, unique-local, multicast, `0.0.0.0`, IPv4-mapped private IPv6, the AWS IMDS endpoint).
- `isPublicHost(hostname: string): Promise<boolean>` — Resolves a hostname via `dns.lookup` and returns `true` only when the resolved address passes `isPrivateIp` rejection. Use this to gate any outbound request you build outside the middleware.
- `resolvePinnedAddress(hostname: string): Promise<{ address: string, family: 4 | 6 }>` — Resolves a hostname once and returns the validated `{ address, family }` pair so a subsequent socket connection can be pinned to the exact IP the validator approved (DNS-rebinding mitigation).
- `buildPinnedAgents(pinned: { address: string, family: 4 | 6 }): { httpAgent, httpsAgent }` — Builds `http.Agent` and `https.Agent` instances whose `lookup` function is pinned to the supplied `{ address, family }`. Drop them into axios / fetch to guarantee the TCP socket connects to the validated IP.
- `isInsideRoot(rootDir: string, candidatePath: string): Promise<boolean>` — Realpath-resolves both inputs and returns `true` only when `candidatePath` is a descendant of `rootDir`. Useful for custom containment checks around private-folder logic.
- `resolveRootDir(rootDir: string): Promise<string>` — Realpath-resolves a configured root directory once; returns the canonical absolute path you should compare against in subsequent containment checks.
- `looksLikeSvg(buffer: Buffer): boolean` — Magic-byte sniffer for SVG inputs (handles `<svg`, `<?xml … <svg`, UTF-8 BOM-prefixed, and comment-prefixed payloads). Returns `true` when libvips/librsvg would attempt to decode the buffer as SVG.

**ETag / source-identifier helpers**

- `buildSourceIdentifier(absolutePath?: string, url?: string): Promise<string | null>` — Builds the deterministic source fingerprint used inside the ETag key: `mtimeMs:size` for a local file (`fs.stat`) or the resolved URL string for a remote source. Returns `null` when no stable identifier can be derived.
- `buildDeterministicEtag(parts: { src, width, height, format, quality, type, folder, userId?, sourceIdentifier }): string` — Computes the SHA-1 ETag used by the middleware **before** any Sharp work runs. Same inputs produce the same ETag, so you can pre-warm a CDN or short-circuit an `If-None-Match` request without invoking the full pipeline.

**Path / API helpers**

- `stripApiPrefix(pathname: string, options: { apiPrefix?: string, apiRegex?: RegExp }): string` — Strips the configured API prefix from a URL pathname using the same precedence rules as the middleware (`apiPrefix` literal `startsWith` wins over `apiRegex`).
- `buildFilename(src: string, format: ImageFormat): { asciiFilename, encodedFilename }` — Builds the dual `filename=` / `filename*=UTF-8''…` pair used in `Content-Disposition`. Handles RFC 5987 percent-encoding, truncation that respects `%XX` boundaries, and the empty/punctuation-only basename fallback to `image`.

```typescript
import {
  isPrivateIp,
  isPublicHost,
  resolvePinnedAddress,
  buildPinnedAgents,
  isInsideRoot,
  resolveRootDir,
  looksLikeSvg,
  buildSourceIdentifier,
  buildDeterministicEtag,
  stripApiPrefix,
  buildFilename,
} from "pixel-serve-server";
```

## Module Formats

```typescript
// ESM
import { registerServe } from "pixel-serve-server";

// CommonJS
const { registerServe } = require("pixel-serve-server");
```

## Versioning and Migration

`pixel-serve-server` follows [semantic versioning](https://semver.org). The
current major line is **2.x**; see [`MIGRATION.md`](./MIGRATION.md) for the
1.x → 2.x upgrade guide (SVG output removal, the `userDataSchema.src`
relaxation, new security-hardening defaults, etc.). Patches and minor
releases inside the 2.x line are backward-compatible — see
[`CHANGELOG.md`](./CHANGELOG.md) for the full history.

## Requirements

- Node.js >= 20
- Express 5.x (included as a dependency)

## Dependencies

- **Sharp**: High-performance image processing
- **Axios**: HTTP client for fetching network images
- **Zod**: Runtime validation for options and query params

## License

MIT

## Contributing

Issues and pull requests are welcome at [GitHub](https://github.com/Hiprax/pixel-serve-server).
See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the local development workflow,
coverage expectations, and PR guidelines.

## Security

See [`SECURITY.md`](./SECURITY.md) for the disclosure policy, supported
versions, and the in-scope / out-of-scope vulnerability classes. Please **do
not** open public GitHub issues for security reports.
