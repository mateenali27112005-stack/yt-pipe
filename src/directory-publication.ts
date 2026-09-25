import { access, rename, rm } from "node:fs/promises";

export interface DirectoryPublicationOperations {
  exists(path: string): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const filesystemOperations: DirectoryPublicationOperations = {
  async exists(path) { try { await access(path); return true; } catch { return false; } },
  rename,
  async remove(path) { await rm(path, { recursive: true, force: true }); }
};

export async function publishDirectory(stagingPath: string, outputPath: string, overwrite: boolean, operations = filesystemOperations): Promise<void> {
  const exists = await operations.exists(outputPath);
  if (!exists) return operations.rename(stagingPath, outputPath);
  if (!overwrite) throw new Error(`Refusing to write into existing ${outputPath}. Choose a new run directory or pass --overwrite explicitly.`);
  const backupPath = `${outputPath}.backup-${process.pid}-${Date.now()}`;
  await operations.rename(outputPath, backupPath);
  try {
    await operations.rename(stagingPath, outputPath);
  } catch (cause) {
    if (!(await operations.exists(outputPath)) && await operations.exists(backupPath)) await operations.rename(backupPath, outputPath);
    throw cause;
  }
  await operations.remove(backupPath);
}
