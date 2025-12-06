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
) => {
  const data: Buffer[] = [];
  res.on("data", (chunk) =>
    data.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  );
  res.on("end", () => callback(null, Buffer.concat(data)));
};

const createApp = () => {
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

    expect(result.length).toBeGreaterThan(0);
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
    expect(result.length).toBeGreaterThan(0);
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
    expect(result.length).toBeGreaterThan(0);
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

  it("returns 304 when etag matches", async () => {
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
});
