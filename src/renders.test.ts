import { describe, expect, it } from "vitest";
import { renderOptions, renderUserData } from "./renders";

describe("renderOptions", () => {
  it("parses minimal options with defaults", () => {
    const result = renderOptions({ baseDir: "/images" });
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

  it("parses all custom options", () => {
    const idHandler = (id: string): string => `user-${id}`;
    const getUserFolder = async (): Promise<string> => "/private";

    const result = renderOptions({
      baseDir: "/custom",
      idHandler,
      getUserFolder,
      websiteURL: "example.com",
      apiRegex: /^\/custom-api\//,
      allowedNetworkList: ["cdn.example.com"],
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
    expect(result.apiRegex.source).toBe("^\\/custom-api\\/");
    expect(result.allowedNetworkList).toEqual(["cdn.example.com"]);
    expect(result.cacheControl).toBe("private, max-age=3600");
    expect(result.etag).toBe(false);
    expect(result.minWidth).toBe(100);
    expect(result.maxWidth).toBe(2000);
    expect(result.minHeight).toBe(100);
    expect(result.maxHeight).toBe(2000);
    expect(result.defaultQuality).toBe(90);
    expect(result.requestTimeoutMs).toBe(10000);
    expect(result.maxDownloadBytes).toBe(10_000_000);
  });

  it("throws on missing baseDir", () => {
    expect(() => renderOptions({} as { baseDir: string })).toThrow();
  });

  it("throws on empty baseDir", () => {
    expect(() => renderOptions({ baseDir: "" })).toThrow();
  });

  it("accepts URL format for websiteURL", () => {
    const result = renderOptions({
      baseDir: "/images",
      websiteURL: "https://example.com",
    });
    expect(result.websiteURL).toBe("https://example.com");
  });

  it("accepts domain-only format for websiteURL", () => {
    const result = renderOptions({
      baseDir: "/images",
      websiteURL: "example.com",
    });
    expect(result.websiteURL).toBe("example.com");
  });
});

describe("renderUserData", () => {
  const defaultBounds = {
    minWidth: 50,
    maxWidth: 4000,
    minHeight: 50,
    maxHeight: 4000,
    defaultQuality: 80,
  };

  it("parses minimal user data with defaults", () => {
    const result = renderUserData({}, defaultBounds);
    // src has no schema default — pixel.ts handles empty/missing src via
    // the `if (!userData.src)` branch (Task 13).
    expect(result.src).toBeUndefined();
    expect(result.format).toBe("jpeg");
    expect(result.quality).toBe(80);
    expect(result.folder).toBe("public");
    expect(result.type).toBe("normal");
    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();
    expect(result.userId).toBeUndefined();
  });

  it("parses all user data fields", () => {
    const result = renderUserData(
      {
        src: "/test.jpg",
        format: "webp",
        width: 800,
        height: 600,
        quality: 90,
        folder: "private",
        type: "avatar",
        userId: "user123",
      },
      defaultBounds,
    );

    expect(result.src).toBe("/test.jpg");
    expect(result.format).toBe("webp");
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(result.quality).toBe(90);
    expect(result.folder).toBe("private");
    expect(result.type).toBe("avatar");
    expect(result.userId).toBe("user123");
  });

  it("clamps width to custom min bound (within schema limits)", () => {
    const customBounds = { ...defaultBounds, minWidth: 100 };
    const result = renderUserData({ width: 50 }, customBounds);
    expect(result.width).toBe(100);
  });

  it("clamps width to custom max bound (within schema limits)", () => {
    const customBounds = { ...defaultBounds, maxWidth: 500 };
    const result = renderUserData({ width: 1000 }, customBounds);
    expect(result.width).toBe(500);
  });

  it("clamps height to custom min bound (within schema limits)", () => {
    const customBounds = { ...defaultBounds, minHeight: 100 };
    const result = renderUserData({ height: 50 }, customBounds);
    expect(result.height).toBe(100);
  });

  it("clamps height to custom max bound (within schema limits)", () => {
    const customBounds = { ...defaultBounds, maxHeight: 500 };
    const result = renderUserData({ height: 1000 }, customBounds);
    expect(result.height).toBe(500);
  });

  it("accepts string values for width and height", () => {
    const result = renderUserData(
      { width: "200", height: "300" },
      defaultBounds,
    );
    expect(result.width).toBe(200);
    expect(result.height).toBe(300);
  });

  it("accepts string values for quality", () => {
    const result = renderUserData({ quality: "95" }, defaultBounds);
    expect(result.quality).toBe(95);
  });

  it("normalizes format to lowercase", () => {
    const result = renderUserData({ format: "WEBP" as "webp" }, defaultBounds);
    expect(result.format).toBe("webp");
  });

  it("ignores invalid format and uses default", () => {
    const result = renderUserData(
      { format: "invalid" as "jpeg" },
      defaultBounds,
    );
    expect(result.format).toBe("jpeg");
  });

  it("trims userId string", () => {
    const result = renderUserData({ userId: "  user123  " }, defaultBounds);
    expect(result.userId).toBe("user123");
  });

  it("converts numeric userId to string", () => {
    const result = renderUserData(
      { userId: 12345 as unknown as string },
      defaultBounds,
    );
    expect(result.userId).toBe("12345");
  });

  it("applies custom bounds correctly (within schema limits)", () => {
    const customBounds = {
      minWidth: 100,
      maxWidth: 1000,
      minHeight: 100,
      maxHeight: 1000,
      defaultQuality: 70,
    };

    // Use values within schema limits (50-4000) but outside custom bounds
    const result = renderUserData({ width: 50, height: 2000 }, customBounds);
    expect(result.width).toBe(100); // Clamped to customBounds.minWidth
    expect(result.height).toBe(1000); // Clamped to customBounds.maxHeight
  });

  it("falls back to bounds.defaultQuality when not provided in input", () => {
    // Phase 5: the schema no longer defaults quality, so this exercises
    // the `parsed.quality ?? bounds.defaultQuality` fallback directly.
    // defaultBounds.defaultQuality is 80, so the observed value is
    // unchanged from before the fix — see "defaultQuality actually
    // governs" below for a bounds value other than 80.
    const result = renderUserData({}, defaultBounds);
    expect(result.quality).toBe(80);
  });

  it("uses provided quality over schema default", () => {
    const result = renderUserData({ quality: 95 }, defaultBounds);
    expect(result.quality).toBe(95);
  });

  it("handles all supported image formats", () => {
    const formats = ["jpeg", "jpg", "png", "webp", "gif", "tiff", "avif"];
    for (const format of formats) {
      const result = renderUserData(
        { format: format as "jpeg" },
        defaultBounds,
      );
      expect(result.format).toBe(format);
    }
  });

  it("rejects svg as output format (falls back to jpeg)", () => {
    const result = renderUserData({ format: "svg" as "jpeg" }, defaultBounds);
    expect(result.format).toBe("jpeg");
  });

  describe("quality propagation outside defaultQuality (Task 14)", () => {
    it("rejects quality above the schema max (101+) before clamping ever runs", () => {
      // The schema enforces `min(1).max(100)` at validation time, so a
      // request like `quality=150` never reaches the renderer's clamp
      // step — it throws inside `userDataSchema.parse`. This test pins
      // the contract: quality clamping is a SCHEMA concern, not a render
      // concern.
      expect(() => renderUserData({ quality: 150 }, defaultBounds)).toThrow();
    });

    it("rejects quality below the schema min (0 / negative)", () => {
      expect(() => renderUserData({ quality: 0 }, defaultBounds)).toThrow();
      expect(() => renderUserData({ quality: -10 }, defaultBounds)).toThrow();
    });

    it("accepts the maximum legal quality (100) verbatim", () => {
      const result = renderUserData({ quality: 100 }, defaultBounds);
      expect(result.quality).toBe(100);
    });

    it("accepts the minimum legal quality (1) verbatim", () => {
      const result = renderUserData({ quality: 1 }, defaultBounds);
      expect(result.quality).toBe(1);
    });

    it("falls back to bounds.defaultQuality when caller omits quality entirely", () => {
      // Phase 5: the schema no longer defaults quality to 80, so an omitted
      // quality reaches renderUserData as `undefined` and
      // `parsed.quality ?? bounds.defaultQuality` now actually governs —
      // omitted quality yields bounds.defaultQuality (70), NOT a
      // hard-coded 80.
      const customBounds = { ...defaultBounds, defaultQuality: 70 };
      const result = renderUserData({}, customBounds);
      expect(result.quality).toBe(70);
    });

    it("uses bounds.defaultQuality when schema-parsed quality is undefined", () => {
      // Direct exercise of the `quality ?? bounds.defaultQuality` fallback.
      // Phase 5 dropped the schema's own `.default(80)`, so
      // bounds.defaultQuality is now the ONLY source of a default quality
      // when the request omits it — pinning the runtime behavior here so a
      // future regression (e.g. re-adding a schema default) is caught.
      const customBounds = { ...defaultBounds, defaultQuality: 55 };
      const result = renderUserData({}, customBounds);
      expect(result.quality).toBe(55);
      expect(result.quality).toBe(customBounds.defaultQuality);
    });
  });

  describe("defaultQuality actually governs when quality is omitted (Phase 5)", () => {
    it("honors a non-80 defaultQuality (60) when the request omits quality", () => {
      const result = renderUserData(
        {},
        { ...defaultBounds, defaultQuality: 60 },
      );
      expect(result.quality).toBe(60);
    });

    it("still yields 80 when defaultQuality is 80 (the operator default)", () => {
      const result = renderUserData(
        {},
        { ...defaultBounds, defaultQuality: 80 },
      );
      expect(result.quality).toBe(80);
    });
  });
});
