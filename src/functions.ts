import path from "node:path";
import * as fs from "node:fs/promises";
import axios from "axios";
import { mimeTypes, API_REGEX, FALLBACKIMAGES } from "./variables";
import type { ImageType } from "./types";

/**
 * @typedef {("avatar" | "normal")} ImageType
 * @description Defines the type of image being processed.
 */

/**
 * Checks if a specified path is valid within a base path.
 *
 * @param {string} basePath - The base directory to resolve paths.
 * @param {string} specifiedPath - The path to check.
 * @returns {boolean} True if the path is valid, false otherwise.
 */
export const isValidPath = async (
  basePath: string,
  specifiedPath: string
): Promise<boolean> => {
  try {
    if (!basePath || !specifiedPath) return false;
    if (specifiedPath.includes("\0")) return false;
    if (path.isAbsolute(specifiedPath)) return false;
    if (!/^[^\x00-\x1F]+$/.test(specifiedPath)) return false;

    const resolvedBase = path.resolve(basePath);
    const resolvedPath = path.resolve(resolvedBase, specifiedPath);

    const [realBase, realPath] = await Promise.all([
      fs.realpath(resolvedBase),
      fs.realpath(resolvedPath),
    ]);

    const baseStats = await fs.stat(realBase);
    if (!baseStats.isDirectory()) return false;

    const normalizedBase = realBase + path.sep;
    const normalizedPath = realPath + path.sep;

    const isInside =
      normalizedPath.startsWith(normalizedBase) || realPath === realBase;

    const relative = path.relative(realBase, realPath);
    return !relative.startsWith("..") && !path.isAbsolute(relative) && isInside;
  } catch {
    return false;
  }
};

/**
 * Fetches an image from a network source.
 *
 * @param {string} src - The URL of the image.
 * @param {ImageType} [type="normal"] - Type of fallback image in case of an error.
 * @returns {Promise<Buffer>} A buffer containing the image data or a fallback image.
 */
const fetchFromNetwork = async (
  src: string,
  type: ImageType = "normal"
): Promise<Buffer> => {
  try {
    const response = await axios.get(src, {
      responseType: "arraybuffer",
      timeout: 5000,
    });

    const contentType = response.headers["content-type"]?.toLowerCase();
    const allowedMimeTypes = Object.values(mimeTypes);

    if (allowedMimeTypes.includes(contentType ?? "")) {
      return Buffer.from(response.data);
    }
    return await FALLBACKIMAGES[type]();
  } catch (error) {
    return await FALLBACKIMAGES[type]();
  }
};

/**
 * Reads an image from the local file system.
 *
 * @param {string} filePath - Path to the image file.
 * @param {string} baseDir - Base directory to resolve paths.
 * @param {ImageType} [type="normal"] - Type of fallback image if the path is invalid.
 * @returns {Promise<Buffer>} A buffer containing the image data.
 */
export const readLocalImage = async (
  filePath: string,
  baseDir: string,
  type: ImageType = "normal"
) => {
  const isValid = await isValidPath(baseDir, filePath);
  if (!isValid) {
    return await FALLBACKIMAGES[type]();
  }
  try {
    return await fs.readFile(path.resolve(baseDir, filePath));
  } catch (error) {
    return await FALLBACKIMAGES[type]();
  }
};

/**
 * Fetches an image from either a local file or a network source.
 *
 * @param {string} src - The URL or local path of the image.
 * @param {string} baseDir - Base directory to resolve local paths.
 * @param {string} websiteURL - The URL of the website.
 * @param {ImageType} [type="normal"] - Type of fallback image if the path is invalid.
 * @param {RegExp} [apiRegex=API_REGEX] - Regular expression to match API routes.
 * @param {string[]} [allowedNetworkList=[]] - List of allowed network hosts.
 * @returns {Promise<Buffer>} A buffer containing the image data or a fallback image.
 */
export const fetchImage = (
  src: string,
  baseDir: string,
  websiteURL: string,
  type: ImageType = "normal",
  apiRegex: RegExp = API_REGEX,
  allowedNetworkList: string[] = []
) => {
  const url = new URL(src);
  const isInternal = [websiteURL, `www.${websiteURL}`].includes(url.host);
  if (isInternal) {
    const localPath = url.pathname.replace(apiRegex, "");
    return readLocalImage(localPath, baseDir, type);
  } else {
    const allowedCondition = allowedNetworkList.includes(url.host);
    if (!allowedCondition) {
      return FALLBACKIMAGES[type]();
    }
    return fetchFromNetwork(src, type);
  }
};
