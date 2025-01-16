# Image Server Middleware

A powerful and customizable middleware for processing, resizing, and serving images in Node.js applications. Built with **TypeScript** and powered by **Sharp**, this package allows you to handle local and network images with robust error handling, fallback images, and customizable options.

---

## Features

- 🖼️ **Dynamic Image Resizing and Formatting**

  - Supports various formats: `jpeg`, `png`, `webp`, `gif`, `tiff`, `avif`, and `svg`.
  - Adjustable dimensions with constraints for safety.

- 🌐 **Network and Local File Handling**

  - Fetches images from allowed network domains.
  - Processes images stored locally with safe path validation.

- 🔒 **Fallback Images**

  - Provides fallback images for invalid or missing sources.

- 🔧 **Highly Configurable**

  - Flexible option to set base directories, private folders, and user-specific paths.
  - Supports user-defined ID handlers and folder logic.

- 🚀 **Efficient and Scalable**
  - Built on **Sharp** for high-performance image processing.
  - Handles concurrent requests with ease.

---

## Installation

Install the package using npm or yarn:

```bash
npm install pixel-serve-server
```

---

## Usage

### Basic Setup

Here’s how to integrate the middleware with an Express application:

```typescript
import express from "express";
import { registerServe } from "pixel-serve-server";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_IMAGE_DIR = path.join(__dirname, "../assets/images/public");
const PRIVATE_IMAGE_DIR = path.join(__dirname, "../assets/images/private");

const serveImage = registerServe({
  baseDir: BASE_IMAGE_DIR, // Base directory for local images
  idHandler: (id: string) => `user-${id}`, // Custom handler for user IDs
  getUserFolder: async (id: string) => `/private/users/${id}`, // Logic for user-specific folder paths
  websiteURL: "example.com", // Your website's base URL
  apiRegex: /^\/api\/v1\//, // Regex for removing API prefixes
  allowedNetworkList: ["trusted.com"], // List of allowed network domains
});

app.get("/api/v1/pixel/serve", serveImage);

app.listen(3000, () => {
  console.log("Server is running on http://localhost:3000");
});
```

---

### Options

The `serveImage` middleware accepts the following options:

| Option               | Type       | Description                                                 |
| -------------------- | ---------- | ----------------------------------------------------------- |
| `baseDir`            | `string`   | Base directory for local image files.                       |
| `idHandler`          | `Function` | Function to handle and format user IDs.                     |
| `getUserFolder`      | `Function` | Async function to resolve a user-specific folder path.      |
| `websiteURL`         | `string`   | Your website's base URL for identifying internal resources. |
| `apiRegex`           | `RegExp`   | Regex to strip API prefixes from internal paths.            |
| `allowedNetworkList` | `string[]` | List of allowed domains for network images.                 |

---

### Example Requests

#### Fetching a Local Image

```bash
GET http://localhost:3000/images?src=/uploads/image1.jpg&width=300&height=300
```

#### Fetching a Network Image

```bash
GET http://localhost:3000/images?src=https://trusted.com/image2.jpg&format=webp
```

#### Handling Private User Folders

```bash
GET http://localhost:3000/images?src=/avatar.jpg&folder=private&userId=12345
```

---

### User Data Parameters

The middleware uses the following `UserData` query parameters:

| Parameter | Type                    | Description                                          |
| --------- | ----------------------- | ---------------------------------------------------- |
| `src`     | `string`                | Path or URL to the image source.                     |
| `format`  | `ImageFormat`           | Desired output format (e.g., `jpeg`, `png`, `webp`). |
| `width`   | `number`                | Desired width of the output image.                   |
| `height`  | `number`                | Desired height of the output image.                  |
| `quality` | `number`                | Image quality (1-100, default: 80).                  |
| `folder`  | `'public' \| 'private'` | Image folder type (default: `public`).               |
| `userId`  | `string \| null`        | User ID for private folder access.                   |
| `type`    | `'normal' \| 'avatar'`  | Image type (default: `normal`).                      |

---

### Image Formats

The following image formats are supported:

- `jpeg`
- `jpg`
- `png`
- `webp`
- `gif`
- `tiff`
- `avif`
- `svg`

Each format is processed with the specified quality settings.

---

### Advanced Configuration

#### Custom ID Handler

Use the `idHandler` option to customize how user IDs are formatted.

```typescript
const options = {
  idHandler: (id) => `user-${id.toUpperCase()}`, // Converts ID to uppercase with "user-" prefix
};
```

#### Resolving User Folders

The `getUserFolder` function dynamically resolves private folder paths for users.

```typescript
const options = {
  getUserFolder: async (id) => `/private/data/users/${id}`, // Returns a private directory path
};
```

#### Allowed Network Domains

Whitelist trusted domains for fetching network images.

```typescript
const options = {
  allowedNetworkList: ["example.com", "cdn.example.com"], // Only allows images from these domains
};
```

---

### Error Handling

The middleware automatically falls back to pre-defined images for errors:

| Error Condition               | Fallback Behavior               |
| ----------------------------- | ------------------------------- |
| Invalid local path            | Returns a fallback image.       |
| Unsupported network domain    | Returns a fallback image.       |
| Invalid or missing parameters | Defaults to placeholder values. |

### Dependencies

This package uses the following dependencies:

- **Express**: HTTP server framework.
- **Sharp**: High-performance image processing.
- **Axios**: HTTP client for fetching network images.

---

### License

This package is licensed under the [MIT License](LICENSE).

### Feedback

If you encounter issues or have suggestions, feel free to open an [issue](https://github.com/Hiprax/pixel-serve-server/issues).
