import type { Request } from "express";

export type ImageType = "avatar" | "normal";

export type ImageFormat =
  | "jpeg"
  | "jpg"
  | "png"
  | "webp"
  | "gif"
  | "tiff"
  | "avif";

/**
 * The known failure phases reported to `onError`. Listed for documentation;
 * the actual `phase` field is typed as `string` so future call sites can
 * introduce new identifiers without a breaking change.
 *
 * - `"sharp"`     — Sharp decode / resize / encode pipeline failed.
 * - `"fetch"`     — Network fetch (axios) failed or rejected by SSRF guards.
 * - `"fs"`        — Local filesystem read or path validation failed.
 * - `"idHandler"` — User-supplied `idHandler` threw, returned a non-string,
 *                   or exceeded the `idHandlerTimeoutMs` budget.
 * - `"getUserFolder"` — User-supplied `getUserFolder` threw or exceeded
 *                       `requestTimeoutMs`.
 * - `"schema"`    — Zod parsing of `PixelServeOptions` failed.
 * - `"validation"`— Per-request user data validation failed (e.g., bad query).
 */
export type PixelServeErrorPhase =
  | "sharp"
  | "fetch"
  | "fs"
  | "idHandler"
  | "getUserFolder"
  | "schema"
  | "validation"
  | string;

/**
 * Context passed to the `onError` observability hook. `phase` always reflects
 * the operation that failed; `src` and `userId` are populated when they have
 * been parsed by the time the failure occurred. Additional fields may be
 * appended in the future and consumers should treat the shape as open.
 */
export type PixelServeErrorContext = {
  phase: PixelServeErrorPhase;
  src?: string;
  userId?: string;
};

/**
 * Observability hook fired at every catch site in the request pipeline. The
 * callback runs synchronously (any returned promise is ignored) and must
 * not throw — throws are swallowed so a buggy logger cannot crash a request.
 * Use this hook to emit structured logs, increment metric counters, or
 * surface unexpected failures to your APM / error tracker.
 */
export type PixelServeOnError = (
  err: unknown,
  context: PixelServeErrorContext,
) => void;

/**
 * Context passed to the `onComplete` observability hook on the happy path
 * (200 response after a successful Sharp pipeline), on either 304 short-
 * circuit (an `If-None-Match` match against the pre-Sharp deterministic
 * ETag, skipping Sharp entirely, OR against the post-Sharp buffer-hash
 * ETag used when no deterministic source identifier is available), and on
 * the hard-fallback path (a 200 response serving the bundled placeholder
 * verbatim after the outer pipeline catch).
 *
 * - `src` / `userId` carry the validated request inputs.
 * - `format` is the output format actually used by the response.
 * - `outputBytes` is the size of the response body in bytes (0 for 304s).
 * - `cached` is `true` when the response was served as 304 Not Modified.
 * - `durationMs` measures end-to-end pipeline latency from the start of
 *   `serveImage` to the moment `res.send` (or `res.end`) was invoked,
 *   captured via `process.hrtime.bigint()` for monotonic precision.
 * - `fallback` is `true` when the served bytes are a bundled placeholder
 *   image rather than a genuinely resolved-and-encoded source — this
 *   covers both a "soft" fallback (e.g. a missing file or blocked host,
 *   still re-encoded through Sharp on a 200) and a "hard" fallback (the
 *   outer pipeline catch serving the bundled asset verbatim on a 200).
 *   `false` for a genuinely resolved-and-encoded image. 304 short-circuits
 *   always report `false` — no bytes are sent, so there is nothing to
 *   characterize as fallback-or-not for that response.
 *
 * Additional fields may be appended in the future; consumers should treat
 * the shape as open.
 */
export type PixelServeCompletionContext = {
  src?: string;
  userId?: string;
  format: ImageFormat;
  outputBytes: number;
  cached: boolean;
  durationMs: number;
  fallback: boolean;
};

/**
 * Observability hook fired after the response has been flushed on the
 * happy path (200 + image bytes), on the 304 cached short-circuit, and on
 * the hard-fallback path (a 200 serving the bundled placeholder verbatim
 * after the outer pipeline catch) — every response that resolves to a 200
 * or a 304 fires this hook exactly once. The callback runs synchronously
 * (any returned promise is ignored) and must not throw — throws are
 * swallowed so a buggy logger cannot crash a request. Use this hook to
 * emit structured logs, ship per-request latency metrics to your APM, or
 * count cache-hit ratios; use the `fallback` field on its context to
 * distinguish a genuinely-served image from a bundled placeholder.
 */
export type PixelServeOnComplete = (
  context: PixelServeCompletionContext,
) => void;

export type PixelServeOptions = {
  baseDir: string;
  /**
   * Transforms an incoming `userId` before it is handed to `getUserFolder`.
   * May be sync or async. Throws and non-string returns are caught by the
   * framework and fall back to the raw `userId`. Async handlers are awaited
   * under `idHandlerTimeoutMs` (defaults to `requestTimeoutMs`).
   */
  idHandler?: (id: string) => string | Promise<string>;
  getUserFolder?: (req: Request, id?: string) => Promise<string> | string;
  /**
   * Optional containment root for `getUserFolder` results. When set, the
   * framework validates that the path returned by `getUserFolder` resolves
   * (via `fs.realpath` + `path.relative`) to a descendant of
   * `getUserFolderRootDir`. If the returned path escapes the root (e.g.,
   * `path.join(PRIVATE_DIR, "../etc")` or a symlink that points outside),
   * the framework treats the call as a `getUserFolder` failure: the
   * `onError` hook fires with `phase: "getUserFolder"` and the request
   * falls back to the public `baseDir`.
   *
   * When unset, no containment check runs and the caller is fully
   * responsible for sanitizing the `userId` input inside their own
   * `getUserFolder` implementation.
   */
  getUserFolderRootDir?: string;
  websiteURL?: string;
  /**
   * Regex stripped from an internal URL pathname before resolving the local
   * file. Only applied when `websiteURL` matches the incoming `src` host.
   *
   * **ReDoS warning.** This regex is executed against arbitrary client-
   * controlled `url.pathname` values via `String.prototype.replace`. A
   * vulnerable pattern (e.g., `/^(a+)+\/$/`, nested quantifiers, ambiguous
   * alternations) opens the deployment to catastrophic-backtracking denial of
   * service. Prefer `apiPrefix` (a plain string `startsWith` check) when you
   * only need to strip a literal prefix. If you must supply a custom regex,
   * audit it with a tool like
   * [safe-regex](https://www.npmjs.com/package/safe-regex) and keep it anchored
   * (`^…`) so partial matches cannot drift across pathological inputs.
   *
   * Defaults to `/^\/api\/v1\//` — a fixed, anchored, literal pattern that is
   * not vulnerable to ReDoS.
   */
  apiRegex?: RegExp;
  /**
   * Optional literal-string prefix stripped from internal URL pathnames before
   * resolving the local file. When set, `apiPrefix` takes precedence over
   * `apiRegex` — the pathname is checked with `startsWith(apiPrefix)` and
   * sliced when it matches, with no regex evaluation at all. This is the
   * recommended option whenever you only need to strip a literal path prefix
   * (no captures, no alternations) because it sidesteps the ReDoS risk
   * inherent to a user-supplied `apiRegex`.
   *
   * Example: `apiPrefix: "/api/v1/"` is equivalent in behavior to the default
   * `apiRegex: /^\/api\/v1\//` but cannot be made vulnerable by mistake.
   *
   * Defaults to `undefined`, in which case `apiRegex` is used.
   */
  apiPrefix?: string;
  /**
   * Hosts allowed as remote image sources. Each entry is a hostname
   * (`images.unsplash.com`) matched exactly, OR a wildcard of the form
   * `*.example.com` which matches the apex (`example.com`) AND any subdomain
   * (`cdn.example.com`, `a.b.example.com`). Use a wildcard for services that
   * redirect to a CDN subdomain (e.g. `picsum.photos` → `fastly.picsum.photos`).
   *
   * A wildcard must have at least two labels after `*.` (so `*.com` is
   * rejected at `registerServe()`), and public-suffix families (`*.co.uk`)
   * are not special-cased. The wildcard relaxes only the hostname allowlist;
   * every redirect hop is still re-validated against the DNS public-IP guard,
   * so a wildcard can never reach a private/loopback/link-local address.
   * Defaults to `[]` (no remote fetching).
   */
  allowedNetworkList?: string[];
  cacheControl?: string;
  etag?: boolean;
  /**
   * Operator dimension bounds. Requested `width`/`height` are first validated
   * against the framework's hard `[1, 4000]` window (out-of-window requests
   * return a fallback image) and then clamped to these bounds. `minWidth`/
   * `minHeight` may be set anywhere from 1 upward to serve small images
   * (avatars, icons, favicons); `maxWidth`/`maxHeight` must not exceed 4000.
   * Defaults: min 50, max 4000.
   */
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  defaultQuality?: number;
  requestTimeoutMs?: number;
  /**
   * Timeout (ms) applied when awaiting an async `idHandler`. Defaults to
   * `requestTimeoutMs` when unset.
   */
  idHandlerTimeoutMs?: number;
  maxDownloadBytes?: number;
  /**
   * Maximum number of HTTP redirects to follow when fetching a remote image.
   * Each hop is re-validated against `allowedNetworkList`, the http/https
   * protocol guard, and the public-IP DNS check (SSRF protection).
   * Defaults to 3.
   */
  maxRedirects?: number;
  /**
   * Maximum number of input pixels accepted by Sharp before failing the
   * request. Protects against decompression bombs (small encoded buffer that
   * decompresses to billions of pixels). Defaults to 16000 * 16000.
   */
  maxInputPixels?: number;
  /**
   * Whether to allow SVG inputs through to Sharp/libvips. SVG decoding has
   * historically been a vector for XML-bomb / billion-laughs style attacks.
   * Defaults to `false`; SVG inputs are detected by magic bytes and rejected
   * with the fallback image.
   */
  allowSvgInput?: boolean;
  /**
   * Optional observability hook invoked whenever the pipeline catches an
   * error. The framework continues to serve a fallback image as before; the
   * hook is purely for logging / metrics / APM integration.
   *
   * The hook is invoked at every catch site (Sharp pipeline, network fetch,
   * filesystem read, `idHandler` failure, `getUserFolder` failure, schema
   * validation failure). It is best-effort: throws from the hook are
   * suppressed and never escape the middleware.
   */
  onError?: PixelServeOnError;
  /**
   * Optional observability hook invoked after the response has been flushed
   * on the happy path (200 response with image bytes), after the 304 cached
   * short-circuit, and after the hard-fallback path (a 200 serving the
   * bundled placeholder verbatim following the outer pipeline catch). Use
   * this hook to ship per-request latency metrics, count cache-hit ratios,
   * or feed structured logs into your APM; the context's `fallback` field
   * distinguishes a genuinely-served image from a bundled placeholder.
   *
   * The hook is best-effort: throws from the hook are suppressed and never
   * escape the middleware. The hook runs synchronously; any returned promise
   * is ignored.
   */
  onComplete?: PixelServeOnComplete;
};

export type UserData = {
  src: string;
  quality?: number | string;
  format?: ImageFormat;
  folder?: "public" | "private";
  type?: ImageType;
  userId?: string;
  width?: number | string;
  height?: number | string;
};
