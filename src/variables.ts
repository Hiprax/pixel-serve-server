import type { ImageFormat } from "./types";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Get the directory path for the current module.
 * Uses import.meta.url for ESM (tsup provides shims for CJS compatibility).
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const getAssetPath = (filename: string): string => {
  return path.join(moduleDir, "assets", filename);
};

const NOT_FOUND_IMAGE = getAssetPath("noimage.jpg");
const NOT_FOUND_AVATAR = getAssetPath("noavatar.png");

export const FALLBACKIMAGES: Record<
  "normal" | "avatar",
  () => Promise<Buffer>
> = {
  normal: async (): Promise<Buffer> => readFile(NOT_FOUND_IMAGE),
  avatar: async (): Promise<Buffer> => readFile(NOT_FOUND_AVATAR),
};

export const API_REGEX: RegExp = /^\/api\/v1\//;

export const allowedFormats: ImageFormat[] = [
  "jpeg",
  "jpg",
  "png",
  "webp",
  "gif",
  "tiff",
  "avif",
  "svg",
];

export const mimeTypes: Readonly<Record<string, string>> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  tiff: "image/tiff",
  avif: "image/avif",
  svg: "image/svg+xml",
};
