import { stat } from "node:fs/promises";
import path from "node:path";
import { DISCLAIMER } from "./disclaimer.js";
import { discover } from "./discover.js";
import { McpReadyError } from "./errors.js";
import { loadSpec } from "./openapi/parse.js";
import type { ParsedSpec } from "./openapi/types.js";
import { gradeFor } from "./rubric.js";
import {
  displayPath,
  graphqlExtraRecommendation,
  rankRecommendations,
  scoreEmpty,
  scoreGraphql,
  scoreOpenApi,
  scoreSource,
  sourceExtraRecommendation,
} from "./score.js";
import type { CheckResult, ScanMode, ScanReport, SpecSummary } from "./types.js";
import { packageVersion } from "./version.js";

export interface ScanOptions {
  cwd?: string;
}

export async function scan(target: string, options: ScanOptions = {}): Promise<ScanReport> {
  const cwd = options.cwd ?? process.cwd();
  const resolved = path.resolve(cwd, target);
  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch {
    throw new McpReadyError(`Path not found: ${target}`);
  }

  let root = resolved;
  let specFile: string | undefined;
  let recursive = true;
  if (fileStat.isFile()) {
    if (!isSpecFile(resolved)) {
      throw new McpReadyError(
        `${target} is not an OpenAPI file. Pass an OpenAPI 3 YAML/JSON document or a project directory.`,
      );
    }
    root = path.dirname(resolved);
    specFile = resolved;
    recursive = false;
  } else if (!fileStat.isDirectory()) {
    throw new McpReadyError(`${target} is not a file or directory.`);
  }

  const discovery = await discover({ root, specFile, recursive });
  let spec: ParsedSpec | null = null;
  if (specFile) {
    spec = await loadSpec(specFile);
  } else if (discovery.openapiFiles.length > 0) {
    const ranked = [...discovery.openapiFiles].sort(compareSpecPaths);
    const chosen = ranked[0];
    if (chosen) spec = await loadSpec(path.join(root, chosen));
    if (ranked.length > 1) {
      discovery.notes.push(`Scored ${chosen}. Other OpenAPI documents: ${ranked.slice(1).join(", ")}.`);
    }
  }

  const mode = selectMode(spec, discovery);
  const checks = checksFor(mode, spec, discovery);
  const extras: string[] = [];
  if (mode === "source") extras.push(sourceExtraRecommendation());
  if (mode === "graphql") extras.push(graphqlExtraRecommendation());
  if (spec?.legacySwagger) {
    extras.push("Convert this Swagger 2.0 document to OpenAPI 3 so generate can map operations with fewer guesses.");
  }
  if (!specFile && discovery.openapiFiles.length > 1) {
    extras.push("Pass a specific OpenAPI file to score one of the other documents in this tree.");
  }
  for (const note of spec?.notes ?? []) discovery.notes.push(note);

  const score = checks.reduce((sum, check) => sum + check.score, 0);
  const grade = gradeFor(score);
  const shownTarget = path.isAbsolute(target) ? displayPath(resolved, cwd) : target.split(path.sep).join("/");

  return {
    tool: "mcp-ready",
    version: packageVersion(),
    disclaimer: DISCLAIMER,
    target: shownTarget,
    mode,
    score,
    grade: grade.id,
    gradeLabel: grade.label,
    spec: spec ? summarize(spec, cwd) : null,
    discovery,
    checks,
    recommendations: rankRecommendations(checks, extras),
    generatedAt: new Date().toISOString(),
  };
}

function checksFor(mode: ScanMode, spec: ParsedSpec | null, discovery: ScanReport["discovery"]): CheckResult[] {
  if (mode === "openapi" && spec) return scoreOpenApi(spec, discovery);
  if (mode === "graphql") return scoreGraphql(discovery);
  if (mode === "source") return scoreSource(discovery);
  return scoreEmpty();
}

function selectMode(spec: ParsedSpec | null, discovery: ScanReport["discovery"]): ScanMode {
  if (spec) return "openapi";
  if (discovery.graphqlFiles.length > 0) return "graphql";
  const signals = discovery.sourceSignals;
  const hasSignal =
    signals.auth ||
    signals.errors !== "none" ||
    signals.idempotency ||
    signals.paginationCursor ||
    signals.paginationOffset ||
    signals.webhooks ||
    signals.schemas ||
    signals.rateLimits;
  const hasDocs =
    discovery.readmeFiles.length > 0 ||
    discovery.llmsTxtFiles.length > 0 ||
    discovery.manifestFiles.length > 0 ||
    discovery.skillFiles.length > 0;
  if (discovery.routeHandlers.length > 0 || hasSignal || hasDocs) return "source";
  return "empty";
}

function summarize(spec: ParsedSpec, cwd: string): SpecSummary {
  return {
    path: displayPath(spec.sourcePath, cwd),
    openapi: spec.openapi,
    title: spec.info.title,
    version: spec.info.version,
    operations: spec.operations.length,
    legacySwagger: spec.legacySwagger,
  };
}

function compareSpecPaths(a: string, b: string): number {
  return rankSpec(a) - rankSpec(b) || a.length - b.length || a.localeCompare(b);
}

function rankSpec(rel: string): number {
  const base = path.basename(rel).toLowerCase();
  if (base === "openapi.yaml" || base === "openapi.yml") return 0;
  if (base === "openapi.json") return 1;
  if (base.includes("openapi")) return 2;
  if (base.includes("swagger")) return 3;
  return 4;
}

function isSpecFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base);
  if (ext !== ".yaml" && ext !== ".yml" && ext !== ".json") return false;
  return true;
}
