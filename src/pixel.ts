import path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp, { FormatEnum, ResizeOptions } from "sharp";
import type { Request, Response, NextFunction } from "express";
import type {
  PixelServeOptions,
  ImageFormat,
  ImageType,
  PixelServeErrorContext,
  PixelServeOnError,
  PixelServeCompletionContext,
  PixelServeOnComplete,
} from "./types";
import {
  allowedFormats,
  API_REGEX,
  FALLBACKIMAGES,
  mimeTypes,
} from "./variables";
import {
  fetchImage,
  isValidPath,
  readLocalImage,
  resolveInternalLocalPath,
} from "./functions";
import { renderOptions, renderUserData } from "./renders";
import type { ParsedOptions } from "./schema";

/**
 * Best-effort observability hook dispatcher. Swallows hook errors so a buggy
 * logger never crashes a request. Returns void.
 */
const reportError = (
  hook: PixelServeOnError | undefined,
  err: unknown,
  context: PixelServeErrorContext,
): void => {
  if (!hook) return;
  try {
    hook(err, context);
  } catch {
    // intentionally suppressed — observability must never break the response
  }
};

/**
 * Best-effort observability hook dispatcher for the success / 304 / hard-
 * fallback paths. Swallows hook errors so a buggy logger never crashes a
 * request. Returns void. Mirrors `reportError`'s contract so consumers can
 * rely on the same dispatch guarantees for both observability surfaces.
 */
const safeOnComplete = (
  hook: PixelServeOnComplete | undefined,
  context: PixelServeCompletionContext,
): void => {
  if (!hook) return;
  try {
    hook(context);
  } catch {
    // intentionally suppressed — observability must never break the response
  }
};

/**
 * Computes the elapsed milliseconds between a `process.hrtime.bigint()`
 * checkpoint and now. Uses bigint math so monotonic-clock precision is
 * preserved (we lose precision when we convert back to a `Number`, but the
 * resulting ms float is plenty precise for APM latency reporting).
 */
const elapsedMs = (start: bigint): number => {
  const diff = process.hrtime.bigint() - start;
  // 1 ms = 1_000_000 ns. We do the division in bigint first to avoid
  // overflowing through Number for absurdly long latencies, then attach the
  // sub-millisecond remainder as a float.
  const whole = Number(diff / 1_000_000n);
  const remainder = Number(diff % 1_000_000n) / 1_000_000;
  return whole + remainder;
};

/**
 * Derives an ASCII-safe filename and an RFC 5987 / RFC 6266
 * `filename*=UTF-8''<percent-encoded>` parameter for use in
 * `Content-Disposition`.
 *
 *  - Strips query strings and URL fragments before extracting basename.
 *  - Strips the existing extension and replaces it with the encoded output
 *    format extension supplied by the caller.
 *  - Maps every non-printable-ASCII / forbidden-header byte to `_` for the
 *    fallback `filename=` parameter (RFC 5987 prohibits raw non-ASCII bytes).
 *  - Percent-encodes the original (UTF-8) basename for the `filename*=`
 *    parameter so unicode names round-trip cleanly.
 *  - Caps both parameters to a sane length so absurd filenames cannot bloat
 *    the response header. The cap is applied AFTER the extension is appended
 *    so the extension is never truncated.
 */
const FILENAME_MAX_LEN = 100;
const ASCII_FALLBACK_DEFAULT = "image";

/**
 * Shared Cache-Control values so the happy path, both fallback paths, and
 * (in a later phase) the 304 short-circuits cannot drift apart. A soft or
 * hard fallback serves a bundled placeholder, never the requested bytes, so
 * it must never inherit the long-lived, real-image cache policy — otherwise
 * a transient failure gets cached as if it were permanent.
 */
const DEFAULT_CACHE_CONTROL =
  "public, max-age=86400, stale-while-revalidate=604800";
const FALLBACK_CACHE_CONTROL = "public, max-age=60";

export const buildFilename = (
  rawSrc: string | undefined,
  outputFormat: string,
): { asciiFilename: string; encodedFilename: string } => {
  const ext = outputFormat;
  // strip query + fragment, then take basename (URL or path-shaped)
  const stripped = (rawSrc ?? "").split("#")[0]!.split("?")[0]!;
  const baseWithExt = path.basename(stripped);
  const baseNoExt =
    baseWithExt && baseWithExt !== "/" && baseWithExt !== "\\"
      ? path.basename(baseWithExt, path.extname(baseWithExt))
      : "";

  // ASCII fallback: replace any byte outside the safe printable ASCII range,
  // plus quote / backslash / control / DEL, with `_`. Collapse runs of `_`
  // into one, then strip a single leading/trailing `_` via direct string
  // ops — the regex form `/^_+|_+$/g` is flagged by CodeQL `js/polynomial-redos`
  // even though the prior collapse guarantees a single underscore in a row.
  let asciiBase = baseNoExt
    .replace(/[^\x20-\x7E]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/["\\\x00-\x1F\x7F]/g, "_")
    .replace(/_+/g, "_");
  if (asciiBase.startsWith("_")) asciiBase = asciiBase.slice(1);
  if (asciiBase.endsWith("_")) asciiBase = asciiBase.slice(0, -1);

  const safeAsciiBase =
    asciiBase.length > 0 ? asciiBase : ASCII_FALLBACK_DEFAULT;
  // Cap base length so the FULL filename stays under the limit including the
  // extension. +1 accounts for the dot.
  const maxBase = Math.max(1, FILENAME_MAX_LEN - ext.length - 1);
  const truncatedAscii = safeAsciiBase.slice(0, maxBase);
  const asciiFilename = `${truncatedAscii}.${ext}`;

  // RFC 5987 encoded value: percent-encode the UTF-8 bytes. We use
  // encodeURIComponent and then re-encode the few characters it leaves alone
  // that are still illegal inside a quoted parameter value per RFC 5987
  // (`'*` are reserved in attr-char; `()<>@,;:\"/[]?={}` are tspecials).
  const utfBase = baseNoExt.length > 0 ? baseNoExt : ASCII_FALLBACK_DEFAULT;
  const encodedBase = encodeURIComponent(utfBase).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  // Apply the same overall length cap to the encoded form (percent-encoded
  // bytes count toward the limit so very long unicode names stay bounded).
  let truncatedEncoded = encodedBase.slice(0, maxBase);
  // The slice may land INSIDE a `%XX` triplet (e.g., cutting `%E4%B8` to
  // `%E4%B` for a long CJK name). Strict RFC 3986 / RFC 5987 parsers reject
  // partial percent-encodings, so walk back to the nearest `%` and drop any
  // incomplete trailing sequence. Triplets that fit (`len - lastPercent >= 3`)
  // are kept verbatim.
  const lastPercent = truncatedEncoded.lastIndexOf("%");
  if (lastPercent >= 0 && truncatedEncoded.length - lastPercent < 3) {
    truncatedEncoded = truncatedEncoded.slice(0, lastPercent);
  }
  // The truncation may also leave an incomplete UTF-8 multi-byte sequence
  // (e.g., `%E4` is a valid percent-encoded byte but `0xE4` alone is not
  // valid UTF-8 — it is the lead byte of a 3-byte sequence). Walk back past
  // any trailing UTF-8 lead bytes that lost their continuation bytes so the
  // header value decodes cleanly under strict UTF-8 parsers. Each triplet
  // occupies exactly 3 characters (`%XX`) so the lookback is bounded.
  while (truncatedEncoded.length >= 3) {
    const tail = truncatedEncoded.slice(-3);
    if (tail[0] !== "%") break;
    const byte = parseInt(tail.slice(1), 16);
    // 0xC0-0xFD are UTF-8 lead bytes (2-byte through 6-byte sequences in the
    // historical encoding; only 2-4 byte sequences are valid today). A lead
    // byte at the very end has no continuation byte after it, so drop it.
    // Continuation bytes (0x80-0xBF) sitting alone at the end without their
    // preceding lead byte are also invalid and must be dropped — keep walking
    // back until we find an ASCII byte or a complete multi-byte sequence.
    if (byte >= 0xc0 && byte <= 0xfd) {
      truncatedEncoded = truncatedEncoded.slice(0, -3);
      break;
    }
    if (byte >= 0x80 && byte <= 0xbf) {
      // Standalone continuation byte: drop it and re-evaluate the new tail.
      truncatedEncoded = truncatedEncoded.slice(0, -3);
      continue;
    }
    break;
  }
  const encodedFilename = `${truncatedEncoded}.${ext}`;

  return { asciiFilename, encodedFilename };
};

/**
 * Returns a stable source identifier for the deterministic ETag.
 *
 *  - Local files contribute `mtimeMs:size`, so any edit to the underlying
 *    file invalidates the cache key. The local-file branch is gated behind
 *    `isValidPath` so a traversal / out-of-tree `src` is rejected BEFORE
 *    `fs.stat` ever runs — without this gate, a traversal `src` that happens
 *    to reference an existing file outside `baseDir` would still `fs.stat`
 *    successfully, turning the ETag into an oracle for that file's
 *    mtime/size and decoupling it from the fallback bytes `readLocalImage`
 *    actually serves for the same rejected path.
 *  - An `http(s)` src whose host matches the configured `options.websiteURL`
 *    (the "internal host" case) is resolved to its on-disk path via
 *    `resolveInternalLocalPath` — the same helper `fetchImage` uses to
 *    decide whether to read locally instead of over the network — and falls
 *    through to the SAME local-file branch below, so its ETag tracks the
 *    underlying file's `mtime:size` rather than the immutable URL string.
 *    Without this, overwriting the on-disk file behind an internal-host URL
 *    never changes its ETag, so a client can be served a stale `304`
 *    forever.
 *  - Any other `http(s)` URL contributes the resolved URL string. The
 *    framework cannot cheaply re-fetch HEAD per request, so the URL is the
 *    strongest identifier available without paying for the body.
 *  - A local file (direct path OR resolved from an internal-host URL) whose
 *    size exceeds the optional `options.maxBytes` returns `null` instead of
 *    a `file:` identifier: `readLocalImage` refuses to serve a file that
 *    large and returns the bundled fallback buffer instead, so keying the
 *    ETag on the oversized file's stat would decouple the ETag from the
 *    bytes actually served. Mirrors the size guard in `readLocalImage`.
 *  - Anything else (missing file, out-of-tree/traversal path, fallback
 *    paths) returns `null` so the caller falls back to the post-Sharp
 *    buffer hash — which always matches the bytes actually sent.
 */
export const buildSourceIdentifier = async (
  src: string | undefined,
  baseDir: string,
  options?: {
    websiteURL?: string;
    apiRegex?: RegExp;
    apiPrefix?: string;
    maxBytes?: number;
  },
): Promise<string | null> => {
  if (!src) return null;

  const statLocalFile = async (localPath: string): Promise<string | null> => {
    if (!(await isValidPath(baseDir, localPath))) return null;
    try {
      const resolved = path.resolve(baseDir, localPath);
      const stats = await fs.stat(resolved);
      if (options?.maxBytes !== undefined && stats.size > options.maxBytes) {
        return null;
      }
      return `file:${stats.mtimeMs}:${stats.size}`;
    } catch {
      return null;
    }
  };

  if (src.startsWith("http://") || src.startsWith("https://")) {
    const internalLocalPath = resolveInternalLocalPath(
      src,
      options?.websiteURL,
      options?.apiRegex ?? API_REGEX,
      options?.apiPrefix,
    );
    if (internalLocalPath !== null) {
      return statLocalFile(internalLocalPath);
    }
    return `url:${src}`;
  }

  return statLocalFile(src);
};

/**
 * Builds the deterministic SHA-256 ETag from the resolved user data + source
 * identifier. The result is wrapped in double-quotes per RFC 7232.
 *
 * SHA-256 is used over SHA-1 because the input contains user-controlled fields
 * (post-`idHandler` userId, src). SHA-1's collision weakness flagged by CodeQL
 * `js/weak-cryptographic-algorithm` does not affect ETag correctness in
 * practice, but a modern hash keeps static analysis green and removes any
 * theoretical concern about a third party forging a matching ETag.
 */
export const buildDeterministicEtag = (
  fields: {
    src: string | undefined;
    width: number | undefined;
    height: number | undefined;
    format: string;
    quality: number;
    type: ImageType;
    folder: "public" | "private";
    parsedUserId: string | undefined;
  },
  sourceIdentifier: string,
): string => {
  const key = JSON.stringify({
    src: fields.src ?? "",
    w: fields.width ?? "",
    h: fields.height ?? "",
    f: fields.format,
    q: fields.quality,
    t: fields.type,
    fo: fields.folder,
    u: fields.parsedUserId ?? "",
    sid: sourceIdentifier,
  });
  return `"${createHash("sha256").update(key).digest("hex")}"`;
};

/**
 * @typedef {Object} Options
 * @property {string} baseDir - The base directory for public image files.
 * @property {function(string): string} idHandler - A function to handle user IDs.
 * @property {function(string, Request): Promise<string>} getUserFolder - Asynchronous function to retrieve user-specific folders.
 * @property {string} websiteURL - The base URL of the website for internal link resolution.
 * @property {RegExp} apiRegex - Regex to parse API endpoints from URLs.
 * @property {string[]} allowedNetworkList - List of allowed network domains for external image fetching.
 */

/**
 * Races a promise against a timeout and clears the timer on settle so it
 * cannot pin the event loop after the race resolves.
 */
const raceWithTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Verifies that `candidate` is contained within `rootDir`. Used to enforce
 * `getUserFolderRootDir` containment so a buggy or malicious `getUserFolder`
 * implementation cannot expand the framework's filesystem surface area
 * beyond an opt-in root.
 *
 * Both the **root** and the **candidate** are normalized via `fs.realpath`
 * before the containment check. This catches symlink escapes (a path that
 * lexically lives inside the root but whose final segment is a symlink
 * pointing outward) at the containment layer rather than waiting for the
 * downstream `isValidPath` read. When `fs.realpath` fails — typically
 * because the candidate is a lazy per-user directory that doesn't exist
 * yet — the function falls back to the lexical `path.resolve` value so
 * containment can still be evaluated; the descendant `isValidPath()`
 * check then realpaths the actual file before reading.
 *
 * The optional `preResolvedRoot` parameter lets the middleware factory
 * cache the resolved root path once at startup and skip the per-request
 * `fs.realpath` syscall on the root side. When supplied, the function
 * treats it as the already-resolved value.
 *
 * Returns `true` when the candidate is inside the root (or equal to it).
 * Returns `false` for empty inputs and any escape detected lexically or
 * via realpath.
 */
export const isInsideRoot = async (
  rootDir: string,
  candidate: string,
  preResolvedRoot?: string,
): Promise<boolean> => {
  if (!rootDir || !candidate) return false;
  let realRoot: string;
  if (preResolvedRoot !== undefined) {
    // The factory already paid the realpath cost — use the cached value.
    realRoot = preResolvedRoot;
  } else {
    try {
      realRoot = await fs.realpath(path.resolve(rootDir));
    } catch {
      // Root does not exist or is unreadable; fall back to lexical resolve
      // so a not-yet-created root tree can still be evaluated. Symlink
      // escapes from this branch are out of scope — the caller opted into a
      // root that does not exist yet, and any descendant `isValidPath`
      // check will still realpath the final candidate before reading.
      realRoot = path.resolve(rootDir);
    }
  }

  const lexicalCandidate = path.resolve(candidate);
  // Resolve the candidate through realpath so a `getUserFolder` result that
  // is a symlink pointing outside the root is caught here rather than
  // silently passing the lexical-prefix check. When the candidate does not
  // exist on disk yet, fall back to the lexical resolve — the descendant
  // isValidPath() check will realpath the final file before reading.
  let realCandidate: string;
  try {
    realCandidate = await fs.realpath(lexicalCandidate);
  } catch {
    realCandidate = lexicalCandidate;
  }
  if (realRoot === realCandidate) return true;
  const relative = path.relative(realRoot, realCandidate);
  if (relative === "" || relative === ".") return true;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * Resolves a configured `getUserFolderRootDir` to its canonical realpath
 * once at middleware-factory time. Returns the lexically-resolved path
 * when the directory does not yet exist or `fs.realpath` fails so a lazy
 * containment root can still be evaluated against future requests.
 *
 * Exported so consumers can pre-resolve their own roots for unit tests.
 */
export const resolveRootDir = async (rootDir: string): Promise<string> => {
  try {
    return await fs.realpath(path.resolve(rootDir));
  } catch {
    return path.resolve(rootDir);
  }
};

/**
 * Matches a `<!DOCTYPE …>` declaration that names `svg` as the document's
 * root element (e.g. `<!DOCTYPE svg PUBLIC …>` or `<!DOCTYPE svg [ … ]>`).
 * ANCHORED to the start of the string it is tested against: callers first
 * strip any leading `<?xml …?>` declaration and `<!-- … -->` comment prolog
 * (via `skipXmlProlog`), so this matches a genuine top-level DOCTYPE token
 * and NOT the literal characters `<!doctype svg` appearing inside a comment's
 * prose (which would wrongly flag a non-SVG document that merely mentions the
 * phrase). The trailing `(?:[\s[>]|$)` boundary keeps it from false-matching
 * a longer root name (`<!DOCTYPE svgish>`).
 *
 * A DOCTYPE naming `svg` as its root is an unambiguous SVG signal on its own,
 * independent of where — or whether — the literal `<svg` root tag falls
 * inside the scanned window: an oversized internal-subset DTD (a
 * billion-laughs entity-bomb) can pad the `<svg` tag past the 4 KiB window,
 * so the DOCTYPE's own root name is the only reliable in-window signal.
 */
const DOCTYPE_SVG_ROOT = /^<!doctype\s+svg(?:[\s[>]|$)/;

/**
 * Skips a leading XML prolog — an optional `<?xml …?>` declaration and any
 * number of `<!-- … -->` comments, in any order, plus surrounding ASCII
 * whitespace — and returns the remainder of `s` starting at the first real
 * markup token. Uses `indexOf` only (no regex backtracking), so it stays
 * linear-time and ReDoS-free on hostile input.
 *
 * If a construct is not closed within `s` (e.g. an oversized comment padded
 * past the 4 KiB scan window so its `-->` never appears in the head),
 * skipping stops and the still-open remainder is returned as-is; that
 * remainder then fails the `<!doctype svg` check and the buffer is left to
 * Sharp's own `meta.format === "svg"` guard (the documented defense-in-depth
 * layer — see the "metadata-based Sharp guards" tests).
 */
const skipXmlProlog = (s: string): string => {
  let i = 0;
  const skipWs = (): void => {
    while (
      i < s.length &&
      (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")
    ) {
      i++;
    }
  };
  for (;;) {
    skipWs();
    if (s.startsWith("<?xml", i)) {
      const end = s.indexOf("?>", i);
      if (end === -1) return s.slice(i);
      i = end + 2;
      continue;
    }
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i);
      if (end === -1) return s.slice(i);
      i = end + 3;
      continue;
    }
    return s.slice(i);
  }
};

/**
 * Classifies an already-`trimStart()`ed, lowercased head string as SVG or
 * not. Shared by the latin1/UTF-8 and UTF-16 BOM decode paths so the two
 * cannot drift. Only ever runs its scans on a head that begins with a
 * recognized XML prolog, so it never inspects arbitrary raster bytes.
 *
 *  - A leading `<svg` root tag is conclusive.
 *  - Behind a recognized prolog (`<?xml`/`<!--`/`<!doctype`): an in-window
 *    `<svg[\s>]` root tag is conclusive (the intentionally-conservative
 *    scan), AND — after skipping the leading `<?xml …?>`/comment prolog — a
 *    genuine top-level `<!DOCTYPE svg …>` declaration is conclusive even when
 *    an oversized entity-bomb DTD pushes the `<svg` root past the window.
 *    Anchoring the DOCTYPE check to the post-prolog position (rather than an
 *    unanchored substring search) avoids false-positiving a non-SVG document
 *    whose comment prose merely mentions the characters `<!doctype svg`.
 *  - Anything else is not SVG.
 */
const headLooksLikeSvg = (head: string): boolean => {
  if (head.startsWith("<svg")) return true;
  if (
    head.startsWith("<?xml") ||
    head.startsWith("<!--") ||
    head.startsWith("<!doctype")
  ) {
    if (/<svg[\s>]/.test(head)) return true;
    return DOCTYPE_SVG_ROOT.test(skipXmlProlog(head));
  }
  return false;
};

/**
 * Detects whether a buffer is an SVG by inspecting its leading bytes for
 * common SVG / XML markers. Tolerates UTF-8 BOM, UTF-16 BE/LE BOMs, leading
 * ASCII whitespace (incl. whitespace BEFORE a BOM), `<?xml` prologs, and
 * `<!--` comments preceding the `<svg` root element. Reads up to 4 KiB so
 * pathologically large XML prologs cannot push `<svg` out of the inspection
 * window. A `<!DOCTYPE …>` prolog is recognized the same way — and when the
 * prolog names `svg` as the DOCTYPE's root element (`<!doctype svg`), that
 * alone is treated as conclusive, even if an oversized internal subset (a
 * billion-laughs entity-bomb DTD) pushes the `<svg` root past the 4 KiB
 * window. This DOCTYPE-root signal fires whether the buffer opens directly
 * with `<!doctype` OR the DOCTYPE sits behind an `<?xml …?>` declaration or
 * an XML comment (see `DOCTYPE_SVG_ROOT`), so the entity-bomb defense is not
 * limited to the bare-`<!doctype`-first shape.
 *
 * The detector is intentionally conservative — any buffer that looks even
 * vaguely SVG-shaped is rejected when `allowSvgInput` is false. This guards
 * against billion-laughs / nested-use SVG bombs that libvips/librsvg parses.
 */
export const looksLikeSvg = (buf: Buffer): boolean => {
  if (!buf || buf.length === 0) return false;
  let start = 0;
  // Skip leading ASCII whitespace (tab, LF, CR, space) before checking BOMs.
  // An attacker who prefixes a single 0x20 byte before the BOM previously
  // bypassed the detector.
  while (
    start < buf.length &&
    (buf[start] === 0x09 ||
      buf[start] === 0x0a ||
      buf[start] === 0x0d ||
      buf[start] === 0x20)
  ) {
    start++;
  }

  // UTF-16 BE / LE BOMs — re-decode the head as UTF-16 then run the heuristic.
  // UTF-16 SVGs are exotic but cheap to defend against.
  if (
    buf.length >= start + 2 &&
    ((buf[start] === 0xfe && buf[start + 1] === 0xff) ||
      (buf[start] === 0xff && buf[start + 1] === 0xfe))
  ) {
    const isLe = buf[start] === 0xff;
    const sliceEnd = Math.min(buf.length, start + 2 + 4096);
    // Node's `toString("utf16le")` decodes LE bytes verbatim. For BE we swap
    // bytes pair-wise into a temp buffer so the same decoder produces the
    // intended characters.
    let head16: string;
    if (isLe) {
      head16 = buf.subarray(start + 2, sliceEnd).toString("utf16le");
    } else {
      const beSrc = buf.subarray(start + 2, sliceEnd);
      const swapped = Buffer.alloc(beSrc.length - (beSrc.length % 2));
      for (let i = 0; i + 1 < beSrc.length; i += 2) {
        swapped[i] = beSrc[i + 1]!;
        swapped[i + 1] = beSrc[i]!;
      }
      head16 = swapped.toString("utf16le");
    }
    const trimmed = head16.trimStart().toLowerCase();
    // Shared classifier — identical logic to the latin1/UTF-8 path below, so
    // the two decode paths cannot drift. Gated on a recognized XML prolog,
    // so a UTF-16 BOM-prefixed plain-text buffer that merely contains `<svg`
    // (or the phrase `<!doctype svg`) without a real prolog/DOCTYPE is not
    // over-blocked.
    return headLooksLikeSvg(trimmed);
  }

  // UTF-8 BOM.
  if (
    buf.length >= start + 3 &&
    buf[start] === 0xef &&
    buf[start + 1] === 0xbb &&
    buf[start + 2] === 0xbf
  ) {
    start += 3;
  }

  // Read up to 4 KiB (was 1 KiB) as latin1 to avoid utf8 decode cost; SVG is
  // ASCII so latin1 round-trips every meaningful byte. The wider window
  // covers pathological XML prologs that pad with comments / DOCTYPE before
  // `<svg`.
  const head = buf
    .subarray(start, Math.min(buf.length, start + 4096))
    .toString("latin1")
    .trimStart()
    .toLowerCase();
  return headLooksLikeSvg(head);
};

/**
 * @function serveImage
 * @description Processes and serves an image based on user data and options.
 * @param {Request} req - The Express request object.
 * @param {Response} res - The Express response object.
 * @param {NextFunction} next - The Express next function.
 * @param {ParsedOptions} parsedOptions - Already-validated options produced
 *   once by `registerServe`. The Zod schema parse is paid at factory time
 *   so the request hot path is purely arithmetic — see Task 4.
 * @param {string | undefined} cachedRealRoot - Optional pre-resolved
 *   realpath of `options.getUserFolderRootDir`, populated once by the
 *   middleware factory so per-request containment checks do not pay a
 *   fresh `fs.realpath` syscall on the root side.
 * @returns {Promise<void>}
 */
const serveImage = async (
  req: Request,
  res: Response,
  next: NextFunction,
  parsedOptions: ParsedOptions,
  cachedRealRoot?: string,
): Promise<void> => {
  // Monotonic timestamp captured at the top of every request so the onComplete
  // hook can report end-to-end pipeline latency regardless of which branch
  // (200 happy path, 304 cached short-circuit, or fallback path) was taken.
  const startedAt = process.hrtime.bigint();
  let requestedType: ImageType = "normal";
  // The schema parse already ran once at factory time, so `onError` and
  // `onComplete` are already the validated function references. Aliased into
  // locals so the outer catch (and the same-named helpers below) can read
  // them without re-deriving the values on every request.
  const onError: PixelServeOnError | undefined = parsedOptions.onError;
  const onComplete: PixelServeOnComplete | undefined = parsedOptions.onComplete;
  let observedSrc: string | undefined;
  let observedUserId: string | undefined;
  try {
    let userData: ReturnType<typeof renderUserData>;
    try {
      // `req.query` is typed by Express as `ParsedQs` (recursive string /
      // string[] / nested object). Pass through as `unknown` and let the
      // Zod schema reject any shape that isn't a flat record of primitive
      // strings/numbers — the schema preprocesses `src` to reject arrays
      // (e.g., `?src[]=a&src[]=b`) with a clear error.
      userData = renderUserData(req.query, {
        minWidth: parsedOptions.minWidth,
        maxWidth: parsedOptions.maxWidth,
        minHeight: parsedOptions.minHeight,
        maxHeight: parsedOptions.maxHeight,
        defaultQuality: parsedOptions.defaultQuality,
      });
    } catch (err) {
      reportError(onError, err, { phase: "validation" });
      throw err;
    }

    observedSrc = userData.src;
    observedUserId = userData.userId;
    // userData.type is narrowed to `ImageType` by the schema enum default.
    requestedType = userData.type ?? "normal";

    let baseDir = parsedOptions.baseDir;
    let parsedUserId: string | undefined;

    if (userData.userId) {
      parsedUserId = userData.userId;
      if (parsedOptions.idHandler) {
        const rawUserId = userData.userId;
        const idTimeoutMs =
          parsedOptions.idHandlerTimeoutMs ?? parsedOptions.requestTimeoutMs;
        try {
          const handlerResult = Promise.resolve().then(() =>
            parsedOptions.idHandler!(rawUserId),
          );
          const candidate = await raceWithTimeout(
            handlerResult,
            idTimeoutMs,
            "idHandler",
          );
          parsedUserId = typeof candidate === "string" ? candidate : rawUserId;
          if (typeof candidate !== "string") {
            reportError(
              onError,
              new Error(
                `idHandler returned a non-string value (${typeof candidate})`,
              ),
              {
                phase: "idHandler",
                src: observedSrc,
                userId: rawUserId,
              },
            );
          }
        } catch (err) {
          // idHandler threw, rejected, or timed out — fall back to raw userId.
          parsedUserId = rawUserId;
          reportError(onError, err, {
            phase: "idHandler",
            src: observedSrc,
            userId: rawUserId,
          });
        }
        observedUserId = parsedUserId;
      }
    }

    if (userData.folder === "private" && parsedOptions.getUserFolder) {
      try {
        // Wrap the invocation in `Promise.resolve().then(...)` so a
        // synchronous throw from `getUserFolder` is captured as a rejection
        // and routed through the timeout race + onError hook.
        const folderPromise = Promise.resolve().then(() =>
          parsedOptions.getUserFolder!(req, parsedUserId),
        );
        const dir = await raceWithTimeout(
          folderPromise,
          parsedOptions.requestTimeoutMs,
          "getUserFolder",
        );
        if (dir) {
          // When the user opts into `getUserFolderRootDir`, the framework
          // validates that the returned path resolves to a descendant of the
          // configured root via realpath + path.relative. If the path
          // escapes (e.g., the user-supplied callback joined a malicious
          // `../etc` userId, or a symlink redirects outside the tree), the
          // resolver is treated as a failure: `onError` is invoked with
          // `phase: "getUserFolder"` and the request falls back to the
          // public `baseDir` configured on `PixelServeOptions`.
          if (parsedOptions.getUserFolderRootDir) {
            const inside = await isInsideRoot(
              parsedOptions.getUserFolderRootDir,
              dir,
              cachedRealRoot,
            );
            if (!inside) {
              reportError(
                onError,
                new Error(
                  `getUserFolder returned path "${dir}" outside getUserFolderRootDir "${parsedOptions.getUserFolderRootDir}"`,
                ),
                {
                  phase: "getUserFolder",
                  src: observedSrc,
                  userId: observedUserId,
                },
              );
            } else {
              baseDir = dir;
            }
          } else {
            baseDir = dir;
          }
        }
      } catch (err) {
        // getUserFolder timed out or failed — use default baseDir
        reportError(onError, err, {
          phase: "getUserFolder",
          src: observedSrc,
          userId: observedUserId,
        });
      }
    }

    // `userData.format` is narrowed to `ImageFormat` by the schema — invalid
    // formats coerce to `undefined`, the renderer fills in `"jpeg"`. The
    // `allowedFormats.includes` check is defensive in case `allowedFormats`
    // drifts away from the schema in the future.
    const outputFormat: ImageFormat = allowedFormats.includes(userData.format)
      ? userData.format
      : "jpeg";

    // ------------------------------------------------------------------
    // Deterministic ETag: built BEFORE any Sharp work so `If-None-Match`
    // can short-circuit decode + resize + re-encode entirely. The key
    // combines every input that materially affects the response bytes
    // (src, width, height, format, quality, type, folder, parsedUserId)
    // plus a source identifier (mtime+size for local files, URL string
    // for remote sources). Source-identifier failures degrade to "no
    // deterministic key available" and the pipeline falls back to the
    // legacy buffer hash (defense in depth).
    // ------------------------------------------------------------------
    // `buildSourceIdentifier` swallows its own filesystem errors and returns
    // `null` when no stable key can be derived (missing file, etc.), so this
    // call cannot throw and does not need its own try/catch. The options
    // mirror what `resolveBuffer` below passes to `fetchImage`/
    // `readLocalImage`, so the identifier this computes always matches the
    // branch that will actually serve the bytes.
    const sourceIdentifier = await buildSourceIdentifier(
      userData.src,
      baseDir,
      {
        websiteURL: parsedOptions.websiteURL,
        apiRegex: parsedOptions.apiRegex,
        apiPrefix: parsedOptions.apiPrefix,
        maxBytes: parsedOptions.maxDownloadBytes,
      },
    );

    let etag: string | undefined;
    if (parsedOptions.etag && sourceIdentifier) {
      etag = buildDeterministicEtag(
        {
          src: userData.src,
          width: userData.width,
          height: userData.height,
          format: outputFormat,
          quality: userData.quality,
          type: userData.type,
          folder: userData.folder,
          parsedUserId,
        },
        sourceIdentifier,
      );
      if (req.headers["if-none-match"] === etag) {
        // Short-circuit BEFORE Sharp is touched at all. RFC 9110 §15.4.5: a
        // 304 SHOULD echo the validators its 200 counterpart would have
        // sent. This branch only ever matches a genuine deterministic ETag
        // (a soft fallback always clears `etag`, so a client can never hold
        // a deterministic ETag for a placeholder), so Cache-Control here is
        // unconditionally the configured/default value.
        res.setHeader("Vary", "Accept-Encoding");
        res.setHeader(
          "Cache-Control",
          parsedOptions.cacheControl ?? DEFAULT_CACHE_CONTROL,
        );
        res.setHeader("ETag", etag);
        res.status(304).end();
        safeOnComplete(onComplete, {
          src: observedSrc,
          userId: observedUserId,
          format: outputFormat,
          outputBytes: 0,
          cached: true,
          durationMs: elapsedMs(startedAt),
          // No bytes are sent on a 304 — there is nothing to characterize as
          // fallback-or-not for this response.
          fallback: false,
        });
        return;
      }
    }

    // Set by `markSoftFallback` (threaded into `resolveBuffer` below) when
    // the resolved buffer turned out to be a bundled placeholder rather than
    // genuinely-resolved bytes (missing/invalid local file, blocked host,
    // SSRF-reject, oversized file, transport failure, etc.) — a "soft"
    // fallback that still flows through Sharp and gets re-encoded like any
    // other image. Declared fresh on every `serveImage` invocation (never
    // module- or factory-scoped) so concurrent requests cannot leak the mark
    // between each other.
    let servedSoftFallback = false;
    const markSoftFallback = (): void => {
      servedSoftFallback = true;
    };

    const resolveBuffer = async (): Promise<Buffer> => {
      if (!userData.src) {
        // userData.type is always present (schema defaults to "normal").
        markSoftFallback();
        return FALLBACKIMAGES[userData.type]();
      }
      if (
        userData.src.startsWith("http://") ||
        userData.src.startsWith("https://")
      ) {
        return fetchImage(
          userData.src,
          baseDir,
          parsedOptions.websiteURL,
          userData.type,
          parsedOptions.apiRegex,
          parsedOptions.allowedNetworkList,
          {
            timeoutMs: parsedOptions.requestTimeoutMs,
            maxBytes: parsedOptions.maxDownloadBytes,
            maxRedirects: parsedOptions.maxRedirects,
            onError,
            apiPrefix: parsedOptions.apiPrefix,
            onFallback: markSoftFallback,
          },
        );
      }
      return readLocalImage(
        userData.src,
        baseDir,
        userData.type,
        parsedOptions.maxDownloadBytes,
        onError,
        markSoftFallback,
      );
    };

    const imageBuffer = await resolveBuffer();

    // A soft fallback served a bundled placeholder, not the requested bytes.
    // Do not let it inherit the real-image cache profile: discard any
    // source-derived deterministic ETag so the response is keyed on the
    // actual placeholder bytes instead — the buffer-hash block below then
    // runs unconditionally. Without this, a source that already had a
    // pre-fetch deterministic identifier (e.g. any external URL, whose
    // identifier is computed before the fetch is even attempted) would ship
    // a stale ETag that names the *source*, not the placeholder that was
    // actually sent, letting a future recovered fetch get permanently
    // 304-locked onto the placeholder.
    if (servedSoftFallback) {
      etag = undefined;
    }

    if (!parsedOptions.allowSvgInput && looksLikeSvg(imageBuffer)) {
      const err = new Error("svg input rejected");
      reportError(onError, err, {
        phase: "sharp",
        src: observedSrc,
        userId: observedUserId,
      });
      throw err;
    }

    let processedImage: Buffer;
    try {
      let image = sharp(imageBuffer, {
        failOn: "warning",
        limitInputPixels: parsedOptions.maxInputPixels,
        sequentialRead: true,
        unlimited: false,
      });

      // Peek metadata first to avoid the expensive decode for hostile inputs.
      const meta = await image.metadata();
      if (meta.width && meta.height) {
        if (meta.width * meta.height > parsedOptions.maxInputPixels) {
          throw new Error("input exceeds maxInputPixels");
        }
      }
      if (!parsedOptions.allowSvgInput && meta.format === "svg") {
        throw new Error("svg input rejected");
      }

      // Re-instantiate Sharp because metadata() consumed the stream state.
      image = sharp(imageBuffer, {
        failOn: "warning",
        limitInputPixels: parsedOptions.maxInputPixels,
        sequentialRead: true,
        unlimited: false,
      }).rotate();

      if (userData.width || userData.height) {
        const resizeOptions: ResizeOptions = {
          width: userData.width ?? undefined,
          height: userData.height ?? undefined,
          fit: sharp.fit.cover,
          withoutEnlargement: true,
        };
        image = image.resize(resizeOptions);
      }

      processedImage = await image
        .toFormat(outputFormat as keyof FormatEnum, {
          quality: userData.quality,
        })
        .toBuffer();
    } catch (err) {
      reportError(onError, err, {
        phase: "sharp",
        src: observedSrc,
        userId: observedUserId,
      });
      throw err;
    }

    // Fallback ETag: if no deterministic source identifier was available, OR
    // the deterministic ETag was just discarded above because this response
    // is a soft fallback, hash the processed buffer instead. This preserves
    // the historical behavior for sources that cannot produce a stable key
    // (e.g., missing file paths) and additionally keys every soft-fallback
    // response on the placeholder bytes actually sent.
    if (parsedOptions.etag && !etag) {
      etag = `"${createHash("sha256").update(processedImage).digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) {
        // RFC 9110 §15.4.5: echo the same validators the 200 would have
        // sent. Unlike the pre-Sharp 304 above, `servedSoftFallback` is
        // already known here, so Cache-Control must track it too — otherwise
        // a recurring placeholder (e.g. a still-missing local file) would get
        // re-validated under the long-lived real-image policy instead of the
        // short fallback one it was originally served with.
        res.setHeader("Vary", "Accept-Encoding");
        res.setHeader(
          "Cache-Control",
          servedSoftFallback
            ? FALLBACK_CACHE_CONTROL
            : (parsedOptions.cacheControl ?? DEFAULT_CACHE_CONTROL),
        );
        res.setHeader("ETag", etag);
        res.status(304).end();
        safeOnComplete(onComplete, {
          src: observedSrc,
          userId: observedUserId,
          format: outputFormat,
          outputBytes: 0,
          cached: true,
          durationMs: elapsedMs(startedAt),
          // No bytes are sent on a 304 — there is nothing to characterize as
          // fallback-or-not for this response, even if the resolved buffer
          // (hashed above) happened to be a soft-fallback placeholder.
          fallback: false,
        });
        return;
      }
    }

    const { asciiFilename, encodedFilename } = buildFilename(
      userData.src,
      outputFormat,
    );

    res.type(mimeTypes[outputFormat]);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
    );
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Cache-Control",
      servedSoftFallback
        ? FALLBACK_CACHE_CONTROL
        : (parsedOptions.cacheControl ?? DEFAULT_CACHE_CONTROL),
    );
    if (etag) {
      res.setHeader("ETag", etag);
    }
    res.setHeader("Content-Length", processedImage.length.toString());
    res.send(processedImage);
    safeOnComplete(onComplete, {
      src: observedSrc,
      userId: observedUserId,
      format: outputFormat,
      outputBytes: processedImage.length,
      cached: false,
      durationMs: elapsedMs(startedAt),
      fallback: servedSoftFallback,
    });
  } catch {
    // If the success path already started flushing the response (e.g., a
    // future streaming refactor calls `res.write` before `res.send`), we
    // cannot recover into a fresh fallback without tripping
    // ERR_HTTP_HEADERS_SENT. Surface to the Express error handler instead so
    // the connection is torn down cleanly. Today the happy path only flushes
    // via `res.send` at the very end, so this guard is defence-in-depth.
    if (res.headersSent) {
      const flushedError = new Error("response already flushed");
      reportError(onError, flushedError, {
        phase: "fs",
        src: observedSrc,
        userId: observedUserId,
      });
      next(flushedError);
      return;
    }
    try {
      const fallbackType = requestedType === "avatar" ? "avatar" : "normal";
      const fallback = await FALLBACKIMAGES[fallbackType]();
      // The bundled fallback assets are pre-encoded and sent here VERBATIM
      // (this error path deliberately skips Sharp re-encoding), so the
      // response Content-Type and filename extension must match the asset
      // actually served: the avatar fallback (`noavatar.png`) is a PNG while
      // the normal fallback (`noimage.jpg`) is a JPEG. Hardcoding JPEG here
      // mislabels the PNG avatar bytes as `image/jpeg`.
      const fallbackFormat = fallbackType === "avatar" ? "png" : "jpeg";
      res.type(mimeTypes[fallbackFormat]);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="fallback.${fallbackFormat}"`,
      );
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", FALLBACK_CACHE_CONTROL);
      res.send(fallback);
      // The hard-fallback path now fires onComplete too (fallback:true) so
      // every response that resolves to a 200 fires the hook exactly once —
      // previously this catch branch left onComplete silent entirely,
      // leaving a consumer unable to distinguish "no completion signal
      // arrived" from "the pipeline is quietly serving 200s full of
      // placeholder bytes."
      safeOnComplete(onComplete, {
        src: observedSrc,
        userId: observedUserId,
        format: fallbackFormat,
        outputBytes: fallback.length,
        cached: false,
        durationMs: elapsedMs(startedAt),
        fallback: true,
      });
    } catch (fallbackError) {
      reportError(onError, fallbackError, {
        phase: "fs",
        src: observedSrc,
        userId: observedUserId,
      });
      next(fallbackError);
    }
  }
};

/**
 * @function registerServe
 * @description A function to register the serveImage function as middleware for Express.
 * @param {PixelServeOptions} options - The options object for image processing.
 * @returns {function(Request, Response, NextFunction): Promise<void>} The middleware function.
 *
 * The factory eagerly validates `options` via `optionsSchema.parse` exactly
 * **once** at registration time (Task 4) so the request hot path does not
 * re-run the Zod schema, refine() callbacks, regex matches, or the
 * `allowedNetworkList` trim/lowercase transform on every request. Operator
 * misconfiguration is surfaced synchronously: the eagerly-captured
 * `options.onError` hook (if any) receives `{ phase: "schema" }` and the
 * factory re-throws so the failure is loud at startup rather than silent
 * fallback noise per-request.
 *
 * The factory also eagerly resolves `options.getUserFolderRootDir` via
 * `fs.realpath` once and caches the result. Every subsequent request reuses
 * the cached realpath inside `isInsideRoot`, so the per-request containment
 * check costs zero extra filesystem syscalls on the root side. When the
 * configured root does not yet exist on disk, the factory falls back to a
 * lexical `path.resolve` so the containment check still works for lazily-
 * created trees.
 */
const registerServe = (
  options: PixelServeOptions,
): ((req: Request, res: Response, next: NextFunction) => Promise<void>) => {
  // Validate options exactly once at factory time. On failure, fire the
  // eagerly-captured onError hook with `phase: "schema"` so operators that
  // wired up observability still see the misconfiguration, then re-throw so
  // the deployment fails loudly at startup rather than serving fallback
  // images forever.
  let parsedOptions: ParsedOptions;
  try {
    parsedOptions = renderOptions(options);
  } catch (err) {
    reportError(options.onError, err, { phase: "schema" });
    throw err;
  }

  // Cached real path of the configured containment root. Populated lazily on
  // the first request that needs it so the factory itself stays synchronous
  // (no awaits at module-load time) and the cost is paid exactly once.
  let cachedRealRoot: string | undefined;
  let cacheResolved = false;
  let pendingResolution: Promise<string> | undefined;

  const ensureCachedRealRoot = async (rootDir: string): Promise<string> => {
    if (cacheResolved && cachedRealRoot !== undefined) return cachedRealRoot;
    // Coalesce concurrent first-request resolutions so a burst of N requests
    // produces exactly one realpath syscall rather than N.
    if (!pendingResolution) {
      pendingResolution = resolveRootDir(rootDir).then((resolved) => {
        cachedRealRoot = resolved;
        cacheResolved = true;
        return resolved;
      });
    }
    return pendingResolution;
  };

  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    let rootForRequest: string | undefined;
    if (parsedOptions.getUserFolderRootDir) {
      rootForRequest = await ensureCachedRealRoot(
        parsedOptions.getUserFolderRootDir,
      );
    }
    return serveImage(req, res, next, parsedOptions, rootForRequest);
  };
};

export default registerServe;
