import { describe, expect, it } from "vitest";
import {
  FALLBACKIMAGES,
  allowedFormats,
  mimeTypes,
  API_REGEX,
} from "./variables";

describe("variables", () => {
  describe("FALLBACKIMAGES", () => {
    it("returns buffer for normal fallback image", async () => {
      const buffer = await FALLBACKIMAGES.normal();
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(0);
    });

    it("returns buffer for avatar fallback image", async () => {
      const buffer = await FALLBACKIMAGES.avatar();
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(0);
    });
  });

  describe("allowedFormats", () => {
    it("includes all expected image formats", () => {
      expect(allowedFormats).toContain("jpeg");
      expect(allowedFormats).toContain("jpg");
      expect(allowedFormats).toContain("png");
      expect(allowedFormats).toContain("webp");
      expect(allowedFormats).toContain("gif");
      expect(allowedFormats).toContain("tiff");
      expect(allowedFormats).toContain("avif");
    });

    it("has exactly 7 formats", () => {
      expect(allowedFormats.length).toBe(7);
    });

    it("does not include svg (sharp cannot encode svg output)", () => {
      expect(allowedFormats).not.toContain("svg");
    });
  });

  describe("mimeTypes", () => {
    it("maps all formats to correct MIME types", () => {
      expect(mimeTypes.jpeg).toBe("image/jpeg");
      expect(mimeTypes.jpg).toBe("image/jpeg");
      expect(mimeTypes.png).toBe("image/png");
      expect(mimeTypes.webp).toBe("image/webp");
      expect(mimeTypes.gif).toBe("image/gif");
      expect(mimeTypes.tiff).toBe("image/tiff");
      expect(mimeTypes.avif).toBe("image/avif");
    });

    it("does not include svg mime mapping", () => {
      expect(mimeTypes.svg).toBeUndefined();
    });
  });

  describe("API_REGEX", () => {
    it("matches /api/v1/ prefix", () => {
      expect(API_REGEX.test("/api/v1/images")).toBe(true);
      expect(API_REGEX.test("/api/v1/")).toBe(true);
    });

    it("does not match other patterns", () => {
      expect(API_REGEX.test("/api/v2/images")).toBe(false);
      expect(API_REGEX.test("/images")).toBe(false);
      expect(API_REGEX.test("api/v1/")).toBe(false);
    });
  });
});
