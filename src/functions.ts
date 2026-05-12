import path from "node:path";
import * as fs from "node:fs/promises";
import * as dns from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import axios, { AxiosError, AxiosResponse } from "axios";
import { FALLBACKIMAGES, mimeTypes } from "./variables";
import type { ImageType, PixelServeOnError } from "./types";

/**
 * Internal helper that fires the user-supplied `onError` hook without ever
 * propagating a hook error back into the request pipeline. Mirrors the
 * dispatcher in `pixel.ts`; duplicated to avoid a circular import.
 */
const safeOnError = (
  hook: PixelServeOnError | undefined,
  err: unknown,
  phase: string,
  src?: string,
): void => {
  if (!hook) return;
  try {
    hook(err, { phase, src });
  } catch {
    // intentionally suppressed
  }
};

/**
 * @typedef {("avatar" | "normal")} ImageType
 * @description Defines the type of image being processed.
 */

/**
 * Maximum length accepted for `specifiedPath`. Both Windows (260 by default,
 * 32767 with `\\?\` LFN prefix) and POSIX (`PATH_MAX` is typically 4096) cap
 * absolute path lengths, but the input here is a relative segment joined to
 * `basePath`, so we cap defensively below the POSIX limit to avoid pathological
 * inputs forcing megabyte string allocations through `path.resolve`.
 */
const MAX_SPECIFIED_PATH_LEN = 4096;

/**
 * Checks if a specified path is valid within a base path.
 *
 * Performs shape validation first (no null bytes, no control characters
 * including `DEL`/`\x7F`, no backslashes on any platform, no absolute paths,
 * length cap), then resolves both `basePath` and the joined path via
 * `fs.realpath`, then asserts containment via `path.relative` plus a
 * prefix check.
 *
 * Cross-platform notes:
 *
 *   - Backslashes are rejected on **all** platforms (not just Windows). On
 *     POSIX, literal `\\` is a valid filename byte; on Windows it is a
 *     directory separator. Allowing the divergence silently is a security
 *     smell, so this guard rejects backslash universally to keep behavior
 *     consistent.
 *   - UNC paths (`\\server\share\...`) are caught by both the backslash
 *     check and `path.isAbsolute` on Windows.
 *   - `\x7F` (DEL) is part of the control-character regex so request paths
 *     containing it are rejected (the `Content-Disposition` sanitizer in
 *     `pixel.ts` also strips `\x7F`; keeping the two consistent here matters).
 *
 * TOCTOU caveat: this function calls `fs.realpath` to validate containment,
 * but `pixel.ts` later re-resolves the path and calls `fs.readFile`
 * independently. Between those two calls the filesystem could change (for
 * example, a symlink target could be swapped). For an image-serving pipeline
 * the resulting worst case is a fallback image being returned; for higher
 * security workloads, callers should mount images on a read-only filesystem
 * or run the process with `fs.open` + atime-checked file handles. This is
 * accepted risk for the default deployment model.
 *
 * @param {string} basePath - The base directory to resolve paths.
 * @param {string} specifiedPath - The path to check.
 * @returns {Promise<boolean>} True if the path is valid, false otherwise.
 */
export const isValidPath = async (
  basePath: string,
  specifiedPath: string,
): Promise<boolean> => {
  try {
    if (!basePath || !specifiedPath) return false;
    if (typeof specifiedPath !== "string") return false;
    if (specifiedPath.length > MAX_SPECIFIED_PATH_LEN) return false;
    if (specifiedPath.includes("\0")) return false;
    // Reject backslash on ALL platforms. On POSIX this is technically a
    // legal filename byte, but on Windows it is a path separator that can
    // be used for traversal. Rejecting unconditionally keeps cross-platform
    // behavior identical and removes a silent divergence.
    if (specifiedPath.includes("\\")) return false;
    if (path.isAbsolute(specifiedPath)) return false;
    // Reject every control character (`\x00`–`\x1F`) and `\x7F` (DEL).
    // eslint-disable-next-line no-control-regex
    if (!/^[^\x00-\x1F\x7F]+$/.test(specifiedPath)) return false;

    const resolvedBase = path.resolve(basePath);
    const resolvedPath = path.resolve(resolvedBase, specifiedPath);

    const [realBase, realPath] = await Promise.all([
      fs.realpath(resolvedBase),
      fs.realpath(resolvedPath),
    ]);

    const baseStats = await fs.stat(realBase);
    if (!baseStats.isDirectory()) return false;

    // The resolved path must be a regular file (or symlink to one), not a
    // directory. Image serving never returns directory listings, and
    // rejecting directories prevents callers from accidentally short-
    // circuiting fallback logic when an attacker references the root.
    const pathStats = await fs.stat(realPath);
    if (!pathStats.isFile()) return false;

    const normalizedBase = realBase + path.sep;
    const normalizedPath = realPath + path.sep;

    const isInside =
      normalizedPath.startsWith(normalizedBase) || realPath === realBase;

    const relative = path.relative(realBase, realPath);
    return !relative.startsWith("..") && !path.isAbsolute(relative) && isInside;
  } catch {
    return false;
  }
};

/**
 * Determines if an IP address (v4 or v6) is private, loopback, link-local,
 * unique-local, multicast, broadcast, or otherwise unsafe to issue requests to.
 *
 * @param {string} ip - The IP address to check.
 * @returns {boolean} True if the IP is considered private/internal.
 */
export const isPrivateIp = (ip: string): boolean => {
  const family = isIP(ip);
  if (family === 0) return true; // not a valid IP — treat as unsafe

  if (family === 4) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b] = parts;
    // 0.0.0.0/8
    if (a === 0) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local, AWS IMDS)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments) and 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 0) return true;
    // 198.18.0.0/15 (benchmarking)
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (a === 198 && b === 51 && parts[2] === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (a === 203 && b === 0 && parts[2] === 113) return true;
    // 224.0.0.0/4 (multicast)
    if (a >= 224 && a <= 239) return true;
    // 240.0.0.0/4 (reserved / 255.255.255.255 broadcast)
    if (a >= 240) return true;
    return false;
  }

  // IPv6 — normalize lowercase
  const lower = ip.toLowerCase();
  // unspecified ::
  if (lower === "::" || lower === "::0") return true;
  // loopback ::1
  if (lower === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d) — any malformed v4 tail is treated as unsafe
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice("::ffff:".length);
    if (isIP(v4) === 4) return isPrivateIp(v4);
    return true;
  }
  // link-local fe80::/10
  if (/^fe[89ab][0-9a-f]?:/i.test(lower)) return true;
  // unique-local fc00::/7
  if (/^f[cd][0-9a-f]{0,2}:/i.test(lower)) return true;
  // multicast ff00::/8
  if (lower.startsWith("ff")) return true;
  return false;
};

/**
 * Resolves a hostname via DNS and verifies every returned address is a public
 * (non-private/loopback/link-local) IP. If the hostname is already an IP
 * literal, validates that directly without a DNS lookup.
 *
 * @param {string} hostname - The hostname to validate.
 * @returns {Promise<boolean>} True if the hostname only resolves to public IPs.
 */
export const isPublicHost = async (hostname: string): Promise<boolean> => {
  if (!hostname) return false;
  // strip brackets that URL.hostname leaves around IPv6 literals
  const stripped = hostname.replace(/^\[|\]$/g, "");
  if (isIP(stripped) !== 0) return !isPrivateIp(stripped);

  try {
    const addresses = await dns.lookup(stripped, { all: true, verbatim: true });
    if (!addresses.length) return false;
    return addresses.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
};

/**
 * Resolves a hostname once, validates every returned address is public, and
 * returns a `{ address, family }` pair that can be pinned to an
 * `http.Agent`/`https.Agent`'s `lookup` function. The same address is then
 * guaranteed to be the one the TCP socket connects to, closing the DNS-
 * rebinding window between the validation lookup and axios' subsequent
 * resolve. For IP literals the input is returned verbatim (still subject to
 * `isPrivateIp`) and no DNS lookup is performed.
 *
 * Returns `null` when the host is empty, the host resolves to no addresses,
 * the host resolves to (or is) a private/loopback/link-local IP, or DNS
 * resolution fails. Callers fall back to the regular failure path on `null`.
 */
export const resolvePinnedAddress = async (
  hostname: string,
): Promise<{ address: string; family: 4 | 6 } | null> => {
  if (!hostname) return null;
  const stripped = hostname.replace(/^\[|\]$/g, "");
  if (isIP(stripped) !== 0) {
    if (isPrivateIp(stripped)) return null;
    const family = isIP(stripped) === 6 ? 6 : 4;
    return { address: stripped, family };
  }
  try {
    const addresses = await dns.lookup(stripped, { all: true, verbatim: true });
    if (!addresses.length) return null;
    if (addresses.some((a) => isPrivateIp(a.address))) return null;
    const first = addresses[0]!;
    return {
      address: first.address,
      family: first.family === 6 ? 6 : 4,
    };
  } catch {
    return null;
  }
};

/**
 * Internal type for the Node `lookup` callback shape we override below.
 * Exported only for tests; real consumers should not depend on it.
 */
type PinnedLookup = (
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number,
  ) => void,
) => void;

/**
 * Builds a pinned `lookup` function that always resolves to the same
 * `{ address, family }` pair. Used by `buildPinnedAgents` to force axios to
 * connect to the pre-validated IP rather than re-resolving the hostname.
 */
const buildPinnedLookup =
  (address: string, family: 4 | 6): PinnedLookup =>
  (_hostname, _options, callback): void => {
    callback(null, address, family);
  };

/**
 * Builds `httpAgent` and `httpsAgent` instances whose internal `lookup`
 * function is pinned to a single `{ address, family }` pair. Passed to axios
 * via the per-request config so the kernel resolver is never consulted again
 * after our `isPublicHost` validation. Mitigates the classic DNS-rebinding
 * exploit where an attacker-controlled authoritative server answers the
 * validation lookup with a public IP and the subsequent connect-time lookup
 * with `127.0.0.1`/`169.254.169.254`/etc.
 *
 * Each call returns a new pair of agents (one per request); the agents are
 * not reused across requests so the pinning lifetime matches the redirect
 * loop hop that validated the IP. Agents are not explicitly `destroy()`-ed
 * because Node garbage-collects unused agents once their sockets close.
 */
export const buildPinnedAgents = (
  address: string,
  family: 4 | 6,
): { httpAgent: http.Agent; httpsAgent: https.Agent } => {
  const lookup = buildPinnedLookup(address, family);
  return {
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup }),
  };
};

const isHostAllowed = (
  hostname: string,
  host: string,
  allowedNetworkList: string[],
): boolean =>
  allowedNetworkList.includes(hostname) || allowedNetworkList.includes(host);

/**
 * Issues a single (non-redirecting) GET request and returns the axios response
 * or null on transport error / non-2xx (when redirects are present). The
 * caller supplies a pinned pair of `httpAgent`/`httpsAgent` so the TCP
 * connection targets the IP that was validated by `resolvePinnedAddress`
 * rather than whatever the kernel resolver returns at connect time.
 */
const requestNoRedirect = async (
  src: string,
  timeoutMs: number,
  maxBytes: number,
  agents: { httpAgent: http.Agent; httpsAgent: https.Agent },
): Promise<AxiosResponse | null> => {
  try {
    return await axios.get(src, {
      responseType: "arraybuffer",
      timeout: timeoutMs,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      maxRedirects: 0,
      httpAgent: agents.httpAgent,
      httpsAgent: agents.httpsAgent,
      validateStatus: (status) =>
        (status >= 200 && status < 300) || (status >= 300 && status < 400),
    });
  } catch (err) {
    // axios throws on 3xx because of maxRedirects: 0; pull response if present
    const aerr = err as AxiosError;
    if (aerr?.response) return aerr.response;
    return null;
  }
};

/**
 * Fetches an image from a network source with manual redirect handling.
 * Every hop re-validates the destination against the allowlist, restricts
 * the protocol to http/https, and verifies the destination hostname does
 * not resolve to a private/loopback/link-local IP (SSRF protection).
 *
 * @param {string} src - The URL of the image.
 * @param {ImageType} [type="normal"] - Type of fallback image in case of an error.
 * @returns {Promise<Buffer>} A buffer containing the image data or a fallback image.
 */
const fetchFromNetwork = async (
  src: string,
  type: ImageType = "normal",
  {
    timeoutMs,
    maxBytes,
    allowedNetworkList,
    maxRedirects,
    onError,
  }: {
    timeoutMs: number;
    maxBytes: number;
    allowedNetworkList: string[];
    maxRedirects: number;
    onError?: PixelServeOnError;
  },
): Promise<Buffer> => {
  try {
    let currentUrl = src;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch (err) {
        safeOnError(onError, err, "fetch", currentUrl);
        return await FALLBACKIMAGES[type]();
      }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        safeOnError(
          onError,
          new Error(`disallowed protocol ${parsed.protocol}`),
          "fetch",
          currentUrl,
        );
        return await FALLBACKIMAGES[type]();
      }
      if (!isHostAllowed(parsed.hostname, parsed.host, allowedNetworkList)) {
        safeOnError(
          onError,
          new Error(`host ${parsed.hostname} not in allowedNetworkList`),
          "fetch",
          currentUrl,
        );
        return await FALLBACKIMAGES[type]();
      }
      // Resolve once and pin the address into the http(s) agent's `lookup`
      // function so axios connects to the IP we validated, NOT whatever the
      // kernel resolver answers microseconds later. This closes the classic
      // DNS-rebinding TOCTOU window across the manual redirect loop. The
      // pinned-address helper also runs the `isPrivateIp` validation, so a
      // separate `isPublicHost` call is redundant here.
      const pinned = await resolvePinnedAddress(parsed.hostname);
      if (!pinned) {
        safeOnError(
          onError,
          new Error(
            `host ${parsed.hostname} resolves to a private IP or DNS lookup failed`,
          ),
          "fetch",
          currentUrl,
        );
        return await FALLBACKIMAGES[type]();
      }

      const agents = buildPinnedAgents(pinned.address, pinned.family);
      const response = await requestNoRedirect(
        currentUrl,
        timeoutMs,
        maxBytes,
        agents,
      );
      if (!response) {
        safeOnError(
          onError,
          new Error("network request returned no response"),
          "fetch",
          currentUrl,
        );
        return await FALLBACKIMAGES[type]();
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.["location"] as string | undefined;
        if (!location) {
          safeOnError(
            onError,
            new Error("redirect response missing Location header"),
            "fetch",
            currentUrl,
          );
          return await FALLBACKIMAGES[type]();
        }
        // resolve relative redirects against current URL
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch (err) {
          safeOnError(onError, err, "fetch", location);
          return await FALLBACKIMAGES[type]();
        }
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        safeOnError(
          onError,
          new Error(`non-2xx status ${response.status}`),
          "fetch",
          currentUrl,
        );
        return await FALLBACKIMAGES[type]();
      }

      const contentType = (
        response.headers?.["content-type"] as string | undefined
      )
        ?.toLowerCase()
        ?.split(";")[0]
        ?.trim();
      const allowedMimeTypes = Object.values(mimeTypes);

      if (contentType && allowedMimeTypes.includes(contentType)) {
        return Buffer.from(response.data as ArrayBuffer);
      }
      safeOnError(
        onError,
        new Error(
          `disallowed content-type ${contentType ?? "missing"} for ${currentUrl}`,
        ),
        "fetch",
        currentUrl,
      );
      return await FALLBACKIMAGES[type]();
    }
    // exhausted redirect budget
    safeOnError(
      onError,
      new Error(`exceeded maxRedirects=${maxRedirects}`),
      "fetch",
      src,
    );
    return await FALLBACKIMAGES[type]();
  } catch (err) {
    safeOnError(onError, err, "fetch", src);
    return await FALLBACKIMAGES[type]();
  }
};

/**
 * Reads an image from the local file system.
 *
 * @param {string} filePath - Path to the image file.
 * @param {string} baseDir - Base directory to resolve paths.
 * @param {ImageType} [type="normal"] - Type of fallback image if the path is invalid.
 * @returns {Promise<Buffer>} A buffer containing the image data.
 */
export const readLocalImage = async (
  filePath: string,
  baseDir: string,
  type: ImageType = "normal",
  maxBytes?: number,
  onError?: PixelServeOnError,
): Promise<Buffer> => {
  const isValid = await isValidPath(baseDir, filePath);
  if (!isValid) {
    safeOnError(
      onError,
      new Error(`invalid local path: ${filePath}`),
      "fs",
      filePath,
    );
    return await FALLBACKIMAGES[type]();
  }
  try {
    const resolvedFile = path.resolve(baseDir, filePath);
    if (maxBytes) {
      const stats = await fs.stat(resolvedFile);
      if (stats.size > maxBytes) {
        safeOnError(
          onError,
          new Error(
            `local file ${filePath} exceeds maxDownloadBytes (${stats.size} > ${maxBytes})`,
          ),
          "fs",
          filePath,
        );
        return await FALLBACKIMAGES[type]();
      }
    }
    return await fs.readFile(resolvedFile);
  } catch (err) {
    safeOnError(onError, err, "fs", filePath);
    return await FALLBACKIMAGES[type]();
  }
};

/**
 * Strips a leading prefix from `pathname` using either a literal-string
 * `apiPrefix` (preferred, ReDoS-free) or a user-supplied `apiRegex`. When
 * both are provided, `apiPrefix` wins — the regex is not evaluated at all,
 * so a vulnerable pattern in `apiRegex` cannot reach this code path.
 *
 * Exported for unit-testability of the precedence + prefix matching logic.
 */
export const stripApiPrefix = (
  pathname: string,
  apiRegex: RegExp,
  apiPrefix: string | undefined,
): string => {
  if (apiPrefix !== undefined) {
    return pathname.startsWith(apiPrefix)
      ? pathname.slice(apiPrefix.length)
      : pathname;
  }
  return pathname.replace(apiRegex, "");
};

/**
 * Fetches an image from either a local file or a network source.
 *
 * @param {string} src - The URL or local path of the image.
 * @param {string} baseDir - Base directory to resolve local paths.
 * @param {string} websiteURL - The URL of the website.
 * @param {ImageType} [type="normal"] - Type of fallback image if the path is invalid.
 * @param {string[]} [allowedNetworkList=[]] - List of allowed network hosts.
 * @returns {Promise<Buffer>} A buffer containing the image data or a fallback image.
 */
export const fetchImage = (
  src: string,
  baseDir: string,
  websiteURL: string | undefined,
  type: ImageType = "normal",
  apiRegex: RegExp,
  allowedNetworkList: string[] = [],
  {
    timeoutMs,
    maxBytes,
    maxRedirects = 3,
    onError,
    apiPrefix,
  }: {
    timeoutMs: number;
    maxBytes: number;
    maxRedirects?: number;
    onError?: PixelServeOnError;
    apiPrefix?: string;
  },
): Promise<Buffer> => {
  try {
    const url = new URL(src);
    const isInternal =
      websiteURL !== undefined &&
      [websiteURL, `www.${websiteURL}`].includes(url.hostname);

    if (isInternal) {
      const localPath = stripApiPrefix(url.pathname, apiRegex, apiPrefix);
      return readLocalImage(localPath, baseDir, type, maxBytes, onError);
    }

    const allowedCondition = isHostAllowed(
      url.hostname,
      url.host,
      allowedNetworkList,
    );
    if (!allowedCondition) {
      safeOnError(
        onError,
        new Error(`host ${url.hostname} not in allowedNetworkList`),
        "fetch",
        src,
      );
      return FALLBACKIMAGES[type]();
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      safeOnError(
        onError,
        new Error(`disallowed protocol ${url.protocol}`),
        "fetch",
        src,
      );
      return FALLBACKIMAGES[type]();
    }
    return fetchFromNetwork(src, type, {
      timeoutMs,
      maxBytes,
      allowedNetworkList,
      maxRedirects,
      onError,
    });
  } catch (err) {
    safeOnError(onError, err, "fetch", src);
    return readLocalImage(src, baseDir, type, maxBytes, onError);
  }
};
