import path from "node:path";
import sharp, { FormatEnum, ResizeOptions } from "sharp";
import type { Request, Response, NextFunction } from "express";
import type { Options, UserData, ImageFormat, ImageType } from "./types";
import { allowedFormats, mimeTypes } from "./variables";
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
 * @param {Options} options - The options object for image processing.
 * @returns {Promise<void>}
 */
const serveImage = async (
  req: Request,
  res: Response,
  next: NextFunction,
  options: Options
) => {
  try {
    const userData = renderUserData(req.query as UserData);
    const parsedOptions = renderOptions(options);

    let imageBuffer;
    let baseDir = parsedOptions.baseDir;
    let parsedUserId;

    if (userData.userId) {
      const userIdStr =
        typeof userData.userId === "object"
          ? String(Object.values(userData.userId)[0])
          : String(userData.userId);
      if (parsedOptions.idHandler) {
        parsedUserId = parsedOptions.idHandler(userIdStr);
      } else {
        parsedUserId = userIdStr;
      }
    }

    if (userData.folder === "private" && parsedUserId) {
      baseDir = await parsedOptions.getUserFolder(parsedUserId, req);
    }

    const outputFormat = allowedFormats.includes(
      userData.format.toLowerCase() as ImageFormat
    )
      ? userData.format.toLowerCase()
      : "jpeg";

    if (userData?.src?.startsWith("http")) {
      imageBuffer = await fetchImage(
        userData.src,
        baseDir,
        parsedOptions.websiteURL,
        userData.type as ImageType,
        parsedOptions.apiRegex
      );
    } else {
      imageBuffer = await readLocalImage(
        userData?.src ?? "",
        baseDir,
        userData.type as ImageType
      );
    }

    let image = sharp(imageBuffer);

    if (userData?.width || userData?.height) {
      const resizeOptions = {
        width: userData?.width ?? undefined,
        height: userData?.height ?? undefined,
        fit: sharp.fit.cover,
      };
      image = image.resize(resizeOptions as ResizeOptions);
    }

    const processedImage = await image
      .toFormat(outputFormat as keyof FormatEnum, {
        quality: userData?.quality ? Number(userData.quality) : 80,
      })
      .toBuffer();

    const processedFileName = `${path.basename(
      userData.src ?? "",
      path.extname(userData.src ?? "")
    )}.${outputFormat}`;

    res.type(mimeTypes[outputFormat]);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${processedFileName}"`
    );
    res.send(processedImage);
  } catch (error) {
    next(error);
  }
};

export default serveImage;
