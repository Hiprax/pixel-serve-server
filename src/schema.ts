import { z } from "zod";
import { API_REGEX, allowedFormats } from "./variables";

const imageFormatEnum = z.enum(allowedFormats as [string, ...string[]]);
const imageTypeEnum = z.enum(["avatar", "normal"]);

export const userDataSchema = z
  .object({
    src: z
      .string()
      .min(1, "src is required")
      .optional()
      .default("/placeholder/noimage.jpg"),
    format: z
      .string()
      .optional()
      .transform((val) => {
        const lower = val?.toLowerCase();
        return lower && imageFormatEnum.options.includes(lower as string)
          ? (lower as (typeof imageFormatEnum)["options"][number])
          : undefined;
      })
      .optional(),
    width: z
      .union([z.number(), z.string()])
      .optional()
      .transform((value) =>
        value === undefined || value === null ? undefined : Number(value)
      )
      .pipe(
        z
          .number()
          .int()
          .min(50, "width too small")
          .max(4000, "width too large")
          .optional()
      ),
    height: z
      .union([z.number(), z.string()])
      .optional()
      .transform((value) =>
        value === undefined || value === null ? undefined : Number(value)
      )
      .pipe(
        z
          .number()
          .int()
          .min(50, "height too small")
          .max(4000, "height too large")
          .optional()
      ),
    quality: z
      .union([z.number(), z.string()])
      .optional()
      .transform((value) =>
        value === undefined || value === null ? undefined : Number(value)
      )
      .pipe(z.number().int().min(1).max(100).default(80)),
    folder: z.enum(["public", "private"]).default("public"),
    type: imageTypeEnum.default("normal"),
    userId: z
      .union([z.string(), z.number()])
      .optional()
      .transform((value) =>
        value === undefined || value === null ? undefined : String(value).trim()
      )
      .pipe(
        z
          .string()
          .min(1, "userId cannot be empty")
          .max(128, "userId too long")
          .optional()
      ),
  })
  .strict();

export const optionsSchema = z
  .object({
    baseDir: z.string().min(1, "baseDir is required"),
    idHandler: z
      .custom<
        (id: string) => string
      >((val) => typeof val === "function", { message: "idHandler must be a function" })
      .optional(),
    getUserFolder: z
      .custom<
        (req: unknown, id?: string) => Promise<string> | string
      >((val) => typeof val === "function", { message: "getUserFolder must be a function" })
      .optional(),
    websiteURL: z.union([z.url(), z.string().regex(/^[\w.-]+$/)]).optional(),
    apiRegex: z.instanceof(RegExp).default(API_REGEX),
    allowedNetworkList: z.array(z.string()).default([]),
    cacheControl: z.string().optional(),
    etag: z.boolean().default(true),
    minWidth: z.number().int().positive().default(50),
    maxWidth: z.number().int().positive().default(4000),
    minHeight: z.number().int().positive().default(50),
    maxHeight: z.number().int().positive().default(4000),
    defaultQuality: z.number().int().min(1).max(100).default(80),
    requestTimeoutMs: z.number().int().positive().default(5000),
    maxDownloadBytes: z.number().int().positive().default(5_000_000),
  })
  .strict();

export type ParsedUserData = z.infer<typeof userDataSchema>;
export type ParsedOptions = z.infer<typeof optionsSchema>;
