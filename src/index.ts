/**
 * @module ImageService
 * @description A module to serve, process, and manage image delivery for web applications.
 */

export { default as registerServe } from "./pixel";
export * from "./types";
export { optionsSchema, userDataSchema } from "./schema";
export {
  isValidPath,
  isPrivateIp,
  isPublicHost,
  resolvePinnedAddress,
  buildPinnedAgents,
  stripApiPrefix,
  resolveInternalLocalPath,
} from "./functions";
export {
  buildFilename,
  buildSourceIdentifier,
  buildDeterministicEtag,
  isInsideRoot,
  looksLikeSvg,
  resolveRootDir,
} from "./pixel";
