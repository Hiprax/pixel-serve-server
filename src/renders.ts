import { API_REGEX } from "./variables";
import type { Options, UserData } from "./types";

/**
 * @typedef {("avatar" | "normal")} ImageType
 * @description Defines the type of image being processed.
 */

/**
 * @typedef {("jpeg" | "jpg" | "png" | "webp" | "gif" | "tiff" | "avif" | "svg")} ImageFormat
 * @description Supported formats for image processing.
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
export const renderOptions = (options: Partial<Options>): Options => {
  const initialOptions: Options = {
    baseDir: "",
    idHandler: (id: string) => id,
    getUserFolder: async () => "",
    websiteURL: "",
    apiRegex: API_REGEX,
    allowedNetworkList: [],
  };
  return {
    ...initialOptions,
    ...options,
  };
};

/**
 * Renders the user data object with default values and user-provided values.
 *
 * @param {Partial<UserData>} userData - The user-provided data.
 * @returns {UserData} The rendered user data object.
 */
export const renderUserData = (userData: Partial<UserData>): UserData => {
  const initialUserData: UserData = {
    quality: 80,
    format: "jpeg",
    src: "/placeholder/noimage.jpg",
    folder: "public",
    type: "normal",
    width: undefined,
    height: undefined,
    userId: undefined,
  };
  return {
    ...initialUserData,
    ...userData,
    quality: userData.quality
      ? Math.min(Math.max(Number(userData.quality) || 80, 1), 100)
      : 100,
    width: userData.width
      ? Math.min(Math.max(Number(userData.width), 50), 2000)
      : undefined,
    height: userData.height
      ? Math.min(Math.max(Number(userData.height), 50), 2000)
      : undefined,
  };
};
