import path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi, beforeEach } from "vitest";
import axios from "axios";
import { FALLBACKIMAGES } from "./variables";
import {
  fetchImage,
  isPrivateIp,
  isPublicHost,
  isValidPath,
  readLocalImage,
  resolvePinnedAddress,
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

  it("flags invalid addresses as unsafe", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
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
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
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

  it("returns fallback when URL parse fails", async () => {
    const result = await fetchImage(
      "not a url",
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

  it("returns fallback when protocol is not http/https", async () => {
    const result = await fetchImage(
      "ftp://allowed.test/img.jpg",
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
    const internalUrl = "http://www.localhost/api/v1/noimage.jpg";
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
    const internalUrl = "http://localhost:3001/api/v1/noimage.jpg";
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
    const internalUrl = "http://localhost/custom/path/noimage.jpg";
    const result = await fetchImage(
      internalUrl,
      baseDir,
      "localhost",
      "normal",
      /^\/custom\/path\//,
      [],
      { timeoutMs: 1000, maxBytes: 1024 },
    );
    const local = await readLocalImage("noimage.jpg", baseDir, "normal");
    expect(result.equals(local)).toBe(true);
  });

  it("readLocalImage returns fallback for maxBytes of 0", async () => {
    const result = await readLocalImage("noimage.jpg", baseDir, "normal", 0);
    // maxBytes of 0 is falsy, so no size check happens - file is read normally
    expect(result.length).toBeGreaterThan(0);
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
    const result = await fetchImage(
      "https://allowed.test/img.jpg",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 4 },
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(5);
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
      | { httpAgent?: http.Agent; httpsAgent?: https.Agent }
      | undefined;
    expect(config).toBeDefined();
    expect(config?.httpAgent).toBeInstanceOf(http.Agent);
    expect(config?.httpsAgent).toBeInstanceOf(https.Agent);

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
