import { readFile } from "node:fs/promises";

/** Load local KEY=value settings without overriding an explicitly exported env var. */
export async function loadDotEnv(path = ".env"): Promise<void> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value = rawValue.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
    process.env[key] = value;
  }
}
