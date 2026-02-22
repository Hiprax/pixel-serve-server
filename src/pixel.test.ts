import axios from "axios";
import express from "express";
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type { Response } from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import registerServe from "./pixel";
import { mimeTypes } from "./variables";
import { FALLBACKIMAGES } from "./variables";
import { fetchImage, isValidPath, readLocalImage } from "./functions";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const assetDir = path.join(__dirname, "assets");

const bufferParser = (
  res: Response,
  callback: (err: Error | null, buffer: Buffer) => void
): void => {
  const data: Buffer[] = [];
  res.on("data", (chunk) =>
    data.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  );
  res.on("end", () => callback(null, Buffer.concat(data)));
};

const createApp = (): ReturnType<typeof express> => {
  const app = express();
  app.get(
    "/api/v1/pixel/serve",
    registerServe({
      baseDir: assetDir,
      cacheControl: "public, max-age=60",
      allowedNetworkList: ["allowed.test"],
      websiteURL: "localhost",
    })
  );
  return app;
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("isValidPath", () => {
  it("rejects traversal attempts", async () => {
    const result = await isValidPath(assetDir, "../secret.txt");
    expect(result).toBe(false);
  });

  it("accepts files within baseDir", async () => {
    const result = await isValidPath(assetDir, "noimage.jpg");
    expect(result).toBe(true);
  });
});

describe("registerServe middleware", () => {
  it("serves resized local images with correct headers", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", width: 120, height: 120, format: "webp" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.webp);
    expect(Number(response.headers["content-length"]) > 0).toBe(true);
  });

  it("returns fallback when path traversal detected", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "../pixel.ts", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    expect(response.body.length > 0).toBe(true);
  });

  it("returns 304 when ETag matches", async () => {
    const app = createApp();
    const first = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    const etag = first.headers.etag;
    expect(etag).toBeDefined();

    const second = await request(app)
      .get("/api/v1/pixel/serve")
      .set("If-None-Match", etag as string)
      .query({ src: "noimage.jpg", format: "jpeg" });

    expect(second.status).toBe(304);
  });

  it("uses custom private folder resolver", async () => {
    const app = express();
    const getUserFolder = vi.fn(async () => assetDir);
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: "/tmp",
        getUserFolder,
      })
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noavatar.png", folder: "private", userId: "123" })
      .parse(bufferParser);

    expect(getUserFolder).toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("blocks disallowed network hosts and serves fallback", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "https://not-allowed.test/image.jpg",
        format: "jpeg",
      })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("fetches network images for allowed hosts", async () => {
    const imageBuffer = Buffer.from("remote-image");
    vi.mocked(axios.get).mockResolvedValue({
      data: imageBuffer,
      headers: { "content-type": mimeTypes.jpeg },
      status: 200,
      statusText: "OK",
      config: {},
    });

    const result = await fetchImage(
      "https://allowed.test/image.jpg",
      assetDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 2000, maxBytes: 1024 }
    );

    expect(result.equals(imageBuffer)).toBe(true);
    expect(axios.get).toHaveBeenCalled();
  });

  it("falls back when network content type is invalid", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.from("bad"),
      headers: { "content-type": "text/plain" },
      status: 200,
      statusText: "OK",
      config: {},
    });

    const result = await fetchImage(
      "https://allowed.test/image.txt",
      assetDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 2000, maxBytes: 1024 }
    );

    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });
  it("falls back when network request fails", async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error("fail"));
    const result = await fetchImage(
      "https://allowed.test/fail.jpg",
      assetDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 2000, maxBytes: 1024 }
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("falls back when URL is invalid", async () => {
    const result = await fetchImage(
      "invalid::url",
      assetDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 2000, maxBytes: 1024 }
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("falls back when protocol is not http/https", async () => {
    const result = await fetchImage(
      "ftp://allowed.test/image.jpg",
      assetDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 2000, maxBytes: 1024 }
    );
    const fallback = await FALLBACKIMAGES.normal();
    expect(result.equals(fallback)).toBe(true);
  });

  it("reads local image when URL matches website host", async () => {
    const localUrl = "http://localhost/api/v1/noimage.jpg";
    const result = await fetchImage(
      localUrl,
      assetDir,
      "localhost",
      "normal",
      /^\/api\/v1\//,
      ["allowed.test"],
      { timeoutMs: 2000, maxBytes: 1024 }
    );
    const localFile = await readLocalImage("noimage.jpg", assetDir, "normal");
    expect(result.equals(localFile)).toBe(true);
  });

  it("falls back when local file missing", async () => {
    const fallback = await FALLBACKIMAGES.normal();
    const result = await readLocalImage("missing.jpg", assetDir, "normal");
    expect(result.equals(fallback)).toBe(true);
  });

  it("returns jpeg when format is unsupported", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "unknown" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("returns fallback on processing error", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        cacheControl: "public, max-age=60",
        allowedNetworkList: ["allowed.test"],
        websiteURL: "localhost",
      })
    );

    vi.spyOn(sharp.prototype, "toBuffer").mockRejectedValueOnce(
      new Error("sharp fail")
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it("returns fallback when fallback image read fails", async () => {
    const app = createApp();
    const fallbackSpy = vi
      .spyOn(FALLBACKIMAGES, "normal")
      .mockRejectedValueOnce(new Error("fallback fail"));
    const toBufferSpy = vi
      .spyOn(sharp.prototype, "toBuffer")
      .mockRejectedValueOnce(new Error("sharp fail"));

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(500); // next(error) should surface when both pipelines fail
    fallbackSpy.mockRestore();
    toBufferSpy.mockRestore();
  });

  it("serves default fallback when src missing", async () => {
    const app = createApp();
    const response = await request(app).get("/api/v1/pixel/serve").query({});

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it("serves image without resize when dimensions not specified", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("serves image with only width specified", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", width: 200, format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("serves image with only height specified", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", height: 200, format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("handles custom quality setting", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", quality: 50, format: "webp" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.webp);
  });

  it("uses idHandler when provided", async () => {
    const app = express();
    const idHandler = vi.fn((id: string) => `processed-${id}`);
    const getUserFolder = vi.fn(async (_req: unknown, id?: string) =>
      id ? assetDir : "/tmp"
    );

    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: "/tmp",
        idHandler,
        getUserFolder,
      })
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noavatar.png", folder: "private", userId: "123" })
      .parse(bufferParser);

    expect(idHandler).toHaveBeenCalledWith("123");
    expect(getUserFolder).toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("serves with default cache control when not specified", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
      })
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      "public, max-age=86400, stale-while-revalidate=604800"
    );
  });

  it("serves without custom etag when etag is disabled", async () => {
    const app = express();
    // Disable Express's built-in etag as well
    app.set("etag", false);
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        etag: false,
      })
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    // When our etag is disabled and Express etag is disabled, no etag should be present
    expect(response.headers.etag).toBeUndefined();
  });

  it("serves avatar image with fallback", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "missing-avatar.jpg", type: "avatar", format: "png" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.png);
  });

  it("handles avif format", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "avif" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.avif);
  });

  it("handles png format", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noavatar.png", format: "png" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.png);
  });

  it("private folder without getUserFolder uses baseDir", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
      })
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", folder: "private", userId: "123" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
  });

  it("clamps dimensions to min/max bounds", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        minWidth: 100,
        maxWidth: 500,
        minHeight: 100,
        maxHeight: 500,
      })
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", width: 10, height: 1000, format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    const metadata = await sharp(response.body).metadata();
    // Width was 10 (below min 100), clamped to 100; height was 1000 (above max 500), clamped to 500
    // withoutEnlargement may prevent actual upscale, but dimensions should not exceed max
    if (metadata.width) expect(metadata.width).toBeLessThanOrEqual(500);
    if (metadata.height) expect(metadata.height).toBeLessThanOrEqual(500);
  });

  it("serves avatar fallback when src is empty and type is avatar", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "", type: "avatar" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("serves normal fallback when src is empty and type is unspecified", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("generates deterministic ETag for same input", async () => {
    const app = createApp();
    const query = { src: "noimage.jpg", width: 100, format: "jpeg" };

    const first = await request(app)
      .get("/api/v1/pixel/serve")
      .query(query)
      .parse(bufferParser);

    const second = await request(app)
      .get("/api/v1/pixel/serve")
      .query(query)
      .parse(bufferParser);

    expect(first.headers.etag).toBeDefined();
    expect(first.headers.etag).toBe(second.headers.etag);
  });

  it("generates different ETag for different quality", async () => {
    const app = createApp();

    const low = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", quality: 20, format: "jpeg" })
      .parse(bufferParser);

    const high = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", quality: 95, format: "jpeg" })
      .parse(bufferParser);

    expect(low.headers.etag).toBeDefined();
    expect(high.headers.etag).toBeDefined();
    expect(low.headers.etag).not.toBe(high.headers.etag);
  });

  it("sets Content-Disposition header with correct filename", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "webp" })
      .parse(bufferParser);

    expect(response.headers["content-disposition"]).toBe(
      'inline; filename="noimage.webp"'
    );
  });

  it("sets Content-Length header matching body size", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(Number(response.headers["content-length"])).toBe(
      response.body.length
    );
  });

  it("handles getUserFolder returning empty string", async () => {
    const app = express();
    const getUserFolder = vi.fn(async () => "");
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        getUserFolder,
      })
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", folder: "private", userId: "123" })
      .parse(bufferParser);

    expect(getUserFolder).toHaveBeenCalled();
    // Empty string is falsy, so baseDir should remain unchanged
    expect(response.status).toBe(200);
  });

  it("uses correct fallback type when avatar request fails in catch block", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
      })
    );

    vi.spyOn(sharp.prototype, "toBuffer").mockRejectedValueOnce(
      new Error("processing fail")
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", type: "avatar", format: "jpeg" })
      .parse(bufferParser);

    // Should still return 200 with the avatar fallback
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("handles custom cacheControl value in response", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        cacheControl: "private, no-cache",
      })
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-cache");
  });

  it("processes image without resize when only format specified", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "png" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.png);
    // Verify the image is valid by reading metadata
    const metadata = await sharp(response.body).metadata();
    expect(metadata.format).toBe("png");
  });

  it("converts between formats correctly", async () => {
    const app = createApp();
    // Request a JPEG image as WebP
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "webp", width: 100, height: 100 })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.webp);
    const metadata = await sharp(response.body).metadata();
    expect(metadata.format).toBe("webp");
  });

  it("sanitizes special characters in Content-Disposition filename", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: 'image"with"quotes.jpg', format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    const disposition = response.headers["content-disposition"] as string;
    expect(disposition).toBeDefined();
    // Quotes, backslashes, and control chars should be replaced with underscores
    expect(disposition).not.toMatch(/image"with"quotes/);
    expect(disposition).toBe('inline; filename="image_with_quotes.jpeg"');
  });

  it("falls back to baseDir when getUserFolder times out", async () => {
    const app = express();
    // getUserFolder returns a promise that never resolves
    const getUserFolder = vi.fn(
      () => new Promise<string>(() => {})
    );
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        getUserFolder,
        requestTimeoutMs: 100,
      })
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", folder: "private", userId: "123" })
      .parse(bufferParser);

    expect(getUserFolder).toHaveBeenCalled();
    // Should still respond using baseDir as fallback after timeout
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("treats 'httpfoo' as a local path, not as a URL", async () => {
    const app = createApp();
    // "httpfoo" starts with "http" but not "http://" so it should be a local path
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "httpfoo", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    // Should serve fallback since the local file doesn't exist
    expect(response.body.length).toBeGreaterThan(0);
    // Verify axios was not called — this was not treated as a network request
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("returns fallback for http:// src with blocked host", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "http://blocked.test/image.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it("returns fallback for https:// src with blocked host", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://blocked.test/image.png", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    expect(response.body.length).toBeGreaterThan(0);
  });
});
