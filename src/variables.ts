import type { ImageFormat } from "./types";
import { readFile } from "node:fs/promises";

const NOT_FOUND_IMAGE = new URL("./assets/noimage.jpg", import.meta.url)
  .pathname;

const NOT_FOUND_AVATAR = new URL("./assets/noavatar.png", import.meta.url)
  .pathname;

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
