import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function tempDir(prefix: string): Promise<string> {
  const root = path.join(repoRoot, ".tmp-tests");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
