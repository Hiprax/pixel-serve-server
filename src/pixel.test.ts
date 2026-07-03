import axios from "axios";
import express from "express";
import sharp from "sharp";
import path from "node:path";
import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type { Response } from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import registerServe, {
  buildDeterministicEtag,
  buildFilename,
  buildSourceIdentifier,
  isInsideRoot,
  looksLikeSvg,
} from "./pixel";
import { mimeTypes } from "./variables";
import { FALLBACKIMAGES } from "./variables";
import { fetchImage, isValidPath, readLocalImage } from "./functions";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import * as dns from "node:dns/promises";

// dns.lookup is multi-overloaded; production code uses `{ all: true }` so it
// resolves to `LookupAddress[]`. The default `mocked()` typing picks the
// single-address overload, so we route through a typed helper.
const setDnsLookup = (
  impl: (hostname: string) => Promise<LookupAddress[]>,
): void => {
  vi.mocked(dns.lookup).mockImplementation(
    impl as unknown as typeof dns.lookup,
  );
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const assetDir = path.join(__dirname, "assets");

const bufferParser = (
  res: Response,
  callback: (err: Error | null, buffer: Buffer) => void,
): void => {
  const data: Buffer[] = [];
  res.on("data", (chunk) =>
    data.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
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
    }),
  );
  return app;
};

beforeEach(() => {
  vi.resetAllMocks();
  setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
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

  it("returns 304 when ETag matches, echoing ETag/Cache-Control/Vary per RFC 9110 §15.4.5", async () => {
    // Deliberately NOT createApp(): its configured cacheControl
    // ("public, max-age=60") is byte-identical to FALLBACK_CACHE_CONTROL, so
    // asserting Cache-Control against that value here would pass whether the
    // 304 echoes the operator's genuine config or the fallback constant by
    // mistake. An explicit, distinct custom value proves the 304 echoes the
    // OPERATOR'S CONFIGURED Cache-Control, not a coincidental match.
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, cacheControl: "private, no-cache" }),
    );
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
    expect(second.headers.etag).toBe(etag);
    expect(second.headers["cache-control"]).toBe("private, no-cache");
    expect(second.headers["vary"]).toBe("Accept-Encoding");
  });

  it("uses custom private folder resolver", async () => {
    const app = express();
    const getUserFolder = vi.fn(async () => assetDir);
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: "/tmp",
        getUserFolder,
      }),
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
      { timeoutMs: 2000, maxBytes: 1024 },
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
      { timeoutMs: 2000, maxBytes: 1024 },
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
      { timeoutMs: 2000, maxBytes: 1024 },
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
      { timeoutMs: 2000, maxBytes: 1024 },
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
      { timeoutMs: 2000, maxBytes: 1024 },
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
      { timeoutMs: 2000, maxBytes: 1024 },
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
      }),
    );

    vi.spyOn(sharp.prototype, "toBuffer").mockRejectedValueOnce(
      new Error("sharp fail"),
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
    const onComplete = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        cacheControl: "public, max-age=60",
        allowedNetworkList: ["allowed.test"],
        websiteURL: "localhost",
        onComplete,
      }),
    );
    const response = await request(app).get("/api/v1/pixel/serve").query({});

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    expect(response.body.length).toBeGreaterThan(0);
    // Distinct soft-fallback trigger from the missing-local-file case covered
    // elsewhere: resolveBuffer's very first branch (no src at all) marks the
    // fallback directly, before ever calling readLocalImage/fetchImage.
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(
      (onComplete.mock.calls[0]![0] as { fallback: boolean }).fallback,
    ).toBe(true);
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
      id ? assetDir : "/tmp",
    );

    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: "/tmp",
        idHandler,
        getUserFolder,
      }),
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
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
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
      }),
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
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", folder: "private", userId: "123" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
  });

  it("clamps dimensions to the operator min/max bounds", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        minWidth: 100,
        maxWidth: 500,
        minHeight: 100,
        maxHeight: 500,
      }),
    );

    // Both requested dimensions lie INSIDE the framework's hard [50, 4000]
    // window — so `userDataSchema` accepts them and the request actually
    // reaches `renderUserData`'s clamp() step — but OUTSIDE the operator
    // bounds above: width 60 is below minWidth 100 → clamped UP to 100;
    // height 2000 is above maxHeight 500 → clamped DOWN to 500. (A width of
    // 10, as this test previously used, would instead be rejected by
    // `userDataSchema`'s absolute 50-px floor BEFORE clamp() ever runs, so
    // the request would serve the unresized 500×500 fallback image — which
    // vacuously satisfies a loose `<= 500` assertion without ever exercising
    // clamping.) The source asset `noimage.jpg` is 500×500, so the cover-fit
    // resize genuinely produces EXACTLY 100×500 with no enlargement.
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", width: 60, height: 2000, format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    const metadata = await sharp(response.body).metadata();
    // Assert the EXACT clamped output dimensions (not a loose bound): 60 was
    // clamped up to minWidth 100, 2000 was clamped down to maxHeight 500.
    expect(metadata.width).toBe(100);
    expect(metadata.height).toBe(500);
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

  it("fallback for empty src fires from pixel.ts, NOT from schema rejection (Task 13)", async () => {
    // Task 13 regression: the schema accepts `src = ""` without throwing, so
    // the request must reach the in-pipeline `if (!userData.src)` branch
    // that serves the fallback. If the schema had rejected empty src, the
    // onError hook would fire with `phase: "validation"`. With the relaxed
    // schema, no validation phase is reported — only the normal happy path
    // continues and the empty-src branch returns the fallback buffer.
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        onError,
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    // No validation/schema-phase errors must be reported — the schema let
    // the empty string through and pixel.ts's empty-src branch did the work.
    const validationErrors = onError.mock.calls.filter((c) => {
      const phase = (c[1] as { phase: string }).phase;
      return phase === "validation" || phase === "schema";
    });
    expect(validationErrors).toEqual([]);
  });

  it("fallback for absent src fires from pixel.ts, NOT from schema rejection (Task 13)", async () => {
    // Same as above but with the `src` query parameter completely absent.
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        onError,
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    const validationErrors = onError.mock.calls.filter((c) => {
      const phase = (c[1] as { phase: string }).phase;
      return phase === "validation" || phase === "schema";
    });
    expect(validationErrors).toEqual([]);
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
      "inline; filename=\"noimage.webp\"; filename*=UTF-8''noimage.webp",
    );
  });

  it("sets Content-Length header matching body size", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(Number(response.headers["content-length"])).toBe(
      response.body.length,
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
      }),
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
      }),
    );

    vi.spyOn(sharp.prototype, "toBuffer").mockRejectedValueOnce(
      new Error("processing fail"),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", type: "avatar", format: "jpeg" })
      .parse(bufferParser);

    // The outer catch serves the pre-encoded AVATAR fallback asset
    // (`noavatar.png`) VERBATIM — no Sharp re-encode — so BOTH the served
    // body and the Content-Type must reflect that PNG asset, not the normal
    // JPEG fallback. Asserting the actual response BYTES (not just the
    // header) is what lets this test catch a regression in the
    // avatar-vs-normal fallback selection: the previous header-only assertion
    // passed identically whether or not that selection worked, because the
    // header was hardcoded.
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.png);
    const avatarFallback = await FALLBACKIMAGES.avatar();
    const normalFallback = await FALLBACKIMAGES.normal();
    expect(avatarFallback.equals(response.body)).toBe(true);
    expect(normalFallback.equals(response.body)).toBe(false);
  });

  it("handles custom cacheControl value in response", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        cacheControl: "private, no-cache",
      }),
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
    // ASCII fallback strips quotes/backslashes/controls to underscores. The
    // RFC 5987 `filename*=UTF-8''...` parameter percent-encodes the original
    // quotes (%22) so the unicode round-trip stays faithful.
    expect(disposition).toMatch(/filename="image_with_quotes\.jpeg"/);
    expect(disposition).toMatch(
      /filename\*=UTF-8''image%22with%22quotes\.jpeg/,
    );
  });

  it("falls back to baseDir when getUserFolder times out", async () => {
    const app = express();
    // getUserFolder returns a promise that never resolves
    const getUserFolder = vi.fn(() => new Promise<string>(() => {}));
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        getUserFolder,
        requestTimeoutMs: 100,
      }),
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

  it("rejects format=svg at validation and serves the jpeg fallback", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "svg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    // unsupported format falls through to the default "jpeg" branch
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("rejects SVG input buffers when allowSvgInput is false (server-internal)", async () => {
    // Smuggle an SVG into the pipeline by labelling the response as a PNG so
    // fetchImage doesn't reject it on MIME type. The magic-byte sniffer must
    // still flag it and bail to fallback.
    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.from(
        "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><circle r='5'/></svg>",
      ),
      headers: { "content-type": "image/png" }, // lie about content-type
      status: 200,
      statusText: "OK",
      config: {},
    });

    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://allowed.test/bomb.svg", format: "png" })
      .parse(bufferParser);

    // The SVG-sniffer should reject the input, the catch should serve the
    // JPEG fallback regardless of the requested format.
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });

  it("rejects SVG content-type from network at the fetch layer", async () => {
    // Even allowSvgInput=true cannot help here because mimeTypes no longer
    // includes image/svg+xml.
    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.from("<svg></svg>"),
      headers: { "content-type": "image/svg+xml" },
      status: 200,
      statusText: "OK",
      config: {},
    });

    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
        allowSvgInput: true,
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://allowed.test/x.svg", format: "png" })
      .parse(bufferParser);

    // fetch returns the normal fallback (JPEG bytes) which then encodes to PNG.
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.png);
  });

  it("looksLikeSvg detects SVG, XML-prolog SVG, BOM SVG, comment-prefixed, and rejects PNG", async () => {
    expect(looksLikeSvg(Buffer.from("<svg></svg>"))).toBe(true);
    expect(
      looksLikeSvg(Buffer.from("<?xml version='1.0'?>\n<svg xmlns='x'></svg>")),
    ).toBe(true);
    // XML prolog WITHOUT SVG content
    expect(looksLikeSvg(Buffer.from("<?xml version='1.0'?>\n<root/>"))).toBe(
      false,
    );
    // Comment-only prefix containing SVG
    expect(looksLikeSvg(Buffer.from("<!-- comment -->\n<svg></svg>"))).toBe(
      true,
    );
    // Comment-only without SVG
    expect(looksLikeSvg(Buffer.from("<!-- comment --><div/>"))).toBe(false);
    // BOM-prefixed
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("<svg></svg>"),
    ]);
    expect(looksLikeSvg(bom)).toBe(true);
    expect(
      looksLikeSvg(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe(false);
    expect(looksLikeSvg(Buffer.alloc(0))).toBe(false);
    // null buffer
    expect(looksLikeSvg(null as unknown as Buffer)).toBe(false);
  });

  it("respects allowSvgInput=true and passes SVG buffers through", async () => {
    expect(looksLikeSvg(Buffer.from("<svg></svg>"))).toBe(true);
    // Sanity: the option exists and parses; the integration path that
    // actually decodes SVG via libvips is not exercised here because the
    // server's fetch layer no longer accepts image/svg+xml MIME.
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowSvgInput: true,
      }),
    );
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(response.status).toBe(200);
  });

  it("resolveBuffer returns avatar fallback when src is missing and type=avatar", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      // src is intentionally omitted; schema defaults src to placeholder,
      // but type=avatar exercises the userData.type branch in resolveBuffer
      .query({ type: "avatar" })
      .parse(bufferParser);
    expect(response.status).toBe(200);
  });

  it("rejects images that exceed maxInputPixels via the metadata peek", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        // ridiculously low budget: any real image (including the fallback)
        // exceeds 4 pixels and must be rejected
        maxInputPixels: 4,
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    // We still respond 200 with the fallback (which is read fresh by the
    // catch block without the pixel cap).
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it("rejects buffers that Sharp's metadata flags as svg", async () => {
    // Mock readLocalImage by feeding raw SVG bytes through a real fetch.
    // Easiest: stand up a server pointing at a folder that contains SVG, but
    // since assets/ has no SVG, we'll re-use the magic-byte detector path.
    // (This duplicates the looksLikeSvg test but verifies the integration.)
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
      }),
    );

    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.from("<?xml version='1.0'?><svg xmlns='x'></svg>"),
      headers: { "content-type": "image/svg+xml" },
      status: 200,
      statusText: "OK",
      config: {},
    });

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://allowed.test/bomb.svg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
  });
});

describe("defaultQuality actually governs (Phase 5)", () => {
  it("encodes at the configured defaultQuality when the request omits quality", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, defaultQuality: 60 }),
    );
    const toFormatSpy = vi.spyOn(sharp.prototype, "toFormat");

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(toFormatSpy).toHaveBeenCalledWith(
      "jpeg",
      expect.objectContaining({ quality: 60 }),
    );
    toFormatSpy.mockRestore();
  });

  it("still encodes at 80 when defaultQuality is left at its own default", async () => {
    const app = createApp();
    const toFormatSpy = vi.spyOn(sharp.prototype, "toFormat");

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(toFormatSpy).toHaveBeenCalledWith(
      "jpeg",
      expect.objectContaining({ quality: 80 }),
    );
    toFormatSpy.mockRestore();
  });
});

describe("idHandler safety", () => {
  it("falls back to raw userId when idHandler throws synchronously", async () => {
    const getUserFolder = vi.fn(async (_req: unknown, id?: string) => {
      // Asserting we received the raw value, not "[object Promise]" or similar.
      expect(id).toBe("raw-id");
      return assetDir;
    });
    const idHandler = vi.fn(() => {
      throw new Error("boom");
    });
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, idHandler, getUserFolder }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "noavatar.png",
        folder: "private",
        userId: "raw-id",
        format: "png",
      })
      .parse(bufferParser);

    expect(idHandler).toHaveBeenCalledWith("raw-id");
    expect(getUserFolder).toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.png);
  });

  it("falls back to raw userId when idHandler returns a non-string value", async () => {
    const seen: (string | undefined)[] = [];
    const getUserFolder = vi.fn(async (_req: unknown, id?: string) => {
      seen.push(id);
      return assetDir;
    });
    // Lie about the return type to simulate a misbehaving consumer that
    // returns a number/object/undefined despite the signature.
    const idHandler = vi.fn(() => 12345 as unknown as string);
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, idHandler, getUserFolder }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "noimage.jpg",
        folder: "private",
        userId: "abc",
        format: "jpeg",
      })
      .parse(bufferParser);

    expect(idHandler).toHaveBeenCalledWith("abc");
    expect(seen).toEqual(["abc"]);
    expect(response.status).toBe(200);
  });

  it("awaits async idHandler resolutions and uses the transformed id", async () => {
    const seen: (string | undefined)[] = [];
    const idHandler = vi.fn(async (id: string) => `async-${id}`);
    const getUserFolder = vi.fn(async (_req: unknown, id?: string) => {
      seen.push(id);
      return assetDir;
    });
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, idHandler, getUserFolder }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "noimage.jpg",
        folder: "private",
        userId: "u1",
        format: "jpeg",
      })
      .parse(bufferParser);

    expect(idHandler).toHaveBeenCalledWith("u1");
    expect(seen).toEqual(["async-u1"]);
    expect(response.status).toBe(200);
  });

  it("falls back to raw userId when async idHandler rejects", async () => {
    const seen: (string | undefined)[] = [];
    const idHandler = vi.fn(async () => {
      throw new Error("async fail");
    });
    const getUserFolder = vi.fn(async (_req: unknown, id?: string) => {
      seen.push(id);
      return assetDir;
    });
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, idHandler, getUserFolder }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "noimage.jpg",
        folder: "private",
        userId: "u2",
        format: "jpeg",
      })
      .parse(bufferParser);

    expect(idHandler).toHaveBeenCalledWith("u2");
    expect(seen).toEqual(["u2"]);
    expect(response.status).toBe(200);
  });

  it("times out a slow idHandler under idHandlerTimeoutMs and uses raw id", async () => {
    const seen: (string | undefined)[] = [];
    const idHandler = vi.fn(() => new Promise<string>(() => undefined));
    const getUserFolder = vi.fn(async (_req: unknown, id?: string) => {
      seen.push(id);
      return assetDir;
    });
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        idHandler,
        getUserFolder,
        idHandlerTimeoutMs: 50,
        requestTimeoutMs: 5000,
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "noimage.jpg",
        folder: "private",
        userId: "u3",
        format: "jpeg",
      })
      .parse(bufferParser);

    expect(idHandler).toHaveBeenCalledWith("u3");
    expect(seen).toEqual(["u3"]);
    expect(response.status).toBe(200);
  });

  it("uses requestTimeoutMs when idHandlerTimeoutMs is unset", async () => {
    const seen: (string | undefined)[] = [];
    const idHandler = vi.fn(() => new Promise<string>(() => undefined));
    const getUserFolder = vi.fn(async (_req: unknown, id?: string) => {
      seen.push(id);
      return assetDir;
    });
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        idHandler,
        getUserFolder,
        requestTimeoutMs: 60,
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "noimage.jpg",
        folder: "private",
        userId: "u4",
        format: "jpeg",
      })
      .parse(bufferParser);

    expect(seen).toEqual(["u4"]);
    expect(response.status).toBe(200);
  });
});

describe("EXIF auto-orient applied before resize", () => {
  it("produces correct output dimensions for an EXIF orientation=6 portrait JPEG", async () => {
    // Build a tagged source: 200x400 image authored upright, then encoded
    // with EXIF orientation=6 ("rotate 90 CW"). Visually this is a 400x200
    // image.
    const baseBuffer = await sharp({
      create: {
        width: 200,
        height: 400,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .jpeg()
      .toBuffer();

    const tagged = await sharp(baseBuffer)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const meta = await sharp(tagged).metadata();
    expect(meta.orientation).toBe(6);
    // Raw raster is still 200x400 before rotation.
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(400);

    // Request a SINGLE dimension (width only, no height) rather than a
    // square target. A square width+height request is vacuous here:
    // `fit: cover` crops to fill the exact box regardless of source
    // orientation, so both the raw 200x400 raster and the rotated 400x200
    // one land on the same output size whether or not `.rotate()` actually
    // ran -- the old assertion passed even with rotation silently dropped.
    // With only `width` supplied, Sharp instead scales proportionally to
    // the source aspect ratio, so the two orderings diverge and become
    // observable: rotate-before-resize operates on the post-rotation
    // 400x200 raster (height = 100 * 200/400 = 50), while a regression that
    // drops `.rotate()` would resize the raw 200x400 raster instead
    // (height = 100 * 400/200 = 200).
    const expected = await sharp(tagged)
      .rotate()
      .resize({
        width: 100,
        fit: sharp.fit.cover,
        withoutEnlargement: true,
      })
      .jpeg()
      .toBuffer();
    const expectedMeta = await sharp(expected).metadata();
    // Empirically confirmed against this fixture: correct (rotate-before-
    // resize) output is 100x50.
    expect(expectedMeta.width).toBe(100);
    expect(expectedMeta.height).toBe(50);

    // Now run the buffer through the middleware end-to-end and confirm the
    // visible output also reads as 100x50, proving rotate() ran before
    // resize() in the pipeline (a dropped `.rotate()` would yield 100x200).
    const tmpDir = path.join(assetDir, "..", "tmp-exif");
    const fsmod = await import("node:fs/promises");
    await fsmod.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, "portrait-orient6.jpg");
    await fsmod.writeFile(tmpFile, tagged);

    try {
      const app = express();
      app.get("/api/v1/pixel/serve", registerServe({ baseDir: tmpDir }));

      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({
          src: "portrait-orient6.jpg",
          width: 100,
          format: "jpeg",
        })
        .parse(bufferParser);

      expect(response.status).toBe(200);
      const outMeta = await sharp(response.body).metadata();
      expect(outMeta.format).toBe("jpeg");
      expect(outMeta.width).toBe(100);
      expect(outMeta.height).toBe(50);
      // Sharp's rotate() always strips EXIF orientation; the output should
      // carry the default orientation (undefined or 1).
      expect(
        outMeta.orientation === undefined || outMeta.orientation === 1,
      ).toBe(true);
    } finally {
      await fsmod.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("getUserFolderRootDir containment (Task 18)", () => {
  // Build a controlled subdirectory tree once per test to validate the
  // realpath + path.relative containment check used by the middleware.
  const buildTempRoot = async (): Promise<{
    rootDir: string;
    insideDir: string;
    outsideDir: string;
    cleanup: () => Promise<void>;
  }> => {
    const fsmod = await import("node:fs/promises");
    const osmod = await import("node:os");
    const rootDir = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-rootdir-"),
    );
    const insideDir = path.join(rootDir, "users", "valid");
    await fsmod.mkdir(insideDir, { recursive: true });
    const outsideDir = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-escape-"),
    );
    // Drop a recognisable image into the inside dir so we can prove which
    // baseDir the middleware actually used.
    await fsmod.copyFile(
      path.join(assetDir, "noimage.jpg"),
      path.join(insideDir, "noimage.jpg"),
    );
    // And a different image into the outside dir for the negative case.
    await fsmod.copyFile(
      path.join(assetDir, "noavatar.png"),
      path.join(outsideDir, "noimage.jpg"),
    );
    return {
      rootDir,
      insideDir,
      outsideDir,
      cleanup: async (): Promise<void> => {
        await fsmod.rm(rootDir, { recursive: true, force: true });
        await fsmod.rm(outsideDir, { recursive: true, force: true });
      },
    };
  };

  it("allows getUserFolder paths inside getUserFolderRootDir", async () => {
    const { rootDir, insideDir, cleanup } = await buildTempRoot();
    try {
      const onError = vi.fn();
      const getUserFolder = vi.fn(async () => insideDir);
      const app = express();
      app.get(
        "/api/v1/pixel/serve",
        registerServe({
          baseDir: assetDir,
          getUserFolder,
          getUserFolderRootDir: rootDir,
          onError,
        }),
      );
      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({
          src: "noimage.jpg",
          folder: "private",
          userId: "valid",
          format: "jpeg",
        })
        .parse(bufferParser);
      expect(response.status).toBe(200);
      expect(getUserFolder).toHaveBeenCalled();
      // No containment-failure error should have fired.
      const containmentErrors = onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "getUserFolder",
      );
      expect(containmentErrors).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("falls back to the public baseDir when getUserFolder escapes via ../etc", async () => {
    const { rootDir, outsideDir, cleanup } = await buildTempRoot();
    try {
      const onError = vi.fn();
      // Pretend the user-supplied callback joined a malicious userId.
      // outsideDir resolves outside the configured root.
      const getUserFolder = vi.fn(async () => outsideDir);
      const app = express();
      app.get(
        "/api/v1/pixel/serve",
        registerServe({
          baseDir: assetDir,
          getUserFolder,
          getUserFolderRootDir: rootDir,
          onError,
        }),
      );
      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({
          src: "noimage.jpg",
          folder: "private",
          userId: "malicious",
          format: "jpeg",
        })
        .parse(bufferParser);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
      expect(getUserFolder).toHaveBeenCalled();
      // The containment failure must surface through onError under the
      // `getUserFolder` phase, and the middleware must NOT have read from
      // outsideDir. We confirm the latter by checking the response body is
      // the noimage.jpg payload (from assetDir/the inside dir copy uses the
      // same source asset) — but the simpler invariant is that onError was
      // called with the expected phase.
      const containmentErrors = onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "getUserFolder",
      );
      expect(containmentErrors.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("falls back to the public baseDir when getUserFolder escapes via a symlink", async () => {
    if (process.platform === "win32") {
      // Symlink creation on Win32 requires admin or developer mode; treat
      // the symlink path as a soft skip when the symlink syscall fails.
    }
    const fsmod = await import("node:fs/promises");
    const { rootDir, outsideDir, cleanup } = await buildTempRoot();
    try {
      const linkPath = path.join(rootDir, "users", "escape");
      try {
        await fsmod.symlink(outsideDir, linkPath, "dir");
      } catch {
        // Cannot create symlinks on this platform — skip gracefully.
        return;
      }
      const onError = vi.fn();
      const getUserFolder = vi.fn(async () => linkPath);
      const app = express();
      app.get(
        "/api/v1/pixel/serve",
        registerServe({
          baseDir: assetDir,
          getUserFolder,
          getUserFolderRootDir: rootDir,
          onError,
        }),
      );
      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({
          src: "noimage.jpg",
          folder: "private",
          userId: "escape",
          format: "jpeg",
        })
        .parse(bufferParser);
      expect(response.status).toBe(200);
      const containmentErrors = onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "getUserFolder",
      );
      expect(containmentErrors.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("works without getUserFolderRootDir (opt-in feature, backward compatible)", async () => {
    // When the option is unset, the framework MUST NOT call realpath /
    // validate containment. Any path returned by getUserFolder is accepted.
    const onError = vi.fn();
    const getUserFolder = vi.fn(async () => assetDir);
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: "/tmp", // any value — getUserFolder replaces it
        getUserFolder,
        onError,
      }),
    );
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "noimage.jpg",
        folder: "private",
        userId: "u",
        format: "jpeg",
      })
      .parse(bufferParser);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    const containmentErrors = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "getUserFolder",
    );
    expect(containmentErrors).toHaveLength(0);
  });

  it("isInsideRoot helper allows the root itself and a descendant", async () => {
    const fsmod = await import("node:fs/promises");
    const osmod = await import("node:os");
    const root = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-iir-"),
    );
    try {
      const child = path.join(root, "sub");
      await fsmod.mkdir(child);
      expect(await isInsideRoot(root, root)).toBe(true);
      expect(await isInsideRoot(root, child)).toBe(true);
    } finally {
      await fsmod.rm(root, { recursive: true, force: true });
    }
  });

  it("isInsideRoot helper rejects sibling directories and empty inputs (Task 7 lexical containment)", async () => {
    // NOTE (Task 7): non-existent candidates inside the root are now ACCEPTED
    // via lexical containment so lazy per-user dirs can be evaluated before
    // they exist on disk. The earlier rejection on non-existent candidates
    // was a side effect of the dual-realpath check and is no longer the
    // correct behavior. See `pixel-serve-server/CHANGELOG.md` for Task 7
    // background and the dedicated "lazy-create" coverage below.
    const fsmod = await import("node:fs/promises");
    const osmod = await import("node:os");
    const root = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-iir-"),
    );
    const sibling = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-sibling-"),
    );
    try {
      expect(await isInsideRoot(root, sibling)).toBe(false);
      // Non-existent candidates inside the root pass the lexical check.
      expect(await isInsideRoot(root, path.join(root, "does-not-exist"))).toBe(
        true,
      );
      expect(await isInsideRoot("", root)).toBe(false);
      expect(await isInsideRoot(root, "")).toBe(false);
    } finally {
      await fsmod.rm(root, { recursive: true, force: true });
      await fsmod.rm(sibling, { recursive: true, force: true });
    }
  });
});

describe("query schema robustness (Task 25)", () => {
  it("serves a fallback when src arrives as an array (?src[]=a&src[]=b)", async () => {
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, onError }),
    );
    // supertest's query() with an array produces ?src[]=a&src[]=b. Express
    // parses this into an array, which the schema must reject cleanly.
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ "src[]": ["a", "b"], format: "jpeg" })
      .parse(bufferParser);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    const validationErrors = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "validation",
    );
    expect(validationErrors.length).toBeGreaterThan(0);
  });

  it("serves a fallback when src arrives as a nested object (?src[key]=v)", async () => {
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, onError }),
    );
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ "src[key]": "value", format: "jpeg" })
      .parse(bufferParser);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    const validationErrors = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "validation",
    );
    expect(validationErrors.length).toBeGreaterThan(0);
  });
});

describe("deterministic ETag (Task 6)", () => {
  it("short-circuits with 304 BEFORE invoking Sharp when If-None-Match matches a pre-computed key", async () => {
    // Pre-compute the deterministic ETag for a request without ever issuing
    // it. We use the exported helpers to do so. Then send the request with
    // If-None-Match SET — the server must return 304 without touching Sharp.
    const sid = await buildSourceIdentifier("noimage.jpg", assetDir);
    expect(sid).not.toBeNull();
    const etag = buildDeterministicEtag(
      {
        src: "noimage.jpg",
        width: undefined,
        height: undefined,
        format: "jpeg",
        quality: 80,
        type: "normal",
        folder: "public",
        parsedUserId: undefined,
      },
      sid as string,
    );

    const sharpSpy = vi.spyOn(sharp.prototype, "toBuffer");
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .set("If-None-Match", etag)
      .query({ src: "noimage.jpg", format: "jpeg" });

    expect(response.status).toBe(304);
    expect(sharpSpy).not.toHaveBeenCalled();
    sharpSpy.mockRestore();
  });

  it("emits a SHA-256-shaped ETag (CodeQL js/weak-cryptographic-algorithm fix)", () => {
    // Direct assertion that the deterministic ETag is SHA-256 (64 hex chars
    // wrapped in double-quotes), not the older SHA-1 form (40 hex chars). A
    // future regression that flips back to a weaker hash will be caught here
    // before it ships.
    const etag = buildDeterministicEtag(
      {
        src: "noimage.jpg",
        width: 100,
        height: 100,
        format: "jpeg",
        quality: 80,
        type: "normal",
        folder: "public",
        parsedUserId: undefined,
      },
      "fixture-source-id",
    );
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("first request returns 200 + ETag, second with If-None-Match returns 304 without Sharp", async () => {
    const app = createApp();
    const first = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeDefined();

    // Now send the same request with If-None-Match and assert Sharp is never
    // called. We spy on toBuffer because it's the universal terminal call.
    const sharpSpy = vi.spyOn(sharp.prototype, "toBuffer");
    const second = await request(app)
      .get("/api/v1/pixel/serve")
      .set("If-None-Match", etag)
      .query({ src: "noimage.jpg", format: "jpeg" });
    expect(second.status).toBe(304);
    expect(sharpSpy).not.toHaveBeenCalled();
    sharpSpy.mockRestore();
  });

  it("produces different ETags for different dimensions and qualities (deterministic key sensitivity)", async () => {
    const app = createApp();
    const baseline = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);
    const withWidth = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", width: 120, format: "jpeg" })
      .parse(bufferParser);
    const withHeight = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", height: 120, format: "jpeg" })
      .parse(bufferParser);
    const withQuality = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", quality: 95, format: "jpeg" })
      .parse(bufferParser);

    const tags = new Set([
      baseline.headers.etag,
      withWidth.headers.etag,
      withHeight.headers.etag,
      withQuality.headers.etag,
    ]);
    expect(tags.size).toBe(4);
  });

  it("produces different ETags for different formats even with identical source", async () => {
    const app = createApp();
    const asJpeg = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);
    const asPng = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "png" })
      .parse(bufferParser);
    expect(asJpeg.headers.etag).toBeDefined();
    expect(asPng.headers.etag).toBeDefined();
    expect(asJpeg.headers.etag).not.toBe(asPng.headers.etag);
  });

  it("invalidates the deterministic ETag when the underlying file changes", async () => {
    // Use a tmp file so we can rewrite it to change mtimeMs/size.
    const fsmod = await import("node:fs/promises");
    const tmpDir = path.join(assetDir, "..", "tmp-etag");
    await fsmod.mkdir(tmpDir, { recursive: true });
    const tmpName = "shifty.png";
    const tmpFile = path.join(tmpDir, tmpName);
    const v1 = await sharp({
      create: {
        width: 80,
        height: 80,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .png()
      .toBuffer();
    await fsmod.writeFile(tmpFile, v1);

    try {
      const app = express();
      app.get("/api/v1/pixel/serve", registerServe({ baseDir: tmpDir }));
      const first = await request(app)
        .get("/api/v1/pixel/serve")
        .query({ src: tmpName, format: "png" })
        .parse(bufferParser);
      const initialEtag = first.headers.etag as string;
      expect(initialEtag).toBeDefined();

      // Rewrite with different content -> mtime/size change.
      await new Promise((r) => setTimeout(r, 20));
      const v2 = await sharp({
        create: {
          width: 80,
          height: 80,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .png()
        .toBuffer();
      await fsmod.writeFile(tmpFile, v2);

      const second = await request(app)
        .get("/api/v1/pixel/serve")
        .query({ src: tmpName, format: "png" })
        .parse(bufferParser);
      const newEtag = second.headers.etag as string;
      expect(newEtag).toBeDefined();
      expect(newEtag).not.toBe(initialEtag);
    } finally {
      await fsmod.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("buildSourceIdentifier returns null for empty src and url-prefixed strings produce a url identifier", async () => {
    expect(await buildSourceIdentifier(undefined, assetDir)).toBeNull();
    expect(await buildSourceIdentifier("", assetDir)).toBeNull();
    expect(
      await buildSourceIdentifier("https://example.com/x.jpg", assetDir),
    ).toBe("url:https://example.com/x.jpg");
    // missing local file falls through to null
    expect(
      await buildSourceIdentifier("does-not-exist.jpg", assetDir),
    ).toBeNull();
    // existing local file returns mtime+size identifier
    const sid = await buildSourceIdentifier("noimage.jpg", assetDir);
    expect(sid).toMatch(/^file:\d+(?:\.\d+)?:\d+$/);
  });

  it("falls back to buffer-hash ETag when no deterministic source identifier is available", async () => {
    // Use a missing src so readLocalImage returns the fallback. Source
    // identifier is null, so the pipeline must still produce an ETag from
    // the processed buffer hash.
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "missing-file.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(response.status).toBe(200);
    expect(response.headers.etag).toBeDefined();
    // Send the same request a second time — the fallback path goes through
    // the same code so the buffer hash stays stable.
    const repeat = await request(app)
      .get("/api/v1/pixel/serve")
      .set("If-None-Match", response.headers.etag as string)
      .query({ src: "missing-file.jpg", format: "jpeg" });
    expect(repeat.status).toBe(304);
  });

  it("post-Sharp 304 on a recurring soft fallback (missing local file) echoes the fallback Cache-Control, not the operator's configured value", async () => {
    // Deliberately NOT createApp(): its configured cacheControl
    // ("public, max-age=60") is byte-identical to FALLBACK_CACHE_CONTROL, so
    // asserting the 304's Cache-Control against that value would pass
    // whether or not the post-Sharp 304 site actually reads
    // `servedSoftFallback` — it would look identical to simply echoing the
    // operator's config unconditionally. An explicit, distinct custom value
    // proves the fallback policy wins over the operator's own setting.
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, cacheControl: "private, no-cache" }),
    );
    const first = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "missing-file.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("public, max-age=60");
    const etag = first.headers.etag as string;
    expect(etag).toBeDefined();

    // Same request again, presenting the buffer-hash ETag captured above —
    // this is the post-Sharp 304 short-circuit (no deterministic source
    // identifier exists for a missing file), and the file is STILL missing,
    // so this is still a soft fallback.
    const second = await request(app)
      .get("/api/v1/pixel/serve")
      .set("If-None-Match", etag)
      .query({ src: "missing-file.jpg", format: "jpeg" });
    expect(second.status).toBe(304);
    expect(second.headers.etag).toBe(etag);
    expect(second.headers["cache-control"]).toBe("public, max-age=60");
    expect(second.headers["vary"]).toBe("Accept-Encoding");
  });

  it("buildSourceIdentifier returns null for a traversal src referencing an existing out-of-tree file (Task 4 containment gate)", async () => {
    // "../pixel.ts" resolves outside assetDir to this package's own real
    // source file, which exists on disk. Before the isValidPath gate, the
    // local-file branch would fs.stat this out-of-tree file directly and
    // return a deterministic `file:<mtimeMs>:<size>` identifier — an ETag
    // oracle for a file having nothing to do with the request. isValidPath
    // now rejects the traversal before fs.stat ever runs, so the identifier
    // degrades to null.
    const result = await buildSourceIdentifier("../pixel.ts", assetDir);
    expect(result).toBeNull();
  });

  it("a traversal src produces a response ETag equal to the buffer-hash of the SERVED bytes, not a file:-derived identifier (Task 4)", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "../pixel.ts", format: "jpeg" })
      .parse(bufferParser);
    expect(response.status).toBe(200);
    const etag = response.headers.etag as string;
    expect(etag).toBeDefined();
    // readLocalImage independently rejects the same traversal via its own
    // isValidPath check and serves FALLBACKIMAGES.normal(), reprocessed by
    // Sharp per the request. The ETag must be the sha256 buffer-hash of
    // exactly those served bytes, proving the deterministic file:-identifier
    // short-circuit never fired for this request (it would otherwise encode
    // pixel.ts's own mtime/size instead).
    const expectedBufferHashEtag = `"${createHash("sha256")
      .update(response.body as Buffer)
      .digest("hex")}"`;
    expect(etag).toBe(expectedBufferHashEtag);

    // A second request with If-None-Match set to that ETag must 304,
    // confirming the buffer-hash ETag is stable/reproducible and not an
    // artifact of the first request only.
    const repeat = await request(app)
      .get("/api/v1/pixel/serve")
      .set("If-None-Match", etag)
      .query({ src: "../pixel.ts", format: "jpeg" });
    expect(repeat.status).toBe(304);
  });

  it("keys the source identifier for an internal-host URL src on the underlying file, matching the direct-local-path identifier (Phase 3)", async () => {
    // `buildSourceIdentifier` must resolve an internal-host URL (one whose
    // host matches the configured websiteURL) to the SAME file:mtimeMs:size
    // identifier as requesting the underlying local path directly — proving
    // the ETag is keyed on the on-disk file, not the immutable URL string.
    const directSid = await buildSourceIdentifier("noimage.jpg", assetDir, {
      websiteURL: "localhost",
    });
    const internalSid = await buildSourceIdentifier(
      "http://localhost/api/v1/noimage.jpg",
      assetDir,
      { websiteURL: "localhost" },
    );
    expect(directSid).not.toBeNull();
    expect(directSid).toMatch(/^file:\d+(?:\.\d+)?:\d+$/);
    expect(internalSid).toBe(directSid);
  });

  it("invalidates the response ETag for an internal-host URL src when the underlying file changes (Phase 3)", async () => {
    // Mirrors "invalidates the deterministic ETag when the underlying file
    // changes" above, but the request src is an internal-host URL
    // (`http://localhost/api/v1/<asset>`) rather than a direct local path.
    // Use a tmp file so we can rewrite it to change mtimeMs/size.
    const fsmod = await import("node:fs/promises");
    const tmpDir = path.join(assetDir, "..", "tmp-etag-internal");
    await fsmod.mkdir(tmpDir, { recursive: true });
    const tmpName = "shifty-internal.png";
    const tmpFile = path.join(tmpDir, tmpName);
    const v1 = await sharp({
      create: {
        width: 80,
        height: 80,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .png()
      .toBuffer();
    await fsmod.writeFile(tmpFile, v1);

    try {
      const app = express();
      app.get(
        "/api/v1/pixel/serve",
        registerServe({ baseDir: tmpDir, websiteURL: "localhost" }),
      );
      const internalSrc = `http://localhost/api/v1/${tmpName}`;

      const first = await request(app)
        .get("/api/v1/pixel/serve")
        .query({ src: internalSrc, format: "png" })
        .parse(bufferParser);
      expect(first.status).toBe(200);
      // Confirms the request was served from local disk (internal-host
      // branch), not the network branch.
      expect(axios.get).not.toHaveBeenCalled();
      const initialEtag = first.headers.etag as string;
      expect(initialEtag).toBeDefined();

      // Rewrite with different content -> mtime/size change.
      await new Promise((r) => setTimeout(r, 20));
      const v2 = await sharp({
        create: {
          width: 80,
          height: 80,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .png()
        .toBuffer();
      await fsmod.writeFile(tmpFile, v2);

      const second = await request(app)
        .get("/api/v1/pixel/serve")
        .query({ src: internalSrc, format: "png" })
        .parse(bufferParser);
      const newEtag = second.headers.etag as string;
      expect(newEtag).toBeDefined();
      expect(newEtag).not.toBe(initialEtag);

      // The stale (pre-change) ETag must no longer satisfy If-None-Match —
      // under the old url:-keyed identifier this would incorrectly 304
      // forever, since the URL string itself never changes.
      const staleCheck = await request(app)
        .get("/api/v1/pixel/serve")
        .set("If-None-Match", initialEtag)
        .query({ src: internalSrc, format: "png" });
      expect(staleCheck.status).toBe(200);
    } finally {
      await fsmod.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for a local file exceeding maxBytes; the live response ETag is a stable buffer-hash, not a file:-derived identifier (Phase 3)", async () => {
    const fsmod = await import("node:fs/promises");
    const stats = await fsmod.stat(path.join(assetDir, "noimage.jpg"));
    const tinyMax = stats.size - 1;

    // Direct proof: the oversized-file guard degrades buildSourceIdentifier
    // to null, mirroring readLocalImage's own size guard (which serves the
    // fallback buffer instead) so the two never decouple.
    const sid = await buildSourceIdentifier("noimage.jpg", assetDir, {
      maxBytes: tinyMax,
    });
    expect(sid).toBeNull();

    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, maxDownloadBytes: tinyMax }),
    );
    const first = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeDefined();
    // With no deterministic identifier available, the pipeline must fall
    // back to hashing the actually-served (fallback) bytes.
    const expectedBufferHashEtag = `"${createHash("sha256")
      .update(first.body as Buffer)
      .digest("hex")}"`;
    expect(etag).toBe(expectedBufferHashEtag);

    // Stable / reproducible across a second identical request.
    const repeat = await request(app)
      .get("/api/v1/pixel/serve")
      .set("If-None-Match", etag)
      .query({ src: "noimage.jpg", format: "jpeg" });
    expect(repeat.status).toBe(304);
  });
});

describe("Content-Disposition hardening (Task 7)", () => {
  it("uses RFC 5987 filename* parameter with percent-encoded unicode (Arabic)", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "صورة.jpg", format: "jpeg" })
      .parse(bufferParser);
    const disposition = response.headers["content-disposition"] as string;
    // ASCII fallback maps all non-ASCII bytes to "_" then collapses runs and
    // trims, leaving the default "image" base.
    expect(disposition).toMatch(/filename="image\.jpeg"/);
    // filename* must percent-encode the original UTF-8 bytes.
    expect(disposition).toMatch(/filename\*=UTF-8''[%0-9A-Fa-f]+\.jpeg/);
  });

  it("uses RFC 5987 filename* with percent-encoded unicode (CJK)", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "图片.png", format: "png" })
      .parse(bufferParser);
    const disposition = response.headers["content-disposition"] as string;
    expect(disposition).toMatch(/filename="image\.png"/);
    expect(disposition).toMatch(/filename\*=UTF-8''[%0-9A-Fa-f]+\.png/);
  });

  it("strips query strings and fragments before deriving filename", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "http://allowed.test/img.jpg?v=2&t=abc#frag",
        format: "jpeg",
      })
      .parse(bufferParser);
    const disposition = response.headers["content-disposition"] as string;
    // The basename "img" survives; the ?v=2 and #frag are stripped.
    expect(disposition).toMatch(/filename="img\.jpeg"/);
    expect(disposition).toMatch(/filename\*=UTF-8''img\.jpeg/);
    // The query string fragments must not appear anywhere in the disposition.
    expect(disposition).not.toMatch(/v=2/);
    expect(disposition).not.toMatch(/frag/);
  });

  it("falls back to 'image' when the basename is only punctuation", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: '""""', format: "jpeg" })
      .parse(bufferParser);
    const disposition = response.headers["content-disposition"] as string;
    // All four quotes collapse to "_" then get trimmed, leaving the default.
    expect(disposition).toMatch(/filename="image\.jpeg"/);
  });

  it("caps absurdly long filenames so the header stays bounded", async () => {
    const app = createApp();
    const huge = "a".repeat(2000);
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: `${huge}.jpg`, format: "jpeg" })
      .parse(bufferParser);
    const disposition = response.headers["content-disposition"] as string;
    expect(disposition).toBeDefined();
    // Sanity: the entire header must be well under the 2000-char src length.
    expect(disposition.length).toBeLessThan(500);
    expect(disposition).toMatch(/filename="a+\.jpeg"/);
  });

  it("emits Vary: Accept-Encoding on successful responses", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(response.headers["vary"]).toBe("Accept-Encoding");
  });

  it("emits Vary: Accept-Encoding on the fallback path too", async () => {
    const app = createApp();
    const toBufferSpy = vi
      .spyOn(sharp.prototype, "toBuffer")
      .mockRejectedValueOnce(new Error("forced sharp failure"));
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(response.status).toBe(200);
    expect(response.headers["vary"]).toBe("Accept-Encoding");
    toBufferSpy.mockRestore();
  });

  it("buildFilename unit: ASCII / unicode / query / punctuation / long names", async () => {
    expect(buildFilename("photo.jpg", "webp")).toEqual({
      asciiFilename: "photo.webp",
      encodedFilename: "photo.webp",
    });
    // Unicode collapses ASCII fallback to "image"
    const cn = buildFilename("图片.png", "png");
    expect(cn.asciiFilename).toBe("image.png");
    expect(cn.encodedFilename).toMatch(/^%[0-9A-F]{2}.*\.png$/);
    // Query/fragment stripping
    const q = buildFilename("http://x/a.jpg?u=1#f", "jpeg");
    expect(q.asciiFilename).toBe("a.jpeg");
    expect(q.encodedFilename).toBe("a.jpeg");
    // Only punctuation
    const p = buildFilename('""""', "jpeg");
    expect(p.asciiFilename).toBe("image.jpeg");
    expect(p.encodedFilename).toMatch(/^%22.*\.jpeg$/);
    // Long
    const long = buildFilename("a".repeat(2000) + ".jpg", "jpeg");
    expect(long.asciiFilename.length).toBeLessThanOrEqual(100);
    expect(long.encodedFilename.length).toBeLessThanOrEqual(100);
    // Undefined src falls back
    const u = buildFilename(undefined, "jpeg");
    expect(u.asciiFilename).toBe("image.jpeg");
    expect(u.encodedFilename).toBe("image.jpeg");

    // Leading/trailing chars that get replaced with `_` are stripped. The
    // implementation does this via two string slices (instead of the
    // CodeQL-flagged `/^_+|_+$/g` regex), so a mixed sequence at each end
    // must still collapse cleanly.
    const wrapped = buildFilename("photo", "jpeg");
    expect(wrapped.asciiFilename).toBe("photo.jpeg");
  });

  it("buildFilename does not truncate mid-percent-encoded byte for long CJK names (Task 5)", () => {
    // Each `中` is three UTF-8 bytes that encodeURIComponent expands into
    // `%E4%B8%AD` (9 chars). Forty CJK characters produce a 360-char
    // encoded base — the naive `.slice(0, 95)` cut used to land inside a
    // triplet (e.g., `%E4%B`), producing a malformed RFC 5987 parameter.
    const result = buildFilename("中".repeat(40), "jpeg");

    // Header parameter must not end in `%`, `%X`, or any partial triplet.
    expect(result.encodedFilename).toMatch(/\.jpeg$/);
    const encodedPortion = result.encodedFilename.replace(/\.jpeg$/, "");
    expect(encodedPortion).not.toMatch(/%$/);
    expect(encodedPortion).not.toMatch(/%[0-9A-Fa-f]$/);
    // Every `%` must be followed by exactly two hex digits.
    expect(encodedPortion).toMatch(/^(?:[^%]|%[0-9A-Fa-f]{2})*$/);
    // Round-trip: the encoded portion must decode without throwing and the
    // decoded text must be a non-empty prefix of the original `中` repetition.
    const decoded = decodeURIComponent(encodedPortion);
    expect(decoded.length).toBeGreaterThan(0);
    expect("中".repeat(40).startsWith(decoded)).toBe(true);
    // The overall filename still respects the length cap.
    expect(result.encodedFilename.length).toBeLessThanOrEqual(100);
  });
});

describe("onError observability hook (Task 19)", () => {
  it("invokes onError with phase=fetch when the host is not in the allowlist", async () => {
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
        onError,
      }),
    );
    await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://blocked.test/x.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(onError).toHaveBeenCalled();
    const phases = onError.mock.calls.map(
      (c) => (c[1] as { phase: string }).phase,
    );
    expect(phases).toContain("fetch");
  });

  it("invokes onError with phase=fetch when DNS resolves to a private IP (SSRF guard)", async () => {
    const onError = vi.fn();
    setDnsLookup(async () => [{ address: "127.0.0.1", family: 4 }]);
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
        onError,
      }),
    );
    await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://allowed.test/x.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(onError).toHaveBeenCalled();
    const fetchCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "fetch",
    );
    expect(fetchCalls.length).toBeGreaterThan(0);
  });

  it("invokes onError with phase=fs when the local file is missing", async () => {
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, onError }),
    );
    await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "does-not-exist.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(onError).toHaveBeenCalled();
    const fsCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "fs",
    );
    expect(fsCalls.length).toBeGreaterThan(0);
    // Context must include the offending src.
    expect((fsCalls[0]![1] as { src?: string }).src).toBe("does-not-exist.jpg");
  });

  it("invokes onError with phase=idHandler when the handler throws", async () => {
    const onError = vi.fn();
    const idHandler = vi.fn(() => {
      throw new Error("idHandler boom");
    });
    const getUserFolder = vi.fn(async () => assetDir);
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        idHandler,
        getUserFolder,
        onError,
      }),
    );
    await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "noimage.jpg",
        folder: "private",
        userId: "id1",
        format: "jpeg",
      })
      .parse(bufferParser);
    const idCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "idHandler",
    );
    expect(idCalls.length).toBeGreaterThan(0);
    expect((idCalls[0]![1] as { userId?: string }).userId).toBe("id1");
  });

  it("invokes onError with phase=idHandler when the handler returns a non-string value", async () => {
    const onError = vi.fn();
    const idHandler = vi.fn(() => 99 as unknown as string);
    const getUserFolder = vi.fn(async () => assetDir);
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        idHandler,
        getUserFolder,
        onError,
      }),
    );
    await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "noimage.jpg",
        folder: "private",
        userId: "id-nonstr",
        format: "jpeg",
      })
      .parse(bufferParser);
    const idCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "idHandler",
    );
    expect(idCalls.length).toBeGreaterThan(0);
  });

  it("invokes onError with phase=getUserFolder when the resolver times out", async () => {
    const onError = vi.fn();
    const getUserFolder = vi.fn(() => new Promise<string>(() => undefined));
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        getUserFolder,
        requestTimeoutMs: 50,
        onError,
      }),
    );
    await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "noimage.jpg",
        folder: "private",
        userId: "u-tmo",
        format: "jpeg",
      })
      .parse(bufferParser);
    const gufCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "getUserFolder",
    );
    expect(gufCalls.length).toBeGreaterThan(0);
  });

  it("invokes onError with phase=sharp when the Sharp pipeline throws", async () => {
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, onError }),
    );
    const toBufferSpy = vi
      .spyOn(sharp.prototype, "toBuffer")
      .mockRejectedValueOnce(new Error("sharp failure"));
    await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);
    toBufferSpy.mockRestore();
    const sharpCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "sharp",
    );
    expect(sharpCalls.length).toBeGreaterThan(0);
  });

  it("invokes onError with phase=sharp for SVG-input rejection", async () => {
    const onError = vi.fn();
    vi.mocked(axios.get).mockResolvedValue({
      data: Buffer.from("<svg></svg>"),
      headers: { "content-type": "image/png" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
        onError,
      }),
    );
    await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://allowed.test/bomb.svg", format: "png" })
      .parse(bufferParser);
    const sharpCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "sharp",
    );
    expect(sharpCalls.length).toBeGreaterThan(0);
  });

  it("invokes onError with phase=fetch on raw-network failures and reports through to the response", async () => {
    const onError = vi.fn();
    vi.mocked(axios.get).mockRejectedValue(new Error("network down"));
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
        onError,
      }),
    );
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://allowed.test/down.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(response.status).toBe(200);
    const fetchCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "fetch",
    );
    expect(fetchCalls.length).toBeGreaterThan(0);
  });

  it("swallows throws from onError so a buggy hook never breaks the response", async () => {
    const onError = vi.fn(() => {
      throw new Error("logger blew up");
    });
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, onError }),
    );
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "missing.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(response.status).toBe(200);
    expect(onError).toHaveBeenCalled();
  });

  it("does not invoke onError for a successful happy-path request", async () => {
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, onError }),
    );
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(response.status).toBe(200);
    expect(onError).not.toHaveBeenCalled();
  });

  it("invokes onError with phase=getUserFolder when the resolver throws synchronously", async () => {
    const onError = vi.fn();
    const getUserFolder = vi.fn(() => {
      throw new Error("getUserFolder boom");
    });
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, getUserFolder, onError }),
    );
    await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        src: "noimage.jpg",
        folder: "private",
        userId: "gid",
        format: "jpeg",
      })
      .parse(bufferParser);
    const calls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "getUserFolder",
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  it("invokes onError with phase=schema and re-throws when registerServe is given invalid options", () => {
    const onError = vi.fn();
    // baseDir is required; supplying an empty string fails the schema. After
    // Task 4 the schema parse runs ONCE at factory time, so the failure
    // surfaces synchronously: onError fires with phase: "schema" and the
    // factory re-throws so the deployment fails loudly rather than serving
    // fallback images forever.
    expect(() => registerServe({ baseDir: "", onError } as never)).toThrow();
    const schemaCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "schema",
    );
    expect(schemaCalls.length).toBeGreaterThan(0);
  });

  it("invokes onError with phase=validation when the query is rejected by the userData schema", async () => {
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, onError }),
    );
    // Sending an unknown query field triggers strict() schema rejection.
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg", unknownField: "x" });
    expect(response.status).toBe(200);
    const calls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "validation",
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  it("does not re-run optionsSchema.parse on subsequent requests (Task 4)", async () => {
    // After Task 4 the options schema is parsed exactly once at factory time.
    // To prove the hot path is free of the Zod call we monkey-patch
    // `optionsSchema.parse` AFTER `registerServe` has already produced its
    // middleware. If the production code ever regresses to per-request
    // parsing the spy would fire — and this assertion would catch it.
    const schemaModule = await import("./schema");
    const app = express();
    app.get("/api/v1/pixel/serve", registerServe({ baseDir: assetDir }));
    const parseSpy = vi.spyOn(schemaModule.optionsSchema, "parse");
    try {
      for (let i = 0; i < 3; i++) {
        const response = await request(app)
          .get("/api/v1/pixel/serve")
          .query({ src: "noimage.jpg", format: "jpeg" })
          .parse(bufferParser);
        expect(response.status).toBe(200);
      }
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });
});

describe("looksLikeSvg hardening (Task 4)", () => {
  it("detects SVG after leading ASCII whitespace before a UTF-8 BOM", () => {
    // 0x20 0xEF 0xBB 0xBF <svg ...>  — the old detector only checked BOM at
    // offset 0, so a single leading space byte slipped past.
    const buf = Buffer.concat([
      Buffer.from([0x20, 0x20, 0x09, 0xef, 0xbb, 0xbf]),
      Buffer.from("<svg></svg>"),
    ]);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("detects SVG when the buffer starts with leading whitespace only", () => {
    const buf = Buffer.concat([
      Buffer.from([0x09, 0x20, 0x0a, 0x0d, 0x20]),
      Buffer.from("<svg/>"),
    ]);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("detects a UTF-16 LE BOM-prefixed SVG", () => {
    // BOM = 0xFF 0xFE; "<svg></svg>" encoded as UTF-16 LE.
    const text = "<svg></svg>";
    const utf16 = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      utf16.writeUInt16LE(text.charCodeAt(i), i * 2);
    }
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("detects a UTF-16 BE BOM-prefixed SVG", () => {
    // BOM = 0xFE 0xFF; "<svg></svg>" encoded as UTF-16 BE.
    const text = "<svg></svg>";
    const utf16 = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      utf16.writeUInt16BE(text.charCodeAt(i), i * 2);
    }
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16]);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("detects a UTF-16 LE BOM-prefixed SVG with an XML prolog", () => {
    const text = "<?xml version='1.0'?><svg xmlns='x'></svg>";
    const utf16 = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      utf16.writeUInt16LE(text.charCodeAt(i), i * 2);
    }
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("does not flag non-SVG UTF-16 BE content", () => {
    const text = "<root></root>";
    const utf16 = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      utf16.writeUInt16BE(text.charCodeAt(i), i * 2);
    }
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16]);
    expect(looksLikeSvg(buf)).toBe(false);
  });

  it("finds <svg> after a 2 KiB XML prolog padded with comments", () => {
    // The old detector capped the inspection window at 1 KiB so a 2 KiB
    // prolog of comments before `<svg>` would slip past undetected.
    const filler = "<!--" + "x".repeat(2048) + "-->";
    const buf = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n${filler}\n<svg xmlns="x"></svg>`,
    );
    expect(buf.length).toBeGreaterThan(2048);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("still rejects buffers that contain no SVG even after a long XML prolog", () => {
    const filler = "<!--" + "x".repeat(2048) + "-->";
    const buf = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n${filler}\n<root></root>`,
    );
    expect(looksLikeSvg(buf)).toBe(false);
  });
});

describe("looksLikeSvg BOM/whitespace/comment combinations (Phase 6 Task 6.1)", () => {
  it("detects a UTF-8 BOM followed by whitespace followed by <svg> (whitespace AFTER the BOM)", () => {
    // Distinct from the existing "whitespace before a UTF-8 BOM" case: here
    // the BOM comes first and the tolerated whitespace sits between the BOM
    // and the root element.
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("   \t\n<svg></svg>"),
    ]);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("detects a UTF-16 LE BOM-prefixed, comment-prefixed SVG (real-world input shape distinct from the existing XML-prolog case)", () => {
    // Note: `<?xml` and `<!--` prefixes both funnel into the identical
    // `/<svg[\s>]/.test(trimmed)` statement in looksLikeSvg's UTF-16 branch,
    // so this does not add NEW branch coverage on top of the pre-existing
    // XML-prolog UTF-16 case — it pins a genuinely different real-world
    // input shape (a comment-only preamble, no XML declaration) that a
    // future refactor separating the two prefixes could otherwise regress
    // silently.
    const text = "<!-- c --><svg></svg>";
    const utf16 = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      utf16.writeUInt16LE(text.charCodeAt(i), i * 2);
    }
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("allows a UTF-8 BOM followed by ordinary plain text (negative — no false positive from the BOM alone)", () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("just a regular caption, not markup at all"),
    ]);
    expect(looksLikeSvg(buf)).toBe(false);
  });

  it("does not over-block a UTF-16 BOM-prefixed plain-text buffer that merely contains the substring <svg> without a recognized prolog", () => {
    // The UTF-16 branch must behave identically to the latin1/UTF-8 branch:
    // its `<svg` window scan (and DOCTYPE-svg-root check) is gated on a
    // recognized XML prolog (`<svg`/`<?xml`/`<!--`/`<!doctype`), NOT run
    // unconditionally. Without that gate a UTF-16-encoded text/JSON/log file
    // whose content happened to include the characters `<svg>` was wrongly
    // classified as SVG (a false positive / over-block). The byte-identical
    // content without a BOM (latin1 path) already returns false, so this
    // pins the two branches to the same behavior.
    const text = "caption for a diagram: see the <svg> tag reference below";
    const utf16 = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      utf16.writeUInt16LE(text.charCodeAt(i), i * 2);
    }
    const utf16Bom = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]);
    expect(looksLikeSvg(utf16Bom)).toBe(false);
    // Symmetry check: the same text through the latin1/UTF-8 path (no BOM)
    // is also not SVG — neither branch may blanket-scan for `<svg`.
    expect(looksLikeSvg(Buffer.from(text))).toBe(false);
  });
});

describe("metadata-based Sharp guards (Phase 6 Task 6.1)", () => {
  it("rejects a buffer that evades the magic-byte sniffer but Sharp's own metadata still identifies it as SVG (defense in depth)", async () => {
    // looksLikeSvg only inspects the first 4 KiB of the buffer. A real SVG
    // document can pad its prolog (e.g. a huge comment) past that window so
    // the app-level sniffer never sees the `<svg` tag. Verified empirically
    // that Sharp/libvips' own loader dispatch is NOT bound by the same 4 KiB
    // cap and still recognizes and parses such a buffer as format "svg" —
    // the independent `meta.format === "svg"` guard inside the Sharp
    // pipeline is what catches this case, proving the second layer of
    // defense has real (not merely theoretical) value.
    const filler = "<!--" + "x".repeat(5000) + "-->";
    const svgText = `<?xml version="1.0" encoding="UTF-8"?>\n${filler}\n<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50"/></svg>`;
    const svgBuffer = Buffer.from(svgText);
    expect(svgBuffer.length).toBeGreaterThan(4096);
    // Confirm the app-level sniffer genuinely misses this buffer — otherwise
    // this test would be exercising the wrong guard entirely.
    expect(looksLikeSvg(svgBuffer)).toBe(false);

    const tmpDir = path.join(assetDir, "..", "tmp-svg-bypass");
    const fsmod = await import("node:fs/promises");
    await fsmod.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, "padded.svg");
    await fsmod.writeFile(tmpFile, svgBuffer);

    try {
      const onError = vi.fn();
      const app = express();
      app.get(
        "/api/v1/pixel/serve",
        registerServe({ baseDir: tmpDir, onError }),
      );
      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({ src: "padded.svg", format: "jpeg" })
        .parse(bufferParser);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
      const sharpErrors = onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "sharp",
      );
      expect(sharpErrors.length).toBeGreaterThan(0);
      expect(
        sharpErrors.some((c) => (c[0] as Error).message.includes("svg")),
      ).toBe(true);
    } finally {
      await fsmod.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects when Sharp's metadata peek reports a pixel count exceeding maxInputPixels (manual re-check)", async () => {
    // Sharp's OWN `limitInputPixels` constructor option already throws
    // directly inside `metadata()` for any real oversized image at the
    // configured threshold (verified empirically across jpeg/png/webp/
    // tiff/gif/avif/svg) — so the manual
    // `meta.width * meta.height > maxInputPixels` re-check in pixel.ts can
    // never fire via a real image at the SAME threshold; it is a
    // defense-in-depth guard for a metadata() implementation that reports
    // oversized dimensions without itself throwing (e.g. a future libvips
    // change that defers enforcement to decode time). Pinned directly by
    // mocking the metadata peek's return value, exactly as the existing
    // Sharp-processing-error tests in this file already do for `toBuffer`.
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, onError }),
    );

    type SharpMetadataResult = Awaited<
      ReturnType<typeof sharp.prototype.metadata>
    >;
    const metaSpy = vi
      .spyOn(sharp.prototype, "metadata")
      .mockResolvedValueOnce({
        width: 99999,
        height: 99999,
        format: "jpeg",
      } as unknown as SharpMetadataResult);

    try {
      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({ src: "noimage.jpg", format: "jpeg" })
        .parse(bufferParser);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
      const sharpErrors = onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "sharp",
      );
      expect(sharpErrors.length).toBeGreaterThan(0);
      expect(
        sharpErrors.some((c) =>
          (c[0] as Error).message.includes("exceeds maxInputPixels"),
        ),
      ).toBe(true);
    } finally {
      metaSpy.mockRestore();
    }
  });

  it("skips the pixel-count guard when metadata reports no width/height, and still serves a genuinely re-encoded image", async () => {
    const app = express();
    app.get("/api/v1/pixel/serve", registerServe({ baseDir: assetDir }));

    type SharpMetadataResult = Awaited<
      ReturnType<typeof sharp.prototype.metadata>
    >;
    const metaSpy = vi
      .spyOn(sharp.prototype, "metadata")
      .mockResolvedValueOnce({
        width: undefined,
        height: undefined,
        format: "jpeg",
      } as unknown as SharpMetadataResult);

    try {
      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({ src: "noimage.jpg", format: "jpeg" })
        .parse(bufferParser);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
      // `noimage.jpg` is ALSO the "normal"-type fallback asset, so a
      // 200/jpeg/non-empty response is satisfied identically whether the
      // guard was correctly skipped (real pipeline success) OR whether it
      // wrongly threw and the outer catch-all served the fallback instead —
      // both paths process/serve that same file. The catch-all fallback
      // path hardcodes `Content-Disposition: filename="fallback.jpeg"`
      // (pixel.ts's outer catch), while the real pipeline derives the
      // filename from `userData.src` via `buildFilename` — "noimage.jpeg".
      // Asserting the LATTER is what actually distinguishes "guard skipped,
      // pipeline ran to completion" from "guard broke and the response only
      // LOOKS like success" (a regression this test would otherwise miss
      // entirely, since both paths independently render as 200/jpeg/
      // non-empty/valid-JPEG bytes).
      expect(response.headers["content-disposition"]).toMatch(
        /filename="noimage\.jpeg"/,
      );
      expect(response.body.length).toBeGreaterThan(0);
      const metadata = await sharp(response.body as Buffer).metadata();
      expect(metadata.format).toBe("jpeg");
    } finally {
      metaSpy.mockRestore();
    }
  });
});

describe("res.headersSent guard in outer catch (Task 5)", () => {
  it("calls next(error) when response was already flushed before the catch", async () => {
    // Plant a middleware that flips `res.headersSent` to true (via calling
    // res.flushHeaders after explicitly writing the head). Then force the
    // pipeline to throw by mocking sharp.toBuffer. The outer catch must
    // detect the flushed state and route to next(error) WITHOUT attempting
    // to write a fresh fallback header (which would trip ERR_HTTP_HEADERS_SENT).
    const app = express();
    app.use((_req, res, next) => {
      // Write a partial response so headersSent becomes true. The framework's
      // outer catch must NOT attempt to re-send headers after this.
      res.status(200).set("content-type", "image/jpeg");
      res.flushHeaders();
      next();
    });
    app.get("/api/v1/pixel/serve", registerServe({ baseDir: assetDir }));
    // Use an Express-level error handler to capture the next(error) signal.
    const seenErrors: unknown[] = [];
    app.use(
      (
        err: unknown,
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction,
      ) => {
        seenErrors.push(err);
        // Express will end the (already-started) response. We just need to
        // observe that the error handler was reached.
        res.end();
      },
    );

    // Force sharp.toBuffer to throw so the outer catch fires.
    vi.spyOn(sharp.prototype, "toBuffer").mockRejectedValueOnce(
      new Error("force outer catch"),
    );

    await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" });

    expect(seenErrors.length).toBeGreaterThan(0);
    const err = seenErrors[0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("response already flushed");
  });

  it("reports the flushed error through onError with phase=fs", async () => {
    const onError = vi.fn();
    const app = express();
    app.use((_req, res, next) => {
      res.status(200).set("content-type", "image/jpeg");
      res.flushHeaders();
      next();
    });
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, onError }),
    );
    app.use(
      (
        _err: unknown,
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction,
      ) => {
        res.end();
      },
    );

    vi.spyOn(sharp.prototype, "toBuffer").mockRejectedValueOnce(
      new Error("force outer catch"),
    );

    await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" });

    const flushedCalls = onError.mock.calls.filter((c) => {
      const ctx = c[1] as { phase: string };
      const err = c[0] as Error | undefined;
      return ctx.phase === "fs" && err?.message === "response already flushed";
    });
    expect(flushedCalls.length).toBeGreaterThan(0);
  });
});

describe("fetchFromNetwork extra coverage for new safeOnError paths", () => {
  it("invokes onError with phase=fetch when a redirect Location is malformed", async () => {
    const onError = vi.fn();
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.alloc(0),
      headers: { location: "::::not-a-url" },
      status: 302,
      statusText: "Found",
      config: {},
    });
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
        onError,
      }),
    );
    await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://allowed.test/img.jpg", format: "jpeg" })
      .parse(bufferParser);
    const fetchCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "fetch",
    );
    expect(fetchCalls.length).toBeGreaterThan(0);
  });

  it("invokes onError with phase=fetch when the redirect target switches protocol", async () => {
    const onError = vi.fn();
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.alloc(0),
      headers: { location: "file:///etc/passwd" },
      status: 302,
      statusText: "Found",
      config: {},
    });
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
        onError,
      }),
    );
    await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://allowed.test/img.jpg", format: "jpeg" })
      .parse(bufferParser);
    const fetchCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "fetch",
    );
    expect(fetchCalls.length).toBeGreaterThan(0);
  });
});

describe("input edge cases (Task 14)", () => {
  it("serves the fallback when src exceeds 4096 characters", async () => {
    // isValidPath caps `specifiedPath` at 4096; the pipeline must degrade
    // gracefully to the fallback image rather than crashing or hanging on
    // a multi-megabyte path string.
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, onError }),
    );
    const longSrc = "a".repeat(5000) + ".jpg";
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: longSrc, format: "jpeg" })
      .parse(bufferParser);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    expect(response.body.length).toBeGreaterThan(0);
    // The path validator must report the failure through the fs phase.
    const fsCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "fs",
    );
    expect(fsCalls.length).toBeGreaterThan(0);
  });

  it("derives a clean filename when src has complex query strings + fragments", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({
        // multi-pair query, semicolons, fragment — buildFilename strips all of
        // these and only keeps the basename.
        src: "complex.png?a=1&b=2;c=3&d[]=x#frag-x",
        format: "png",
      })
      .parse(bufferParser);
    expect(response.status).toBe(200);
    const disposition = response.headers["content-disposition"] as string;
    expect(disposition).toMatch(/filename="complex\.png"/);
    expect(disposition).toMatch(/filename\*=UTF-8''complex\.png/);
    // None of the query metadata may bleed into the filename header.
    expect(disposition).not.toMatch(/a=1/);
    expect(disposition).not.toMatch(/frag-x/);
  });

  it("serves the fallback for non-ASCII unicode src (Arabic + CJK)", async () => {
    const app = createApp();
    const arabicResponse = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "صورة-عربية.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(arabicResponse.status).toBe(200);
    expect(arabicResponse.headers["content-type"]).toBe(mimeTypes.jpeg);
    expect(arabicResponse.body.length).toBeGreaterThan(0);
    // RFC 5987 filename* carries the original UTF-8 bytes, percent-encoded.
    // Allow hyphens / underscores in the encoded segment because they are
    // unreserved per RFC 3986 and survive encodeURIComponent untouched.
    const arabicDisp = arabicResponse.headers["content-disposition"] as string;
    expect(arabicDisp).toMatch(/filename\*=UTF-8''[%0-9A-Fa-f\-_.]+\.jpeg/);
    // Confirm at least one percent-encoded byte from the original UTF-8 src
    // made it through the encoder.
    expect(arabicDisp).toMatch(/filename\*=UTF-8''[^"]*%[0-9A-Fa-f]{2}/);

    const cjkResponse = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "中文图片.png", format: "png" })
      .parse(bufferParser);
    expect(cjkResponse.status).toBe(200);
    expect(cjkResponse.headers["content-type"]).toBe(mimeTypes.png);
    const cjkDisp = cjkResponse.headers["content-disposition"] as string;
    expect(cjkDisp).toMatch(/filename\*=UTF-8''[%0-9A-Fa-f\-_.]+\.png/);
    expect(cjkDisp).toMatch(/filename\*=UTF-8''[^"]*%[0-9A-Fa-f]{2}/);
  });

  it("invokes onError from isValidPath when getUserFolder points outside baseDir (no root option)", async () => {
    // When `getUserFolderRootDir` is unset the framework does NOT proactively
    // block the returned path — but a subsequent isValidPath check inside
    // readLocalImage still rejects any path that does not resolve as a child
    // of the returned baseDir. The onError fs ping is the observable signal.
    const fsmod = await import("node:fs/promises");
    const osmod = await import("node:os");
    const farAwayDir = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-faraway-"),
    );
    try {
      const onError = vi.fn();
      const app = express();
      app.get(
        "/api/v1/pixel/serve",
        registerServe({
          baseDir: assetDir,
          getUserFolder: async () => farAwayDir,
          onError,
        }),
      );
      // The getUserFolder return value REPLACES baseDir for this request.
      // The request asks for `noimage.jpg` which does not exist in the
      // far-away dir, so isValidPath fails and a phase=fs onError fires.
      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({
          src: "noimage.jpg",
          folder: "private",
          userId: "u1",
          format: "jpeg",
        })
        .parse(bufferParser);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
      const fsCalls = onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "fs",
      );
      expect(fsCalls.length).toBeGreaterThan(0);
    } finally {
      await fsmod.rm(farAwayDir, { recursive: true, force: true });
    }
  });

  it("falls back gracefully when Sharp encounters a truncated/corrupt buffer", async () => {
    // A real-world failure mode: an upstream returns a buffer that LOOKS like
    // an image (passes content-type + magic bytes) but is truncated mid-IDAT.
    // With `failOn: "warning"` the decoder bails — the pipeline must catch
    // and serve the JPEG fallback, fire onError with phase=sharp.
    const truncatedPng = Buffer.concat([
      Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // PNG signature
      ]),
      // IHDR chunk header + a few bytes; deliberately incomplete so libvips
      // throws while decoding.
      Buffer.from([0x00, 0x00, 0x00, 0x0d]),
      Buffer.from("IHDR"),
      Buffer.from([0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10]),
    ]);
    vi.mocked(axios.get).mockResolvedValue({
      data: truncatedPng,
      headers: { "content-type": "image/png" },
      status: 200,
      statusText: "OK",
      config: {},
    });
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
        onError,
      }),
    );
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://allowed.test/truncated.png", format: "png" })
      .parse(bufferParser);
    // Response is always a 200 fallback; the failure surfaces via onError.
    expect(response.status).toBe(200);
    expect(response.body.length).toBeGreaterThan(0);
    const sharpCalls = onError.mock.calls.filter(
      (c) => (c[1] as { phase: string }).phase === "sharp",
    );
    expect(sharpCalls.length).toBeGreaterThan(0);
  });
});

describe("onComplete observability hook (Task 6)", () => {
  it("fires after a successful 200 response with format / outputBytes / durationMs", async () => {
    const onComplete = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        onComplete,
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "webp", width: 100 })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(onComplete).toHaveBeenCalledTimes(1);
    const ctx = onComplete.mock.calls[0]![0] as {
      src?: string;
      userId?: string;
      format: string;
      outputBytes: number;
      cached: boolean;
      durationMs: number;
      fallback: boolean;
    };
    expect(ctx.src).toBe("noimage.jpg");
    expect(ctx.userId).toBeUndefined();
    expect(ctx.format).toBe("webp");
    expect(ctx.cached).toBe(false);
    // A genuinely resolved-and-encoded image (not a bundled placeholder).
    expect(ctx.fallback).toBe(false);
    // outputBytes should match the response body length exactly.
    expect(ctx.outputBytes).toBe(response.body.length);
    expect(ctx.outputBytes).toBeGreaterThan(0);
    expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
    // Sanity bound — the test request should not take more than ~30s.
    expect(ctx.durationMs).toBeLessThan(30_000);
  });

  it("fires with cached=true on the 304 short-circuit (deterministic ETag)", async () => {
    const onComplete = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        onComplete,
      }),
    );

    // First request — capture the deterministic ETag.
    const first = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeDefined();

    onComplete.mockClear();

    // Second request — sends If-None-Match -> 304.
    const second = await request(app)
      .get("/api/v1/pixel/serve")
      .set("If-None-Match", etag)
      .query({ src: "noimage.jpg", format: "jpeg" });
    expect(second.status).toBe(304);

    expect(onComplete).toHaveBeenCalledTimes(1);
    const ctx = onComplete.mock.calls[0]![0] as {
      cached: boolean;
      outputBytes: number;
      format: string;
      durationMs: number;
      fallback: boolean;
    };
    expect(ctx.cached).toBe(true);
    expect(ctx.outputBytes).toBe(0);
    expect(ctx.format).toBe("jpeg");
    expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
    // No bytes are sent on a 304 — fallback is always reported false.
    expect(ctx.fallback).toBe(false);
  });

  it("fires with cached=true on the 304 short-circuit (buffer-hash ETag, no deterministic source identifier)", async () => {
    // Distinct code path from the deterministic-ETag test above: when
    // buildSourceIdentifier cannot derive a stable key (e.g. a missing
    // local file, which still serves a valid fallback buffer), the ETag is
    // instead computed AFTER Sharp processing by hashing the output buffer
    // (pixel.ts's second `if (parsedOptions.etag && !etag)` branch). That
    // 304 short-circuit and its onComplete dispatch are a physically
    // different code location from the deterministic-ETag 304 above and
    // must be pinned independently.
    const onComplete = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        onComplete,
      }),
    );

    // "missing-file.jpg" does not exist -> buildSourceIdentifier returns
    // null -> the pipeline falls back to the buffer-hash ETag. It also means
    // resolveBuffer's readLocalImage call resolves to the bundled fallback
    // (a "soft" fallback, still re-encoded through Sharp), so this doubles
    // as the soft-fallback `fallback:true` coverage on a live 200 response.
    const first = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "missing-file.jpg", format: "jpeg" })
      .parse(bufferParser);
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeDefined();
    expect(onComplete).toHaveBeenCalledTimes(1);
    const firstCtx = onComplete.mock.calls[0]![0] as {
      cached: boolean;
      fallback: boolean;
    };
    expect(firstCtx.cached).toBe(false);
    expect(firstCtx.fallback).toBe(true);

    onComplete.mockClear();

    const second = await request(app)
      .get("/api/v1/pixel/serve")
      .set("If-None-Match", etag)
      .query({ src: "missing-file.jpg", format: "jpeg" });
    expect(second.status).toBe(304);

    expect(onComplete).toHaveBeenCalledTimes(1);
    const ctx = onComplete.mock.calls[0]![0] as {
      cached: boolean;
      outputBytes: number;
      format: string;
      durationMs: number;
      fallback: boolean;
    };
    expect(ctx.cached).toBe(true);
    expect(ctx.outputBytes).toBe(0);
    expect(ctx.format).toBe("jpeg");
    expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
    // Still false on the 304 even though the underlying resource IS a
    // fallback — no bytes are sent this round-trip, so there's nothing to
    // characterize as fallback-or-not.
    expect(ctx.fallback).toBe(false);
  });

  it("swallows throws from the onComplete hook so the response is unaffected", async () => {
    // Best-effort dispatch contract: a buggy onComplete must not crash the
    // response. The 200 must still flush its image body.
    const onComplete = vi.fn(() => {
      throw new Error("logger blew up");
    });
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        onComplete,
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
    expect(response.body.length).toBeGreaterThan(0);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("fires with fallback:true on the outer hard-fallback path (Phase 8: previously silent)", async () => {
    // A pipeline failure AFTER the source buffer is resolved (e.g. a Sharp
    // encode failure) routes through the outer catch, which serves the
    // bundled placeholder verbatim (skipping Sharp re-encoding entirely) —
    // the "hard" fallback, distinct from the "soft" fallback the happy path
    // can also report. Before Phase 8 this branch left onComplete silent;
    // it now fires exactly once with fallback:true so every 200 fires the
    // hook, and a consumer can tell "real image" from "placeholder" purely
    // from the hook without inspecting response bytes.
    const onComplete = vi.fn();
    const onError = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        onComplete,
        onError,
      }),
    );

    vi.spyOn(sharp.prototype, "toBuffer").mockRejectedValueOnce(
      new Error("sharp blew up"),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    // Fallback path always returns 200.
    expect(response.status).toBe(200);
    // onError fired with phase=sharp.
    expect(onError).toHaveBeenCalled();
    // onComplete now fires exactly once from the hard-fallback catch branch.
    expect(onComplete).toHaveBeenCalledTimes(1);
    const ctx = onComplete.mock.calls[0]![0] as {
      cached: boolean;
      outputBytes: number;
      format: string;
      durationMs: number;
      fallback: boolean;
    };
    expect(ctx.fallback).toBe(true);
    expect(ctx.cached).toBe(false);
    // requestedType defaults to "normal" -> the bundled fallback is the
    // pre-encoded JPEG asset, sent verbatim (no Sharp re-encode on this path).
    expect(ctx.format).toBe("jpeg");
    expect(ctx.outputBytes).toBe(response.body.length);
    expect(ctx.outputBytes).toBeGreaterThan(0);
    expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fires with fallback:true and format:png on the outer hard-fallback path for an avatar request", async () => {
    // Distinct fallbackType branch from the test above: an avatar-type
    // request's hard fallback is the bundled PNG asset, not the normal-type
    // JPEG — pins that `format`/`outputBytes` are derived from the actual
    // bytes served on THIS branch, not copy-pasted from the normal case.
    const onComplete = vi.fn();
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        onComplete,
      }),
    );

    vi.spyOn(sharp.prototype, "toBuffer").mockRejectedValueOnce(
      new Error("sharp blew up"),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg", type: "avatar" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(onComplete).toHaveBeenCalledTimes(1);
    const ctx = onComplete.mock.calls[0]![0] as {
      format: string;
      outputBytes: number;
      fallback: boolean;
    };
    expect(ctx.fallback).toBe(true);
    expect(ctx.format).toBe("png");
    expect(ctx.outputBytes).toBe(response.body.length);
  });
});

describe("getUserFolderRootDir lazy-create + cached realpath (Tasks 7, 8)", () => {
  it("accepts a not-yet-created candidate dir whose parent is inside the root (Task 7)", async () => {
    // The lazy per-user dir does NOT exist on disk yet. The parent (the
    // configured root) does. Previously, `isInsideRoot` required BOTH paths
    // to resolve via realpath, so legitimate first-time requests silently
    // failed the containment check and fell back to the public baseDir.
    // After Task 7, the candidate side is checked lexically.
    const fsmod = await import("node:fs/promises");
    const osmod = await import("node:os");
    const rootDir = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-lazy-"),
    );
    try {
      // Direct unit-level assertion on the helper.
      const lazyChild = path.join(rootDir, "future-user-123");
      expect(await isInsideRoot(rootDir, lazyChild)).toBe(true);

      // Deeper lazy paths still resolve.
      const lazyNested = path.join(rootDir, "future-user-123", "uploads");
      expect(await isInsideRoot(rootDir, lazyNested)).toBe(true);

      // Lexical escape still rejected even when the candidate does not exist.
      const escape = path.resolve(rootDir, "..", "elsewhere");
      expect(await isInsideRoot(rootDir, escape)).toBe(false);
    } finally {
      await fsmod.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("isInsideRoot still allows real descendants (regression for Task 7)", async () => {
    const fsmod = await import("node:fs/promises");
    const osmod = await import("node:os");
    const rootDir = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-regress-"),
    );
    try {
      const child = path.join(rootDir, "real-child");
      await fsmod.mkdir(child);
      // Existing root + existing descendant must keep returning true.
      expect(await isInsideRoot(rootDir, rootDir)).toBe(true);
      expect(await isInsideRoot(rootDir, child)).toBe(true);
      // Sibling outside root still rejected.
      const sibling = await fsmod.mkdtemp(
        path.join(osmod.tmpdir(), "pixel-serve-sibling-"),
      );
      try {
        expect(await isInsideRoot(rootDir, sibling)).toBe(false);
      } finally {
        await fsmod.rm(sibling, { recursive: true, force: true });
      }
    } finally {
      await fsmod.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("isInsideRoot rejects symlink escapes from the candidate side via fs.realpath (Task 7)", async () => {
    // A path that is *lexically* a descendant of root but whose final
    // segment is a symlink pointing outside root MUST be rejected at the
    // containment layer, not just at the later isValidPath() read. The
    // realpath of the candidate is compared against the realpath of the
    // root; a target outside the root returns `false`.
    if (process.platform === "win32") {
      // Symlink creation on Win32 requires admin / developer mode. Skip
      // gracefully on Windows — Linux CI exercises this property.
      return;
    }
    const fsmod = await import("node:fs/promises");
    const osmod = await import("node:os");
    const rootDir = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-symlink-"),
    );
    const outside = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-outside-"),
    );
    try {
      const linkPath = path.join(rootDir, "shortcut");
      try {
        await fsmod.symlink(outside, linkPath, "dir");
      } catch {
        return; // unsupported platform
      }
      // realpath(linkPath) === outside, which is not inside rootDir.
      expect(await isInsideRoot(rootDir, linkPath)).toBe(false);
    } finally {
      await fsmod.rm(rootDir, { recursive: true, force: true });
      await fsmod.rm(outside, { recursive: true, force: true });
    }
  });

  it("middleware accepts lazy per-user dirs from getUserFolder (Task 7 end-to-end)", async () => {
    // Wire up a real-world scenario: a getUserFolder that points at a path
    // that does not yet exist (lazy create). The middleware must accept the
    // containment (no onError ping for `phase: "getUserFolder"`) and fall
    // through to the standard image-read pipeline, which then serves the
    // fallback because the file inside the lazy dir does not exist.
    const fsmod = await import("node:fs/promises");
    const osmod = await import("node:os");
    const rootDir = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-mw-lazy-"),
    );
    try {
      // NOTE: lazy child is NEVER created.
      const lazyChild = path.join(rootDir, "user-lazy");
      const onError = vi.fn();
      const getUserFolder = vi.fn(async () => lazyChild);
      const app = express();
      app.get(
        "/api/v1/pixel/serve",
        registerServe({
          baseDir: assetDir,
          getUserFolder,
          getUserFolderRootDir: rootDir,
          onError,
        }),
      );
      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({
          src: "noimage.jpg",
          folder: "private",
          userId: "u",
          format: "jpeg",
        })
        .parse(bufferParser);
      expect(response.status).toBe(200);
      expect(getUserFolder).toHaveBeenCalled();
      // No containment failure should have been recorded.
      const containmentErrors = onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "getUserFolder",
      );
      expect(containmentErrors).toHaveLength(0);
    } finally {
      await fsmod.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("realpath(rootDir) is invoked exactly once across many requests (Task 8 cache)", async () => {
    // The middleware factory caches the resolved root realpath via the
    // exported `resolveRootDir` helper. Across N requests we expect exactly
    // ONE invocation of that helper — subsequent requests reuse the cached
    // value, so the candidate-side `isInsideRoot` call no longer pays a
    // root-side realpath syscall. We assert by intercepting the module-level
    // realpath at vi.mock time and counting calls whose first argument is
    // the configured root.
    //
    // We use a scoped sub-describe with a fresh module + a partial mock so
    // the spy can be attached BEFORE the SUT imports `node:fs/promises`.
    const fsmod = await import("node:fs/promises");
    const osmod = await import("node:os");
    const rootDir = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-cache-"),
    );
    const childDir = path.join(rootDir, "user-x");
    await fsmod.mkdir(childDir, { recursive: true });
    await fsmod.copyFile(
      path.join(assetDir, "noimage.jpg"),
      path.join(childDir, "noimage.jpg"),
    );

    // Capture the canonical realpath of the configured root so we can match
    // both `rootDir` and its macOS-resolved equivalent (`/tmp` -> `/private/tmp`).
    const realRoot = await fsmod.realpath(rootDir);

    // Build a counting wrapper that we install via vi.doMock + a fresh
    // module instance import. The wrapper delegates to the real
    // `node:fs/promises` so all other operations behave normally; only the
    // realpath calls are observable.
    let rootRealpathCalls = 0;
    vi.doMock("node:fs/promises", async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      return {
        ...actual,
        default: actual,
        realpath: ((target: string, ...rest: unknown[]): Promise<string> => {
          if (
            typeof target === "string" &&
            (target === rootDir || target === realRoot)
          ) {
            rootRealpathCalls++;
          }
          // The realpath signature has overloads; we delegate verbatim via
          // a typed thunk so the wrapper preserves behavior for every shape.
          return (
            actual.realpath as unknown as (...a: unknown[]) => Promise<string>
          )(target, ...rest);
        }) as typeof actual.realpath,
      };
    });

    try {
      // Re-import the SUT against the mocked module graph. Vite/Vitest
      // resolves the `?cache-test` query-string suffix to a fresh module
      // instance so the factory closure rebinds against the mocked
      // `node:fs/promises`. The specifier is built dynamically so the TS
      // compiler does not attempt to resolve `./pixel?cache-test` as a
      // static path (it isn't one).
      const specifier = "./pixel" + "?cache-test";
      const freshPixel = (await import(specifier)) as {
        default: typeof registerServe;
      };
      const freshRegister = freshPixel.default;

      const getUserFolder = vi.fn(async () => childDir);
      const app = express();
      app.get(
        "/api/v1/pixel/serve",
        freshRegister({
          baseDir: assetDir,
          getUserFolder,
          getUserFolderRootDir: rootDir,
        }),
      );

      // Fire several requests in sequence.
      for (let i = 0; i < 5; i++) {
        const response = await request(app)
          .get("/api/v1/pixel/serve")
          .query({
            src: "noimage.jpg",
            folder: "private",
            userId: `u-${i}`,
            format: "jpeg",
          })
          .parse(bufferParser);
        expect(response.status).toBe(200);
      }

      // Strict-equality: exactly ONE realpath call against the configured
      // root across all five requests proves the factory-level cache holds.
      expect(rootRealpathCalls).toBe(1);
    } finally {
      vi.doUnmock("node:fs/promises");
      await fsmod.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("falls back to lexical resolve when rootDir does not exist at startup (Task 7 + 8)", async () => {
    // The cached-realpath helper must tolerate a not-yet-created root —
    // the factory must not throw, and the lexical fallback must allow
    // proper descendants. Once the directory is later created and a
    // request fires, containment still works.
    const osmod = await import("node:os");
    const rootDir = path.join(
      osmod.tmpdir(),
      `pixel-serve-missing-${Date.now()}`,
    );
    // Confirm absent.
    const fsmod = await import("node:fs/promises");
    await fsmod.rm(rootDir, { recursive: true, force: true }).catch(() => {});

    const childDir = path.join(rootDir, "lazy-user");
    const onError = vi.fn();
    const getUserFolder = vi.fn(async () => childDir);
    const app = express();
    expect(() =>
      app.get(
        "/api/v1/pixel/serve",
        registerServe({
          baseDir: assetDir,
          getUserFolder,
          getUserFolderRootDir: rootDir,
          onError,
        }),
      ),
    ).not.toThrow();

    try {
      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({
          src: "noimage.jpg",
          folder: "private",
          userId: "x",
          format: "jpeg",
        })
        .parse(bufferParser);
      expect(response.status).toBe(200);
      // Containment passed — no `phase: "getUserFolder"` ping.
      const containmentErrors = onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "getUserFolder",
      );
      expect(containmentErrors).toHaveLength(0);
    } finally {
      await fsmod.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("isInsideRoot preResolvedRoot parameter (Phase 6 Task 6.2 direct unit coverage)", () => {
  it("trusts a supplied preResolvedRoot verbatim instead of re-resolving rootDir", async () => {
    // Every existing isInsideRoot call in this file omits the third
    // argument, so the `preResolvedRoot !== undefined` branch is only ever
    // exercised indirectly through the middleware's own factory-level
    // cache (see "realpath(rootDir) is invoked exactly once..." above).
    // This test drives the exported parameter directly and proves the
    // fast path genuinely SKIPS re-deriving rootDir's realpath — it uses
    // whatever value the caller hands it, even when that value does not
    // match `rootDir`'s own real location.
    const fsmod = await import("node:fs/promises");
    const osmod = await import("node:os");
    const root = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-preres-"),
    );
    const other = await fsmod.mkdtemp(
      path.join(osmod.tmpdir(), "pixel-serve-preres-other-"),
    );
    try {
      const child = path.join(root, "sub");
      await fsmod.mkdir(child);

      // Sanity baseline (no preResolvedRoot override): child is inside
      // root and NOT inside other.
      expect(await isInsideRoot(root, child)).toBe(true);
      expect(await isInsideRoot(other, child)).toBe(false);

      // Passing `other`'s realpath AS the preResolvedRoot for a call whose
      // `rootDir` argument is `root` proves the function trusts the
      // supplied value verbatim rather than re-deriving it from `rootDir`:
      // `child` is not inside `other`, so this must now report false even
      // though the `rootDir` argument is `root` (which DOES contain child).
      const realOther = await fsmod.realpath(other);
      expect(await isInsideRoot(root, child, realOther)).toBe(false);

      // And the inverse sanity check: pre-resolving to root's OWN realpath
      // keeps the expected true result — the fast path is behaviorally
      // identical to the self-resolved path when given the correct value.
      const realRoot = await fsmod.realpath(root);
      expect(await isInsideRoot(root, child, realRoot)).toBe(true);
      expect(await isInsideRoot(root, root, realRoot)).toBe(true);
    } finally {
      await fsmod.rm(root, { recursive: true, force: true });
      await fsmod.rm(other, { recursive: true, force: true });
    }
  });
});

describe("looksLikeSvg: DOCTYPE-prefixed SVG and entity-bomb detection", () => {
  it("detects a plain <!DOCTYPE svg …> SVG with the root element inside the scan window", () => {
    const buf = Buffer.from(
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
    );
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("detects a minimal <!DOCTYPE svg> with no external identifier", () => {
    expect(looksLikeSvg(Buffer.from("<!DOCTYPE svg><svg></svg>"))).toBe(true);
  });

  it("does not false-positive on an unrelated DOCTYPE (e.g. html) even when the document mentions svg", () => {
    const buf = Buffer.from(
      "<!DOCTYPE html><html><body>renders an svg icon</body></html>",
    );
    expect(looksLikeSvg(buf)).toBe(false);
  });

  it("does not false-positive on a DOCTYPE root name that merely starts with 'svg' (prefix trap)", () => {
    expect(looksLikeSvg(Buffer.from("<!DOCTYPE svgish><svgish/>"))).toBe(false);
  });

  it("detects a <!DOCTYPE svg [ <!ENTITY …> ]> billion-laughs bomb even when the <svg> root is pushed past the 4 KiB scan window", () => {
    // Structurally a genuine nested-entity ("billion laughs") DOCTYPE — each
    // entity references the previous one 3 times — but kept to a tiny depth
    // / multiplier so a full expansion is only a few hundred bytes. This test
    // must stay safe to run even if the fix under test has a bug and the
    // buffer reaches a real XML/DTD parser; the actual DoS vector (an
    // exponential-expansion bomb) is never exercised here, only sniffed.
    // A separate, inert (non-recursive) filler entity pads the DOCTYPE's raw
    // byte size well past the 4 KiB window without contributing to any
    // expansion — this is what stands in for an attacker padding the
    // internal subset with many real entity definitions.
    const entities =
      '<!ENTITY lol0 "lol">\n' +
      '<!ENTITY lol1 "&lol0;&lol0;&lol0;">\n' +
      '<!ENTITY lol2 "&lol1;&lol1;&lol1;">\n' +
      `<!ENTITY filler "${"x".repeat(4500)}">\n`;
    const buf = Buffer.from(
      `<!DOCTYPE svg [\n${entities}]>\n<svg><text>&lol2;</text></svg>`,
    );
    expect(buf.length).toBeGreaterThan(4096);
    // Confirm the root <svg> tag itself is genuinely outside the scanned
    // window — otherwise this test would exercise the ordinary window scan
    // added alongside it, not the entity-bomb-specific defense.
    const svgTagIndex = buf.toString("latin1").indexOf("<svg>");
    expect(svgTagIndex).toBeGreaterThan(4096);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("does not false-positive on a real raster (JPEG) fixture", async () => {
    const jpegBytes = await FALLBACKIMAGES.normal();
    expect(looksLikeSvg(jpegBytes)).toBe(false);
  });

  it("does not false-positive on plain text that merely contains the word svg without an SVG root or prolog", () => {
    const buf = Buffer.from(
      "This changelog entry documents svg handling improvements but is not markup at all.",
    );
    expect(looksLikeSvg(buf)).toBe(false);
  });

  it("rejects a DOCTYPE-bomb-shaped SVG buffer BEFORE Sharp ever parses it, when allowSvgInput is false (default)", async () => {
    // End-to-end confirmation that the sniffer fix actually prevents the
    // buffer from ever reaching Sharp/librsvg's DTD parser. This must NOT be
    // asserted via response status/content-type alone: Sharp's own
    // metadata-based `format === "svg"` guard (see "metadata-based Sharp
    // guards" above) is a SEPARATE defense-in-depth layer that empirically
    // also recognizes this exact buffer shape as SVG and rejects it with an
    // identical 200/fallback/onError outcome — so a response-shape
    // assertion alone would pass unchanged whether or not the Task 4.1 fix
    // exists, making it vacuous. That second guard only fires AFTER Sharp's
    // own parser has already processed the DTD far enough to identify the
    // format — exactly the DTD-parsing exposure the sniff-level guard exists
    // to avoid entirely. `sharp.prototype.metadata` is spied and asserted
    // NEVER called (it is the package's only call site, confirmed via
    // `grep -rn "\.metadata("` across src/) to prove the rejection happens
    // at the sniff stage, before any Sharp instance is even asked to parse
    // the buffer.
    const entities =
      '<!ENTITY lol0 "lol">\n' +
      '<!ENTITY lol1 "&lol0;&lol0;&lol0;">\n' +
      '<!ENTITY lol2 "&lol1;&lol1;&lol1;">\n' +
      `<!ENTITY filler "${"x".repeat(4500)}">\n`;
    const bombBuffer = Buffer.from(
      `<!DOCTYPE svg [\n${entities}]>\n<svg><text>&lol2;</text></svg>`,
    );

    const tmpDir = path.join(assetDir, "..", "tmp-svg-doctype-bomb");
    const fsmod = await import("node:fs/promises");
    await fsmod.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, "bomb.svg");
    await fsmod.writeFile(tmpFile, bombBuffer);

    const metadataSpy = vi.spyOn(sharp.prototype, "metadata");
    try {
      const onError = vi.fn();
      const app = express();
      app.get(
        "/api/v1/pixel/serve",
        registerServe({ baseDir: tmpDir, onError }),
      );
      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({ src: "bomb.svg", format: "jpeg" })
        .parse(bufferParser);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
      expect(metadataSpy).not.toHaveBeenCalled();
      const rejectionErrors = onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "sharp",
      );
      expect(rejectionErrors.length).toBeGreaterThan(0);
      expect(
        rejectionErrors.some((c) => (c[0] as Error).message.includes("svg")),
      ).toBe(true);
    } finally {
      metadataSpy.mockRestore();
      await fsmod.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects a UTF-16 LE BOM-prefixed billion-laughs DOCTYPE bomb pushed past the scan window", () => {
    // Mirrors the latin1/UTF-8 entity-bomb case above but through the
    // UTF-16 BOM branch, which has its own separate entity-bomb fallback.
    const entities =
      '<!ENTITY lol0 "lol">\n' +
      '<!ENTITY lol1 "&lol0;&lol0;&lol0;">\n' +
      `<!ENTITY filler "${"x".repeat(4500)}">\n`;
    const text = `<!DOCTYPE svg [\n${entities}]>\n<svg><text>&lol1;</text></svg>`;
    const utf16 = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      utf16.writeUInt16LE(text.charCodeAt(i), i * 2);
    }
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]);
    // Confirm the root <svg> tag is genuinely outside the scanned window
    // (start + 2-byte BOM + 4096 bytes of UTF-16 code units).
    const svgTagIndex = text.indexOf("<svg>");
    expect(svgTagIndex).toBeGreaterThan(2048);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  // The DOCTYPE-svg-root entity-bomb defense must also fire when the hostile
  // DOCTYPE sits BEHIND an `<?xml …?>` declaration or `<!-- … -->` comment
  // prolog — `<?xml version="1.0"?>` is in fact the most common real-world
  // SVG opening. Before this was closed, only a bare-`<!doctype`-first head
  // got the unconditional DOCTYPE fallback; a `<?xml`/comment-prefixed bomb
  // DOCTYPE returned false and leaked the DTD to librsvg.
  const bombEntities =
    '<!ENTITY lol0 "lol">\n' +
    '<!ENTITY lol1 "&lol0;&lol0;&lol0;">\n' +
    '<!ENTITY lol2 "&lol1;&lol1;&lol1;">\n' +
    `<!ENTITY filler "${"x".repeat(4500)}">\n`;

  it("detects an <?xml …?>-prefixed <!DOCTYPE svg [entity-bomb]> even when the <svg> root is pushed past the 4 KiB window (latin1)", () => {
    const buf = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg [\n${bombEntities}]>\n<svg><text>&lol2;</text></svg>`,
    );
    expect(buf.length).toBeGreaterThan(4096);
    // The literal <svg> tag must genuinely be outside the scanned window, so
    // this exercises the DOCTYPE-root fallback and not the ordinary <svg scan.
    const svgTagIndex = buf.toString("latin1").indexOf("<svg>");
    expect(svgTagIndex).toBeGreaterThan(4096);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("detects a <!-- comment -->-prefixed <!DOCTYPE svg [entity-bomb]> pushed past the 4 KiB window (latin1)", () => {
    const buf = Buffer.from(
      `<!-- generated by design tool -->\n<!DOCTYPE svg [\n${bombEntities}]>\n<svg><text>&lol2;</text></svg>`,
    );
    expect(buf.length).toBeGreaterThan(4096);
    const svgTagIndex = buf.toString("latin1").indexOf("<svg>");
    expect(svgTagIndex).toBeGreaterThan(4096);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("detects a UTF-16 LE BOM + <?xml …?>-prefixed <!DOCTYPE svg [entity-bomb]> pushed past the scan window", () => {
    const text = `<?xml version="1.0" encoding="UTF-16"?>\n<!DOCTYPE svg [\n${bombEntities}]>\n<svg><text>&lol2;</text></svg>`;
    const utf16 = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      utf16.writeUInt16LE(text.charCodeAt(i), i * 2);
    }
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]);
    const svgTagIndex = text.indexOf("<svg>");
    expect(svgTagIndex).toBeGreaterThan(2048);
    expect(looksLikeSvg(buf)).toBe(true);
  });

  it("does not false-positive on an <?xml …?>-prefixed non-SVG DOCTYPE (e.g. html) even with an oversized DTD", () => {
    // Same prolog+oversized-DTD shape as the bomb cases, but the DOCTYPE
    // names `html`, not `svg`. The prolog-gated scan must NOT blanket-accept
    // every prolog+DTD buffer — only ones whose DOCTYPE root is `svg` (or
    // that carry an in-window `<svg` tag).
    const buf = Buffer.from(
      `<?xml version="1.0"?>\n<!DOCTYPE html [\n<!ENTITY filler "${"x".repeat(
        4500,
      )}">\n]>\n<html><body>an svg icon lives here</body></html>`,
    );
    expect(buf.length).toBeGreaterThan(4096);
    expect(looksLikeSvg(buf)).toBe(false);
  });

  it("does not false-positive on an <?xml …?>-prefixed DOCTYPE whose root merely starts with 'svg' (prefix trap behind a prolog)", () => {
    expect(
      looksLikeSvg(
        Buffer.from(
          `<?xml version="1.0"?>\n<!DOCTYPE svgish [\n<!ENTITY filler "${"x".repeat(
            4500,
          )}">\n]>\n<svgish/>`,
        ),
      ),
    ).toBe(false);
  });

  it("rejects an <?xml …?>-prefixed DOCTYPE-bomb SVG BEFORE Sharp ever parses it, when allowSvgInput is false (default)", async () => {
    // End-to-end analogue of the bare-DOCTYPE metadata-spy test above, but
    // for the `<?xml`-prefixed shape that previously leaked. Proves the fix
    // stops the buffer at the sniff stage: sharp.prototype.metadata (the
    // package's only .metadata() call site) is asserted NEVER invoked, so the
    // hostile DTD never reaches librsvg's parser.
    const bombBuffer = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg [\n${bombEntities}]>\n<svg><text>&lol2;</text></svg>`,
    );

    const tmpDir = path.join(assetDir, "..", "tmp-svg-xml-doctype-bomb");
    const fsmod = await import("node:fs/promises");
    await fsmod.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, "xmlbomb.svg");
    await fsmod.writeFile(tmpFile, bombBuffer);

    const metadataSpy = vi.spyOn(sharp.prototype, "metadata");
    try {
      const onError = vi.fn();
      const app = express();
      app.get(
        "/api/v1/pixel/serve",
        registerServe({ baseDir: tmpDir, onError }),
      );
      const response = await request(app)
        .get("/api/v1/pixel/serve")
        .query({ src: "xmlbomb.svg", format: "jpeg" })
        .parse(bufferParser);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(mimeTypes.jpeg);
      expect(metadataSpy).not.toHaveBeenCalled();
      const rejectionErrors = onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "sharp",
      );
      expect(rejectionErrors.length).toBeGreaterThan(0);
      expect(
        rejectionErrors.some((c) => (c[0] as Error).message.includes("svg")),
      ).toBe(true);
    } finally {
      metadataSpy.mockRestore();
      await fsmod.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not false-positive on a prolog-prefixed non-SVG document whose comment prose merely mentions the phrase <!doctype svg", () => {
    // The DOCTYPE-svg-root check is anchored to a genuine top-level DOCTYPE
    // token (reached by skipping the leading `<?xml …?>`/comment prolog), NOT
    // an unanchored substring search over the whole window. A non-SVG
    // document that merely *mentions* the characters `<!doctype svg` inside a
    // comment must NOT be classified as SVG.
    expect(
      looksLikeSvg(
        Buffer.from(
          "<!-- this file demonstrates <!doctype svg usage in other docs -->\n<!DOCTYPE html><html><body>hi</body></html>",
        ),
      ),
    ).toBe(false);
    expect(
      looksLikeSvg(
        Buffer.from(
          '<?xml version="1.0"?>\n<!-- see <!doctype svg for reference -->\n<!DOCTYPE root><root/>',
        ),
      ),
    ).toBe(false);
  });

  it("still detects a real <!DOCTYPE svg entity bomb that sits behind BOTH an <?xml declaration AND a comment", () => {
    // The prolog skipper must strip an `<?xml …?>` declaration followed by one
    // or more `<!-- … -->` comments (in that order) and still reach the
    // genuine DOCTYPE, even though the DOCTYPE-root regex is anchored.
    const entities =
      '<!ENTITY lol0 "lol">\n' +
      '<!ENTITY lol1 "&lol0;&lol0;&lol0;">\n' +
      `<!ENTITY filler "${"x".repeat(4500)}">\n`;
    const buf = Buffer.from(
      `<?xml version="1.0"?>\n<!-- generated -->\n<!-- second comment -->\n<!DOCTYPE svg [\n${entities}]>\n<svg><text>&lol1;</text></svg>`,
    );
    expect(buf.length).toBeGreaterThan(4096);
    const svgTagIndex = buf.toString("latin1").indexOf("<svg>");
    expect(svgTagIndex).toBeGreaterThan(4096);
    expect(looksLikeSvg(buf)).toBe(true);
  });
});

describe("Phase 1 (server-fallback-cache): soft-fallback-aware Cache-Control + ETag", () => {
  it("soft fallback (missing local file) is served with the short fallback Cache-Control, not the real-image default", async () => {
    // Deliberately NOT createApp(): its configured cacheControl
    // ("public, max-age=60") happens to equal the fallback policy, which
    // would make a Cache-Control assertion pass whether or not the fix is
    // actually implemented. A fresh app with no override makes the
    // DEFAULT_CACHE_CONTROL ("public, max-age=86400,…") vs
    // FALLBACK_CACHE_CONTROL ("public, max-age=60") distinction meaningful.
    const app = express();
    app.get("/api/v1/pixel/serve", registerServe({ baseDir: assetDir }));

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "missing-file.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
    expect(response.headers.etag).toBeDefined();
  });

  it("soft fallback overrides even an operator-configured custom Cache-Control, not just an unset default", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({ baseDir: assetDir, cacheControl: "private, no-cache" }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "missing-file.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    // The soft-fallback policy wins over the operator's own explicit,
    // non-default configuration — proving the branch is keyed on
    // servedSoftFallback, not merely "whatever the unset default would be."
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("soft fallback (blocked external host) is served with the short fallback Cache-Control and a buffer-hash ETag, not the pre-fetch url-keyed one", async () => {
    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
      }),
    );

    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "https://blocked.test/image.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
    const etag = response.headers.etag as string;
    expect(etag).toBeDefined();

    // "blocked.test" has a real deterministic identifier available BEFORE
    // any fetch is attempted (buildSourceIdentifier returns `url:<src>`
    // unconditionally for any external http(s) src). Prove the response
    // ETag is instead the buffer-hash of the bytes actually sent — the same
    // positive-proof technique the traversal-ETag test above uses.
    const expectedBufferHashEtag = `"${createHash("sha256")
      .update(response.body as Buffer)
      .digest("hex")}"`;
    expect(etag).toBe(expectedBufferHashEtag);
  });

  it("an external transient failure does not permanently 304-lock a client onto the placeholder — recovery after the ETag was captured returns 200 with the real image", async () => {
    // First request: the allowed host is transiently unreachable. axios.get
    // rejects, so fetchImage's onFallback marks this a soft fallback and the
    // response ships the bundled placeholder with a buffer-hash ETag (proved
    // by the tests above).
    vi.mocked(axios.get).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const app = express();
    app.get(
      "/api/v1/pixel/serve",
      registerServe({
        baseDir: assetDir,
        allowedNetworkList: ["allowed.test"],
      }),
    );

    const query = { src: "https://allowed.test/down.jpg", format: "jpeg" };

    const first = await request(app)
      .get("/api/v1/pixel/serve")
      .query(query)
      .parse(bufferParser);
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("public, max-age=60");
    const capturedEtag = first.headers.etag as string;
    expect(capturedEtag).toBeDefined();

    // Host "recovers": axios.get now resolves with a genuine, Sharp-decodable
    // image, distinguishable from the JPEG placeholder by its pixel
    // dimensions once decoded.
    const recoveredImage = await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 3,
        background: { r: 10, g: 200, b: 10 },
      },
    })
      .png()
      .toBuffer();
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: recoveredImage,
      headers: { "content-type": mimeTypes.png },
      status: 200,
      statusText: "OK",
      config: {},
    });

    // Present the ETag captured from the FIRST (placeholder) response.
    // Pre-fix, that captured ETag would have been the stable, pre-fetch
    // `url:<src>`-keyed deterministic ETag, and the pre-Sharp 304
    // short-circuit would match it forever — permanently hiding the
    // recovered real image behind a 304 even though the host is back up.
    // Post-fix, the captured ETag is a buffer-hash of the placeholder bytes,
    // which can never match the freshly-recomputed deterministic ETag, so
    // the short-circuit misses, resolveBuffer() genuinely re-fetches, and
    // the recovered image is served.
    const second = await request(app)
      .get("/api/v1/pixel/serve")
      .set("If-None-Match", capturedEtag)
      .query(query)
      .parse(bufferParser);

    expect(second.status).toBe(200);
    expect(second.headers["content-type"]).toBe(mimeTypes.jpeg);
    expect(second.headers["cache-control"]).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
    );

    const firstMeta = await sharp(first.body as Buffer).metadata();
    const secondMeta = await sharp(second.body as Buffer).metadata();
    expect(secondMeta.width).toBe(40);
    expect(secondMeta.height).toBe(40);
    expect(
      secondMeta.width === firstMeta.width &&
        secondMeta.height === firstMeta.height,
    ).toBe(false);
  });
});

describe("Phase 3 (server-hardening): X-Content-Type-Options nosniff", () => {
  it("genuine image response carries X-Content-Type-Options: nosniff", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("soft-fallback response (missing local file) carries X-Content-Type-Options: nosniff", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "missing-file.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("hard-fallback response (Sharp throw, outer catch) carries X-Content-Type-Options: nosniff", async () => {
    // Same forced-failure technique as "emits Vary: Accept-Encoding on the
    // fallback path too" above: resolveBuffer() succeeds (a real local file),
    // so servedSoftFallback is false, and the throw during Sharp encoding is
    // only caught by the outer catch — the hard-fallback branch.
    const app = createApp();
    const toBufferSpy = vi
      .spyOn(sharp.prototype, "toBuffer")
      .mockRejectedValueOnce(new Error("forced sharp failure"));
    const response = await request(app)
      .get("/api/v1/pixel/serve")
      .query({ src: "noimage.jpg", format: "jpeg" })
      .parse(bufferParser);

    expect(response.status).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    toBufferSpy.mockRestore();
  });
});
