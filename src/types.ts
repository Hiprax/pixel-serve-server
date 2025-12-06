import type { Request } from "express";

export type ImageType = "avatar" | "normal";

export type ImageFormat =
  | "jpeg"
  | "jpg"
  | "png"
  | "webp"
  | "gif"
  | "tiff"
  | "avif"
  | "svg";

export type PixelServeOptions = {
  baseDir: string;
  idHandler?: (id: string) => string;
  getUserFolder?: (req: Request, id?: string) => Promise<string> | string;
  websiteURL?: string;
  apiRegex?: RegExp;
  allowedNetworkList?: string[];
  cacheControl?: string;
  etag?: boolean;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  defaultQuality?: number;
  requestTimeoutMs?: number;
  maxDownloadBytes?: number;
};

export type UserData = {
  src: string;
  quality?: number | string;
  format?: ImageFormat;
  folder?: "public" | "private";
  type?: ImageType;
  userId?: string;
  width?: number | string;
  height?: number | string;
};
