import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import axios from "axios";
import { FALLBACKIMAGES } from "./variables";
import { fetchImage, isValidPath, readLocalImage } from "./functions";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

const baseDir = path.join(__dirname, "assets");

beforeEach(() => {
  vi.resetAllMocks();
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
      { timeoutMs: 1000, maxBytes: 1024 }
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
      { timeoutMs: 1000, maxBytes: 1024 }
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
      { timeoutMs: 1, maxBytes: 1 }
    );
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns fallback when URL parse fails", async () => {
    const result = await fetchImage(
      "not a url",
      baseDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 1, maxBytes: 1 }
    );
    expect(result.length).toBeGreaterThan(0);
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
      { timeoutMs: 1000, maxBytes: 1024 }
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
      { timeoutMs: 1000, maxBytes: 1024 }
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
      { timeoutMs: 1000, maxBytes: 1024 }
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
      { timeoutMs: 1000, maxBytes: 1024 }
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
      { timeoutMs: 1000, maxBytes: 1024 }
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
      { timeoutMs: 1000, maxBytes: 1024 }
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
      { timeoutMs: 1000, maxBytes: 1024 }
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
      { timeoutMs: 1000, maxBytes: 1024 }
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
      { timeoutMs: 1000, maxBytes: 1024 }
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
      { timeoutMs: 1000, maxBytes: 1024 }
    );
    // Should fall back to local read which returns fallback for invalid path
    expect(result.length).toBeGreaterThan(0);
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
      { timeoutMs: 1000, maxBytes: 1024 }
    );
    const fallback = await FALLBACKIMAGES.avatar();
    expect(result.equals(fallback)).toBe(true);
  });
});
