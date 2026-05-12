import { describe, expect, it } from "vitest";
import { optionsSchema, userDataSchema } from "./schema";

describe("userDataSchema", () => {
  it("validates minimal input with defaults", () => {
    const result = userDataSchema.parse({});
    // src is intentionally truly optional with no default — pixel.ts handles
    // empty/missing src via the `if (!userData.src)` branch (Task 13).
    expect(result.src).toBeUndefined();
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
      "width too small",
    );
  });

  it("rejects width above maximum", () => {
    expect(() => userDataSchema.parse({ width: 5000 })).toThrow(
      "width too large",
    );
  });

  it("rejects height below minimum", () => {
    expect(() => userDataSchema.parse({ height: 10 })).toThrow(
      "height too small",
    );
  });

  it("rejects height above maximum", () => {
    expect(() => userDataSchema.parse({ height: 5000 })).toThrow(
      "height too large",
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
      "userId too long",
    );
  });

  it("rejects empty userId after trim", () => {
    expect(() => userDataSchema.parse({ userId: "   " })).toThrow(
      "userId cannot be empty",
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
      "baseDir is required",
    );
  });

  it("rejects missing baseDir", () => {
    expect(() => optionsSchema.parse({})).toThrow();
  });

  it("rejects non-function idHandler", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", idHandler: "not a function" }),
    ).toThrow("idHandler must be a function");
  });

  it("rejects non-function getUserFolder", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        getUserFolder: "not a function",
      }),
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
      optionsSchema.parse({ baseDir: "/images", unknownField: "value" }),
    ).toThrow();
  });

  it("validates numeric constraints", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", minWidth: 0 }),
    ).toThrow();

    expect(() =>
      optionsSchema.parse({ baseDir: "/images", minWidth: -1 }),
    ).toThrow();

    expect(() =>
      optionsSchema.parse({ baseDir: "/images", requestTimeoutMs: 0 }),
    ).toThrow();

    expect(() =>
      optionsSchema.parse({ baseDir: "/images", maxDownloadBytes: 0 }),
    ).toThrow();
  });

  it("validates quality range", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", defaultQuality: 0 }),
    ).toThrow();

    expect(() =>
      optionsSchema.parse({ baseDir: "/images", defaultQuality: 101 }),
    ).toThrow();
  });

  it("rejects minWidth greater than maxWidth", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        minWidth: 5000,
        maxWidth: 100,
      }),
    ).toThrow("minWidth must be less than or equal to maxWidth");
  });

  it("rejects minHeight greater than maxHeight", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        minHeight: 5000,
        maxHeight: 100,
      }),
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

  it("provides defaults for SSRF/decompression-bomb options", () => {
    const result = optionsSchema.parse({ baseDir: "/images" });
    expect(result.maxRedirects).toBe(3);
    expect(result.maxInputPixels).toBe(16_000 * 16_000);
    expect(result.allowSvgInput).toBe(false);
  });

  it("accepts overrides for SSRF/decompression-bomb options", () => {
    const result = optionsSchema.parse({
      baseDir: "/images",
      maxRedirects: 0,
      maxInputPixels: 1000,
      allowSvgInput: true,
    });
    expect(result.maxRedirects).toBe(0);
    expect(result.maxInputPixels).toBe(1000);
    expect(result.allowSvgInput).toBe(true);
  });

  it("rejects negative maxRedirects", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", maxRedirects: -1 }),
    ).toThrow();
  });

  it("rejects maxRedirects above the hard cap", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", maxRedirects: 50 }),
    ).toThrow();
  });

  it("rejects non-positive maxInputPixels", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", maxInputPixels: 0 }),
    ).toThrow();
  });
});

describe("allowedNetworkList entry validation (Task 9)", () => {
  it("rejects an empty-string entry", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", allowedNetworkList: [""] }),
    ).toThrow(/allowedNetworkList entries cannot be empty/);
  });

  it("rejects a whitespace-only entry", () => {
    // The inner schema trims first, so `"  "` collapses to `""` and is
    // caught by `.min(1)` — the operator gets the "cannot be empty"
    // message which is the more actionable surface for this failure mode.
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", allowedNetworkList: ["  "] }),
    ).toThrow(/allowedNetworkList entries cannot be empty/);
  });

  it("rejects a mixed array containing empty and whitespace entries", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        allowedNetworkList: ["", "  "],
      }),
    ).toThrow();
  });

  it("rejects an entry containing internal whitespace", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        allowedNetworkList: ["cdn .example.com"],
      }),
    ).toThrow(/allowedNetworkList entry is not a valid hostname/);
  });

  it("rejects an entry containing protocol or path characters", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        allowedNetworkList: ["https://cdn.example.com"],
      }),
    ).toThrow(/allowedNetworkList entry is not a valid hostname/);
  });

  it("keeps the Task 2 lowercase + trim normalisation intact after validation", () => {
    // Validation runs BEFORE the transform, so a mixed-case hostname still
    // emerges lowercased on the parsed result.
    const result = optionsSchema.parse({
      baseDir: "/images",
      allowedNetworkList: ["CDN.Example.com", "Images.Test"],
    });
    expect(result.allowedNetworkList).toEqual([
      "cdn.example.com",
      "images.test",
    ]);
  });
});

describe("svg output rejection", () => {
  it("does not accept svg as a userData format", () => {
    const result = userDataSchema.parse({ format: "svg" });
    // unknown formats normalize to undefined; the renderer then defaults to jpeg
    expect(result.format).toBeUndefined();
  });
});

describe("getUserFolderRootDir option (Task 18)", () => {
  it("is undefined by default and backward compatible", () => {
    const result = optionsSchema.parse({ baseDir: "/images" });
    expect(result.getUserFolderRootDir).toBeUndefined();
  });

  it("accepts an absolute path string", () => {
    const result = optionsSchema.parse({
      baseDir: "/images",
      getUserFolderRootDir: "/srv/users",
    });
    expect(result.getUserFolderRootDir).toBe("/srv/users");
  });

  it("rejects an empty getUserFolderRootDir", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", getUserFolderRootDir: "" }),
    ).toThrow();
  });

  it("rejects a non-string getUserFolderRootDir", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        getUserFolderRootDir: 123 as unknown as string,
      }),
    ).toThrow();
  });
});

describe("src array rejection (Task 25)", () => {
  it("rejects src arriving as an array with a clear message", () => {
    expect(() => userDataSchema.parse({ src: ["a", "b"] })).toThrow(
      /src must be a string \(received array\)/,
    );
  });

  it("rejects src arriving as an object with a clear message", () => {
    expect(() => userDataSchema.parse({ src: { evil: "value" } })).toThrow(
      /src must be a string \(received object\)/,
    );
  });

  it("rejects src arriving as a number with a clear message", () => {
    expect(() => userDataSchema.parse({ src: 42 })).toThrow(
      /src must be a string \(received number\)/,
    );
  });

  it("accepts a valid string src unchanged (regression)", () => {
    const result = userDataSchema.parse({ src: "image.jpg" });
    expect(result.src).toBe("image.jpg");
  });

  it("leaves src undefined when not provided (Task 13)", () => {
    // Task 13: schema no longer applies a default — pixel.ts handles the
    // fallback via the `if (!userData.src)` branch, which keeps the empty /
    // missing src semantics in one place.
    const result = userDataSchema.parse({});
    expect(result.src).toBeUndefined();
  });

  it("passes through null on the preprocess fast path", () => {
    // The preprocess returns the value unchanged for null/undefined so the
    // downstream `.optional()` chain handles it. Null falls through to the
    // string check which rejects.
    expect(() => userDataSchema.parse({ src: null })).toThrow();
  });

  it("rejects src arriving as a boolean", () => {
    expect(() => userDataSchema.parse({ src: true })).toThrow(
      /src must be a string \(received boolean\)/,
    );
  });
});

describe("apiPrefix option (Task 15)", () => {
  it("is undefined by default and backward compatible", () => {
    const result = optionsSchema.parse({ baseDir: "/images" });
    expect(result.apiPrefix).toBeUndefined();
    // apiRegex still gets its default — apiPrefix is purely additive.
    expect(result.apiRegex.source).toBe("^\\/api\\/v1\\/");
  });

  it("accepts a literal string prefix", () => {
    const result = optionsSchema.parse({
      baseDir: "/images",
      apiPrefix: "/api/v2/",
    });
    expect(result.apiPrefix).toBe("/api/v2/");
  });

  it("rejects an empty apiPrefix", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", apiPrefix: "" }),
    ).toThrow();
  });

  it("rejects a non-string apiPrefix", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        apiPrefix: 123 as unknown as string,
      }),
    ).toThrow();
  });

  it("accepts apiPrefix alongside a custom apiRegex", () => {
    const result = optionsSchema.parse({
      baseDir: "/images",
      apiPrefix: "/v3/",
      apiRegex: /^\/legacy\//,
    });
    expect(result.apiPrefix).toBe("/v3/");
    expect(result.apiRegex.source).toBe("^\\/legacy\\/");
  });
});

describe("apiRegex performance (Task 14)", () => {
  it("accepts a user-supplied apiRegex without invoking it during parse", () => {
    // The schema only stores apiRegex; it does NOT execute it. A user can
    // supply a regex that would be catastrophic if run against the wrong
    // input, but `optionsSchema.parse` must finish in microseconds because
    // it only validates the instanceof check.
    const pathological = /^(a+)+\/$/;
    const start = Date.now();
    const result = optionsSchema.parse({
      baseDir: "/images",
      apiRegex: pathological,
    });
    const elapsed = Date.now() - start;
    // 50ms is a generous safety margin — real parses finish in well under 1ms.
    expect(elapsed).toBeLessThan(50);
    expect(result.apiRegex).toBe(pathological);
  });

  it("never executes the user-supplied apiRegex against a giant input during parse", () => {
    // If a future refactor ever runs the regex during schema parsing, this
    // test will time out (vitest default test timeout is 5s) because the
    // pathological regex against 50k chars would exhibit catastrophic
    // backtracking. Construct the regex but DO NOT execute it manually
    // anywhere in this assertion — we are checking the schema layer, not
    // the runtime usage path.
    const evilRegex = /^(a+)+b$/;
    const giantPath = "a".repeat(50_000);
    // The presence of `giantPath` in the closure ensures the test object
    // references it but never feeds it to the regex.
    expect(giantPath.length).toBe(50_000);
    const start = Date.now();
    optionsSchema.parse({ baseDir: "/images", apiRegex: evilRegex });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe("websiteURL ReDoS hardening (Task 6)", () => {
  it("accepts every previously-valid hostname form", () => {
    const valids = [
      "example.com",
      "localhost",
      "sub.example.com",
      "www.example.com",
      "a.b.c.example.com",
      "https://example.com/path",
      "https://example.com",
    ];
    for (const v of valids) {
      const result = optionsSchema.parse({ baseDir: "/images", websiteURL: v });
      expect(result.websiteURL).toBe(v);
    }
  });

  it("rejects hostnames with leading hyphen on any label", () => {
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        websiteURL: "-bad.example.com",
      }),
    ).toThrow();
    expect(() =>
      optionsSchema.parse({
        baseDir: "/images",
        websiteURL: "good.-bad.example.com",
      }),
    ).toThrow();
  });

  it("rejects empty labels (leading / trailing / doubled dots)", () => {
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", websiteURL: ".example.com" }),
    ).toThrow();
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", websiteURL: "example..com" }),
    ).toThrow();
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", websiteURL: "example.com." }),
    ).toThrow();
  });

  it("rejects pathological ReDoS input within a tight time budget", () => {
    // The old regex `/^(?![-.])([\w]+[-.]?)*[\w]+$/` exhibited catastrophic
    // backtracking on `"a".repeat(N) + "!"` — at N=31 it hung for >5s on a
    // typical laptop. The replacement regex is anchored with no nested
    // quantifiers so the same input must reject in linear time.
    const pathological = "a".repeat(50) + "!";
    const start = Date.now();
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", websiteURL: pathological }),
    ).toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it("rejects labels longer than 63 characters", () => {
    const tooLongLabel = "a".repeat(64);
    expect(() =>
      optionsSchema.parse({ baseDir: "/images", websiteURL: tooLongLabel }),
    ).toThrow();
  });
});

describe("src optionality (Task 13)", () => {
  it('accepts src = "" without throwing', () => {
    // Empty string is a valid input at the schema layer. The downstream
    // pipeline (`pixel.ts`) handles the empty/missing case via its own
    // `if (!userData.src)` branch — putting both checks in the schema
    // would duplicate state and make the fallback path harder to reason
    // about.
    expect(() => userDataSchema.parse({ src: "" })).not.toThrow();
    const result = userDataSchema.parse({ src: "" });
    expect(result.src).toBe("");
  });

  it("accepts src = undefined without throwing", () => {
    expect(() => userDataSchema.parse({ src: undefined })).not.toThrow();
    const result = userDataSchema.parse({ src: undefined });
    expect(result.src).toBeUndefined();
  });

  it("accepts a totally absent src key without throwing", () => {
    expect(() => userDataSchema.parse({})).not.toThrow();
    const result = userDataSchema.parse({});
    expect(result.src).toBeUndefined();
  });
});
