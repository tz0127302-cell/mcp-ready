import assert from "node:assert/strict";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { initProject } from "../src/init.js";
import { scan } from "../src/scan.js";
import { repoRoot, removeDir, tempDir } from "./helpers.js";

describe("init", () => {
  it("writes llms.txt, a manifest, and a skill hint", async () => {
    const dir = await tempDir("init-");
    try {
      const result = await initProject({
        target: dir,
        name: "Warehouse",
        description: "Track bins and pick lists.",
        url: "https://warehouse.example.com",
      });
      assert.deepEqual(result.written.sort(), ["AGENTS.md", "llms.txt", "mcp.manifest.json"]);
      const llms = await readFile(path.join(dir, "llms.txt"), "utf8");
      assert.match(llms, /^# Warehouse/);
      assert.match(llms, /warehouse\.example\.com/);
      assert.match(llms, /not affiliated/);
      const manifest = JSON.parse(await readFile(path.join(dir, "mcp.manifest.json"), "utf8")) as {
        unofficial: boolean;
        transport: { type: string };
      };
      assert.equal(manifest.unofficial, true);
      assert.equal(manifest.transport.type, "stdio");
      const agents = await readFile(path.join(dir, "AGENTS.md"), "utf8");
      assert.match(agents, /Idempotency-Key/);
      await assert.rejects(() => initProject({ target: dir }), /already exist/);
      const forced = await initProject({ target: dir, force: true, name: "Warehouse" });
      assert.equal(forced.written.length, 3);
    } finally {
      await removeDir(dir);
    }
  });

  it("raises the agent-docs score of the sample catalog", async () => {
    const dir = await tempDir("catalog-");
    try {
      await cp(path.join(repoRoot, "examples/orders-catalog"), dir, { recursive: true });
      const before = await scan(dir, { cwd: repoRoot });
      const result = await initProject({ target: dir });
      assert.ok(result.suggestedTools >= 5);
      const after = await scan(dir, { cwd: repoRoot });
      const beforeDocs = before.checks.find((check) => check.id === "agent-docs")?.score ?? 0;
      const afterDocs = after.checks.find((check) => check.id === "agent-docs")?.score ?? 0;
      assert.ok(afterDocs > beforeDocs, `${beforeDocs} -> ${afterDocs}`);
      assert.ok(after.score > before.score);
      const llms = await readFile(path.join(dir, "llms.txt"), "utf8");
      assert.match(llms, /list_products|listProducts|Orders & Catalog/);
    } finally {
      await removeDir(dir);
    }
  });
});
