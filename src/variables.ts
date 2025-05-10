import type { ImageFormat } from "./types";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const getAssetPath = (filename: string) => {
  return path.join(__dirname, "assets", filename);
};

const NOT_FOUND_IMAGE = getAssetPath("noimage.jpg");
const NOT_FOUND_AVATAR = getAssetPath("noavatar.png");

export const FALLBACKIMAGES = {
  normal: async () => readFile(NOT_FOUND_IMAGE),
  avatar: async () => readFile(NOT_FOUND_AVATAR),
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
