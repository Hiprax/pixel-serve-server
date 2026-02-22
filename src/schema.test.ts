import { describe, expect, it } from "vitest";
import { optionsSchema, userDataSchema } from "./schema";

describe("userDataSchema", () => {
  it("validates minimal input with defaults", () => {
    const result = userDataSchema.parse({});
    expect(result.src).toBe("/placeholder/noimage.jpg");
    expect(result.folder).toBe("public");
    expect(result.type).toBe("normal");
    expect(result.quality).toBe(80);
  });

  it("validates complete input", () => {
    const result = userDataSchema.parse({
      src: "/image.jpg",
      format: "png",
      width: 800,
      height: 600,
      quality: 90,
      folder: "private",
      type: "avatar",
      userId: "user123",
    });

    expect(result.src).toBe("/image.jpg");
    expect(result.format).toBe("png");
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(result.quality).toBe(90);
    expect(result.folder).toBe("private");
    expect(result.type).toBe("avatar");
    expect(result.userId).toBe("user123");
  });

  it("transforms string dimensions to numbers", () => {
    const result = userDataSchema.parse({
      width: "500",
      height: "400",
      quality: "85",
    });

    expect(result.width).toBe(500);
    expect(result.height).toBe(400);
    expect(result.quality).toBe(85);
  });

  it("transforms format to lowercase", () => {
    const result = userDataSchema.parse({ format: "WEBP" });
    expect(result.format).toBe("webp");
  });

  it("returns undefined for invalid format", () => {
    const result = userDataSchema.parse({ format: "invalid" });
    expect(result.format).toBeUndefined();
  });

  it("trims and validates userId", () => {
    const result = userDataSchema.parse({ userId: "  test  " });
    expect(result.userId).toBe("test");
  });

  it("converts numeric userId to string", () => {
    const result = userDataSchema.parse({ userId: 12345 });
    expect(result.userId).toBe("12345");
  });

  it("rejects width below minimum", () => {
    expect(() => userDataSchema.parse({ width: 10 })).toThrow(
      "width too small"
    );
  });

  it("rejects width above maximum", () => {
    expect(() => userDataSchema.parse({ width: 5000 })).toThrow(
      "width too large"
    );
  });

  it("rejects height below minimum", () => {
    expect(() => userDataSchema.parse({ height: 10 })).toThrow(
      "height too small"
    );
  });

  it("rejects height above maximum", () => {
    expect(() => userDataSchema.parse({ height: 5000 })).toThrow(
      "height too large"
    );
  });

  it("rejects quality below minimum", () => {
    expect(() => userDataSchema.parse({ quality: 0 })).toThrow();
  });

  it("rejects quality above maximum", () => {
    expect(() => userDataSchema.parse({ quality: 101 })).toThrow();
  });

  it("rejects userId that is too long", () => {
    const longUserId = "a".repeat(129);
    expect(() => userDataSchema.parse({ userId: longUserId })).toThrow(
      "userId too long"
    );
  });

  it("rejects empty userId after trim", () => {
    expect(() => userDataSchema.parse({ userId: "   " })).toThrow(
      "userId cannot be empty"
    );
  });

  it("handles undefined values for optional fields", () => {
    const result = userDataSchema.parse({
      width: undefined,
      height: undefined,
      quality: undefined,
      userId: undefined,
    });

    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();
    expect(result.quality).toBe(80);
    expect(result.userId).toBeUndefined();
  });

  it("rejects null values for height (strict typing)", () => {
    expect(() => userDataSchema.parse({ height: null })).toThrow();
  });

  it("rejects unknown fields in strict mode", () => {
    expect(() => userDataSchema.parse({ unknownField: "value" })).toThrow();
  });
});

describe("optionsSchema", () => {
  it("validates minimal options with defaults", () => {
    const result = optionsSchema.parse({ baseDir: "/images" });
    expect(result.baseDir).toBe("/images");
    expect(result.minWidth).toBe(50);
    expect(result.maxWidth).toBe(4000);
    expect(result.minHeight).toBe(50);
    expect(result.maxHeight).toBe(4000);
    expect(result.defaultQuality).toBe(80);
    expect(result.requestTimeoutMs).toBe(5000);
    expect(result.maxDownloadBytes).toBe(5_000_000);
    expect(result.etag).toBe(true);
    expect(result.allowedNetworkList).toEqual([]);
  });

  it("validates complete options", () => {
    const idHandler = (id: string): string => `user-${id}`;
    const getUserFolder = async (): Promise<string> => "/private";

    const result = optionsSchema.parse({
      baseDir: "/custom",
      idHandler,
      getUserFolder,
      websiteURL: "example.com",
      apiRegex: /^\/api\//,
      allowedNetworkList: ["cdn.example.com", "images.example.com"],
      cacheControl: "private, max-age=3600",
      etag: false,
      minWidth: 100,
      maxWidth: 2000,
      minHeight: 100,
      maxHeight: 2000,
      defaultQuality: 90,
      requestTimeoutMs: 10000,
      maxDownloadBytes: 10_000_000,
    });

    expect(result.baseDir).toBe("/custom");
    expect(result.idHandler).toBe(idHandler);
    expect(result.getUserFolder).toBe(getUserFolder);
    expect(result.websiteURL).toBe("example.com");
    expect(result.apiRegex.source).toBe("^\\/api\\/");
    expect(result.allowedNetworkList).toEqual([
      "cdn.example.com",
      "images.example.com",
    ]);
    expect(result.cacheControl).toBe("private, max-age=3600");
    expect(result.etag).toBe(false);
  });

  it("rejects empty baseDir", () => {
    expect(() => optionsSchema.parse({ baseDir: "" })).toThrow(
      "baseDir is required"
    );
  });

  it("rejects missing baseDir", () => {
    expect(() => optionsSchema.parse({})).toThrow();
  });

  it("rejects non-function idHandler", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", idHandler: "not a function" })
    ).toThrow("idHandler must be a function");
  });

  it("rejects non-function getUserFolder", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        getUserFolder: "not a function",
      })
    ).toThrow("getUserFolder must be a function");
  });

  it("accepts URL format for websiteURL", () => {
    const result = optionsSchema.parse({
      baseDir: "/images",
      websiteURL: "https://example.com/path",
    });
    expect(result.websiteURL).toBe("https://example.com/path");
  });

  it("accepts domain-only format for websiteURL", () => {
    const result = optionsSchema.parse({
      baseDir: "/images",
      websiteURL: "example.com",
    });
    expect(result.websiteURL).toBe("example.com");
  });

  it("accepts domain with subdomain for websiteURL", () => {
    const result = optionsSchema.parse({
      baseDir: "/images",
      websiteURL: "www.example.com",
    });
    expect(result.websiteURL).toBe("www.example.com");
  });

  it("uses default API regex when not provided", () => {
    const result = optionsSchema.parse({ baseDir: "/images" });
    expect(result.apiRegex.source).toBe("^\\/api\\/v1\\/");
  });

  it("rejects unknown fields in strict mode", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", unknownField: "value" })
    ).toThrow();
  });

  it("validates numeric constraints", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", minWidth: 0 })
    ).toThrow();

    expect(() =>
      optionsSchema.parse({ baseDir: "/images", minWidth: -1 })
    ).toThrow();

    expect(() =>
      optionsSchema.parse({ baseDir: "/images", requestTimeoutMs: 0 })
    ).toThrow();

    expect(() =>
      optionsSchema.parse({ baseDir: "/images", maxDownloadBytes: 0 })
    ).toThrow();
  });

  it("validates quality range", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", defaultQuality: 0 })
    ).toThrow();

    expect(() =>
      optionsSchema.parse({ baseDir: "/images", defaultQuality: 101 })
    ).toThrow();
  });

  it("rejects minWidth greater than maxWidth", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        minWidth: 5000,
        maxWidth: 100,
      })
    ).toThrow("minWidth must be less than or equal to maxWidth");
  });

  it("rejects minHeight greater than maxHeight", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        minHeight: 5000,
        maxHeight: 100,
      })
    ).toThrow("minHeight must be less than or equal to maxHeight");
  });

  it("accepts minWidth equal to maxWidth", () => {
    const result = optionsSchema.parse({
      baseDir: "/images",
      minWidth: 500,
      maxWidth: 500,
    });
    expect(result.minWidth).toBe(500);
    expect(result.maxWidth).toBe(500);
  });
});
