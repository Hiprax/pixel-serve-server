import { z } from "zod";
import type {
  ImageFormat,
  PixelServeOnError,
  PixelServeOnComplete,
} from "./types";
import { API_REGEX, allowedFormats } from "./variables";

const imageFormatEnum = z.enum(allowedFormats as [string, ...string[]]);
const imageTypeEnum = z.enum(["avatar", "normal"]);

export const userDataSchema = z
  .object({
    src: z
      // Reject arrays/objects/numbers/booleans with a clear error — a
      // malicious or buggy client sending `?src[]=a&src[]=b` (which Express
      // parses as an array) gets a meaningful rejection here. Anything that
      // is not a primitive string or `undefined`/`null` falls into the outer
      // pipeline catch and produces the standard fallback image rather than
      // `[object Object]` being forwarded through downstream logic.
      //
      // `src` is intentionally truly optional with no `.min(1)` and no
      // default — empty strings and `undefined` are both valid inputs at
      // the schema layer, and `pixel.ts` handles them via the
      // `if (!userData.src)` branch which serves the appropriate fallback
      // image based on the requested `type`.
      .preprocess((value, ctx) => {
        if (value === undefined || value === null) return value;
        if (typeof value === "string") return value;
        const got = Array.isArray(value) ? "array" : typeof value;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `src must be a string (received ${got})`,
        });
        return z.NEVER;
      }, z.string().optional())
      .optional(),
    format: z
      .string()
      .optional()
      .transform((val): ImageFormat | undefined => {
        const lower = val?.toLowerCase();
        return lower && imageFormatEnum.options.includes(lower)
          ? (lower as ImageFormat)
          : undefined;
      })
      .optional(),
    width: z
      .union([z.number(), z.string()])
      .optional()
      .transform((value) =>
        value === undefined || value === null ? undefined : Number(value),
      )
      .pipe(
        z
          .number()
          .int()
          .min(50, "width too small")
          .max(4000, "width too large")
          .optional(),
      ),
    height: z
      .union([z.number(), z.string()])
      .optional()
      .transform((value) =>
        value === undefined || value === null ? undefined : Number(value),
      )
      .pipe(
        z
          .number()
          .int()
          .min(50, "height too small")
          .max(4000, "height too large")
          .optional(),
      ),
    quality: z
      .union([z.number(), z.string()])
      .optional()
      .transform((value) =>
        value === undefined || value === null ? undefined : Number(value),
      )
      .pipe(z.number().int().min(1).max(100).default(80)),
    folder: z.enum(["public", "private"]).default("public"),
    type: imageTypeEnum.default("normal"),
    userId: z
      .union([z.string(), z.number()])
      .optional()
      .transform((value) =>
        value === undefined || value === null
          ? undefined
          : String(value).trim(),
      )
      .pipe(
        z
          .string()
          .min(1, "userId cannot be empty")
          .max(128, "userId too long")
          .optional(),
      ),
  })
  .strict();

export const optionsSchema = z
  .object({
    baseDir: z.string().min(1, "baseDir is required"),
    idHandler: z
      .custom<
        (id: string) => string | Promise<string>
      >((val) => typeof val === "function", { message: "idHandler must be a function" })
      .optional(),
    getUserFolder: z
      .custom<
        (req: unknown, id?: string) => Promise<string> | string
      >((val) => typeof val === "function", { message: "getUserFolder must be a function" })
      .optional(),
    getUserFolderRootDir: z.string().min(1).optional(),
    websiteURL: z
      .union([
        z.url(),
        // Hostname grammar with NO nested quantifiers — every label is 1-63
        // alphanumeric/hyphen chars, labels are dot-separated, and no label
        // may start with `-`. The earlier `/^(?![-.])([\w]+[-.]?)*[\w]+$/`
        // was ReDoS-vulnerable (catastrophic backtracking on inputs like
        // `"a".repeat(50) + "!"`); this anchored pattern runs in linear time
        // because the outer group is a flat `(\.label)*` with no nested
        // repetition. Single-label hostnames (`localhost`) and FQDNs both
        // validate; the previous regex's underscore acceptance is dropped
        // because RFC 1123 hostnames do not include `_`.
        z
          .string()
          .regex(/^(?!-)[A-Za-z0-9-]{1,63}(\.(?!-)[A-Za-z0-9-]{1,63})*$/),
      ])
      .optional(),
    apiRegex: z.instanceof(RegExp).default(API_REGEX),
    apiPrefix: z.string().min(1, "apiPrefix cannot be empty").optional(),
    allowedNetworkList: z
      .array(
        z
          .string()
          // Trim FIRST so the regex/min-length checks below operate on the
          // operator-intended hostname rather than incidental whitespace
          // injected by `.env` files or CI config copies.
          .transform((value) => value.trim())
          .pipe(
            z
              .string()
              .min(1, "allowedNetworkList entries cannot be empty")
              // Hostnames only: letters, digits, dots, hyphens. Rejects
              // whitespace-only entries (after trim → empty → caught by
              // `.min(1)`) and any entry containing path/protocol/internal-
              // whitespace characters. Defence in depth — the Task 2
              // lowercase transform below already collapses an empty entry
              // into `""` which would silently match
              // `url.hostname === ""` for inputs like `http:///path`. The
              // regex is intentionally permissive (no FQDN structure
              // enforcement) so single-label hosts and IDN-encoded punycode
              // labels still parse.
              .regex(
                /^[a-z0-9.-]+$/i,
                "allowedNetworkList entry is not a valid hostname",
              ),
          ),
      )
      // Task 2 contract: also lowercase so case-mismatched config still
      // matches the WHATWG-URL-lowercased `url.hostname`. The trim above
      // happens per-entry inside the inner schema; this transform finishes
      // the normalisation.
      .transform((arr) => arr.map((host) => host.toLowerCase()))
      .default([]),
    cacheControl: z.string().optional(),
    etag: z.boolean().default(true),
    minWidth: z.number().int().positive().default(50),
    maxWidth: z.number().int().positive().default(4000),
    minHeight: z.number().int().positive().default(50),
    maxHeight: z.number().int().positive().default(4000),
    defaultQuality: z.number().int().min(1).max(100).default(80),
    requestTimeoutMs: z.number().int().positive().default(5000),
    idHandlerTimeoutMs: z.number().int().positive().optional(),
    maxDownloadBytes: z.number().int().positive().default(5_000_000),
    maxRedirects: z.number().int().min(0).max(10).default(3),
    maxInputPixels: z
      .number()
      .int()
      .positive()
      .default(16_000 * 16_000),
    allowSvgInput: z.boolean().default(false),
    onError: z
      .custom<PixelServeOnError>((val) => typeof val === "function", {
        message: "onError must be a function",
      })
      .optional(),
    onComplete: z
      .custom<PixelServeOnComplete>((val) => typeof val === "function", {
        message: "onComplete must be a function",
      })
      .optional(),
  })
  .strict()
  .refine((data) => data.minWidth <= data.maxWidth, {
    message: "minWidth must be less than or equal to maxWidth",
    path: ["minWidth"],
  })
  .refine((data) => data.minHeight <= data.maxHeight, {
    message: "minHeight must be less than or equal to maxHeight",
    path: ["minHeight"],
  });

export type ParsedUserData = z.infer<typeof userDataSchema>;
export type ParsedOptions = z.infer<typeof optionsSchema>;
