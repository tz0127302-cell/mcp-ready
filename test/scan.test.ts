import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { renderMarkdown } from "../src/report/markdown.js";
import { renderTerminal } from "../src/report/terminal.js";
import { scan } from "../src/scan.js";
import { repoRoot, removeDir, tempDir } from "./helpers.js";

const exampleSpec = "examples/orders-catalog/openapi.yaml";
const exampleDir = "examples/orders-catalog";

function breakdown(report: Awaited<ReturnType<typeof scan>>): string {
  return report.checks.map((check) => `${check.id} ${check.score}/${check.maxScore} ${check.status}`).join(" | ");
}

describe("scan", () => {
  it("scores the orders catalog as ready with gaps", async () => {
    const fromFile = await scan(exampleSpec, { cwd: repoRoot });
    const fromDir = await scan(exampleDir, { cwd: repoRoot });
    assert.equal(fromFile.score, fromDir.score, `${breakdown(fromFile)} vs ${breakdown(fromDir)}`);
    assert.equal(fromFile.mode, "openapi");
    assert.equal(fromFile.spec?.title, "Orders & Catalog API");
    assert.equal(fromFile.spec?.operations, 8);
    assert.equal(
      fromFile.checks.reduce((sum, check) => sum + check.score, 0),
      fromFile.score,
    );
    assert.equal(
      fromFile.checks.reduce((sum, check) => sum + check.maxScore, 0),
      100,
    );
    assert.equal(fromFile.score, 65, breakdown(fromFile));
    assert.equal(fromFile.grade, "gaps");
    const byId = Object.fromEntries(fromFile.checks.map((check) => [check.id, check]));
    assert.equal(byId.pagination?.status, "pass");
    assert.equal(byId["rate-limits"]?.status, "pass");
    assert.equal(byId.webhooks?.status, "fail");
    assert.notEqual(byId.auth?.status, "fail");
    assert.ok((byId["agent-docs"]?.score ?? 0) < 5);
    assert.equal(byId.idempotency?.status, "partial");
    assert.ok(fromFile.recommendations.length >= 3);
    assert.match(fromFile.disclaimer, /not affiliated/);
    assert.equal(fromDir.discovery.routeHandlers.length >= 6, true);
    assert.ok(fromDir.discovery.graphql.queries.includes("products"));
    assert.equal(fromFile.discovery.routeHandlers.length, 0);

    const markdown = renderMarkdown(fromFile);
    assert.match(markdown, /MCP readiness: Orders & Catalog API/);
    assert.match(markdown, /\| Auth story \|/);
    assert.match(markdown, /## Checklist/);
    const terminal = renderTerminal(fromFile, { color: false, ascii: true });
    assert.match(terminal, /Score/);
    assert.match(terminal, new RegExp(String(fromFile.score)));
    assert.match(terminal, /Checklist/);
    assert.doesNotMatch(terminal, /\u001b/);
  });

  it("gives a fully documented API a perfect score", async () => {
    const report = await scan("test/fixtures/agent-ready", { cwd: repoRoot });
    assert.equal(report.score, 100, breakdown(report));
    assert.equal(report.grade, "agent-ready");
    assert.ok(report.checks.every((check) => check.status === "pass"));
  });

  it("scores a catch-all spec as not agent-ready", async () => {
    const report = await scan("test/fixtures/sparse.openapi.yaml", { cwd: repoRoot });
    assert.equal(report.mode, "openapi");
    assert.ok(report.score < 25, breakdown(report));
    assert.equal(report.grade, "not-ready");
    const auth = report.checks.find((check) => check.id === "auth");
    assert.equal(auth?.status, "fail");
    const pagination = report.checks.find((check) => check.id === "pagination");
    assert.equal(pagination?.status, "pass");
  });

  it("reads Swagger 2 with a conversion note", async () => {
    const report = await scan("test/fixtures/swagger2.yaml", { cwd: repoRoot });
    assert.equal(report.spec?.legacySwagger, true);
    assert.equal(report.spec?.title, "Legacy Widgets");
    assert.ok((report.spec?.operations ?? 0) >= 1);
    assert.match(report.recommendations.join(" "), /Swagger 2/);
  });

  it("infers a partial score from route handlers when there is no contract", async () => {
    const report = await scan("test/fixtures/source-api", { cwd: repoRoot });
    assert.equal(report.mode, "source");
    assert.equal(report.spec, null);
    assert.ok(report.discovery.routeHandlers.length >= 3);
    assert.match(report.recommendations.join(" "), /OpenAPI 3/);
    assert.ok(report.score >= 30 && report.score < 55, breakdown(report));
    assert.equal(report.grade, "at-risk");
  });

  it("lists GraphQL fields and does not treat the schema as OpenAPI", async () => {
    const report = await scan("test/fixtures/graphql-api", { cwd: repoRoot });
    assert.equal(report.mode, "graphql");
    assert.deepEqual(report.discovery.graphql.queries, ["product", "products"]);
    assert.deepEqual(report.discovery.graphql.mutations, ["createOrder"]);
    assert.deepEqual(report.discovery.graphql.subscriptions, ["orderUpdated"]);
    assert.match(report.recommendations.join("\n"), /one MCP tool per field|OpenAPI 3/);
    assert.ok(report.score >= 20 && report.score < 55, breakdown(report));
  });

  it("scores an empty directory as zero", async () => {
    const dir = await tempDir("empty-");
    try {
      const report = await scan(dir, { cwd: repoRoot });
      assert.equal(report.mode, "empty");
      assert.equal(report.score, 0);
      assert.equal(report.checks.length, 9);
    } finally {
      await removeDir(dir);
    }
  });

  it("rejects a missing path", async () => {
    await assert.rejects(() => scan("test/fixtures/missing.yaml", { cwd: repoRoot }), /Path not found/);
  });

  it("rejects a source file that is not a spec", async () => {
    await assert.rejects(() => scan(path.join(repoRoot, "src/scan.ts")), /not an OpenAPI file/);
  });
});
