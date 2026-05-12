import { optionsSchema, userDataSchema } from "./schema";
import type { ParsedOptions, ParsedUserData } from "./schema";
import type { ImageFormat, PixelServeOptions } from "./types";

/**
 * @typedef {("avatar" | "normal")} ImageType
 * @description Defines the type of image being processed.
 */

/**
 * @typedef {("jpeg" | "jpg" | "png" | "webp" | "gif" | "tiff" | "avif")} ImageFormat
 * @description Supported output formats. SVG is intentionally excluded because
 *   Sharp/libvips cannot re-encode SVG output.
 */

/**
 * @typedef {Object} Options
 * @property {string} baseDir - The base directory for public image files.
 * @property {function(string): string} idHandler - A function to handle user IDs.
 * @property {function(string, Request): Promise<string>} getUserFolder - Asynchronous function to retrieve user-specific folders.
 * @property {string} websiteURL - The base URL of the website for internal link resolution.
 * @property {RegExp} apiRegex - Regex to parse API endpoints from URLs.
 * @property {string[]} allowedNetworkList - List of allowed network domains for external image fetching.
 */

/**
 * @typedef {Object} UserData
 * @property {number|string} quality - Quality of the image (1–100).
 * @property {ImageFormat} format - Desired format of the image.
 * @property {string} [src] - Source path or URL for the image.
 * @property {string} [folder] - The folder type ("public" or "private").
 * @property {ImageType} [type] - Type of the image ("avatar" or "normal").
 * @property {string|null} [userId] - Optional user identifier.
 * @property {number|string} [width] - Desired image width.
 * @property {number|string} [height] - Desired image height.
 */

/**
 * Renders the options object with default values and user-provided values.
 *
 * @param {Partial<Options>} options - The user-provided options.
 * @returns {Options} The rendered options object.
 */
export const renderOptions = (options: PixelServeOptions): ParsedOptions =>
  optionsSchema.parse(options);

/**
 * Renders the user data object with default values and user-provided values.
 *
 * @param {Partial<UserData>} userData - The user-provided data.
 * @returns {UserData} The rendered user data object.
 */
/**
 * Result of `renderUserData`. Narrower than `ParsedUserData` (Zod-inferred):
 * `format` is guaranteed to be an `ImageFormat` (defaulting to `"jpeg"`),
 * and `quality` is guaranteed to be a number (defaulting to
 * `bounds.defaultQuality`). The remaining fields keep their Zod-inferred
 * types, so callers can drop ad-hoc `as ImageFormat` / `as ImageType`
 * casts in favor of the validated shape.
 */
export type RenderedUserData = Omit<ParsedUserData, "format" | "quality"> & {
  format: ImageFormat;
  quality: number;
};

export const renderUserData = (
  userData: unknown,
  bounds: {
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    maxHeight: number;
    defaultQuality: number;
  },
): RenderedUserData => {
  const parsed = userDataSchema.parse(userData);

  const clamp = (
    value: number | undefined,
    min: number,
    max: number,
  ): number | undefined => {
    if (value === undefined) return undefined;
    return Math.min(Math.max(value, min), max);
  };

  return {
    ...parsed,
    width: clamp(parsed.width, bounds.minWidth, bounds.maxWidth),
    height: clamp(parsed.height, bounds.minHeight, bounds.maxHeight),
    quality: parsed.quality ?? bounds.defaultQuality,
    format: parsed.format ?? "jpeg",
  };
};
