import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function packageVersion(): string {
  if (cached) return cached;
  const url = new URL("../package.json", import.meta.url);
  const raw = readFileSync(fileURLToPath(url), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  cached = parsed.version ?? "0.0.0";
  return cached;
}
