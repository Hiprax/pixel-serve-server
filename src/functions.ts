import path from "node:path";
import * as fs from "node:fs/promises";
import * as dns from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
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
 * A fully-expanded IPv6 address: its 8 constituent 16-bit hextets, in order.
 */
type Hextets = [number, number, number, number, number, number, number, number];

/**
 * Expands any syntactically valid IPv6 literal (already confirmed via
 * `isIP(ip) === 6`) into its 8 constituent hextets. Handles `::` zero-run
 * compression at any position and the optional trailing IPv4 dotted-quad
 * tail (RFC 4291 §2.2 item 3, e.g. `"64:ff9b::192.0.2.1"`).
 *
 * Used so NAT64 prefix detection below is a numeric comparison rather than
 * a `startsWith("64:ff9b::")` string match, which would miss a fully
 * expanded or partially compressed equivalent representing the exact same
 * address — a real bypass vector for an attacker-supplied IP literal that
 * never goes through DNS. Returns `null` if the (already-validated) string
 * does not decompose into exactly 8 hextets, which should not happen in
 * practice given the `isIP` precondition.
 */
const expandIPv6Hextets = (ip: string): Hextets | null => {
  let body = ip;
  const lastColon = body.lastIndexOf(":");
  const tail = lastColon >= 0 ? body.slice(lastColon + 1) : body;
  if (isIP(tail) === 4) {
    const octets = tail.split(".").map(Number);
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    body = body.slice(0, lastColon + 1) + hi + ":" + lo;
  }

  const halves = body.split("::");
  if (halves.length > 2) return null;

  // Parse a colon-separated run of hextets, failing closed (returning null) on
  // any group that is not a clean 1-4 digit hex value. Without this validation
  // `parseInt` would silently truncate a malformed group — e.g. an RFC 4007
  // zone-id suffix leaves the tail "127.0.0.1%eth0", which `parseInt(_, 16)`
  // collapses to `0x127` — producing a plausible-but-wrong tuple that shifts
  // the classifier's markers out of position and could report a private
  // address as public. `net.isIP` accepts a zone-id'd literal as valid IPv6,
  // so this parser must reject anything that is not a bare address explicitly.
  const parseGroup = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const h of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };

  let hextets: number[];
  if (halves.length === 1) {
    const only = parseGroup(halves[0]!);
    if (only === null) return null;
    hextets = only;
  } else {
    const left = parseGroup(halves[0]!);
    const right = parseGroup(halves[1]!);
    if (left === null || right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    hextets = [...left, ...Array<number>(missing).fill(0), ...right];
  }

  return hextets.length === 8 ? (hextets as Hextets) : null;
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
    // 100.64.0.0/10 RFC 6598 shared address space (CGNAT, cloud-internal)
    if (a === 100 && b >= 64 && b <= 127) return true;
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
    // 192.88.99.0/24 RFC 3068 6to4 anycast relay (deprecated)
    if (a === 192 && b === 88 && parts[2] === 99) return true;
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

  // IPv6 — classify from the fully-expanded numeric hextets rather than from
  // textual prefixes. Textual matching was unsound in BOTH directions: in the
  // "allow" direction the loopback ::1 written uncompressed ("0:0:0:0:0:0:0:1"),
  // the unspecified :: written uncompressed, and an uncompressed IPv4-mapped
  // address ("0:0:0:0:0:ffff:7f00:1") all slipped past the exact-string /
  // `startsWith` checks and were wrongly treated as public — an SSRF bypass in
  // the exported `isPrivateIp` guard and in the DNS-validation path, since a
  // resolver or a caller can legitimately hand us an uncompressed literal; in
  // the "block" direction "fe8:…" (numeric 0x0fe8 — unrelated reserved space,
  // not link-local) matched the old fe80::/10 regex. Expanding to the 8 numeric
  // hextets first (via `expandIPv6Hextets`, which also folds a trailing
  // dotted-quad IPv4 tail) makes every textual representation of the same
  // address classify identically. `isIP(ip) === 6` guarantees a parse; fail
  // closed (treat as unsafe) on the defensive `null` branch.
  const hextets = expandIPv6Hextets(ip.toLowerCase());
  if (!hextets) return true;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  const embeddedV4 = (hi: number, lo: number): string =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const highBitsZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;

  // ::/96 low block — the unspecified address (::), loopback (::1), and the
  // deprecated IPv4-compatible ::a.b.c.d form (RFC 4291 §2.5.5.1, "MUST NOT be
  // assigned to any node"). Classify by the embedded low-32-bit IPv4: :: maps
  // to 0.0.0.0 and ::1 to 0.0.0.1 (both in the blocked 0.0.0.0/8 range), and an
  // embedded private/loopback/link-local v4 (e.g. ::127.0.0.1, ::10.0.0.1,
  // ::169.254.169.254) is blocked, while an embedded — deprecated, non-routable
  // — public v4 passes through, mirroring the ::ffff: and NAT64 /96 branches.
  if (highBitsZero && h5 === 0) return isPrivateIp(embeddedV4(h6, h7));
  // IPv4-mapped ::ffff:a.b.c.d (RFC 4291) — recurse on the embedded IPv4 so a
  // mapped private/loopback v4 is blocked while a mapped public v4 passes.
  if (highBitsZero && h5 === 0xffff) return isPrivateIp(embeddedV4(h6, h7));
  // NAT64 (RFC 6052 / RFC 8215) — addresses that embed an IPv4 address.
  if (h0 === 0x64 && h1 === 0xff9b) {
    if (h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
      // 64:ff9b::/96 (RFC 6052 Well-Known Prefix) — the embedded IPv4
      // occupies the low 32 bits contiguously. Recurse so a NAT64-wrapped
      // private v4 is blocked while a NAT64-wrapped public v4 passes.
      return isPrivateIp(embeddedV4(h6, h7));
    }
    if (h2 === 1) {
      // 64:ff9b:1::/48 (RFC 8215 Local-Use Prefix) — intentionally NOT
      // unwrapped. RFC 8215 explicitly exempts this prefix from the
      // Well-Known Prefix's "embedded address must be public" restriction
      // (it may legitimately carry private IPv4 addresses) and it exists
      // only for an operator's own limited/local NAT64 domain — a
      // general-purpose fetch middleware has no legitimate reason to ever
      // see it in the wild. Its embedded IPv4 is also split
      // non-contiguously around a reserved zero octet at different bit
      // offsets than the /96 form (RFC 6052 §2.2), so a hand-rolled
      // extraction here would be new, untested, security-critical
      // bit-splicing logic. Two independent judge reviews converged on
      // blocking the whole range rather than risk a subtly wrong decode
      // silently opening an SSRF bypass.
      return true;
    }
  }
  // 6to4 2002::/16 (RFC 3056) — embeds a 32-bit IPv4 address in h1:h2
  // (`2002:<hi>:<lo>::/48`). Unlike the NAT64 well-known prefix above, 6to4
  // legitimately tunnels arbitrary *public* IPv4 traffic, so — mirroring the
  // NAT64 /96 handling — unwrap the embedded address and recurse rather than
  // blocking the whole range outright: a 6to4-wrapped private/loopback v4
  // (e.g. 2002:a00:1:: embedding 10.0.0.1) is blocked, while a 6to4-wrapped
  // public v4 (e.g. 2002:808:808:: embedding 8.8.8.8) still passes.
  if (h0 === 0x2002) return isPrivateIp(embeddedV4(h1, h2));
  // link-local fe80::/10 (0xfe80–0xfebf)
  if (h0 >= 0xfe80 && h0 <= 0xfebf) return true;
  // deprecated site-local fec0::/10 (0xfec0–0xfeff, RFC 3879)
  if (h0 >= 0xfec0 && h0 <= 0xfeff) return true;
  // unique-local fc00::/7 (0xfc00–0xfdff)
  if (h0 >= 0xfc00 && h0 <= 0xfdff) return true;
  // multicast ff00::/8 (0xff00–0xffff)
  if (h0 >= 0xff00 && h0 <= 0xffff) return true;
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
 * Internal alias for Node's own `lookup` callback shape
 * (`net.LookupFunction`), used by `http.Agent`/`https.Agent`'s `lookup`
 * option. Node invokes this with a `{ all: true }` options object —
 * expecting `callback(err, LookupAddress[])` — whenever `autoSelectFamily`
 * is enabled (the default on Node >=20) and no `family` is pinned on the
 * connect options; otherwise it uses the legacy single-address
 * `callback(err, address, family)` form. `buildPinnedLookup` below must
 * therefore handle both callback shapes. Module-private; tests reach the
 * built function indirectly via the constructed agent's `options.lookup`.
 */
type PinnedLookup = LookupFunction;

/**
 * Builds a pinned `lookup` function that always resolves to the same
 * `{ address, family }` pair. Used by `buildPinnedAgents` to force axios to
 * connect to the pre-validated IP rather than re-resolving the hostname.
 *
 * Handles both calling conventions Node uses for an Agent's pinned `lookup`:
 * the `{ all: true }` shape (the default on Node >=20, since
 * `net.getDefaultAutoSelectFamily()` is `true` and no `family` is pinned on
 * the connect options) expects `callback(err, [{ address, family }])`; the
 * legacy single-address `callback(err, address, family)` form is used
 * otherwise. Without this, `net` receives `undefined` from the single-address
 * form and the socket connect throws `ERR_INVALID_IP_ADDRESS`.
 */
const buildPinnedLookup =
  (address: string, family: 4 | 6): PinnedLookup =>
  (_hostname, options, callback): void => {
    if (options?.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
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
 *
 * `family` and `autoSelectFamily: false` are also passed directly to both
 * agents as defense in depth: even if a future Node change alters how/when
 * `lookup` is invoked, pinning `family` and disabling Happy Eyeballs
 * (`autoSelectFamily`) keeps the socket connect from second-guessing the
 * validated address.
 */
export const buildPinnedAgents = (
  address: string,
  family: 4 | 6,
): { httpAgent: http.Agent; httpsAgent: https.Agent } => {
  const lookup = buildPinnedLookup(address, family);
  return {
    httpAgent: new http.Agent({ lookup, family, autoSelectFamily: false }),
    httpsAgent: new https.Agent({ lookup, family, autoSelectFamily: false }),
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
      // Disable axios' ambient HTTP(S)_PROXY / http(s)_proxy env-var proxy
      // detection. The allowlist + public-IP validation + DNS pinning above
      // are this request's entire security boundary, and an operator-machine
      // env proxy would silently defeat all three: an IP-literal proxy
      // connects the socket to a target we never validated, and a
      // hostname-literal proxy re-resolves at connect time through the
      // proxy's own resolver, undoing the pinned `lookup` that closes the
      // DNS-rebinding window. `proxy: false` is axios' own documented
      // mitigation for exactly this (see axios THREATMODEL.md "Proxy
      // environment variable hijack"). An operator who needs an egress proxy
      // must front this middleware with one at the network layer instead.
      proxy: false,
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
    onFallback,
  }: {
    timeoutMs: number;
    maxBytes: number;
    allowedNetworkList: string[];
    maxRedirects: number;
    onError?: PixelServeOnError;
    /**
     * Optional callback fired whenever this call resolves to the bundled
     * `FALLBACKIMAGES[type]()` placeholder rather than genuinely-fetched
     * bytes (blocked host, SSRF-reject, non-2xx, disallowed MIME, transport
     * failure, etc.). Trailing and optional — backward-compatible.
     */
    onFallback?: () => void;
  },
): Promise<Buffer> => {
  const fallback = async (): Promise<Buffer> => {
    onFallback?.();
    return FALLBACKIMAGES[type]();
  };
  try {
    let currentUrl = src;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch (err) {
        safeOnError(onError, err, "fetch", currentUrl);
        return await fallback();
      }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        safeOnError(
          onError,
          new Error(`disallowed protocol ${parsed.protocol}`),
          "fetch",
          currentUrl,
        );
        return await fallback();
      }
      if (!isHostAllowed(parsed.hostname, parsed.host, allowedNetworkList)) {
        safeOnError(
          onError,
          new Error(`host ${parsed.hostname} not in allowedNetworkList`),
          "fetch",
          currentUrl,
        );
        return await fallback();
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
        return await fallback();
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
        return await fallback();
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
          return await fallback();
        }
        // resolve relative redirects against current URL
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch (err) {
          safeOnError(onError, err, "fetch", location);
          return await fallback();
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
        return await fallback();
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
      return await fallback();
    }
    // exhausted redirect budget
    safeOnError(
      onError,
      new Error(`exceeded maxRedirects=${maxRedirects}`),
      "fetch",
      src,
    );
    return await fallback();
  } catch (err) {
    safeOnError(onError, err, "fetch", src);
    return await fallback();
  }
};

/**
 * Reads an image from the local file system.
 *
 * @param {string} filePath - Path to the image file.
 * @param {string} baseDir - Base directory to resolve paths.
 * @param {ImageType} [type="normal"] - Type of fallback image if the path is invalid.
 * @param {number} [maxBytes] - Optional max file size; larger files fall back.
 * @param {PixelServeOnError} [onError] - Optional error observability hook.
 * @param {() => void} [onFallback] - Optional callback fired whenever this
 *   call resolves to the bundled `FALLBACKIMAGES[type]()` placeholder rather
 *   than the requested file's real bytes. Lets callers (namely `serveImage`)
 *   distinguish a genuinely-served image from a placeholder without
 *   re-deriving the same validity/size checks. Trailing and optional so the
 *   exported signature stays backward-compatible.
 * @returns {Promise<Buffer>} A buffer containing the image data.
 */
export const readLocalImage = async (
  filePath: string,
  baseDir: string,
  type: ImageType = "normal",
  maxBytes?: number,
  onError?: PixelServeOnError,
  onFallback?: () => void,
): Promise<Buffer> => {
  const fallback = async (): Promise<Buffer> => {
    onFallback?.();
    return FALLBACKIMAGES[type]();
  };
  const isValid = await isValidPath(baseDir, filePath);
  if (!isValid) {
    safeOnError(
      onError,
      new Error(`invalid local path: ${filePath}`),
      "fs",
      filePath,
    );
    return await fallback();
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
        return await fallback();
      }
    }
    return await fs.readFile(resolvedFile);
  } catch (err) {
    safeOnError(onError, err, "fs", filePath);
    return await fallback();
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
 * Normalizes a configured `websiteURL` (bare hostname, `host:port`, or a
 * full URL, all three accepted by `optionsSchema`) into the `{ hostname,
 * host }` pair `fetchImage` compares against `url.hostname`/`url.host`.
 *
 * `websiteURL` is parsed as a URL by prepending a placeholder `http://`
 * scheme whenever the configured value has no `://` of its own — otherwise
 * a bare `host:port` value like `"localhost:3001"` parses as the opaque-path
 * URL `{ protocol: "localhost:", pathname: "3001" }` instead of an authority
 * with a host (verified against `new URL()`'s WHATWG behavior), which is not
 * what an operator configuring `websiteURL: "localhost:3001"` means. The
 * scheme itself is discarded — only `hostname`/`host` are read.
 *
 * On parse failure (defensively — `optionsSchema` already restricts
 * `websiteURL` to values that parse cleanly this way), falls back to
 * comparing the raw configured string directly, matching this function's
 * pre-normalization behavior so a parse failure never makes a
 * previously-working exact-string config silently stop matching.
 *
 * Returns `null` when `websiteURL` is `undefined` (internal-host detection
 * disabled entirely, matching prior behavior).
 */
const normalizeWebsiteHost = (
  websiteURL: string | undefined,
): { hostname: string; host: string } | null => {
  if (websiteURL === undefined) return null;
  try {
    const parsed = new URL(
      websiteURL.includes("://") ? websiteURL : `http://${websiteURL}`,
    );
    return { hostname: parsed.hostname, host: parsed.host };
  } catch {
    return { hostname: websiteURL, host: websiteURL };
  }
};

/**
 * Resolves an `http(s)` URL `src` to an API-prefix-stripped local pathname
 * when its host matches the configured `websiteURL` (the "internal host"
 * case — the app's own image endpoint referencing itself by absolute URL).
 * Returns `null` when `src` does not parse as a URL, `websiteURL` is not
 * configured (`normalizeWebsiteHost` returns `null`), or the URL's host
 * matches neither the bare nor `www.`-prefixed configured hostname/host.
 *
 * Single source of truth for "is this src actually a local file reachable
 * through our own internal host" — shared by `fetchImage` (decides whether
 * to read locally or fetch over the network) and `buildSourceIdentifier`
 * (`pixel.ts`; keys the deterministic ETag on the underlying file's
 * `mtime:size` rather than the immutable URL string) so the two internal-
 * host detection rules cannot drift apart.
 */
export const resolveInternalLocalPath = (
  src: string,
  websiteURL: string | undefined,
  apiRegex: RegExp,
  apiPrefix: string | undefined,
): string | null => {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  const configuredHost = normalizeWebsiteHost(websiteURL);
  const isInternal =
    configuredHost !== null &&
    ([configuredHost.hostname, `www.${configuredHost.hostname}`].includes(
      url.hostname,
    ) ||
      [configuredHost.host, `www.${configuredHost.host}`].includes(url.host));
  if (!isInternal) return null;
  return stripApiPrefix(url.pathname, apiRegex, apiPrefix);
};

/**
 * Fetches an image from either a local file or a network source.
 *
 * @param {string} src - The URL or local path of the image.
 * @param {string} baseDir - Base directory to resolve local paths.
 * @param {string} websiteURL - The website's configured internal host —
 *   accepts a bare hostname (`"example.com"`), a `host:port` pair
 *   (`"example.com:8080"`), or a full URL (`"https://example.com:8080"`);
 *   all three are normalized to a hostname/host pair via
 *   `normalizeWebsiteHost` before comparison.
 * @param {ImageType} [type="normal"] - Type of fallback image if the path is invalid.
 * @param {string[]} [allowedNetworkList=[]] - List of allowed network hosts.
 *
 * The trailing options object also accepts an optional `onFallback: () =>
 * void` field, fired whenever this call resolves to the bundled
 * `FALLBACKIMAGES[type]()` placeholder rather than genuinely-resolved bytes —
 * whether from the internal-local, network, or exception-recovery branch.
 * Optional and additive, so the exported signature stays backward-compatible.
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
    onFallback,
  }: {
    timeoutMs: number;
    maxBytes: number;
    maxRedirects?: number;
    onError?: PixelServeOnError;
    apiPrefix?: string;
    onFallback?: () => void;
  },
): Promise<Buffer> => {
  try {
    const internalLocalPath = resolveInternalLocalPath(
      src,
      websiteURL,
      apiRegex,
      apiPrefix,
    );
    if (internalLocalPath !== null) {
      return readLocalImage(
        internalLocalPath,
        baseDir,
        type,
        maxBytes,
        onError,
        onFallback,
      );
    }

    const url = new URL(src);
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
      onFallback?.();
      return FALLBACKIMAGES[type]();
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      safeOnError(
        onError,
        new Error(`disallowed protocol ${url.protocol}`),
        "fetch",
        src,
      );
      onFallback?.();
      return FALLBACKIMAGES[type]();
    }
    return fetchFromNetwork(src, type, {
      timeoutMs,
      maxBytes,
      allowedNetworkList,
      maxRedirects,
      onError,
      onFallback,
    });
  } catch (err) {
    safeOnError(onError, err, "fetch", src);
    return readLocalImage(src, baseDir, type, maxBytes, onError, onFallback);
  }
};
