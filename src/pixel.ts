import path from "node:path";
import { createHash } from "node:crypto";
import sharp, { FormatEnum, ResizeOptions } from "sharp";
import type { Request, Response, NextFunction } from "express";
import type {
  PixelServeOptions,
  UserData,
  ImageFormat,
  ImageType,
} from "./types";
import { allowedFormats, FALLBACKIMAGES, mimeTypes } from "./variables";
import { fetchImage, readLocalImage } from "./functions";
import { renderOptions, renderUserData } from "./renders";

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
 * @function serveImage
 * @description Processes and serves an image based on user data and options.
 * @param {Request} req - The Express request object.
 * @param {Response} res - The Express response object.
 * @param {NextFunction} next - The Express next function.
 * @param {PixelServeOptions} options - The options object for image processing.
 * @returns {Promise<void>}
 */
const serveImage = async (
  req: Request,
  res: Response,
  next: NextFunction,
  options: PixelServeOptions
) => {
  try {
    const parsedOptions = renderOptions(options);
    const userData = renderUserData(req.query as Partial<UserData>, {
      minWidth: parsedOptions.minWidth,
      maxWidth: parsedOptions.maxWidth,
      minHeight: parsedOptions.minHeight,
      maxHeight: parsedOptions.maxHeight,
      defaultQuality: parsedOptions.defaultQuality,
    });

    let baseDir = parsedOptions.baseDir;
    let parsedUserId: string | undefined;

    if (userData.userId) {
      parsedUserId = parsedOptions.idHandler
        ? parsedOptions.idHandler(userData.userId)
        : userData.userId;
    }

    if (userData.folder === "private" && parsedOptions.getUserFolder) {
      const dir = await parsedOptions.getUserFolder(req, parsedUserId);
      if (dir) {
        baseDir = dir;
      }
    }

    const outputFormat = allowedFormats.includes(
      (userData.format ?? "").toLowerCase() as ImageFormat
    )
      ? (userData.format as ImageFormat)
      : "jpeg";

    const resolveBuffer = async (): Promise<Buffer> => {
      if (!userData.src) {
        return FALLBACKIMAGES[userData.type ?? "normal"]();
      }
      if (userData.src.startsWith("http")) {
        return fetchImage(
          userData.src,
          baseDir,
          parsedOptions.websiteURL,
          userData.type as ImageType,
          parsedOptions.apiRegex,
          parsedOptions.allowedNetworkList,
          {
            timeoutMs: parsedOptions.requestTimeoutMs,
            maxBytes: parsedOptions.maxDownloadBytes,
          }
        );
      }
      return readLocalImage(userData.src, baseDir, userData.type as ImageType);
    };

    const imageBuffer = await resolveBuffer();
    let image = sharp(imageBuffer, { failOn: "truncated" });

    if (userData.width || userData.height) {
      const resizeOptions: ResizeOptions = {
        width: userData.width ?? undefined,
        height: userData.height ?? undefined,
        fit: sharp.fit.cover,
        withoutEnlargement: true,
      };
      image = image.resize(resizeOptions);
    }

    const processedImage = await image
      .rotate()
      .toFormat(outputFormat as keyof FormatEnum, {
        quality: userData.quality,
      })
      .toBuffer();

    const sourceName = userData.src
      ? path.basename(userData.src, path.extname(userData.src))
      : "image";
    const processedFileName = `${sourceName}.${outputFormat}`;

    const etag = parsedOptions.etag
      ? `"${createHash("sha1").update(processedImage).digest("hex")}"`
      : undefined;

    if (etag && req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }

    res.type(mimeTypes[outputFormat]);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${processedFileName}"`
    );
    res.setHeader(
      "Cache-Control",
      parsedOptions.cacheControl ??
        "public, max-age=86400, stale-while-revalidate=604800"
    );
    if (etag) {
      res.setHeader("ETag", etag);
    }
    res.setHeader("Content-Length", processedImage.length.toString());
    res.send(processedImage);
    /* c8 ignore next */
  } catch (error) {
    try {
      const fallback = await FALLBACKIMAGES.normal();
      res.type(mimeTypes.jpeg);
      res.setHeader("Content-Disposition", `inline; filename="fallback.jpeg"`);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.send(fallback);
    } catch (fallbackError) {
      next(fallbackError);
    }
  }
};

/**
 * @function registerServe
 * @description A function to register the serveImage function as middleware for Express.
 * @param {PixelServeOptions} options - The options object for image processing.
 * @returns {function(Request, Response, NextFunction): Promise<void>} The middleware function.
 */
const registerServe = (options: PixelServeOptions) => {
  return async (req: Request, res: Response, next: NextFunction) =>
    serveImage(req, res, next, options);
};

export default registerServe;
