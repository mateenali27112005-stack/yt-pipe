import type { ImageProvider } from "../image.ts";

// A valid 1x1 PNG makes the full asset lifecycle testable without a network call.
const DETERMINISTIC_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

export const fakeImageProvider: ImageProvider = {
  name: "deterministic-fake-image",
  async generate() {
    return {
      bytes: new Uint8Array(DETERMINISTIC_PNG),
      model: "deterministic-fake-v1"
    };
  }
};
