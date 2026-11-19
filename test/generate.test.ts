import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { generateServer } from "../src/generate.js";
import { repoRoot, removeDir, tempDir } from "./helpers.js";

const spec = path.join(repoRoot, "examples/orders-catalog/openapi.yaml");

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...extra };
}

describe("generate", () => {
  it("scaffolds a stdio server that lists tools and serves fixtures", async () => {
    const outDir = await tempDir("gen-");
    const stderr: string[] = [];
    let client: Client | undefined;
    try {
      const result = await generateServer({ specPath: spec, outDir });
      const names = result.tools.map((tool) => tool.name);
      assert.ok(names.includes("list_products"));
      assert.ok(names.includes("create_order"));
      assert.ok(names.includes("get_health"));
      assert.ok(!names.some((name) => name.includes("execute")));
      assert.ok(result.skipped.some((item) => item.path === "/admin/execute"));
      assert.ok(result.files.includes("src/index.ts"));

      const register = await readFile(path.join(outDir, "src/register.ts"), "utf8");
      assert.match(register, /registerTool/);
      assert.match(register, /idempotencyKey/);
      const fixtures = await readFile(path.join(outDir, "src/fixtures.ts"), "utf8");
      assert.match(fixtures, /Field Notebook/);
      const readme = await readFile(path.join(outDir, "README.md"), "utf8");
      assert.match(readme, /not affiliated/);
      assert.match(readme, /MCP_READY_MOCK=0/);

      const tsc = path.join(repoRoot, "node_modules/typescript/bin/tsc");
      const typecheck = spawnSync(process.execPath, [tsc, "-p", outDir, "--pretty", "false"], {
        cwd: outDir,
        encoding: "utf8",
      });
      assert.equal(typecheck.status, 0, `${typecheck.stdout}\n${typecheck.stderr}`);

      const tsx = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [tsx, "src/index.ts"],
        cwd: outDir,
        stderr: "pipe",
        env: childEnv(),
      });
      transport.stderr?.on("data", (chunk) => {
        stderr.push(String(chunk));
      });
      client = new Client({ name: "mcp-ready-test", version: "0.0.0" });
      await client.connect(transport);
      const listed = await client.listTools();
      const listedNames = listed.tools.map((tool) => tool.name);
      assert.ok(listedNames.includes("list_products"), stderr.join(""));
      const page = await client.callTool({ name: "list_products", arguments: { limit: 2 } });
      assert.match(JSON.stringify(page), /Field Notebook/);
      const created = await client.callTool({
        name: "create_order",
        arguments: { sku: "prod_notebook", quantity: 1, idempotencyKey: "retry-key-1" },
      });
      assert.match(JSON.stringify(created), /ord_1001/);
      const product = await client.callTool({
        name: "get_product",
        arguments: { productId: "prod_pen" },
      });
      assert.match(JSON.stringify(product), /prod_pen/);
    } finally {
      await client?.close().catch(() => undefined);
      await removeDir(outDir);
    }
  });

  it("calls a local HTTP server when mock mode is off", async () => {
    const outDir = await tempDir("live-");
    const seen: { url?: string; authorization?: string } = {};
    const httpServer = createServer((request, response) => {
      seen.url = request.url;
      seen.authorization = request.headers.authorization;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "from-live", name: "Live Notebook" }], nextCursor: null }));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const address = httpServer.address() as AddressInfo;
    let client: Client | undefined;
    try {
      await generateServer({ specPath: spec, outDir, force: true });
      const tsx = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [tsx, "src/index.ts"],
        cwd: outDir,
        stderr: "pipe",
        env: childEnv({
          MCP_READY_MOCK: "0",
          API_BASE_URL: `http://127.0.0.1:${address.port}`,
          API_TOKEN: "test-token",
        }),
      });
      client = new Client({ name: "mcp-ready-live", version: "0.0.0" });
      await client.connect(transport);
      const result = await client.callTool({ name: "list_products", arguments: {} });
      assert.match(JSON.stringify(result), /Live Notebook/);
      assert.match(seen.url ?? "", /^\/products/);
      assert.equal(seen.authorization, "Bearer test-token");
    } finally {
      await client?.close().catch(() => undefined);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await removeDir(outDir);
    }
  });

  it("refuses to overwrite a non-empty directory without --force", async () => {
    const outDir = await tempDir("occupied-");
    try {
      await generateServer({ specPath: spec, outDir });
      await assert.rejects(() => generateServer({ specPath: spec, outDir }), /not empty/);
      const again = await generateServer({ specPath: spec, outDir, force: true });
      assert.ok(again.tools.length > 0);
    } finally {
      await removeDir(outDir);
    }
  });
});
