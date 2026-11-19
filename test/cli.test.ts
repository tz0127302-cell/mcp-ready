import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { main } from "../src/cli.js";
import { repoRoot } from "./helpers.js";

function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io = {
    stdout: { write(chunk: string) { stdout += chunk; } },
    stderr: { write(chunk: string) { stderr += chunk; } },
  };
  return main(argv, io).then((code) => ({ code, stdout, stderr }));
}

describe("cli", () => {
  it("prints help and version", async () => {
    const help = await capture(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /mcp-ready scan <path>/);
    assert.match(help.stdout, /mcp-ready generate/);
    assert.match(help.stdout, /mcp-ready init/);
    assert.match(help.stdout, /not affiliated/);
    const version = await capture(["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
    const missing = await capture([]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /USAGE/);
  });

  it("prints JSON for the sample spec", async () => {
    const result = await capture(["scan", "examples/orders-catalog/openapi.yaml", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { score: number; checks: unknown[]; disclaimer: string };
    assert.equal(typeof report.score, "number");
    assert.equal(report.checks.length, 9);
    assert.match(report.disclaimer, /independent/);
  });

  it("exits 2 when the score is under --fail-under", async () => {
    const low = await capture(["scan", "test/fixtures/sparse.openapi.yaml", "--json", "--fail-under", "90"]);
    assert.equal(low.code, 2);
    assert.match(low.stderr, /below 90/);
    const high = await capture(["scan", "test/fixtures/agent-ready", "--fail-under", "90", "--json"]);
    assert.equal(high.code, 0, high.stderr);
  });

  it("rejects unknown flags", async () => {
    const result = await capture(["scan", "examples/orders-catalog/openapi.yaml", "--nope"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown option/);
  });

  it("runs as a process", () => {
    const tsx = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
    const result = spawnSync(process.execPath, [tsx, path.join(repoRoot, "src/cli.ts"), "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fail-under/);
  });
});
