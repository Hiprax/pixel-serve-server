import path from "node:path";
import * as fs from "node:fs/promises";
import axios from "axios";
import { FALLBACKIMAGES, mimeTypes } from "./variables";
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
 * @returns {Promise<boolean>} True if the path is valid, false otherwise.
 */
export const isValidPath = async (
  basePath: string,
  specifiedPath: string
): Promise<boolean> => {
  try {
    if (!basePath || !specifiedPath) return false;
    if (specifiedPath.includes("\0")) return false;
    if (path.isAbsolute(specifiedPath)) return false;
    // eslint-disable-next-line no-control-regex
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
  type: ImageType = "normal",
  {
    timeoutMs,
    maxBytes,
  }: {
    timeoutMs: number;
    maxBytes: number;
  }
): Promise<Buffer> => {
  try {
    const response = await axios.get(src, {
      responseType: "arraybuffer",
      timeout: timeoutMs,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    const contentType = response.headers["content-type"]
      ?.toLowerCase()
      ?.split(";")[0]
      ?.trim();
    const allowedMimeTypes = Object.values(mimeTypes);

    if (allowedMimeTypes.includes(contentType ?? "")) {
      return Buffer.from(response.data);
    }
    return await FALLBACKIMAGES[type]();
  } catch {
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
  type: ImageType = "normal",
  maxBytes?: number
): Promise<Buffer> => {
  const isValid = await isValidPath(baseDir, filePath);
  if (!isValid) {
    return await FALLBACKIMAGES[type]();
  }
  try {
    const resolvedFile = path.resolve(baseDir, filePath);
    if (maxBytes) {
      const stats = await fs.stat(resolvedFile);
      if (stats.size > maxBytes) {
        return await FALLBACKIMAGES[type]();
      }
    }
    return await fs.readFile(resolvedFile);
  } catch {
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
 * @param {string[]} [allowedNetworkList=[]] - List of allowed network hosts.
 * @returns {Promise<Buffer>} A buffer containing the image data or a fallback image.
 */
export const fetchImage = (
  src: string,
  baseDir: string,
  websiteURL: string | undefined,
  type: ImageType = "normal",
  apiRegex: RegExp,
  allowedNetworkList: string[] = [],
  {
    timeoutMs,
    maxBytes,
  }: {
    timeoutMs: number;
    maxBytes: number;
  }
): Promise<Buffer> => {
  try {
    const url = new URL(src);
    const isInternal =
      websiteURL !== undefined &&
      [websiteURL, `www.${websiteURL}`].includes(url.hostname);

    if (isInternal) {
      const localPath = url.pathname.replace(apiRegex, "");
      return readLocalImage(localPath, baseDir, type, maxBytes);
    }

    const allowedCondition =
      allowedNetworkList.includes(url.hostname) ||
      allowedNetworkList.includes(url.host);
    if (!allowedCondition) {
      return FALLBACKIMAGES[type]();
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      return FALLBACKIMAGES[type]();
    }
    return fetchFromNetwork(src, type, { timeoutMs, maxBytes });
  } catch {
    return readLocalImage(src, baseDir, type, maxBytes);
  }
};
