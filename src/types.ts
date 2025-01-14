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

export type Options = {
  baseDir: string;
  idHandler: (id: string) => string;
  getUserFolder: (id: string, req: Request) => Promise<string>;
  websiteURL: string;
  apiRegex: RegExp;
  allowedNetworkList: string[];
};

export type UserData = {
  quality: number | string;
  format: ImageFormat;
  src?: string;
  folder?: string;
  type?: ImageType;
  userId?: string;
  width?: number | string;
  height?: number | string;
};
