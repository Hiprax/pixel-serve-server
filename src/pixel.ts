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
import { allowedFormats, FALLBACKIMAGES, mimeTypes } from "./variables";
import { fetchImage, readLocalImage } from "./functions";
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
 * Best-effort observability hook dispatcher for the success / 304 path.
 * Swallows hook errors so a buggy logger never crashes a request. Returns
 * void. Mirrors `reportError`'s contract so consumers can rely on the same
 * dispatch guarantees for both observability surfaces.
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
  // plus quote / backslash / control / DEL, with `_`. Then collapse runs of
  // `_` and trim leading/trailing underscores so the output is still readable.
  const asciiBase = baseNoExt
    .replace(/[^\x20-\x7E]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/["\\\x00-\x1F\x7F]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

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
 *    file invalidates the cache key.
 *  - Remote URLs contribute the resolved URL string. The framework cannot
 *    cheaply re-fetch HEAD per request, so the URL is the strongest
 *    identifier available without paying for the body.
 *  - Anything else (missing file, fallback paths) returns `null` so the
 *    caller falls back to the post-Sharp buffer hash.
 */
export const buildSourceIdentifier = async (
  src: string | undefined,
  baseDir: string,
): Promise<string | null> => {
  if (!src) return null;
  if (src.startsWith("http://") || src.startsWith("https://")) {
    return `url:${src}`;
  }
  try {
    const resolved = path.resolve(baseDir, src);
    const stats = await fs.stat(resolved);
    return `file:${stats.mtimeMs}:${stats.size}`;
  } catch {
    return null;
  }
};

/**
 * Builds the deterministic SHA1 ETag from the resolved user data + source
 * identifier. The result is wrapped in double-quotes per RFC 7232.
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
  return `"${createHash("sha1").update(key).digest("hex")}"`;
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
 * Containment is checked **lexically on the candidate side** so that lazy
 * per-user directories (created on first write) are accepted before they
 * exist on disk. The root side is normalized via `fs.realpath` when
 * possible — symlinks pointing into the root resolve correctly — and falls
 * back to lexical `path.resolve` when the root itself cannot be read.
 *
 * Symlink escapes from the candidate side (e.g., a symlink inside the root
 * that points outward) are caught later by `isValidPath`'s realpath check
 * inside `readLocalImage`. The two-pass design covers both states:
 *   1. lexical containment here for the missing-directory case,
 *   2. realpath there for the symlink-escape case.
 *
 * The optional `preResolvedRoot` parameter lets the middleware factory
 * cache the resolved root path once at startup and skip the per-request
 * `fs.realpath` syscall on the root side. When supplied, the function
 * treats it as the already-resolved value and runs the lexical check only.
 *
 * Returns `true` when the candidate is inside the root (or equal to it).
 * Returns `false` for empty inputs and any escape detected lexically.
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
 * Detects whether a buffer is an SVG by inspecting its leading bytes for
 * common SVG / XML markers. Tolerates UTF-8 BOM, UTF-16 BE/LE BOMs, leading
 * ASCII whitespace (incl. whitespace BEFORE a BOM), `<?xml` prologs, and
 * `<!--` comments preceding the `<svg` root element. Reads up to 4 KiB so
 * pathologically large XML prologs cannot push `<svg` out of the inspection
 * window.
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
    if (trimmed.startsWith("<svg")) return true;
    if (trimmed.startsWith("<?xml") || trimmed.startsWith("<!--")) {
      return /<svg[\s>]/.test(trimmed);
    }
    return /<svg[\s>]/.test(trimmed);
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
  if (head.startsWith("<svg")) return true;
  if (head.startsWith("<?xml") || head.startsWith("<!--")) {
    return /<svg[\s>]/.test(head);
  }
  return false;
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
    // call cannot throw and does not need its own try/catch.
    const sourceIdentifier = await buildSourceIdentifier(userData.src, baseDir);

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
        // Short-circuit BEFORE Sharp is touched at all.
        res.status(304).end();
        safeOnComplete(onComplete, {
          src: observedSrc,
          userId: observedUserId,
          format: outputFormat,
          outputBytes: 0,
          cached: true,
          durationMs: elapsedMs(startedAt),
        });
        return;
      }
    }

    const resolveBuffer = async (): Promise<Buffer> => {
      if (!userData.src) {
        // userData.type is always present (schema defaults to "normal").
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
          },
        );
      }
      return readLocalImage(
        userData.src,
        baseDir,
        userData.type,
        parsedOptions.maxDownloadBytes,
        onError,
      );
    };

    const imageBuffer = await resolveBuffer();

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

    // Fallback ETag: if no deterministic source identifier was available,
    // hash the processed buffer. This preserves the historical behavior for
    // sources that cannot produce a stable key (e.g., missing file paths).
    if (parsedOptions.etag && !etag) {
      etag = `"${createHash("sha1").update(processedImage).digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        safeOnComplete(onComplete, {
          src: observedSrc,
          userId: observedUserId,
          format: outputFormat,
          outputBytes: 0,
          cached: true,
          durationMs: elapsedMs(startedAt),
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
    res.setHeader(
      "Cache-Control",
      parsedOptions.cacheControl ??
        "public, max-age=86400, stale-while-revalidate=604800",
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
      res.type(mimeTypes.jpeg);
      res.setHeader("Content-Disposition", `inline; filename="fallback.jpeg"`);
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("Cache-Control", "public, max-age=60");
      res.send(fallback);
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
