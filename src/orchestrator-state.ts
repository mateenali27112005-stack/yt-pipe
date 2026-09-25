import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ProductionRunState } from "./orchestrator-types.ts";

export const stateFilename = ".production-state.json";

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function hashArtifact(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.staging-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${canonicalJson(value)}\n`, { flag: "wx" });
    await rename(temporary, destination);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

export async function saveRunState(runDirectory: string, state: ProductionRunState): Promise<void> { await atomicWriteJson(resolve(runDirectory, stateFilename), state); }

export async function loadRunState(runDirectory: string): Promise<ProductionRunState | undefined> {
  try { return JSON.parse(await readFile(resolve(runDirectory, stateFilename), "utf8")) as ProductionRunState; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error(`Could not read ${stateFilename}: ${cause instanceof Error ? cause.message : String(cause)}`); }
}

export async function readArtifact<T>(runDirectory: string, path: string): Promise<T> { return JSON.parse(await readFile(resolve(runDirectory, path), "utf8")) as T; }
