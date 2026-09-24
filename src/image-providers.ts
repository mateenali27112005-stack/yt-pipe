import { openAiImageProvider, type ImageProvider } from "./image.ts";
import { fakeImageProvider } from "./providers/fake-image-provider.ts";

export const imageProviderNames = ["fake", "openai"] as const;
export type ImageProviderName = (typeof imageProviderNames)[number];

export function getImageProvider(name: string): ImageProvider {
  switch (name) {
    case "fake":
      return fakeImageProvider;
    case "openai":
      return openAiImageProvider;
    default:
      throw new Error(`Unknown image provider '${name}'. Choose one of: ${imageProviderNames.join(", ")}.`);
  }
}
