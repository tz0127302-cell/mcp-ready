import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { extractGraphqlFields, mergeGraphql } from "./graphql.js";
import type { Discovery, RouteHit } from "./types.js";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  ".tmp-tests",
  "vendor",
  "out",
  "target",
]);

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".java", ".kt"]);
const MAX_FILES = 4000;
const MAX_DEPTH = 8;
const MAX_READ = 700_000;

export interface WalkTarget {
  /** Directory whose contents are in scope. */
  root: string;
  /** When set, only this OpenAPI file is the contract. */
  specFile?: string;
  /** File targets only inspect siblings, not nested packages. */
  recursive: boolean;
}

export async function discover(target: WalkTarget): Promise<Discovery> {
  const files = target.recursive ? await walk(target.root) : await listSiblingFiles(target.root);
  const discovery: Discovery = {
    openapiFiles: [],
    graphqlFiles: [],
    readmeFiles: [],
    llmsTxtFiles: [],
    manifestFiles: [],
    skillFiles: [],
    routeHandlers: [],
    graphql: { queries: [], mutations: [], subscriptions: [] },
    sourceSignals: {
      auth: false,
      errors: "none",
      idempotency: false,
      paginationCursor: false,
      paginationOffset: false,
      webhooks: false,
      schemas: false,
      rateLimits: false,
      readmeMentionsAgents: false,
    },
    filesScanned: files.length,
    notes: [],
  };

  const graphqlParts = [];
  for (const file of files) {
    const rel = path.relative(target.root, file);
    const base = path.basename(file);
    const lower = base.toLowerCase();
    if (isLlms(lower)) discovery.llmsTxtFiles.push(rel);
    if (isReadme(lower)) discovery.readmeFiles.push(rel);
    if (isManifest(rel)) discovery.manifestFiles.push(rel);
    if (isSkill(lower)) discovery.skillFiles.push(rel);
    if (lower.endsWith(".graphql") || lower.endsWith(".gql")) discovery.graphqlFiles.push(rel);

    if (target.specFile && path.resolve(file) === path.resolve(target.specFile)) {
      discovery.openapiFiles.push(rel || path.basename(file));
      continue;
    }
    if (!target.specFile && (await looksLikeOpenApi(file))) {
      discovery.openapiFiles.push(rel);
    }
  }

  if (target.specFile) {
    const rel = path.relative(target.root, target.specFile);
    if (!discovery.openapiFiles.includes(rel) && !discovery.openapiFiles.includes(path.basename(target.specFile))) {
      discovery.openapiFiles.unshift(rel || path.basename(target.specFile));
    }
  }

  const codeFiles = files.filter((file) => CODE_EXT.has(path.extname(file).toLowerCase()));
  const graphqlFiles = files.filter((file) => {
    const lower = path.basename(file).toLowerCase();
    return lower.endsWith(".graphql") || lower.endsWith(".gql");
  });
  const readmeFiles = files.filter((file) => isReadme(path.basename(file).toLowerCase()));

  for (const file of graphqlFiles) {
    const text = await readText(file);
    if (!text) continue;
    graphqlParts.push(extractGraphqlFields(text));
    absorbSignals(discovery, text);
  }
  discovery.graphql = mergeGraphql(graphqlParts);

  for (const file of readmeFiles) {
    const text = await readText(file);
    if (text && mentionsAgents(text)) discovery.sourceSignals.readmeMentionsAgents = true;
  }

  for (const file of codeFiles) {
    const text = await readText(file);
    if (!text) continue;
    const rel = path.relative(target.root, file);
    discovery.routeHandlers.push(...findRoutes(rel, text));
    absorbSignals(discovery, text);
  }

  discovery.openapiFiles.sort();
  discovery.routeHandlers.sort((a, b) => a.file.localeCompare(b.file) || a.method.localeCompare(b.method));
  return discovery;
}

function absorbSignals(discovery: Discovery, text: string): void {
  const signals = discovery.sourceSignals;
  if (/authorization|bearer|\bjwt\b|jsonwebtoken|api[-_ ]?key|\boauth\b|passport|clerk|auth0/i.test(text)) {
    signals.auth = true;
  }
  if (/problem\+json|errorHandler|HttpException|ZodError|ExceptionHandler|\(\s*err\b/i.test(text)) {
    signals.errors = "handler";
  }
  else if (signals.errors === "none" && /\bcatch\s*\(/.test(text) && /status\s*[:(]|res\.status\(/.test(text)) {
    signals.errors = "catch";
  }
  if (/idempotency[-_ ]?key/i.test(text)) signals.idempotency = true;
  if (/\bcursor\b|pageToken|starting_after|nextCursor/i.test(text)) signals.paginationCursor = true;
  if (/\blimit\b|\boffset\b|pageSize|per_page|\bpage\b/i.test(text)) signals.paginationOffset = true;
  if (/\bwebhook/i.test(text)) signals.webhooks = true;
  if (/\bzod\b|\bjoi\b|\byup\b|typebox|jsonschema|io-ts/i.test(text)) signals.schemas = true;
  if (/rate[-_ ]?limit|\b429\b|Retry-After/i.test(text)) signals.rateLimits = true;
}

function findRoutes(file: string, text: string): RouteHit[] {
  const hits: RouteHit[] = [];
  const express =
    /\b(?:app|router|fastify|server)\.(get|post|put|patch|delete|all|head|options)\(\s*["'`]([^"'`]*)["'`]/gi;
  for (const match of text.matchAll(express)) {
    const method = match[1]?.toLowerCase();
    if (!method) continue;
    hits.push({
      file,
      framework: "http",
      method: method === "all" ? "*" : method,
      ...(match[2] ? { path: match[2] } : {}),
    });
  }
  const nest = /@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*["'`]([^"'`]*)["'`]\s*\)/g;
  for (const match of text.matchAll(nest)) {
    const method = match[1]?.toLowerCase();
    if (!method) continue;
    hits.push({
      file,
      framework: "nest",
      method: method === "all" ? "*" : method,
      ...(match[2] ? { path: match[2] } : {}),
    });
  }
  const nextFn = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
  for (const match of text.matchAll(nextFn)) {
    const method = match[1]?.toLowerCase();
    if (!method) continue;
    hits.push({ file, framework: "next", method });
  }
  const nextConst = /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
  for (const match of text.matchAll(nextConst)) {
    const method = match[1]?.toLowerCase();
    if (!method) continue;
    hits.push({ file, framework: "next", method });
  }
  return hits;
}

async function looksLikeOpenApi(file: string): Promise<boolean> {
  const base = path.basename(file).toLowerCase();
  const ext = path.extname(base);
  if (ext !== ".yaml" && ext !== ".yml" && ext !== ".json") return false;
  if (base === "package.json" || base.endsWith("package-lock.json") || base === "tsconfig.json") return false;
  if (/openapi|swagger/.test(base)) return true;
  const head = await readText(file, 4000);
  if (!head) return false;
  return /^\s*openapi\s*:/m.test(head) || /^\s*swagger\s*:/m.test(head) || /"openapi"\s*:/.test(head) || /"swagger"\s*:/.test(head);
}

async function listSiblingFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    files.push(path.join(root, entry.name));
  }
  return files;
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(full);
    }
  }
  await visit(root, 0);
  return files;
}

async function readText(file: string, max = MAX_READ): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > max) return undefined;
    const text = await readFile(file, "utf8");
    if (text.includes("\u0000")) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function isLlms(base: string): boolean {
  return base === "llms.txt";
}

function isReadme(base: string): boolean {
  return base === "readme" || base === "readme.md" || base === "readme.txt";
}

function isSkill(base: string): boolean {
  return base === "agents.md" || base === "skill.md";
}

function isManifest(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").toLowerCase();
  const base = path.basename(norm);
  if (base === "mcp.manifest.json" || base === "mcp.json") return true;
  return norm.endsWith(".well-known/mcp.json") || norm.endsWith(".mcp/manifest.json");
}

function mentionsAgents(text: string): boolean {
  return (
    /\b(llms\.txt|agents?\.md)\b/i.test(text) ||
    /\bmodel context protocol\b/i.test(text) ||
    /\bagents?\b/i.test(text) ||
    /\bmcp server\b/i.test(text) ||
    /\bmcp manifest\b/i.test(text)
  );
}
