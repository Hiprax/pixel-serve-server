import path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi, beforeEach } from "vitest";
import axios from "axios";
import { FALLBACKIMAGES } from "./variables";
import {
  buildPinnedAgents,
  fetchImage,
  isPrivateIp,
  isPublicHost,
  isValidPath,
  readLocalImage,
  resolveInternalLocalPath,
  resolvePinnedAddress,
  resolvePinnedAddresses,
  stripApiPrefix,
} from "./functions";
import { API_REGEX } from "./variables";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import * as dns from "node:dns/promises";

// Partial passthrough mock: every fs/promises function starts out as the
// REAL implementation (spread from importOriginal). This lets individual
// tests `vi.spyOn(fsp, "<fn>")` to override exactly one call (e.g. to
// simulate a TOCTOU stat failure) while every other test in this file keeps
// hitting the real filesystem untouched. A wholesale `vi.mock` (like the
// dns mock above) is not viable here because `isValidPath` — exercised by
// nearly every test in this file — depends on real `fs.realpath`/`fs.stat`.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual };
});

import * as fsp from "node:fs/promises";

const baseDir = path.join(__dirname, "assets");

// dns.lookup has multiple overloads; the production code always calls it with
// `{ all: true }`, so it resolves to `LookupAddress[]`. Vitest's `mocked()`
// picks the first overload (single LookupAddress), so we cast through unknown
// to a function that returns the array-shaped overload result.
const setDnsLookup = (
  impl: (hostname: string) => Promise<LookupAddress[]>,
): void => {
  vi.mocked(dns.lookup).mockImplementation(
    impl as unknown as typeof dns.lookup,
  );
};

const mockDnsPublic = (): void => {
  setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
};

const mockDnsPrivate = (): void => {
  setDnsLookup(async () => [{ address: "127.0.0.1", family: 4 }]);
};

const mockDnsFail = (): void => {
  setDnsLookup(async () => {
    throw new Error("ENOTFOUND");
  });
};

beforeEach(() => {
  vi.resetAllMocks();
  mockDnsPublic();
});

describe("isPrivateIp", () => {
  it("flags loopback IPv4", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.10.0.1")).toBe(true);
  });

  it("flags 0.0.0.0/8", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });

  it("flags RFC1918 private ranges", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("flags link-local 169.254/16 (AWS IMDS)", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  it("flags multicast and reserved", () => {
    expect(isPrivateIp("224.0.0.1")).toBe(true);
    expect(isPrivateIp("240.0.0.1")).toBe(true);
    expect(isPrivateIp("255.255.255.255")).toBe(true);
  });

  it("allows public IPv4 addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });

  it("flags IPv6 loopback and unspecified", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
  });

  it("flags IPv4-mapped IPv6 private addresses", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
  });

  it("flags IPv6 link-local fe80::/10", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  it("flags IPv6 unique-local fc00::/7", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
  });

  it("flags IPv6 multicast ff00::/8", () => {
    expect(isPrivateIp("ff02::1")).toBe(true);
  });

  it("allows public IPv6", () => {
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });

  it("flags deprecated IPv6 site-local fec0::/10", () => {
    expect(isPrivateIp("fec0::1")).toBe(true);
    expect(isPrivateIp("feff::1")).toBe(true);
  });

  it("does not confuse fec0::/10 with the adjacent fe80::/10 link-local range", () => {
    // 0xFEBF is the exact top of fe80::/10 (fe80-febf) — one hextet value
    // below fec0's start — so this pins the precise boundary rather than an
    // arbitrary mid-range value.
    expect(isPrivateIp("febf::1")).toBe(true); // still private (link-local)
  });

  it("flags a NAT64 well-known-prefix address embedding a private IPv4", () => {
    expect(isPrivateIp("64:ff9b::7f00:1")).toBe(true); // 127.0.0.1
    expect(isPrivateIp("64:ff9b::a00:1")).toBe(true); // 10.0.0.1
  });

  it("allows a NAT64 well-known-prefix address embedding a public IPv4", () => {
    expect(isPrivateIp("64:ff9b::808:808")).toBe(false); // 8.8.8.8
  });

  it("resolves the NAT64 dotted-quad IPv4 tail the same as the hextet tail", () => {
    expect(isPrivateIp("64:ff9b::127.0.0.1")).toBe(true);
    expect(isPrivateIp("64:ff9b::10.0.0.1")).toBe(true);
    expect(isPrivateIp("64:ff9b::93.184.216.34")).toBe(false); // public
  });

  it("detects the NAT64 well-known prefix numerically, not by string prefix", () => {
    // Fully expanded (no "::" compression at all) — the exact same address
    // as "64:ff9b::7f00:1" (127.0.0.1 embedded). A naive
    // `startsWith("64:ff9b::")` check would miss this representation.
    expect(isPrivateIp("0064:ff9b:0000:0000:0000:0000:7f00:0001")).toBe(true);
    expect(isPrivateIp("64:ff9b:0:0:0:0:7f00:1")).toBe(true);
  });

  it("blocks the entire NAT64 local-use prefix 64:ff9b:1::/48 without attempting extraction", () => {
    // RFC 8215 permits this prefix to carry private addresses and scopes
    // it to an operator's own local domain, so the whole range is treated
    // as private — even for a payload that would decode to a public IPv4
    // under the /96 (contiguous low-32-bits) scheme, since that scheme
    // does not apply to a /48 prefix (RFC 6052 §2.2 embeds it non-
    // contiguously around a reserved octet at different bit offsets).
    expect(isPrivateIp("64:ff9b:1::7f00:1")).toBe(true);
    expect(isPrivateIp("64:ff9b:1::808:808")).toBe(true);
  });

  it("does not misclassify an unrelated address merely starting with the hextet 64", () => {
    expect(isPrivateIp("64:1234:5678::1")).toBe(false);
  });

  it("does not treat an undefined 64:ff9b:X sub-range as a NAT64 prefix", () => {
    // Only 64:ff9b::/96 (hextet[2..5] all zero) and 64:ff9b:1::/48
    // (hextet[2] === 1) are defined NAT64 prefixes. A third hextet value
    // outside both must fall through to ordinary (public) handling.
    expect(isPrivateIp("64:ff9b:2::1")).toBe(false);
  });

  it("blocks the /48 local-use prefix in its trailing-:: compressed form too", () => {
    // Same conservative-block rule as above, exercised via a differently
    // compressed textual representation (zero-run compressed at the end
    // rather than in the middle) to confirm the numeric prefix match is
    // representation-independent, not coincidentally tied to one spelling.
    expect(isPrivateIp("64:ff9b:1:a00:0:100::")).toBe(true);
  });

  it("blocks the loopback ::1 in its fully-uncompressed form (SSRF bypass fix)", () => {
    // The classic loopback address written out in full. A prior exact-string
    // `lower === "::1"` check treated this as PUBLIC (returned false), letting
    // an attacker or a non-canonicalizing DNS resolver reach loopback through
    // the exported `isPrivateIp` guard. Numeric hextet classification blocks
    // every textual spelling of the same address.
    expect(isPrivateIp("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isPrivateIp("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(true);
  });

  it("blocks the unspecified :: in its fully-uncompressed form", () => {
    expect(isPrivateIp("0:0:0:0:0:0:0:0")).toBe(true);
    expect(isPrivateIp("0000:0000:0000:0000:0000:0000:0000:0000")).toBe(true);
    // the "::0" spelling of the unspecified address
    expect(isPrivateIp("::0")).toBe(true);
  });

  it("blocks IPv4-mapped private/loopback addresses in uncompressed form (SSRF bypass fix)", () => {
    // A prior `startsWith("::ffff:")` check missed the uncompressed spelling,
    // so ::ffff:127.0.0.1 written in full slipped through as public.
    expect(isPrivateIp("0:0:0:0:0:ffff:7f00:1")).toBe(true); // ::ffff:127.0.0.1
    expect(isPrivateIp("0:0:0:0:0:ffff:a00:5")).toBe(true); // ::ffff:10.0.0.5
    // canonical mapped forms still recurse on the embedded IPv4
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false); // mapped public passes
  });

  it("classifies link-local/site-local/ULA/multicast by numeric hextet range, not text prefix", () => {
    // Range boundaries: link-local fe80–febf, site-local fec0–feff,
    // ULA fc00–fdff, multicast ff00–ffff.
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("febf:ffff::1")).toBe(true);
    expect(isPrivateIp("fec0::1")).toBe(true);
    expect(isPrivateIp("feff:ffff::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fdff:ffff::1")).toBe(true);
    expect(isPrivateIp("ff00::1")).toBe(true);
    expect(isPrivateIp("ffff::1")).toBe(true);
  });

  it("does not over-block a short leading hextet that only textually resembles a reserved prefix", () => {
    // "fe8:…" is the hextet 0x0fe8 (in the unrelated, reserved 0000::/8 block),
    // NOT the fe80::/10 link-local range — likewise "fc:…" (0x00fc) and "ff:…"
    // (0x00ff). The old regex/`startsWith` checks over-matched these on their
    // textual prefix; numeric classification correctly leaves them unflagged.
    expect(isPrivateIp("fe8:1:2:3:4:5:6:7")).toBe(false);
    expect(isPrivateIp("fc:1:2:3:4:5:6:7")).toBe(false);
    expect(isPrivateIp("ff:1:2:3:4:5:6:7")).toBe(false);
  });

  it("still allows genuine public IPv6 addresses", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false); // Google
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false); // Cloudflare
    expect(isPrivateIp("2a00:1450:4001:80e::200e")).toBe(false); // global unicast
  });

  it("blocks the deprecated IPv4-compatible ::a.b.c.d form embedding a private/loopback IPv4", () => {
    // RFC 4291 §2.5.5.1 deprecated ::a.b.c.d ("IPv4-compatible", distinct from
    // the ::ffff: "IPv4-mapped" form). The whole ::/96 block is classified by
    // its embedded low-32-bit IPv4, so a private/loopback/link-local embed is
    // blocked while an embedded (non-routable) public v4 passes.
    expect(isPrivateIp("::127.0.0.1")).toBe(true); // loopback
    expect(isPrivateIp("::10.0.0.1")).toBe(true); // RFC1918
    expect(isPrivateIp("::172.16.0.1")).toBe(true); // RFC1918
    expect(isPrivateIp("::192.168.1.1")).toBe(true); // RFC1918
    expect(isPrivateIp("::169.254.169.254")).toBe(true); // link-local / IMDS
    expect(isPrivateIp("::255.255.255.255")).toBe(true); // broadcast
    expect(isPrivateIp("0:0:0:0:0:0:127.0.0.1")).toBe(true); // uncompressed
    expect(isPrivateIp("::8.8.8.8")).toBe(false); // embedded public passes
  });

  it("fails closed on a zone-id (RFC 4007 %scope) suffix so a mis-parse cannot leak a private address", () => {
    // `net.isIP` accepts a zone-id'd literal as valid IPv6. The embedded
    // dotted-quad tail would otherwise be silently mis-parsed by the hextet
    // expander (`parseInt("127.0.0.1%eth0", 16)` -> 0x127), shifting the
    // IPv4-mapped marker out of position and reporting loopback/private as
    // public — a real SSRF bypass in the exported guard. The parser now
    // rejects any non-hex group, so a zone-id'd address is treated as unsafe.
    expect(isPrivateIp("::ffff:127.0.0.1%eth0")).toBe(true); // loopback
    expect(isPrivateIp("::ffff:169.254.169.254%eth0")).toBe(true); // IMDS
    expect(isPrivateIp("::ffff:10.0.0.5%eth0")).toBe(true); // RFC1918
    expect(isPrivateIp("fe80::1%eth0")).toBe(true); // link-local
    // Over-blocking a zone-id'd public address is acceptable (fail-safe) since
    // a zone-scoped address is never a legitimate outbound fetch target.
    expect(isPrivateIp("64:ff9b::8.8.8.8%eth0")).toBe(true);
  });

  it("flags invalid addresses as unsafe", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
  });

  it("blocks the RFC 6598 shared address space 100.64.0.0/10 (CGNAT, cloud-internal)", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("100.127.255.255")).toBe(true); // top of the /10
  });

  it("does not over-block the addresses immediately adjacent to 100.64.0.0/10", () => {
    expect(isPrivateIp("100.63.255.255")).toBe(false); // one address below the range
    expect(isPrivateIp("100.128.0.0")).toBe(false); // one address above the range
  });

  it("blocks the deprecated 6to4 anycast relay 192.88.99.0/24 (RFC 3068)", () => {
    expect(isPrivateIp("192.88.99.1")).toBe(true);
  });

  it("does not over-block the addresses immediately adjacent to 192.88.99.0/24", () => {
    expect(isPrivateIp("192.88.98.255")).toBe(false); // one address below the range
    expect(isPrivateIp("192.88.100.0")).toBe(false); // one address above the range
  });

  it("unwraps a 6to4 2002::/16 address and recurses on the embedded private IPv4 (RFC 3056)", () => {
    expect(isPrivateIp("2002:a00:1::")).toBe(true); // embeds 10.0.0.1
    expect(isPrivateIp("2002:7f00:1::")).toBe(true); // embeds 127.0.0.1
  });

  it("allows a 6to4-wrapped public IPv4 through instead of blocking the whole 2002::/16 range", () => {
    expect(isPrivateIp("2002:808:808::")).toBe(false); // embeds 8.8.8.8
  });
});

describe("isPublicHost", () => {
  it("returns false for empty host", async () => {
    expect(await isPublicHost("")).toBe(false);
  });

  it("returns true for public IPv4 literal without DNS", async () => {
    expect(await isPublicHost("8.8.8.8")).toBe(true);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("returns false for private IPv4 literal without DNS", async () => {
    expect(await isPublicHost("127.0.0.1")).toBe(false);
    expect(await isPublicHost("169.254.169.254")).toBe(false);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("looks up hostname and returns true when all addresses are public", async () => {
    expect(await isPublicHost("public.example")).toBe(true);
    expect(dns.lookup).toHaveBeenCalledWith("public.example", {
      all: true,
      verbatim: true,
    });
  });

  it("returns false when any resolved address is private", async () => {
    setDnsLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(await isPublicHost("mixed.example")).toBe(false);
  });

  it("returns false when DNS lookup throws", async () => {
    mockDnsFail();
    expect(await isPublicHost("nx.example")).toBe(false);
  });

  it("returns false when DNS returns no addresses", async () => {
    setDnsLookup(async () => []);
    expect(await isPublicHost("empty.example")).toBe(false);
  });

  it("strips brackets from IPv6 hostnames before validation", async () => {
    expect(await isPublicHost("[::1]")).toBe(false);
  });
});

describe("functions", () => {
  it("reads a valid local image", async () => {
    const buf = await readLocalImage("noimage.jpg", baseDir, "normal");
    expect(buf.length).toBeGreaterThan(0);
  });

  it("returns fallback when read fails", async () => {
    const result = await readLocalImage("missing.jpg", baseDir, "normal");
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("fetches network image with allowed mime", async () => {
    const data = Buffer.from("image");
    vi.mocked(axios.get).mockResolvedValue({
      data,
      headers: { "content-type": "image/jpeg" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(Buffer.from("image"))).toBe(true);
  });

  it("falls back when axios throws", async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error("network fail"));
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("returns fallback on non-2xx response", async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error("status 408"));
    const onFallback = vi.fn();
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1, maxBytes: 1, onFallback },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("returns fallback when URL parse fails", async () => {
    // Also exercises fetchImage's own catch-all branch, which treats the
    // unparseable `src` as a local path via a nested readLocalImage call —
    // proves onFallback threads through THAT delegation, not just the
    // direct network branches.
    const onFallback = vi.fn();
    const result = await fetchImage(
      "not a url",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1, maxBytes: 1, onFallback },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("returns fallback when content-type is missing", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.from("data"),
      headers: {},
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("returns fallback when host is not allowed", async () => {
    const result = await fetchImage(
      "https://disallowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("returns fallback when allowed host has disallowed mime", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.from("data"),
      headers: { "content-type": "text/plain" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const onFallback = vi.fn();
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, onFallback },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("returns fallback when protocol is not http/https", async () => {
    const onFallback = vi.fn();
    const result = await fetchImage(
      "ftp://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, onFallback },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("reads local when host is internal", async () => {
    const internalUrl = "http://localhost/api/v1/noimage.jpg";
    const result = await fetchImage(
      internalUrl,
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const local = await readLocalImage("noimage.jpg", baseDir, "normal");
    expect(result.equals(local)).toBe(true);
  });

  it("isValidPath returns false when baseDir is a file", async () => {
    const fileBase = path.join(baseDir, "noimage.jpg");
    const valid = await isValidPath(fileBase, "nested.jpg");
    expect(valid).toBe(false);
  });

  it("isValidPath returns false on empty base or specified path", async () => {
    expect(await isValidPath("", "file")).toBe(false);
    expect(await isValidPath(baseDir, "")).toBe(false);
  });

  it("returns fallback when URL parsing fails", async () => {
    const result = await fetchImage(
      "::::",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1, maxBytes: 1 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("provides avatar fallback asset", async () => {
    const avatar = await FALLBACKIMAGES.avatar();
    expect(avatar.length).toBeGreaterThan(0);
  });

  it("returns fallback when readLocalImage catches fs errors", async () => {
    const result = await readLocalImage(".", baseDir, "normal"); // "." resolves to directory -> readFile throws
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("returns fallback when path is invalid", async () => {
    const valid = await isValidPath(baseDir, "../etc/passwd");
    expect(valid).toBe(false);
  });

  it("isValidPath rejects null bytes in path", async () => {
    const valid = await isValidPath(baseDir, "file\0name.jpg");
    expect(valid).toBe(false);
  });

  it("isValidPath rejects absolute paths", async () => {
    const valid = await isValidPath(baseDir, "/etc/passwd");
    expect(valid).toBe(false);
  });

  it("isValidPath rejects control characters in path", async () => {
    const valid = await isValidPath(baseDir, "file\x01name.jpg");
    expect(valid).toBe(false);
  });

  it("isValidPath accepts valid file within base directory", async () => {
    const valid = await isValidPath(baseDir, "noimage.jpg");
    expect(valid).toBe(true);
  });

  it("reads local image with avatar type fallback", async () => {
    const result = await readLocalImage("missing.jpg", baseDir, "avatar");
    const fallback = await FALLBACKIMAGES.avatar();
    expect(result.equals(fallback)).toBe(true);
  });

  it("fetchImage uses avatar fallback for disallowed host", async () => {
    const result = await fetchImage(
      "https://disallowed.test/img.jpg",
      baseDir,
      "localhost",
      "avatar",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.avatar();
    expect(result.equals(fallback)).toBe(true);
  });

  it("fetchImage handles www subdomain for internal host", async () => {
    // Mismatched-type trick (see the "websiteURL config-form normalization"
    // block below for the full rationale): request `type: "avatar"` while
    // targeting the *normal*-type asset `noimage.jpg`, so a genuine internal
    // local read (returns `noimage.jpg`'s bytes) is byte-distinguishable from
    // the blocked-host fallback (returns the avatar asset `noavatar.png`). A
    // matched `type: "normal"` here would pass vacuously — the blocked-host
    // branch ALSO serves `noimage.jpg` (it IS the normal fallback). `maxBytes`
    // is raised above the real fixture size so the on-disk read is not masked
    // by `readLocalImage`'s own size-guard fallback.
    const internalUrl = "http://www.localhost/api/v1/noimage.jpg";
    const result = await fetchImage(
      internalUrl,
      baseDir,
      "localhost",
      "avatar",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 10_000_000 },
    );
    const local = await readLocalImage(
      "noimage.jpg",
      baseDir,
      "avatar",
      10_000_000,
    );
    const avatarFallback = await FALLBACKIMAGES.avatar();
    expect(result.equals(local)).toBe(true);
    expect(result.equals(avatarFallback)).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("fetchImage handles websiteURL being undefined", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.from("image"),
      headers: { "content-type": "image/jpeg" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      undefined,
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(Buffer.from("image"))).toBe(true);
  });

  it("fetchImage falls back to local read when URL parse fails", async () => {
    const result = await fetchImage(
      "not-a-url-at-all",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      [],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    // Should fall back to local read which returns fallback for invalid path
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("fetchFromNetwork returns avatar fallback on error", async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error("network error"));
    const result = await fetchImage(
      "https://allowed.test/avatar.jpg",
      baseDir,
      "localhost",
      "avatar",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.avatar();
    expect(result.equals(fallback)).toBe(true);
  });

  it("accepts content-type with charset parameter", async () => {
    const data = Buffer.from("image-data");
    vi.mocked(axios.get).mockResolvedValue({
      data,
      headers: { "content-type": "image/jpeg; charset=utf-8" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(Buffer.from("image-data"))).toBe(true);
  });

  it("matches internal host regardless of port", async () => {
    // Mismatched-type trick: bare `websiteURL: "localhost"` must match a
    // request whose host carries a port (`localhost:3001`) via the hostname
    // comparison. Request `type: "avatar"` against the normal-type asset so a
    // real internal local read is byte-distinguishable from the blocked-host
    // avatar fallback; a matched `type: "normal"` would pass vacuously.
    const internalUrl = "http://localhost:3001/api/v1/noimage.jpg";
    const result = await fetchImage(
      internalUrl,
      baseDir,
      "localhost",
      "avatar",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 10_000_000 },
    );
    const local = await readLocalImage(
      "noimage.jpg",
      baseDir,
      "avatar",
      10_000_000,
    );
    const avatarFallback = await FALLBACKIMAGES.avatar();
    expect(result.equals(local)).toBe(true);
    expect(result.equals(avatarFallback)).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("readLocalImage returns fallback when file exceeds maxBytes", async () => {
    const result = await readLocalImage("noimage.jpg", baseDir, "normal", 1);
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("readLocalImage reads file when under maxBytes limit", async () => {
    const result = await readLocalImage(
      "noimage.jpg",
      baseDir,
      "normal",
      10_000_000,
    );
    expect(result.length).toBeGreaterThan(0);
  });

  it("matches allowed network host with port in URL", async () => {
    const data = Buffer.from("image-data");
    vi.mocked(axios.get).mockResolvedValue({
      data,
      headers: { "content-type": "image/png" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test:8080/img.png",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(Buffer.from("image-data"))).toBe(true);
  });

  it("isValidPath rejects double-dot encoded traversal paths", async () => {
    const valid = await isValidPath(baseDir, "..%2F..%2Fetc%2Fpasswd");
    expect(valid).toBe(false);
  });

  it("isValidPath rejects paths with backslash traversal", async () => {
    const valid = await isValidPath(baseDir, "..\\secret.txt");
    expect(valid).toBe(false);
  });

  it("readLocalImage returns avatar fallback when directory read fails", async () => {
    const result = await readLocalImage(".", baseDir, "avatar");
    const fallback = await FALLBACKIMAGES.avatar();
    expect(result.equals(fallback)).toBe(true);
  });

  it("fetchImage falls back when allowed host has uppercase content-type", async () => {
    const data = Buffer.from("image-data");
    vi.mocked(axios.get).mockResolvedValue({
      data,
      headers: { "content-type": "IMAGE/JPEG" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(Buffer.from("image-data"))).toBe(true);
  });

  it("fetchImage handles content-type with multiple parameters", async () => {
    const data = Buffer.from("image-data");
    vi.mocked(axios.get).mockResolvedValue({
      data,
      headers: {
        "content-type": "image/png; charset=utf-8; boundary=something",
      },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.png",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(Buffer.from("image-data"))).toBe(true);
  });

  it("fetchImage reads local for internal URL with custom apiRegex", async () => {
    // Mismatched-type trick: prove the custom `apiRegex` (`/^\/custom\/path\//`)
    // is stripped and the result is a genuine internal local read of
    // `noimage.jpg`, not the blocked-host avatar fallback. Request
    // `type: "avatar"` against the normal-type asset so the two outcomes are
    // byte-distinguishable; a matched `type: "normal"` would pass vacuously.
    const internalUrl = "http://localhost/custom/path/noimage.jpg";
    const result = await fetchImage(
      internalUrl,
      baseDir,
      "localhost",
      "avatar",
      /^\/custom\/path\//,
      [],
      { timeoutMs: 1000, maxBytes: 10_000_000 },
    );
    const local = await readLocalImage(
      "noimage.jpg",
      baseDir,
      "avatar",
      10_000_000,
    );
    const avatarFallback = await FALLBACKIMAGES.avatar();
    expect(result.equals(local)).toBe(true);
    expect(result.equals(avatarFallback)).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("readLocalImage returns fallback for maxBytes of 0", async () => {
    const result = await readLocalImage("noimage.jpg", baseDir, "normal", 0);
    // maxBytes of 0 is falsy, so no size check happens - file is read normally
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("websiteURL config-form normalization (Phase 2)", () => {
  // Prior to normalization, fetchImage compared `url.hostname` against the
  // RAW `websiteURL` string. A bare hostname happened to work by accident
  // (hostname-vs-hostname), but `host:port` and full-URL config values never
  // matched `url.hostname` (which never contains a port), so internal images
  // were misrouted through the external-fetch/allowlist path.
  //
  // Proof strategy: `baseDir` (the test fixtures directory) contains ONLY
  // the package's own bundled fallback images, so a plain
  // `result.equals(await readLocalImage("noimage.jpg", baseDir, "normal"))`
  // assertion would be VACUOUS — the "blocked host -> serve fallback" branch
  // ALSO reads `noimage.jpg` (it IS the normal-type fallback asset), so that
  // assertion passes whether or not the internal-host branch actually ran.
  // Each case below instead requests `type: "avatar"` while targeting
  // `noimage.jpg` (the *normal*-type asset). `readLocalImage` ignores `type`
  // on a successful read and returns the target file's actual bytes, so:
  //   - internal-host branch (correct): returns noimage.jpg's bytes
  //   - blocked-host branch (bug): returns FALLBACKIMAGES.avatar()'s bytes
  //     (noavatar.png) instead — a different file, so the two outcomes are
  //     byte-distinguishable and the test genuinely proves which branch ran.
  // `maxBytes` is set well above the real fixture size (unlike the mocked-
  // axios tests elsewhere in this file, these reads hit the actual on-disk
  // asset, so an undersized maxBytes would itself trigger the size-guard
  // fallback and mask the very branch this test is trying to prove).
  // Verified by temporarily reverting the fix: the bare-hostname case already
  // passed pre-fix (a bare hostname matched `url.hostname` by coincidence
  // even under the old raw-string comparison — see Finding #2), while the
  // host:port and full-URL cases genuinely resolved to `avatarFallback`
  // instead of `local` and failed, confirming those two are real regression
  // tests for the bug this phase fixes.

  it("resolves an internal src to a local read when websiteURL is a bare hostname", async () => {
    const internalUrl = "http://localhost/api/v1/noimage.jpg";
    const result = await fetchImage(
      internalUrl,
      baseDir,
      "localhost",
      "avatar",
      /^\/api\/v1\//,
      [],
      { timeoutMs: 1000, maxBytes: 10_000_000 },
    );
    const local = await readLocalImage(
      "noimage.jpg",
      baseDir,
      "avatar",
      10_000_000,
    );
    const avatarFallback = await FALLBACKIMAGES.avatar();
    expect(result.equals(local)).toBe(true);
    expect(result.equals(avatarFallback)).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("resolves an internal src to a local read when websiteURL is a host:port pair", async () => {
    // The shipped demo config form (Finding #2 / #10): `websiteURL:
    // "localhost:3001"`. `new URL("localhost:3001")` (no scheme prepended)
    // parses as protocol "localhost:" with an opaque path "3001" — NOT an
    // authority with a host — so normalizeWebsiteHost must prepend a
    // placeholder scheme before parsing for this form to resolve at all.
    const internalUrl = "http://localhost:3001/api/v1/noimage.jpg";
    const result = await fetchImage(
      internalUrl,
      baseDir,
      "localhost:3001",
      "avatar",
      /^\/api\/v1\//,
      [],
      { timeoutMs: 1000, maxBytes: 10_000_000 },
    );
    const local = await readLocalImage(
      "noimage.jpg",
      baseDir,
      "avatar",
      10_000_000,
    );
    const avatarFallback = await FALLBACKIMAGES.avatar();
    expect(result.equals(local)).toBe(true);
    expect(result.equals(avatarFallback)).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("resolves an internal src to a local read when websiteURL is a full URL", async () => {
    const internalUrl = "https://localhost:3001/api/v1/noimage.jpg";
    const result = await fetchImage(
      internalUrl,
      baseDir,
      "https://localhost:3001",
      "avatar",
      /^\/api\/v1\//,
      [],
      { timeoutMs: 1000, maxBytes: 10_000_000 },
    );
    const local = await readLocalImage(
      "noimage.jpg",
      baseDir,
      "avatar",
      10_000_000,
    );
    const avatarFallback = await FALLBACKIMAGES.avatar();
    expect(result.equals(local)).toBe(true);
    expect(result.equals(avatarFallback)).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("still treats a genuinely external host as external when websiteURL is a host:port pair", async () => {
    // Defense-in-depth: the looser host:port/full-URL normalization must not
    // over-match and misroute a real external allowlisted host into the
    // internal (local-read) branch.
    const data = Buffer.from("image-data");
    vi.mocked(axios.get).mockResolvedValue({
      data,
      headers: { "content-type": "image/jpeg" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost:3001",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(data)).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it("falls back to raw-string comparison when websiteURL fails to parse even with a scheme prepended", async () => {
    // A configured value containing a raw space is not a valid hostname and
    // fails `new URL("http://" + websiteURL)`. Without a defensive fallback,
    // that parse failure would propagate out of normalizeWebsiteHost and hit
    // fetchImage's OUTER catch, which re-routes the ENTIRE src through
    // readLocalImage as a literal filesystem path — breaking even genuinely
    // external, allowlisted requests. The fallback must instead let the
    // request proceed through the normal (non-internal) branch so an
    // unrelated, well-formed request is unaffected by the bad config.
    const data = Buffer.from("image-data");
    vi.mocked(axios.get).mockResolvedValue({
      data,
      headers: { "content-type": "image/jpeg" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "exa mple.com",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(data)).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});

describe("resolveInternalLocalPath", () => {
  // Pure-function unit tests for the helper `fetchImage` and (as of this
  // phase) `buildSourceIdentifier` both delegate to for internal-host
  // detection. No filesystem access happens here — the assertions are on
  // the returned pathname string itself, not on what is actually on disk.

  it("resolves an internal URL to its stripped pathname when websiteURL is a bare hostname", () => {
    const result = resolveInternalLocalPath(
      "http://localhost/api/v1/noimage.jpg",
      "localhost",
      API_REGEX,
      undefined,
    );
    expect(result).toBe("noimage.jpg");
  });

  it("resolves an internal URL to its stripped pathname when websiteURL is a host:port pair", () => {
    const result = resolveInternalLocalPath(
      "http://localhost:3001/api/v1/noimage.jpg",
      "localhost:3001",
      API_REGEX,
      undefined,
    );
    expect(result).toBe("noimage.jpg");
  });

  it("resolves an internal URL to its stripped pathname when websiteURL is a full URL", () => {
    const result = resolveInternalLocalPath(
      "https://localhost:3001/api/v1/noimage.jpg",
      "https://localhost:3001",
      API_REGEX,
      undefined,
    );
    expect(result).toBe("noimage.jpg");
  });

  it("matches the www-prefixed variant of the configured hostname", () => {
    const result = resolveInternalLocalPath(
      "http://www.localhost/api/v1/noimage.jpg",
      "localhost",
      API_REGEX,
      undefined,
    );
    expect(result).toBe("noimage.jpg");
  });

  it("uses apiPrefix instead of apiRegex when both are supplied (precedence)", () => {
    // apiRegex would strip "/api/v1/"; apiPrefix ("/custom/") does not match
    // this pathname at all, so with precedence enforced the regex must not
    // run and the pathname returns unchanged.
    const result = resolveInternalLocalPath(
      "http://localhost/api/v1/noimage.jpg",
      "localhost",
      API_REGEX,
      "/custom/",
    );
    expect(result).toBe("/api/v1/noimage.jpg");
  });

  it("returns null for a genuinely external host", () => {
    const result = resolveInternalLocalPath(
      "https://allowed.test/img.jpg",
      "localhost",
      API_REGEX,
      undefined,
    );
    expect(result).toBeNull();
  });

  it("returns null when websiteURL is undefined (internal-host detection disabled)", () => {
    const result = resolveInternalLocalPath(
      "http://localhost/api/v1/noimage.jpg",
      undefined,
      API_REGEX,
      undefined,
    );
    expect(result).toBeNull();
  });

  it("returns null when src does not parse as a URL", () => {
    const result = resolveInternalLocalPath(
      "not-a-url-at-all",
      "localhost",
      API_REGEX,
      undefined,
    );
    expect(result).toBeNull();
  });
});

describe("isValidPath edge cases", () => {
  it("rejects paths starting with a backslash (Windows-style absolute / UNC)", async () => {
    // \\\\server\\share\\file would be path.isAbsolute on Win32, but the
    // backslash guard fires first on every platform.
    expect(await isValidPath(baseDir, "\\server\\share\\file")).toBe(false);
    expect(await isValidPath(baseDir, "\\\\server\\share\\file")).toBe(false);
  });

  it("rejects paths containing a single backslash anywhere", async () => {
    // POSIX accepts `\\` as a literal filename byte. Pixel Serve rejects it
    // unconditionally so behavior matches Windows where `\\` is a separator.
    expect(await isValidPath(baseDir, "sub\\noimage.jpg")).toBe(false);
    expect(await isValidPath(baseDir, "noimage.jpg\\")).toBe(false);
    expect(await isValidPath(baseDir, "noimage\\.jpg")).toBe(false);
  });

  it("rejects paths containing the DEL control character (\\x7F)", async () => {
    expect(await isValidPath(baseDir, "file\x7Fname.jpg")).toBe(false);
    expect(await isValidPath(baseDir, "\x7Fnoimage.jpg")).toBe(false);
  });

  it("accepts paths with redundant forward slashes (path.resolve normalizes)", async () => {
    // path.resolve collapses repeated slashes, so `foo//bar` resolves the
    // same as `foo/bar`. The containment check therefore still holds.
    expect(await isValidPath(baseDir, "noimage.jpg")).toBe(true);
    // Multiple leading slashes that look absolute are rejected by isAbsolute.
    expect(await isValidPath(baseDir, "//noimage.jpg")).toBe(false);
  });

  it("rejects paths that resolve to a directory rather than a file", async () => {
    // assets/ contains the asset files but the baseDir itself is a dir.
    // Passing "." (or anything that resolves back to baseDir) must reject.
    expect(await isValidPath(baseDir, ".")).toBe(false);
  });

  it("rejects pathological long paths (> 4096 chars)", async () => {
    const longSegment = "a".repeat(5000);
    expect(await isValidPath(baseDir, longSegment)).toBe(false);
    // Boundary: exactly 4097 is rejected, 4096 reaches realpath which throws
    expect(await isValidPath(baseDir, "a".repeat(4097))).toBe(false);
  });

  it("normalizes trailing slashes consistently with the underlying FS", async () => {
    // path.resolve strips trailing slashes; realpath then sees a file. The
    // result is platform-dependent: POSIX realpath may reject the implied
    // directory ref, Windows is lenient. Either outcome is acceptable —
    // the important property is that the function does NOT throw and
    // returns a boolean. The other isValidPath tests pin the security
    // properties (no traversal, no symlink escape).
    const result = await isValidPath(baseDir, "noimage.jpg/");
    expect(typeof result).toBe("boolean");
  });

  it("rejects empty path with leading whitespace + control char (regex-based)", async () => {
    // The control-char regex rejects any \x00-\x1F or \x7F before realpath.
    expect(await isValidPath(baseDir, " \tnoimage.jpg")).toBe(false);
  });

  it("rejects paths that resolve to a directory inside the base", async () => {
    // The new isFile() check rejects anything that resolves to a directory,
    // even when the directory is inside baseDir. Use the assets dir itself
    // by referencing its containing folder name via a sibling that's a dir.
    const fsmod = await import("node:fs/promises");
    const osmod = await import("node:os");
    const tmpBase = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-dirref-"),
    );
    try {
      const subDir = path.join(tmpBase, "subdir");
      await fsmod.mkdir(subDir);
      // Referencing "subdir" resolves to a directory, which must be
      // rejected by the new isFile() guard.
      expect(await isValidPath(tmpBase, "subdir")).toBe(false);
    } finally {
      await fsmod.rm(tmpBase, { recursive: true, force: true });
    }
  });

  // Note: Backslash handling diverges between POSIX (literal byte) and
  // Windows (separator). The implementation rejects backslash on both
  // platforms for cross-platform safety; the tests above pin this.
});

describe("SSRF redirect protection", () => {
  it("rejects an allowed host whose DNS resolves to a private IP", async () => {
    mockDnsPrivate();
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("rejects an allowed host when DNS lookup fails", async () => {
    mockDnsFail();
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("follows a single redirect to another allowed public host", async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        data: Buffer.alloc(0),
        headers: { location: "https://other.test/final.jpg" },
        status: 302,
        statusText: "Found",
        config: {},
      })
      .mockResolvedValueOnce({
        data: Buffer.from("redirected-image"),
        headers: { "content-type": "image/jpeg" },
        status: 200,
        statusText: "OK",
        config: {},
      });

    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test", "other.test"],
      {
        timeoutMs: 1000,
        maxBytes: 1024,
        maxRedirects: 3,
      },
    );
    expect(result.equals(Buffer.from("redirected-image"))).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it("rejects a redirect to an unlisted host", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.alloc(0),
      headers: { location: "https://evil.test/final.jpg" },
      status: 302,
      statusText: "Found",
      config: {},
    });

    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"], // evil.test NOT in allowlist
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect to a private/loopback IP", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.alloc(0),
      headers: { location: "http://127.0.0.1:6379/keys" },
      status: 302,
      statusText: "Found",
      config: {},
    });

    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test", "127.0.0.1"], // even if allowlisted, private IP must be rejected
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("rejects a redirect to the AWS IMDS link-local address", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.alloc(0),
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
      status: 301,
      statusText: "Moved",
      config: {},
    });

    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test", "169.254.169.254"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("bails after exhausting maxRedirects", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.alloc(0),
      headers: { location: "https://allowed.test/loop" },
      status: 302,
      statusText: "Found",
      config: {},
    });

    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 2 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    // 1 initial + 2 redirect follows = 3 hops, then bail
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  it("rejects redirect without Location header", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.alloc(0),
      headers: {},
      status: 302,
      statusText: "Found",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("rejects redirect with malformed Location URL", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.alloc(0),
      headers: { location: "::::not a url" },
      status: 302,
      statusText: "Found",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("treats axios 3xx error responses as redirects", async () => {
    // Axios with maxRedirects: 0 throws on 3xx; simulate AxiosError with response
    const axiosErr = Object.assign(new Error("Redirect"), {
      response: {
        data: Buffer.alloc(0),
        headers: { location: "https://allowed.test/img2.jpg" },
        status: 302,
        statusText: "Found",
        config: {},
      },
    });
    vi.mocked(axios.get)
      .mockRejectedValueOnce(axiosErr)
      .mockResolvedValueOnce({
        data: Buffer.from("after-error-redirect"),
        headers: { "content-type": "image/jpeg" },
        status: 200,
        statusText: "OK",
        config: {},
      });

    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    expect(result.equals(Buffer.from("after-error-redirect"))).toBe(true);
  });

  it("rejects a redirect that switches to a non-http(s) protocol", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.alloc(0),
      headers: { location: "file:///etc/passwd" },
      status: 302,
      statusText: "Found",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("does not auto-follow redirects via axios (maxRedirects: 0 enforced)", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.from("ignored"),
      headers: { "content-type": "image/jpeg" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const callArgs = vi.mocked(axios.get).mock.calls[0]?.[1];
    expect(callArgs?.maxRedirects).toBe(0);
  });

  it("returns fallback when status is 5xx after a redirect", async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        data: Buffer.alloc(0),
        headers: { location: "https://allowed.test/final.jpg" },
        status: 302,
        statusText: "Found",
        config: {},
      })
      .mockResolvedValueOnce({
        data: Buffer.from("garbage"),
        headers: { "content-type": "image/jpeg" },
        // simulate axios surfacing a successful range that's actually 4xx by
        // hijacking validateStatus — we'll fake the response status.
        status: 500,
        statusText: "Server Error",
        config: {},
      });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("validateStatus closure accepts 2xx and 3xx, rejects 4xx/5xx", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.from("ok"),
      headers: { "content-type": "image/jpeg" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    const callOptions = vi.mocked(axios.get).mock.calls[0]?.[1];
    const validateStatus = callOptions?.validateStatus as
      | ((s: number) => boolean)
      | undefined;
    expect(validateStatus).toBeDefined();
    expect(validateStatus?.(200)).toBe(true);
    expect(validateStatus?.(204)).toBe(true);
    expect(validateStatus?.(302)).toBe(true);
    expect(validateStatus?.(399)).toBe(true);
    expect(validateStatus?.(400)).toBe(false);
    expect(validateStatus?.(500)).toBe(false);
    expect(validateStatus?.(199)).toBe(false);
  });

  it("recovers when axios throws a non-AxiosError without response field", async () => {
    vi.mocked(axios.get).mockRejectedValueOnce({ no: "response" });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("uses default maxRedirects of 3 when not passed explicitly", async () => {
    // simulate 4 consecutive redirects -- initial + 3 follows = 4 calls -- then bail
    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.alloc(0),
      headers: { location: "https://allowed.test/again" },
      status: 302,
      statusText: "Found",
      config: {},
    });
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(4);
  });
});

describe("apiPrefix + apiRegex (Task 15)", () => {
  describe("stripApiPrefix unit", () => {
    it("strips a matching apiPrefix and returns the suffix unchanged", () => {
      expect(stripApiPrefix("/api/v1/photo.jpg", API_REGEX, "/api/v1/")).toBe(
        "photo.jpg",
      );
    });

    it("returns the original pathname when apiPrefix does not match", () => {
      expect(stripApiPrefix("/cdn/photo.jpg", API_REGEX, "/api/v1/")).toBe(
        "/cdn/photo.jpg",
      );
    });

    it("falls back to apiRegex when apiPrefix is undefined", () => {
      expect(stripApiPrefix("/api/v1/photo.jpg", API_REGEX, undefined)).toBe(
        "photo.jpg",
      );
    });

    it("apiPrefix takes precedence over apiRegex when both are supplied", () => {
      // The pathname matches the apiRegex but NOT the apiPrefix. With
      // precedence enforced, the regex must not run — the original pathname
      // is returned unchanged.
      const result = stripApiPrefix(
        "/api/v1/photo.jpg",
        /^\/api\/v1\//,
        "/different-prefix/",
      );
      expect(result).toBe("/api/v1/photo.jpg");
    });

    it("apiPrefix with empty pathname returns the empty string", () => {
      expect(stripApiPrefix("", API_REGEX, "/api/v1/")).toBe("");
    });
  });

  describe("default apiRegex ReDoS resistance", () => {
    it("processes pathological long inputs in well under 100ms", () => {
      // Feed a very long string that *almost* matches the default
      // `/^\/api\/v1\//` pattern but never satisfies it. The default regex
      // is fixed and anchored, so it cannot exhibit catastrophic
      // backtracking. We assert an order-of-magnitude bound to catch any
      // future regression that introduces ambiguous quantifiers.
      const pathological = "/api/v1" + "/".repeat(50_000) + "x";
      const start = Date.now();
      const result = pathological.replace(API_REGEX, "");
      const elapsed = Date.now() - start;
      // Safe-margin upper bound. Real measurements on Node 22 sit < 5ms.
      expect(elapsed).toBeLessThan(100);
      // Sanity: the regex actually matched the prefix and stripped 8 chars
      // (`/api/v1/`).
      expect(result.length).toBe(pathological.length - "/api/v1/".length);
    });

    it("handles a million-character non-matching input in well under 100ms", () => {
      const noMatch = "/cdn/" + "a".repeat(1_000_000);
      const start = Date.now();
      const result = noMatch.replace(API_REGEX, "");
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
      // No match — pathname is returned unchanged.
      expect(result).toBe(noMatch);
    });
  });

  describe("fetchImage integration", () => {
    it("uses apiPrefix to strip internal URLs when supplied", async () => {
      // The pathname is `/api/v1/noimage.jpg`. apiPrefix "/api/v1/" strips
      // the leading 8 characters; pixel-serve then reads `noimage.jpg`
      // from baseDir.
      const internalUrl = "http://localhost/api/v1/noimage.jpg";
      const result = await fetchImage(
        internalUrl,
        baseDir,
        "localhost",
        "normal",
        /^\/IGNORED-REGEX-MUST-NOT-RUN\//,
        [],
        {
          timeoutMs: 1000,
          maxBytes: 1024,
          apiPrefix: "/api/v1/",
        },
      );
      const local = await readLocalImage("noimage.jpg", baseDir, "normal");
      expect(result.equals(local)).toBe(true);
    });

    it("apiPrefix takes precedence over apiRegex in fetchImage", async () => {
      // The apiPrefix "/different/" does NOT match the URL pathname, so the
      // pathname is left intact (`/api/v1/noimage.jpg`). The regex would
      // have stripped the prefix if it had been allowed to run, but the
      // precedence rule skips the regex entirely. The resulting local path
      // is `/api/v1/noimage.jpg` which is absolute → isValidPath rejects →
      // pixel-serve returns the fallback image.
      const internalUrl = "http://localhost/api/v1/noimage.jpg";
      const result = await fetchImage(
        internalUrl,
        baseDir,
        "localhost",
        "normal",
        /^\/api\/v1\//,
        [],
        {
          timeoutMs: 1000,
          maxBytes: 1024,
          apiPrefix: "/different/",
        },
      );
      const fallback = await FALLBACKIMAGES.normal();
      expect(result.equals(fallback)).toBe(true);
    });

    it("falls back to apiRegex when apiPrefix is not supplied", async () => {
      const internalUrl = "http://localhost/api/v1/noimage.jpg";
      const result = await fetchImage(
        internalUrl,
        baseDir,
        "localhost",
        "normal",
        /^\/api\/v1\//,
        [],
        { timeoutMs: 1000, maxBytes: 1024 },
      );
      const local = await readLocalImage("noimage.jpg", baseDir, "normal");
      expect(result.equals(local)).toBe(true);
    });
  });
});

describe("fetchImage edge cases (Task 14)", () => {
  it("bails after EXACTLY maxRedirects hops (boundary check)", async () => {
    // 1 initial GET + 4 redirect follows = 5 calls when maxRedirects=4. The
    // loop in fetchFromNetwork runs for `hop <= maxRedirects`, so the 5th
    // iteration receives the last 302, increments the hop counter, then the
    // for-loop exits and the function returns the fallback.
    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.alloc(0),
      headers: { location: "https://allowed.test/again" },
      status: 302,
      statusText: "Found",
      config: {},
    });
    const onFallback = vi.fn();
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 4, onFallback },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(5);
    // Exhausted-redirect-budget branch: a distinct fetchFromNetwork exit
    // point from the "no response"/non-2xx/disallowed-mime branches covered
    // elsewhere, still routed through the same shared fallback() closure.
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("accepts Number.MAX_SAFE_INTEGER as maxBytes without overflow", async () => {
    // The size guard inside readLocalImage compares `stats.size > maxBytes`.
    // With MAX_SAFE_INTEGER the comparison must NOT overflow into negative
    // territory or NaN — any real image is well under the cap and reads
    // normally.
    const result = await readLocalImage(
      "noimage.jpg",
      baseDir,
      "normal",
      Number.MAX_SAFE_INTEGER,
    );
    expect(result.length).toBeGreaterThan(0);
  });

  it("treats negative maxBytes as a no-op size guard (current behavior)", async () => {
    // Negative numbers are falsy-ish (`-1` is truthy in JS, but the guard
    // does an explicit `> maxBytes` comparison). With maxBytes=-1, every
    // stats.size is > -1, so the guard FIRES and the fallback is returned.
    // This documents the current behavior so a future refactor noticing the
    // weird semantics has a regression test pinning the contract.
    const result = await readLocalImage("noimage.jpg", baseDir, "normal", -1);
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("rejects javascript: URLs because they are not http/https", async () => {
    // `new URL("javascript:alert(1)")` parses successfully in Node, but the
    // protocol guard in fetchImage must reject the request before any axios
    // call is made.
    const result = await fetchImage(
      "javascript:alert(1)",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("falls back when the URL string is malformed (bracketed IPv6 without closing bracket)", async () => {
    // `http://[not-an-ipv6` throws inside `new URL(...)`; fetchImage's outer
    // catch routes to readLocalImage, which then rejects the path. The end
    // result is the fallback image.
    const result = await fetchImage(
      "http://[not-an-ipv6",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("falls back for an empty hostname URL (http:///path)", async () => {
    const result = await fetchImage(
      "http:///just-a-path",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });
});

describe("allowedNetworkList case-insensitive matching (Task 2)", () => {
  it("matches host case-insensitively against allowedNetworkList configured with uppercase entries", async () => {
    // The WHATWG URL parser always lowercases hostnames, so an operator
    // configuring `allowedNetworkList: ["CDN.Example.com"]` (e.g. from an
    // .env file or case-preserving config) would silently never match
    // without schema-level normalization. The optionsSchema lowercases
    // entries at parse time, so by the time fetchImage receives the
    // allowedNetworkList it is already normalized.
    const { optionsSchema } = await import("./schema");
    const parsed = optionsSchema.parse({
      baseDir: "/tmp",
      allowedNetworkList: ["CDN.Example.com", "  Images.Test  "],
    });
    expect(parsed.allowedNetworkList).toEqual([
      "cdn.example.com",
      "images.test",
    ]);

    // End-to-end: pass the normalized list through to fetchImage and
    // confirm the lowercase hostname in the URL is matched successfully.
    mockDnsPublic();
    const data = Buffer.from("image");
    vi.mocked(axios.get).mockResolvedValue({
      data,
      headers: { "content-type": "image/jpeg" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://cdn.example.com/x.jpg",
      baseDir,
      undefined,
      "normal",
      /^\/api\/v1\//,
      parsed.allowedNetworkList,
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(data)).toBe(true);
  });
});

describe("wildcard allowlist matching (*.domain)", () => {
  // Regression coverage for the picsum.photos breakage: a host that
  // 302-redirects to a CDN SUBDOMAIN (`picsum.photos` → `fastly.picsum.photos`)
  // is rejected by an exact-match allowlist because the redirect hop is
  // re-validated. A `*.picsum.photos` wildcard entry allows the apex and any
  // subdomain, so the redirect resolves to the real image.

  it("follows a redirect to a CDN subdomain when the wildcard entry allows it (picsum scenario)", async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        data: Buffer.alloc(0),
        headers: { location: "https://fastly.picsum.photos/id/1/800/600.jpg" },
        status: 302,
        statusText: "Found",
        config: {},
      })
      .mockResolvedValueOnce({
        data: Buffer.from("cdn-image"),
        headers: { "content-type": "image/jpeg" },
        status: 200,
        statusText: "OK",
        config: {},
      });

    const result = await fetchImage(
      "https://picsum.photos/seed/net1/800/600",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["*.picsum.photos"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    expect(result.equals(Buffer.from("cdn-image"))).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it("still falls back on the same redirect when only the exact apex is allowlisted", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.alloc(0),
      headers: { location: "https://fastly.picsum.photos/id/1/800/600.jpg" },
      status: 302,
      statusText: "Found",
      config: {},
    });

    const result = await fetchImage(
      "https://picsum.photos/seed/net1/800/600",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["picsum.photos"], // exact — does NOT cover the fastly.* subdomain
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it("matches the apex host directly via a wildcard entry (no redirect)", async () => {
    const data = Buffer.from("apex-image");
    vi.mocked(axios.get).mockResolvedValue({
      data,
      headers: { "content-type": "image/jpeg" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://picsum.photos/x.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["*.picsum.photos"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(data)).toBe(true);
  });

  it("matches a deep subdomain via a wildcard entry", async () => {
    const data = Buffer.from("deep-image");
    vi.mocked(axios.get).mockResolvedValue({
      data,
      headers: { "content-type": "image/jpeg" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const result = await fetchImage(
      "https://a.b.picsum.photos/x.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["*.picsum.photos"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(data)).toBe(true);
  });

  it("rejects a sibling-label host that only textually resembles the wildcard suffix", async () => {
    // `evilpicsum.photos` ends with "picsum.photos" but NOT ".picsum.photos",
    // so the leading-dot suffix check must reject it (no bypass). axios must
    // never be called — the host is rejected before any request.
    const result = await fetchImage(
      "https://evilpicsum.photos/x.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["*.picsum.photos"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("rejects an unrelated host against a wildcard entry", async () => {
    const result = await fetchImage(
      "https://images.unsplash.com/x.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["*.picsum.photos"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("does not treat a domain that merely contains the wildcard base as a subdomain", async () => {
    // `picsum.photos.evil.com` must not match `*.picsum.photos` (the suffix
    // ".picsum.photos" appears mid-string, not at the end).
    const result = await fetchImage(
      "https://picsum.photos.evil.com/x.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["*.picsum.photos"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe("DNS rebinding mitigation via pinned http(s) agents (Task 3)", () => {
  it("resolvePinnedAddress returns the validated address for a public hostname", async () => {
    setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    const pinned = await resolvePinnedAddress("public.example");
    expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("resolvePinnedAddress returns null when any resolved address is private", async () => {
    setDnsLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(await resolvePinnedAddress("mixed.example")).toBeNull();
  });

  it("resolvePinnedAddress returns null when DNS lookup fails", async () => {
    mockDnsFail();
    expect(await resolvePinnedAddress("nx.example")).toBeNull();
  });

  it("resolvePinnedAddress returns null for empty hostname", async () => {
    expect(await resolvePinnedAddress("")).toBeNull();
  });

  it("resolvePinnedAddress returns null for private IP literal without DNS", async () => {
    expect(await resolvePinnedAddress("127.0.0.1")).toBeNull();
    expect(await resolvePinnedAddress("169.254.169.254")).toBeNull();
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("resolvePinnedAddress returns the IP verbatim for a public IPv4 literal", async () => {
    const pinned = await resolvePinnedAddress("8.8.8.8");
    expect(pinned).toEqual({ address: "8.8.8.8", family: 4 });
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("resolvePinnedAddress returns family=6 for a public IPv6 literal", async () => {
    const pinned = await resolvePinnedAddress("2606:4700:4700::1111");
    expect(pinned).toEqual({ address: "2606:4700:4700::1111", family: 6 });
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("resolvePinnedAddresses returns EVERY validated address for a dual-stack host", async () => {
    setDnsLookup(async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ]);
    const pinned = await resolvePinnedAddresses("dual.example");
    expect(pinned).toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ]);
  });

  it("resolvePinnedAddresses returns null when ANY resolved address is private", async () => {
    setDnsLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(await resolvePinnedAddresses("mixed.example")).toBeNull();
  });

  it("resolvePinnedAddresses returns null on lookup failure and for a private literal", async () => {
    mockDnsFail();
    expect(await resolvePinnedAddresses("nx.example")).toBeNull();
    expect(await resolvePinnedAddresses("10.0.0.1")).toBeNull();
  });

  it("resolvePinnedAddresses returns a one-element list for a public IP literal (no DNS)", async () => {
    expect(await resolvePinnedAddresses("8.8.8.8")).toEqual([
      { address: "8.8.8.8", family: 4 },
    ]);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("axios is invoked with a custom httpsAgent whose lookup is pinned to the resolved IP", async () => {
    // Mock dns.lookup to return a single public IPv4 address. The agent's
    // pinned `lookup` callback must then return that same IP regardless of
    // the hostname it is asked about, proving axios will connect to the IP
    // the framework validated rather than re-resolving at connect time.
    setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);

    const data = Buffer.from("payload");
    vi.mocked(axios.get).mockResolvedValue({
      data,
      headers: { "content-type": "image/jpeg" },
      status: 200,
      statusText: "OK",
      config: {},
    });

    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    expect(result.equals(data)).toBe(true);

    expect(axios.get).toHaveBeenCalledTimes(1);
    const config = vi.mocked(axios.get).mock.calls[0]?.[1] as
      | {
          httpAgent?: http.Agent;
          httpsAgent?: https.Agent;
          proxy?: boolean;
          maxContentLength?: number;
          maxBodyLength?: number;
        }
      | undefined;
    expect(config).toBeDefined();
    expect(config?.httpAgent).toBeInstanceOf(http.Agent);
    expect(config?.httpsAgent).toBeInstanceOf(https.Agent);
    // An ambient HTTP(S)_PROXY env var must not be able to reroute the
    // request around the allowlist/public-IP/DNS-pin validation above.
    expect(config?.proxy).toBe(false);
    // The configured download-size cap must reach axios verbatim on both the
    // response-content and request-body axes. Axios is fully mocked in this
    // suite, so a refactor that silently dropped either config key would
    // otherwise fail no test.
    expect(config?.maxContentLength).toBe(1024);
    expect(config?.maxBodyLength).toBe(1024);

    // Invoke the pinned lookup directly and confirm it returns the address
    // we validated, ignoring whatever hostname is passed in. This is the
    // load-bearing assertion for the DNS-rebinding mitigation: the agent
    // will NOT consult the kernel resolver again.
    const httpsAgent = config!.httpsAgent! as https.Agent & {
      options: { lookup?: unknown };
    };
    const lookup = httpsAgent.options.lookup as
      | ((
          hostname: string,
          options: unknown,
          callback: (err: unknown, address: string, family: number) => void,
        ) => void)
      | undefined;
    expect(typeof lookup).toBe("function");
    const result1: { err: unknown; address: string; family: number } =
      await new Promise((resolve) =>
        lookup!("allowed.test", {}, (err, address, family) =>
          resolve({ err, address, family }),
        ),
      );
    expect(result1.err).toBeNull();
    expect(result1.address).toBe("93.184.216.34");
    expect(result1.family).toBe(4);

    // Even when asked about a different (potentially attacker-supplied)
    // hostname, the agent's lookup still returns the pinned IP.
    const result2: { err: unknown; address: string; family: number } =
      await new Promise((resolve) =>
        lookup!("evil.example", {}, (err, address, family) =>
          resolve({ err, address, family }),
        ),
      );
    expect(result2.address).toBe("93.184.216.34");

    const httpAgent = config!.httpAgent! as http.Agent & {
      options: { lookup?: unknown };
    };
    expect(typeof httpAgent.options.lookup).toBe("function");
  });

  it("returns the fallback and reports phase=fetch when the response exceeds the download-size cap", async () => {
    // Simulate axios' own maxContentLength/maxBodyLength enforcement tripping
    // mid-response. This project always sets maxRedirects:0, so axios' Node
    // http adapter handles the request directly rather than delegating to
    // follow-redirects; confirmed against the installed axios source
    // (lib/adapters/http.js) that an overrun there rejects with
    // `AxiosError.ERR_BAD_RESPONSE` and NO `.response` field (the socket is
    // destroyed before a full response is assembled). `requestNoRedirect`
    // must treat that like any other transport failure (return null), and
    // `fetchFromNetwork` must report a `phase:"fetch"` error and resolve to
    // the bundled fallback rather than letting the rejection propagate.
    const maxContentLengthErr = Object.assign(
      new Error("maxContentLength size of 1024 exceeded"),
      { code: "ERR_BAD_RESPONSE" },
    );
    vi.mocked(axios.get).mockRejectedValueOnce(maxContentLengthErr);

    const onError = vi.fn();
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, onError },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    const fetchErrors = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "fetch",
    );
    expect(fetchErrors.length).toBeGreaterThan(0);
    // Pin the SPECIFIC "no response" guard in fetchFromNetwork, not merely
    // "some fetch-phase error occurred": a broader, pre-existing outer catch
    // in the same function also reports phase:"fetch" and falls back (e.g.
    // for a redirect-Location parse failure), so checking only
    // `fetchErrors.length > 0` would still pass even if the dedicated
    // `if (!response)` guard this test targets were deleted. Asserting the
    // exact message distinguishes the two.
    const reportedError = fetchErrors[0]?.[0] as Error | undefined;
    expect(reportedError?.message).toBe("network request returned no response");
  });

  it("does not make the axios request when dns.lookup returns a private IP", async () => {
    // The framework must short-circuit BEFORE building any agents and
    // BEFORE invoking axios when the resolved address is private.
    mockDnsPrivate();
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("rebuilds and pins a fresh agent per redirect hop (each hop is independently validated)", async () => {
    // Two hops: the initial allowed.test request 302-redirects to other.test.
    // dns.lookup is called once per hop (returning public IPs both times).
    // Each axios call must receive a distinct pinned agent pair.
    setDnsLookup(async (host: string) => {
      if (host === "allowed.test") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      if (host === "other.test") {
        return [{ address: "1.1.1.1", family: 4 }];
      }
      return [];
    });

    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        data: Buffer.alloc(0),
        headers: { location: "https://other.test/final.jpg" },
        status: 302,
        statusText: "Found",
        config: {},
      })
      .mockResolvedValueOnce({
        data: Buffer.from("final"),
        headers: { "content-type": "image/jpeg" },
        status: 200,
        statusText: "OK",
        config: {},
      });

    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test", "other.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );
    expect(result.equals(Buffer.from("final"))).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(2);

    const firstConfig = vi.mocked(axios.get).mock.calls[0]?.[1] as
      | { httpsAgent?: https.Agent }
      | undefined;
    const secondConfig = vi.mocked(axios.get).mock.calls[1]?.[1] as
      | { httpsAgent?: https.Agent }
      | undefined;
    expect(firstConfig?.httpsAgent).toBeInstanceOf(https.Agent);
    expect(secondConfig?.httpsAgent).toBeInstanceOf(https.Agent);
    // Distinct agent instances — each hop is independently pinned.
    expect(firstConfig?.httpsAgent).not.toBe(secondConfig?.httpsAgent);
  });
});

describe("buildPinnedLookup dual callback shape (Task 1.1 — Node >=20 autoSelectFamily)", () => {
  it("answers both the {all:true} array shape and the legacy single-address shape", async () => {
    // Node's `net` module invokes an Agent's pinned `lookup` with the legacy
    // single-address callback in some configurations, but switches to the
    // `{ all: true }` array-callback shape whenever `autoSelectFamily`
    // applies (the default on Node >=20). The agents no longer disable
    // Happy-Eyeballs or pin a single `family`, so the real net stack may
    // choose the `{ all: true }` shape at runtime (the real-loopback tests
    // below therefore exercise it). This test drives the extracted `lookup`
    // function directly with both option shapes so BOTH branches are
    // deterministically pinned regardless of which shape any particular Node
    // version's internals choose to call. A single pinned address surfaces as
    // a one-element array on the `{ all: true }` shape.
    const { httpAgent } = buildPinnedAgents("93.184.216.34", 4);
    const agent = httpAgent as http.Agent & {
      options: { lookup?: unknown };
    };
    const lookup = agent.options.lookup as
      | ((
          hostname: string,
          options: { all?: boolean },
          callback: (
            err: NodeJS.ErrnoException | null,
            address: string | LookupAddress[],
            family?: number,
          ) => void,
        ) => void)
      | undefined;
    expect(typeof lookup).toBe("function");

    const arrayResult: {
      err: NodeJS.ErrnoException | null;
      address: string | LookupAddress[];
      family?: number;
    } = await new Promise((resolve) =>
      lookup!("evil.example", { all: true }, (err, address, family) =>
        resolve({ err, address, family }),
      ),
    );
    expect(arrayResult.err).toBeNull();
    expect(arrayResult.address).toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);

    const singleResult: {
      err: NodeJS.ErrnoException | null;
      address: string | LookupAddress[];
      family?: number;
    } = await new Promise((resolve) =>
      lookup!("evil.example", {}, (err, address, family) =>
        resolve({ err, address, family }),
      ),
    );
    expect(singleResult.err).toBeNull();
    expect(singleResult.address).toBe("93.184.216.34");
    expect(singleResult.family).toBe(4);
  });

  it("leaves Happy-Eyeballs enabled and does not pin a single family on either agent", () => {
    // The agents rely SOLELY on the pinned `lookup` for their SSRF boundary
    // (the socket can only connect to a validated address the lookup returns).
    // They deliberately do NOT set `autoSelectFamily: false` or a single
    // `family`, so Node's default Happy-Eyeballs can fail over across the
    // validated addresses instead of hanging on an unreachable first address.
    const { httpAgent, httpsAgent } = buildPinnedAgents(
      "2606:4700:4700::1111",
      6,
    );
    const httpOpts = (
      httpAgent as http.Agent & {
        options: { family?: number; autoSelectFamily?: boolean };
      }
    ).options;
    const httpsOpts = (
      httpsAgent as https.Agent & {
        options: { family?: number; autoSelectFamily?: boolean };
      }
    ).options;
    expect(httpOpts.autoSelectFamily).toBeUndefined();
    expect(httpOpts.family).toBeUndefined();
    expect(httpsOpts.autoSelectFamily).toBeUndefined();
    expect(httpsOpts.family).toBeUndefined();
  });

  it("pins all validated addresses so Happy-Eyeballs can fail over across them", async () => {
    // A dual-stack host resolves to both an IPv6 and an IPv4 address. The
    // pinned lookup must return BOTH on the `{ all: true }` shape (the shape
    // Node uses when Happy-Eyeballs is active) so an unreachable first address
    // no longer times out the whole fetch — this is the robustness fix.
    const addresses: { address: string; family: 4 | 6 }[] = [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ];
    const { httpAgent } = buildPinnedAgents(addresses);
    const lookup = (httpAgent as http.Agent & { options: { lookup?: unknown } })
      .options.lookup as
      | ((
          hostname: string,
          options: { all?: boolean },
          callback: (
            err: NodeJS.ErrnoException | null,
            address: string | LookupAddress[],
            family?: number,
          ) => void,
        ) => void)
      | undefined;
    expect(typeof lookup).toBe("function");

    const all: string | LookupAddress[] = await new Promise((resolve) =>
      lookup!("evil.example", { all: true }, (_err, address) =>
        resolve(address),
      ),
    );
    expect(all).toEqual(addresses);

    const single: {
      address: string | LookupAddress[];
      family?: number;
    } = await new Promise((resolve) =>
      lookup!("evil.example", {}, (_err, address, family) =>
        resolve({ address, family }),
      ),
    );
    // Legacy single-address shape still yields the FIRST validated address.
    expect(single.address).toBe("2606:4700:4700::1111");
    expect(single.family).toBe(6);
  });
});

describe("buildPinnedAgents real (un-mocked) loopback connectivity (Task 1.2)", () => {
  // This suite drives a REAL axios request (via vi.importActual, bypassing
  // the file-level `vi.mock("axios", ...)` above) through a real
  // http.Server on a loopback address. That exercises Node's actual
  // net.Socket connect path, including the `{ all: true }` lookup-callback
  // shape `net` uses by default on Node >=20 (`net.getDefaultAutoSelectFamily()
  // === true`). A mocked-axios test can never catch a regression here,
  // because mocking `axios.get` never reaches `socket.connect()` at all —
  // exactly how the original 3-arg-only `buildPinnedLookup` broke every
  // real network fetch while the existing mocked tests stayed green.
  const listen = (server: http.Server, host: string): Promise<number | null> =>
    new Promise((resolve) => {
      const onError = (): void => {
        server.removeListener("listening", onListening);
        resolve(null);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        const addr = server.address();
        resolve(addr !== null && typeof addr !== "string" ? addr.port : null);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, host);
    });

  it("connects through the pinned lookup on Node's real net/http stack (IPv4 loopback)", async () => {
    const realAxios = (await vi.importActual<typeof import("axios")>("axios"))
      .default;
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(imageBytes);
    });

    const port = await listen(server, "127.0.0.1");
    expect(port).not.toBeNull();

    try {
      const { httpAgent, httpsAgent } = buildPinnedAgents("127.0.0.1", 4);
      // "pinned.test" resolves nowhere in real DNS — the pinned lookup must
      // never consult it and must connect straight to the loopback server.
      const response = await realAxios.get(`http://pinned.test:${port}/x.jpg`, {
        httpAgent,
        httpsAgent,
        responseType: "arraybuffer",
        maxRedirects: 0,
        timeout: 2000,
      });
      expect(response.status).toBe(200);
      expect(Buffer.from(response.data as ArrayBuffer).length).toBeGreaterThan(
        0,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("connects through the pinned lookup on Node's real net/http stack (IPv6 loopback, skips gracefully if ::1 is unavailable)", async (ctx) => {
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(imageBytes);
    });

    const port = await listen(server, "::1");
    if (port === null) {
      ctx.skip("IPv6 loopback (::1) is unavailable in this environment");
      return;
    }

    try {
      const realAxios = (await vi.importActual<typeof import("axios")>("axios"))
        .default;
      const { httpAgent, httpsAgent } = buildPinnedAgents("::1", 6);
      const response = await realAxios.get(
        `http://pinned6.test:${port}/x.jpg`,
        {
          httpAgent,
          httpsAgent,
          responseType: "arraybuffer",
          maxRedirects: 0,
          timeout: 2000,
        },
      );
      expect(response.status).toBe(200);
      expect(Buffer.from(response.data as ArrayBuffer).length).toBeGreaterThan(
        0,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("real-stream maxContentLength enforcement (Phase 3 Task 3.3)", () => {
  // TRAP this suite deliberately avoids: fetchImage/fetchFromNetwork reject
  // any loopback target via resolvePinnedAddress -> isPrivateIp BEFORE axios
  // (or maxContentLength) ever runs, so routing a real-loopback request
  // through those entry points would only prove the SSRF guard fires first —
  // never that the size cap itself bites over a real stream. Instead, mirror
  // "buildPinnedAgents real (un-mocked) loopback connectivity" above: drive a
  // RAW axios call (bypassing the file-level `vi.mock("axios", ...)` via
  // `vi.importActual`) through a real http.Server on loopback, built with the
  // same `buildPinnedAgents` pinned-lookup agents production uses.
  it("aborts a real oversized response stream and rejects with ERR_BAD_RESPONSE once bytes exceed maxContentLength", async () => {
    const maxBytes = 16;
    // Comfortably larger than maxBytes so the cap trips deterministically
    // regardless of how the OS/TCP stack chunks the response across `data`
    // events — axios accumulates bytes-received across every chunk and
    // rejects as soon as the running total exceeds the cap (verified against
    // the installed axios' `lib/adapters/http.js` responseType:"arraybuffer"
    // handler), so this is not a race against a single expected chunk size.
    const oversized = Buffer.alloc(maxBytes * 8, 0xff);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(oversized);
    });

    const port = await new Promise<number | null>((resolve) => {
      const onError = (): void => {
        server.removeListener("listening", onListening);
        resolve(null);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        const addr = server.address();
        resolve(addr !== null && typeof addr !== "string" ? addr.port : null);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    expect(port).not.toBeNull();

    try {
      const realAxios = (await vi.importActual<typeof import("axios")>("axios"))
        .default;
      const { httpAgent, httpsAgent } = buildPinnedAgents("127.0.0.1", 4);

      await expect(
        realAxios.get(`http://pinned-cap.test:${port}/big.jpg`, {
          responseType: "arraybuffer",
          maxContentLength: maxBytes,
          maxBodyLength: maxBytes,
          maxRedirects: 0,
          httpAgent,
          httpsAgent,
          proxy: false,
          timeout: 2000,
        }),
      ).rejects.toMatchObject({ code: "ERR_BAD_RESPONSE" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("readLocalImage stat-throw branch (Phase 6 Task 6.2)", () => {
  it("falls back and reports phase=fs when fs.stat rejects AFTER isValidPath already passed", async () => {
    // isValidPath performs its own two fs.stat calls (on the real base dir,
    // then the real resolved file) before returning true. readLocalImage
    // then performs a THIRD, independent fs.stat call (gated behind
    // `maxBytes`) on the same file. In production this third call can only
    // fail via a genuine TOCTOU race (the file is deleted/replaced between
    // the two checks) — reproduced deterministically here by letting the
    // first two (real) stat calls succeed and rejecting only the third.
    let statCalls = 0;
    const realStat = fsp.stat;
    const statSpy = vi.spyOn(fsp, "stat").mockImplementation(((
      ...args: unknown[]
    ): Promise<unknown> => {
      statCalls++;
      if (statCalls > 2) {
        return Promise.reject(new Error("simulated ENOENT after isValidPath"));
      }
      return (realStat as unknown as (...a: unknown[]) => Promise<unknown>)(
        ...args,
      );
    }) as typeof fsp.stat);

    try {
      const onError = vi.fn();
      const result = await readLocalImage(
        "noimage.jpg",
        baseDir,
        "normal",
        10_000_000, // truthy maxBytes forces readLocalImage's own fs.stat call
        onError,
      );
      const fallback = await FALLBACKIMAGES.normal();
      expect(result.equals(fallback)).toBe(true);
      expect(statCalls).toBeGreaterThan(2);
      const fsErrors = onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "fs",
      );
      expect(fsErrors.length).toBeGreaterThan(0);
      expect((fsErrors[0]![0] as Error).message).toMatch(
        /simulated ENOENT after isValidPath/,
      );
    } finally {
      statSpy.mockRestore();
    }
  });

  it("readLocalImage still works normally when maxBytes is unset (real fs.stat/readFile, no mock involved)", async () => {
    // Plain regression case for the maxBytes-unset path (readLocalImage
    // never calls its own fs.stat here — only isValidPath's two internal
    // calls happen). Isolation from the test above is guaranteed by that
    // test's own `finally { statSpy.mockRestore() }` plus the file's global
    // `beforeEach(() => vi.resetAllMocks())` — not by this test's assertion.
    const result = await readLocalImage("noimage.jpg", baseDir, "normal");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("fetchFromNetwork relative-redirect resolution (Phase 6 Task 6.2)", () => {
  it("resolves a root-relative Location header against the current URL and follows it", async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        data: Buffer.alloc(0),
        headers: { location: "/relocated/final.jpg" },
        status: 302,
        statusText: "Found",
        config: {},
      })
      .mockResolvedValueOnce({
        data: Buffer.from("relative-redirect-image"),
        headers: { "content-type": "image/jpeg" },
        status: 200,
        statusText: "OK",
        config: {},
      });

    const result = await fetchImage(
      "https://allowed.test/original/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3 },
    );

    expect(result.equals(Buffer.from("relative-redirect-image"))).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(2);
    // The relative Location must have been resolved against the FIRST
    // request's URL (same scheme+host, path replaced) — not treated as a
    // separate host and not left unresolved.
    const secondCallUrl = vi.mocked(axios.get).mock.calls[1]?.[0];
    expect(secondCallUrl).toBe("https://allowed.test/relocated/final.jpg");
  });

  it("returns the fallback and reports phase=fetch when a redirect Location fails to resolve even against a valid base URL", async () => {
    // `new URL(location, currentUrl)` tolerates most malformed relative
    // references by resolving them against the base — but an absolute
    // Location with its own invalid authority (e.g. an out-of-range port)
    // still fails to parse regardless of the base, because it is parsed as
    // an absolute URL first. This exercises the try/catch specifically
    // around the redirect-URL resolution step (distinct from the initial
    // `new URL(src)` parse at the top of the loop, and distinct from the
    // "malformed Location" cases elsewhere that happen to resolve fine
    // against a base and fail later for an unrelated reason).
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.alloc(0),
      headers: { location: "http://bad-host:999999/x.jpg" },
      status: 302,
      statusText: "Found",
      config: {},
    });
    const onError = vi.fn();
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 3, onError },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    // Only the initial request was ever attempted; the malformed hop never
    // reaches axios.
    expect(axios.get).toHaveBeenCalledTimes(1);
    const fetchErrors = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "fetch",
    );
    expect(fetchErrors.length).toBeGreaterThan(0);
  });
});

describe("onFallback callback threading (Phase 8)", () => {
  it("readLocalImage fires onFallback when the path is invalid", async () => {
    const onFallback = vi.fn();
    const result = await readLocalImage(
      "missing.jpg",
      baseDir,
      "normal",
      undefined,
      undefined,
      onFallback,
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("readLocalImage does NOT fire onFallback on a successful read", async () => {
    const onFallback = vi.fn();
    const result = await readLocalImage(
      "noimage.jpg",
      baseDir,
      "normal",
      undefined,
      undefined,
      onFallback,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("readLocalImage fires onFallback when the file exceeds maxBytes", async () => {
    const onFallback = vi.fn();
    const result = await readLocalImage(
      "noimage.jpg",
      baseDir,
      "normal",
      1,
      undefined,
      onFallback,
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("fetchImage fires onFallback when the host is not allowed", async () => {
    const onFallback = vi.fn();
    const result = await fetchImage(
      "https://disallowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, onFallback },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("fetchImage fires onFallback when the network request fails (routed through fetchFromNetwork)", async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error("network fail"));
    const onFallback = vi.fn();
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, onFallback },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("fetchImage does NOT fire onFallback on a successful network fetch", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.from("image"),
      headers: { "content-type": "image/jpeg" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const onFallback = vi.fn();
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, onFallback },
    );
    expect(result.equals(Buffer.from("image"))).toBe(true);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("fetchImage threads onFallback into the internal-local-path branch (missing local file)", async () => {
    // Internal-host URL resolving to a LOCAL file that does not exist —
    // proves the callback passed to fetchImage propagates all the way
    // through resolveInternalLocalPath -> readLocalImage, not just the
    // direct network branch below it.
    const onFallback = vi.fn();
    const result = await fetchImage(
      "http://localhost:3001/api/v1/does-not-exist.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, onFallback },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("fetchImage does NOT fire onFallback for a successful internal-local-path read", async () => {
    const onFallback = vi.fn();
    const internalUrl = "http://localhost:3001/api/v1/noimage.jpg";
    const result = await fetchImage(
      internalUrl,
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 10_000_000, onFallback },
    );
    const local = await readLocalImage("noimage.jpg", baseDir, "normal");
    expect(result.equals(local)).toBe(true);
    expect(onFallback).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
});
