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
          // Framework hard window is [1, 4000]. A request inside the window is
          // then clamped to the operator's minWidth/maxWidth by
          // renderUserData; a request below 1 or above 4000 is rejected here
          // (→ fallback image). The floor was lowered from 50 to 1 so common
          // small sizes (32px/48px avatars, 16px favicons, thumbnails) are
          // servable when the operator opts in with a low minWidth; the
          // previous floor turned every sub-50px request into a placeholder.
          .min(1, "width too small")
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
          .min(1, "height too small")
          .max(4000, "height too large")
          .optional(),
      ),
    // No `.default(80)` here (Phase 5): a hard-coded schema default always
    // won, so `renderUserData`'s `parsed.quality ?? bounds.defaultQuality`
    // fallback could never fire and the documented `defaultQuality` option
    // was dead code. Leaving `quality` genuinely optional lets that fallback
    // govern; `optionsSchema.defaultQuality`'s own `.default(80)` keeps the
    // effective middleware default unchanged.
    quality: z
      .union([z.number(), z.string()])
      .optional()
      .transform((value) =>
        value === undefined || value === null ? undefined : Number(value),
      )
      .pipe(z.number().int().min(1).max(100).optional()),
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
              // Hostnames only, with an OPTIONAL leading `*.` wildcard.
              // Letters, digits, dots, hyphens for the host part; a single
              // `*.` prefix opts the entry into subdomain matching (see
              // `isHostAllowed` in functions.ts — the wildcard matches the
              // apex AND any subdomain). Rejects whitespace-only entries
              // (after trim → empty → caught by `.min(1)`) and any entry
              // containing path/protocol/internal-whitespace characters. The
              // regex is intentionally permissive on the host part (no FQDN
              // structure enforcement) so single-label hosts and IDN-encoded
              // punycode labels still parse.
              .regex(
                /^(\*\.)?[a-z0-9.-]+$/i,
                "allowedNetworkList entry is not a valid hostname",
              )
              // Footgun guard: a wildcard entry must carry at least two
              // NON-EMPTY labels after `*.` (e.g. `*.picsum.photos`), so an
              // overly broad `*.com` / `*.` / `*` can never be configured.
              // Empty labels are filtered before counting so a trailing or
              // doubled dot cannot smuggle a too-broad entry past the count:
              // `*.com.` would otherwise split to ["com", ""] (length 2) and
              // be accepted, then match every `*.com.` FQDN — the WHATWG URL
              // parser preserves a trailing root dot in `hostname`. Note the
              // wildcard relaxes only the HOSTNAME check; the per-hop DNS
              // public-IP guard still runs on every redirect, so a wildcard
              // can never open an SSRF path to a private IP. Public-suffix
              // families (`*.co.uk`) are not special-cased — an operator that
              // lists such an entry accepts every host under it.
              .refine(
                (entry) =>
                  !entry.startsWith("*.") ||
                  entry.slice(2).split(".").filter(Boolean).length >= 2,
                {
                  message:
                    "wildcard allowedNetworkList entry must have at least two labels after '*.' (e.g. *.example.com)",
                },
              ),
          ),
      )
      // Also lowercase so case-mismatched config still matches the WHATWG-URL-
      // lowercased `url.hostname`. The trim above happens per-entry inside the
      // inner schema; this transform finishes the normalisation. The `*.`
      // prefix is unaffected by lowercasing.
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
  })
  // userDataSchema hard-rejects any request width/height outside [1, 4000]
  // (see above) before renderUserData's clamp() ever runs, so an operator
  // maxWidth/maxHeight configured above 4000 is silently non-functional for
  // the out-of-window portion of its range — e.g. maxWidth: 5000 can never
  // satisfy a width:4500 request, since the schema throws "width too large"
  // first. Fail loudly at registerServe() time instead of shipping a config
  // that quietly does nothing. The lower bound needs no refinement: minWidth/
  // minHeight are already `.positive()` (>= 1), which is exactly the window
  // floor, so any valid config is representable.
  .refine((data) => data.maxWidth <= 4000, {
    message:
      "maxWidth must lie within the framework's hard [1, 4000] dimension window",
    path: ["maxWidth"],
  })
  .refine((data) => data.maxHeight <= 4000, {
    message:
      "maxHeight must lie within the framework's hard [1, 4000] dimension window",
    path: ["maxHeight"],
  });

export type ParsedUserData = z.infer<typeof userDataSchema>;
export type ParsedOptions = z.infer<typeof optionsSchema>;
