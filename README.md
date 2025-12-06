# Pixel Serve Server

A modern, type-safe middleware for processing, resizing, and serving images in Node.js applications. Built with **TypeScript**, powered by **Sharp**, and designed for secure production use with ESM & CJS bundles.

## Features

- 🖼️ **Dynamic resizing & formatting**: `jpeg`, `png`, `webp`, `gif`, `tiff`, `avif`, `svg` with configurable width/height bounds and quality limits
- 🌐 **Secure source resolution**: Strict path validation, domain allowlists, and MIME type checks for network fetches
- 🔒 **Fallbacks & private folders**: Built-in placeholder images plus async `getUserFolder` for private assets
- ⚡ **Caching ready**: ETag + Cache-Control headers out of the box
- 🧪 **Type-safe & tested**: 100% TypeScript with Vitest coverage and exported Zod schemas
- ♻️ **Dual builds**: Works in both ESM and CommonJS environments

## Installation

```bash
npm install pixel-serve-server
# or
yarn add pixel-serve-server
# or
pnpm add pixel-serve-server
```

## Quick Start

### Basic Setup (Express)

```typescript
import express from "express";
import { registerServe } from "pixel-serve-server";
import path from "node:path";

const app = express();

const serveImage = registerServe({
  baseDir: path.join(__dirname, "../assets/images/public"),
});

app.get("/api/v1/pixel/serve", serveImage);

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
```

### Advanced Setup with All Options

```typescript
import express from "express";
import { registerServe } from "pixel-serve-server";
import path from "node:path";

const app = express();

const serveImage = registerServe({
  // Required: Base directory for public images
  baseDir: path.join(__dirname, "../assets/images/public"),

  // Custom user ID handler
  idHandler: (id: string) => `user-${id}`,

  // Async function to resolve private folder paths
  getUserFolder: async (req, userId) => {
    // Your logic to resolve user-specific folder
    return `/private/users/${userId}`;
  },

  // Your website's base URL (for treating internal URLs as local)
  websiteURL: "example.com",

  // Regex to strip API prefix from internal URLs
  apiRegex: /^\/api\/v1\//,

  // Allowed remote hosts for fetching network images
  allowedNetworkList: ["cdn.example.com", "images.example.com"],

  // Custom Cache-Control header
  cacheControl: "public, max-age=86400, stale-while-revalidate=604800",

  // Enable/disable ETag generation
  etag: true,

  // Image dimension bounds
  minWidth: 50,
  maxWidth: 4000,
  minHeight: 50,
  maxHeight: 4000,

  // Default JPEG/WebP/AVIF quality
  defaultQuality: 80,

  // Network fetch timeout (ms)
  requestTimeoutMs: 5000,

  // Maximum download size from remote sources (bytes)
  maxDownloadBytes: 5_000_000,
});

app.get("/api/v1/pixel/serve", serveImage);

app.listen(3000);
```

## Configuration Options

| Option               | Type                                      | Default                    | Description                                                             |
| -------------------- | ----------------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `baseDir`            | `string`                                  | **required**               | Base directory for local images                                         |
| `idHandler`          | `(id: string) => string`                  | `id => id`                 | Transform user IDs before lookup                                        |
| `getUserFolder`      | `(req, id?) => string \| Promise<string>` | `undefined`                | Resolve private folder path when `folder=private`                       |
| `websiteURL`         | `string`                                  | `undefined`                | If set, internal URLs pointing to this host are treated as local assets |
| `apiRegex`           | `RegExp`                                  | `/^\/api\/v1\//`           | Prefix stripped from internal URLs before lookup                        |
| `allowedNetworkList` | `string[]`                                | `[]`                       | Allowed remote hosts. Others immediately fall back                      |
| `cacheControl`       | `string`                                  | `public, max-age=86400...` | Cache-Control header value                                              |
| `etag`               | `boolean`                                 | `true`                     | Emit ETag and honor If-None-Match                                       |
| `minWidth`           | `number`                                  | `50`                       | Minimum accepted width                                                  |
| `maxWidth`           | `number`                                  | `4000`                     | Maximum accepted width                                                  |
| `minHeight`          | `number`                                  | `50`                       | Minimum accepted height                                                 |
| `maxHeight`          | `number`                                  | `4000`                     | Maximum accepted height                                                 |
| `defaultQuality`     | `number`                                  | `80`                       | Default JPEG/WebP/AVIF quality                                          |
| `requestTimeoutMs`   | `number`                                  | `5000`                     | Network fetch timeout                                                   |
| `maxDownloadBytes`   | `number`                                  | `5_000_000`                | Maximum remote download size                                            |

## Query Parameters

| Parameter | Type                    | Default     | Description                                                         |
| --------- | ----------------------- | ----------- | ------------------------------------------------------------------- |
| `src`     | `string`                | _required_  | Path or URL to the image source                                     |
| `format`  | `ImageFormat`           | `jpeg`      | Output format (`jpeg`, `png`, `webp`, `gif`, `tiff`, `avif`, `svg`) |
| `width`   | `number`                | `undefined` | Desired output width (px)                                           |
| `height`  | `number`                | `undefined` | Desired output height (px)                                          |
| `quality` | `number`                | `80`        | Image quality (1-100)                                               |
| `folder`  | `'public' \| 'private'` | `public`    | Image folder type                                                   |
| `userId`  | `string`                | `undefined` | User ID for private folder access                                   |
| `type`    | `'normal' \| 'avatar'`  | `normal`    | Image type (affects fallback image)                                 |

## Example Requests

### Local Image with Resize

```bash
GET /api/v1/pixel/serve?src=uploads/photo.jpg&width=800&height=600&format=webp
```

### Network Image

```bash
GET /api/v1/pixel/serve?src=https://cdn.example.com/image.jpg&format=avif&quality=90
```

### Private User Image

```bash
GET /api/v1/pixel/serve?src=avatar.jpg&folder=private&userId=12345&type=avatar
```

## Integration with Pixel Serve Client

This package is designed to work seamlessly with [`pixel-serve-client`](https://www.npmjs.com/package/pixel-serve-client), a React component that automatically generates the correct query parameters.

```tsx
// Client-side (React)
import Pixel from "pixel-serve-client";

<Pixel
  src="/uploads/photo.jpg"
  width={800}
  height={600}
  backendUrl="/api/v1/pixel/serve"
/>;
```

## Security Features

### Path Traversal Protection

All local paths are validated to prevent directory traversal attacks:

- Rejects paths with `..`
- Rejects absolute paths
- Validates resolved paths stay within `baseDir`
- Rejects null bytes and control characters

### Network Image Security

- Only fetches from explicitly allowed domains (`allowedNetworkList`)
- Validates MIME type of responses
- Configurable timeout and size limits
- Rejects non-HTTP/HTTPS protocols

### Private Folder Access

Use `getUserFolder` to implement your own authentication/authorization logic:

```typescript
const serveImage = registerServe({
  baseDir: "/public/images",
  getUserFolder: async (req, userId) => {
    const user = await verifyToken(req.headers.authorization);
    if (!user || user.id !== userId) {
      return null; // Will use baseDir instead
    }
    return `/private/users/${userId}`;
  },
});
```

## Fallback Images

The package includes built-in fallback images for:

- **Normal images**: Displayed when an image cannot be loaded
- **Avatars**: Displayed when an avatar image cannot be loaded

These are automatically served when:

- The requested image doesn't exist
- Path validation fails
- Network fetch fails or returns invalid data
- Image processing fails

## Exports

```typescript
// Main middleware factory
import { registerServe } from "pixel-serve-server";

// Types
import type {
  PixelServeOptions,
  UserData,
  ImageFormat,
  ImageType,
} from "pixel-serve-server";

// Zod schemas for validation
import { optionsSchema, userDataSchema } from "pixel-serve-server";

// Utility function
import { isValidPath } from "pixel-serve-server";
```

## Module Formats

```typescript
// ESM
import { registerServe } from "pixel-serve-server";

// CommonJS
const { registerServe } = require("pixel-serve-server");
```

## Requirements

- Node.js >= 18
- Express 5.x (peer dependency)

## Dependencies

- **Sharp**: High-performance image processing
- **Axios**: HTTP client for fetching network images
- **Zod**: Runtime validation for options and query params

## License

MIT

## Contributing

Issues and pull requests are welcome at [GitHub](https://github.com/Hiprax/pixel-serve-server).
