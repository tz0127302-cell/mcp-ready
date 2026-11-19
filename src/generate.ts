import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DISCLAIMER } from "./disclaimer.js";
import { McpReadyError } from "./errors.js";
import { toArgName, toServerName, toToolName } from "./names.js";
import { loadSpec } from "./openapi/parse.js";
import { effectiveSchema, exampleFromSchema, zodFromSchema } from "./openapi/schema.js";
import { hasIdempotencyKey, isCatchAllPath, isGenericAction, mentionsIdempotent, operationProse } from "./openapi/shape.js";
import type { JsonSchema, Operation, ParsedSpec } from "./openapi/types.js";
import type { GenerateOptions, GenerateResult, GeneratedTool, SkippedOperation } from "./types.js";

const SERVER_SDK = "2.4.0";
const ZOD_VERSION = "4.6.7";
const TSX_VERSION = "4.23.15";
const TS_VERSION = "5.9.3";
const NODE_TYPES = "22.19.7";

interface WireField {
  arg: string;
  wire: string;
}

interface ToolPlan {
  operation: Operation;
  operationId: string;
  toolName: string;
  description: string;
  title: string;
  fields: PlannedField[];
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  fixture: unknown;
}

interface PlannedField extends WireField {
  location: "path" | "query" | "header" | "body";
  required: boolean;
  zod: string;
}

export async function generateServer(options: GenerateOptions): Promise<GenerateResult> {
  const spec = await loadSpec(path.resolve(options.specPath));
  const maxTools = options.maxTools ?? 24;
  if (!Number.isInteger(maxTools) || maxTools < 1) {
    throw new McpReadyError("--max-tools must be a positive integer.");
  }
  const outDir = path.resolve(options.outDir);
  await assertOutDir(outDir, options.force ?? false);

  const serverName = toServerName(options.name ?? spec.info.title);
  const { tools, skipped } = planTools(spec, maxTools);
  const files: Record<string, string> = {
    "package.json": packageJson(serverName),
    "tsconfig.json": tsconfig(),
    ".gitignore": "node_modules/\ndist/\n",
    "README.md": readme(spec, serverName, tools, skipped),
    "src/index.ts": indexSource(spec, serverName),
    "src/register.ts": registerSource(tools),
    "src/operations.ts": operationsSource(tools),
    "src/fixtures.ts": fixturesSource(tools),
    "src/backend.ts": backendSource(),
  };

  await mkdir(path.join(outDir, "src"), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(outDir, name), contents);
  }

  return {
    outDir,
    serverName,
    packageName: serverName,
    files: Object.keys(files),
    tools: tools.map((tool) => ({
      name: tool.toolName,
      operationId: tool.operationId,
      method: tool.operation.method.toUpperCase(),
      path: tool.operation.path,
      description: tool.description,
    })),
    skipped,
  };
}

async function assertOutDir(outDir: string, force: boolean): Promise<void> {
  let existing: string[] | undefined;
  try {
    existing = await readdir(outDir);
  } catch {
    existing = undefined;
  }
  const clutter = (existing ?? []).filter((name) => name !== ".gitkeep" && name !== ".DS_Store");
  if (clutter.length > 0 && !force) {
    throw new McpReadyError(`${outDir} is not empty. Pass --force to overwrite the generated files.`);
  }
  await mkdir(outDir, { recursive: true });
}

function planTools(spec: ParsedSpec, maxTools: number): { tools: ToolPlan[]; skipped: SkippedOperation[] } {
  const skipped: SkippedOperation[] = [];
  const candidates: Operation[] = [];
  for (const operation of spec.operations) {
    if (operation.deprecated) {
      skipped.push(skip(operation, "deprecated"));
      continue;
    }
    if (isCatchAllPath(operation.path)) {
      skipped.push(skip(operation, "catch-all path"));
      continue;
    }
    if (isGenericAction(operation)) {
      skipped.push(skip(operation, "generic action endpoint"));
      continue;
    }
    candidates.push(operation);
  }
  candidates.sort((a, b) => {
    const rank = (op: Operation) => (op.method === "get" || op.method === "head" ? 0 : 1);
    return rank(a) - rank(b) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method);
  });
  const selected = candidates.slice(0, maxTools);
  for (const operation of candidates.slice(maxTools)) {
    skipped.push(skip(operation, `beyond --max-tools ${maxTools}`));
  }

  const used = new Set<string>();
  const tools = selected.map((operation) => {
    const operationId = operation.operationId ?? synthesizeId(operation);
    let toolName = toToolName(operationId);
    let suffix = 2;
    while (used.has(toolName)) {
      toolName = `${toToolName(operationId).slice(0, 60)}_${suffix}`;
      suffix += 1;
    }
    used.add(toolName);
    const readOnly = operation.method === "get" || operation.method === "head" || operation.method === "options";
    const destructive =
      operation.method === "delete" || /cancel|delete|remove|destroy/i.test(operation.operationId ?? operation.path);
    const idempotent =
      readOnly || operation.method === "put" || operation.method === "delete" || hasIdempotencyKey(operation) || mentionsIdempotent(operation);
    return {
      operation,
      operationId,
      toolName,
      title: operation.summary?.trim() || humanize(toolName),
      description: toolDescription(operation),
      fields: fieldsFor(operation, spec),
      readOnly,
      destructive,
      idempotent,
      fixture: fixtureFor(operation, spec),
    };
  });
  return { tools, skipped };
}

function skip(operation: Operation, reason: string): SkippedOperation {
  return {
    method: operation.method.toUpperCase(),
    path: operation.path,
    ...(operation.operationId ? { operationId: operation.operationId } : {}),
    reason,
  };
}

function synthesizeId(operation: Operation): string {
  const parts = operation.path
    .split("/")
    .filter(Boolean)
    .map((segment) => (segment.startsWith("{") ? `by_${segment.slice(1, -1)}` : segment));
  return `${operation.method}_${parts.join("_") || "root"}`;
}

function humanize(toolName: string): string {
  return toolName
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toolDescription(operation: Operation): string {
  const prose = operationProse(operation);
  const base = prose || `${operation.method.toUpperCase()} ${operation.path}`;
  const text = `${base} (${operation.method.toUpperCase()} ${operation.path}). Mock mode returns fixture data and does not send credentials.`;
  return text.length > 900 ? `${text.slice(0, 897)}...` : text;
}

function fieldsFor(operation: Operation, spec: ParsedSpec): PlannedField[] {
  const fields: PlannedField[] = [];
  const used = new Set<string>();
  const claim = (name: string): string => {
    const base = toArgName(name);
    let candidate = base;
    let index = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${index}`;
      index += 1;
    }
    used.add(candidate);
    return candidate;
  };

  for (const param of operation.parameters) {
    if (param.in === "cookie") continue;
    if (param.in === "header" && isCredentialHeader(param.name, spec)) continue;
    const zod = optionalize(
      withDescription(param.schema ? zodFromSchema(param.schema, spec) : "z.string()", param.description),
      param.required,
    );
    fields.push({
      arg: claim(param.name),
      wire: param.name,
      location: param.in,
      required: param.required,
      zod,
    });
  }

  const body = operation.requestBody;
  if (!body?.schema) return fields;
  const flat = effectiveSchema(body.schema, spec);
  const props = flat?.properties ?? {};
  const keys = Object.keys(props);
  const collides = keys.some((key) => used.has(toArgName(key)));
  if (keys.length > 0 && keys.length <= 12 && !collides) {
    const required = new Set(flat?.required ?? []);
    for (const key of keys) {
      const child = props[key];
      const req = body.required && required.has(key);
      fields.push({
        arg: claim(key),
        wire: key,
        location: "body",
        required: req,
        zod: optionalize(zodFromSchema(child, spec), req),
      });
    }
    return fields;
  }
  const req = body.required;
  fields.push({
    arg: claim("body"),
    wire: "body",
    location: "body",
    required: req,
    zod: optionalize(zodFromSchema(body.schema, spec), req),
  });
  return fields;
}

function withDescription(zod: string, description: string | undefined): string {
  const text = description?.trim();
  if (!text || zod.includes(".describe(")) return zod;
  return `${zod}.describe(${JSON.stringify(text)})`;
}

function optionalize(zod: string, required: boolean): string {
  if (required) return zod;
  if (/\.optional\(\)/.test(zod)) return zod;
  return `${zod}.optional()`;
}

function isCredentialHeader(name: string, spec: ParsedSpec): boolean {
  const token = name.toLowerCase();
  if (token === "authorization" || token === "proxy-authorization") return true;
  return spec.securitySchemes.some(
    (scheme) => scheme.type === "apiKey" && scheme.in === "header" && scheme.paramName?.toLowerCase() === token,
  );
}

function fixtureFor(operation: Operation, spec: ParsedSpec): unknown {
  const responses = operation.responses
    .filter((response) => /^2\d\d$/.test(response.status))
    .sort((a, b) => a.status.localeCompare(b.status));
  const success = responses[0];
  if (!success) return { ok: true };
  if (success.example !== undefined) return success.example;
  if (success.schema) return exampleFromSchema(success.schema, spec);
  return { ok: true };
}

function packageJson(serverName: string): string {
  return `${JSON.stringify(
    {
      name: serverName,
      version: "0.1.0",
      private: true,
      type: "module",
      description: "Starter MCP server generated by mcp-ready. Mock mode needs no credentials.",
      engines: { node: ">=20" },
      scripts: {
        start: "tsx src/index.ts",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        "@modelcontextprotocol/server": SERVER_SDK,
        zod: ZOD_VERSION,
      },
      devDependencies: {
        "@types/node": NODE_TYPES,
        tsx: TSX_VERSION,
        typescript: TS_VERSION,
      },
    },
    null,
    2,
  )}\n`;
}

function tsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        types: ["node"],
        rootDir: "src",
        noEmit: true,
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`;
}

function indexSource(spec: ParsedSpec, serverName: string): string {
  const instructions = [
    `${spec.info.title}.`,
    "Mock mode is the default: tools return fixtures and do not call the network or read credentials.",
    "Set MCP_READY_MOCK=0 and API_BASE_URL to call the real HTTP API. API_TOKEN is sent as a bearer token when set. API_KEY is sent as X-Api-Key when set.",
    DISCLAIMER,
  ].join(" ");
  return `import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerTools } from "./register.js";

const server = new McpServer(
  { name: ${JSON.stringify(serverName)}, version: "0.1.0" },
  { instructions: ${JSON.stringify(instructions)} },
);

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
`;
}

function fieldLine(field: PlannedField): string {
  const [first, ...rest] = field.zod.split("\n");
  const head = `        ${field.arg}: ${first ?? "z.unknown()"}`;
  const tail = rest.map((line) => `        ${line}`);
  return [head, ...tail].join("\n");
}

function registerSource(tools: ToolPlan[]): string {
  const blocks = tools.map((tool) => {
    const props = tool.fields.map((field) => fieldLine(field)).join(",\n");
    const schema = tool.fields.length === 0 ? "z.object({})" : `z.object({\n${props},\n      })`;
    return `  server.registerTool(
    ${JSON.stringify(tool.toolName)},
    {
      title: ${JSON.stringify(tool.title)},
      description: ${JSON.stringify(tool.description)},
      inputSchema: ${schema},
      annotations: {
        readOnlyHint: ${tool.readOnly},
        destructiveHint: ${tool.destructive},
        idempotentHint: ${tool.idempotent},
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await execute(${JSON.stringify(tool.operationId)}, args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );`;
  });
  return `import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { execute } from "./backend.js";

export function registerTools(server: McpServer): void {
${blocks.length > 0 ? blocks.join("\n\n") : "  void server;"}
}
`;
}

function operationsSource(tools: ToolPlan[]): string {
  const data = tools.map((tool) => ({
    operationId: tool.operationId,
    toolName: tool.toolName,
    method: tool.operation.method.toUpperCase(),
    path: tool.operation.path,
    query: wire(tool, "query"),
    pathParams: wire(tool, "path"),
    headers: wire(tool, "header"),
    body: wire(tool, "body"),
  }));
  return `export interface WireField {
  arg: string;
  wire: string;
}

export interface OperationSpec {
  operationId: string;
  toolName: string;
  method: string;
  path: string;
  query: WireField[];
  pathParams: WireField[];
  headers: WireField[];
  body: WireField[];
}

export const operations: OperationSpec[] = ${JSON.stringify(data, null, 2)};
`;
}

function wire(tool: ToolPlan, location: PlannedField["location"]): WireField[] {
  return tool.fields
    .filter((field) => field.location === location)
    .map((field) => ({ arg: field.arg, wire: field.wire }));
}

function fixturesSource(tools: ToolPlan[]): string {
  const data: Record<string, unknown> = {};
  for (const tool of tools) data[tool.operationId] = tool.fixture;
  return `/** Fixture responses used when MCP_READY_MOCK is not "0". */
export const fixtures: Record<string, unknown> = ${JSON.stringify(data, null, 2)};
`;
}

function backendSource(): string {
  return `import { fixtures } from "./fixtures.js";
import { operations, type OperationSpec } from "./operations.js";

export async function execute(operationId: string, args: unknown): Promise<unknown> {
  const operation = operations.find((item) => item.operationId === operationId);
  if (!operation) throw new Error(\`Unknown operation \${operationId}.\`);
  const input = asRecord(args);
  if (process.env.MCP_READY_MOCK === "0") return live(operation, input);
  return mock(operation, input);
}

function mock(operation: OperationSpec, args: Record<string, unknown>): unknown {
  const fixture = fixtures[operation.operationId];
  const base = fixture === undefined ? { ok: true, operationId: operation.operationId, echo: args } : fixture;
  const copy = structuredClone(base);
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) return copy;
  const record = copy as Record<string, unknown>;
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && Object.prototype.hasOwnProperty.call(record, key)) record[key] = value;
  }
  const echoed = Object.entries(args).find((entry) => typeof entry[1] === "string" && /id$/i.test(entry[0]));
  if (echoed && typeof record.id === "string") record.id = echoed[1];
  return record;
}

async function live(operation: OperationSpec, args: Record<string, unknown>): Promise<unknown> {
  const base = process.env.API_BASE_URL;
  if (!base) {
    throw new Error("API_BASE_URL is not set. Leave MCP_READY_MOCK unset to keep using fixtures.");
  }
  let route = operation.path;
  for (const param of operation.pathParams) {
    const value = args[param.arg];
    if (value === undefined || value === null || value === "") {
      throw new Error(\`Missing path parameter \${param.arg}.\`);
    }
    route = route.replaceAll(\`{\${param.wire}}\`, encodeURIComponent(String(value)));
  }
  const url = joinUrl(base, route);
  for (const param of operation.query) {
    const value = args[param.arg];
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(param.wire, String(value));
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.API_TOKEN) headers.authorization = \`Bearer \${process.env.API_TOKEN}\`;
  if (process.env.API_KEY) headers["x-api-key"] = process.env.API_KEY;
  for (const param of operation.headers) {
    const value = args[param.arg];
    if (value !== undefined && value !== null && value !== "") headers[param.wire] = String(value);
  }
  const body = encodeBody(operation, args);
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(url, { method: operation.method, headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(\`\${operation.method} \${url.pathname} failed with \${response.status}: \${text.slice(0, 500)}\`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function encodeBody(operation: OperationSpec, args: Record<string, unknown>): string | undefined {
  if (operation.body.length === 1 && operation.body[0]?.wire === "body") {
    const value = args[operation.body[0].arg];
    return value === undefined ? undefined : JSON.stringify(value);
  }
  if (operation.body.length === 0) return undefined;
  const payload: Record<string, unknown> = {};
  for (const field of operation.body) {
    if (args[field.arg] !== undefined) payload[field.wire] = args[field.arg];
  }
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined;
}

function joinUrl(base: string, route: string): URL {
  const normalizedBase = base.endsWith("/") ? base : \`\${base}/\`;
  const normalizedRoute = route.startsWith("/") ? route.slice(1) : route;
  return new URL(normalizedRoute, normalizedBase);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
`;
}

function readme(spec: ParsedSpec, serverName: string, tools: ToolPlan[], skipped: SkippedOperation[]): string {
  const lines: string[] = [];
  lines.push(`# ${spec.info.title} MCP server`);
  lines.push("");
  lines.push("Stdio MCP server generated by [mcp-ready](https://github.com/tz0127302-cell/mcp-ready). It maps a subset of OpenAPI operations to tools.");
  lines.push("");
  lines.push(`> ${DISCLAIMER}`);
  lines.push("");
  lines.push("## Run it");
  lines.push("");
  lines.push("```bash");
  lines.push("npm install");
  lines.push("npm start");
  lines.push("```");
  lines.push("");
  lines.push("The process speaks MCP on stdin/stdout. Point an MCP client at `npm start` in this directory.");
  lines.push("");
  lines.push("Mock mode is the default. Tools return fixture JSON from `src/fixtures.ts` and do not call the network, so the server starts with no API key and no base URL.");
  lines.push("");
  lines.push("## Call the real API");
  lines.push("");
  lines.push("```bash");
  lines.push("export MCP_READY_MOCK=0");
  lines.push("export API_BASE_URL=https://api.example.com");
  lines.push("export API_TOKEN=...   # optional bearer token, sent only on a tool call");
  lines.push("npm start");
  lines.push("```");
  lines.push("");
  lines.push("`API_KEY`, when set, is sent as `X-Api-Key`. Startup still succeeds if those variables are missing; the first live tool call explains what to set.");
  lines.push("");
  lines.push("## Tools");
  lines.push("");
  lines.push("| Tool | HTTP | Path |");
  lines.push("| --- | --- | --- |");
  for (const tool of tools) {
    lines.push(`| \`${tool.toolName}\` | ${tool.operation.method.toUpperCase()} | \`${tool.operation.path}\` |`);
  }
  if (tools.length === 0) lines.push("| _none_ | | No operations were tool-sized. |");
  lines.push("");
  if (skipped.length > 0) {
    lines.push("## Skipped");
    lines.push("");
    for (const item of skipped) {
      lines.push(`- \`${item.method} ${item.path}\` — ${item.reason}`);
    }
    lines.push("");
  }
  lines.push("## Layout");
  lines.push("");
  lines.push("- `src/index.ts` connects the stdio transport.");
  lines.push("- `src/register.ts` registers one tool per operation.");
  lines.push("- `src/backend.ts` switches between fixtures and `fetch`.");
  lines.push("- `src/fixtures.ts` holds the mock responses taken from OpenAPI examples.");
  lines.push("");
  const server = spec.servers[0];
  if (server) lines.push(`Documented server URL: \`${server.url}\`. Mock mode does not call it.`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export type { GeneratedTool };
