import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { McpReadyError } from "../errors.js";
import type {
  HttpMethod,
  JsonSchema,
  OpResponse,
  Operation,
  Param,
  ParsedSpec,
  RequestBody,
  SecurityRequirement,
  SecurityScheme,
  WebhookOp,
} from "./types.js";

const METHODS = new Set<HttpMethod>(["get", "put", "post", "delete", "patch", "head", "options"]);

const JSON_TYPES = ["application/json", "application/problem+json"];

export async function loadSpec(filePath: string): Promise<ParsedSpec> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpReadyError(`Could not read ${filePath}: ${message}`);
  }
  let raw: unknown;
  try {
    raw = text.trimStart().startsWith("{") ? (JSON.parse(text) as unknown) : parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpReadyError(`Could not parse ${filePath} as JSON or YAML: ${message}`);
  }
  return parseSpec(filePath, raw);
}

export function parseSpec(sourcePath: string, raw: unknown): ParsedSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new McpReadyError(`${sourcePath} is not an OpenAPI document.`);
  }
  const root = raw as Record<string, unknown>;
  const notes: string[] = [];
  let document = root;
  let legacySwagger = false;
  let openapi = typeof root.openapi === "string" ? root.openapi : "";

  if (!openapi && (root.swagger === "2.0" || root.swagger === 2)) {
    document = swaggerToOpenApi(root);
    legacySwagger = true;
    openapi = "3.0.0";
    notes.push("Converted from Swagger 2.0. Scores are approximate until the document is OpenAPI 3.");
  }

  if (!openapi.startsWith("3.")) {
    throw new McpReadyError(
      `${sourcePath} is not OpenAPI 3. Found ${openapi || "no openapi version"}. mcp-ready scores OpenAPI 3.x and reads Swagger 2.0 with a best-effort conversion.`,
    );
  }

  const infoRaw = asRecord(document.info) ?? {};
  const info = {
    title: typeof infoRaw.title === "string" && infoRaw.title.trim() ? infoRaw.title.trim() : "Untitled API",
    version: typeof infoRaw.version === "string" ? infoRaw.version : "0.0.0",
    ...(typeof infoRaw.description === "string" ? { description: infoRaw.description } : {}),
  };

  const components = asRecord(document.components) ?? {};
  const schemas = asRecord(components.schemas) ?? {};
  const resolve = makeResolver(document);

  const securitySchemes = readSecuritySchemes(asRecord(components.securitySchemes) ?? {});
  const security = readSecurity(document.security);
  const operations = readOperations(document, resolve);
  const webhooks = [
    ...readWebhooks(asRecord(document.webhooks), resolve),
    ...readWebhooks(asRecord(document["x-webhooks"]), resolve),
  ];

  return {
    sourcePath,
    openapi,
    legacySwagger,
    info,
    servers: readServers(document.servers),
    security,
    securitySchemes,
    operations,
    webhooks,
    schemaNames: Object.keys(schemas),
    notes,
    resolve,
  };
}

function makeResolver(document: Record<string, unknown>) {
  return function resolve(schema: JsonSchema | undefined, seen?: Set<string>): JsonSchema | undefined {
    if (!schema) return undefined;
    if (!schema.$ref) return schema;
    const trail = seen ?? new Set<string>();
    if (trail.has(schema.$ref)) return schema;
    trail.add(schema.$ref);
    const target = getPointer(document, schema.$ref);
    if (!target || typeof target !== "object") return undefined;
    const next = target as JsonSchema;
    if (typeof next.$ref === "string") return resolve(next, trail);
    return next;
  };
}

function readServers(value: unknown): { url: string; description?: string }[] {
  if (!Array.isArray(value)) return [];
  const servers = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record || typeof record.url !== "string") continue;
    servers.push({
      url: record.url,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
    });
  }
  return servers;
}

function readSecurity(value: unknown): SecurityRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SecurityRequirement => !!item && typeof item === "object" && !Array.isArray(item));
}

function readSecuritySchemes(raw: Record<string, unknown>): SecurityScheme[] {
  const schemes: SecurityScheme[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const record = asRecord(value);
    if (!record || typeof record.type !== "string") continue;
    const flows = asRecord(record.flows);
    schemes.push({
      key,
      type: record.type,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(typeof record.in === "string" ? { in: record.in } : {}),
      ...(typeof record.name === "string" ? { paramName: record.name } : {}),
      ...(typeof record.scheme === "string" ? { scheme: record.scheme } : {}),
      ...(typeof record.bearerFormat === "string" ? { bearerFormat: record.bearerFormat } : {}),
      hasFlows: !!flows && Object.keys(flows).length > 0,
    });
  }
  return schemes;
}

function readOperations(document: Record<string, unknown>, resolve: ParsedSpec["resolve"]): Operation[] {
  const paths = asRecord(document.paths) ?? {};
  const operations: Operation[] = [];
  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = dereference(document, pathValue);
    if (!pathItem) continue;
    const sharedParams = readParams(pathItem.parameters, document, resolve);
    for (const method of METHODS) {
      const opRaw = asRecord(pathItem[method]);
      if (!opRaw) continue;
      const ownParams = readParams(opRaw.parameters, document, resolve);
      const parameters = mergeParams(sharedParams, ownParams);
      const responses = readResponses(opRaw.responses, document, resolve);
      const callbacks = readCallbackFlag(opRaw.callbacks);
      const security = Object.prototype.hasOwnProperty.call(opRaw, "security")
        ? readSecurity(opRaw.security)
        : undefined;
      operations.push({
        method,
        path,
        ...(typeof opRaw.operationId === "string" ? { operationId: opRaw.operationId } : {}),
        ...(typeof opRaw.summary === "string" ? { summary: opRaw.summary } : {}),
        ...(typeof opRaw.description === "string" ? { description: opRaw.description } : {}),
        tags: Array.isArray(opRaw.tags) ? opRaw.tags.filter((tag): tag is string => typeof tag === "string") : [],
        deprecated: opRaw.deprecated === true,
        ...(security ? { security } : {}),
        parameters,
        ...(readBody(opRaw.requestBody, document, resolve) ?? {}),
        responses,
        callbackCount: callbacks.count,
        callbacksTyped: callbacks.typed,
      });
    }
  }
  return operations;
}

function readBody(
  value: unknown,
  document: Record<string, unknown>,
  resolve: ParsedSpec["resolve"],
): { requestBody: RequestBody } | undefined {
  const record = dereference(document, value);
  if (!record) return undefined;
  const media = pickMedia(asRecord(record.content));
  if (!media && typeof record.description !== "string") return undefined;
  return {
    requestBody: {
      required: record.required === true,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(media?.contentType ? { contentType: media.contentType } : {}),
      ...(media?.schema ? { schema: media.schema } : {}),
      ...(media && media.example !== undefined ? { example: media.example } : {}),
    },
  };
}

function readResponses(
  value: unknown,
  document: Record<string, unknown>,
  resolve: ParsedSpec["resolve"],
): OpResponse[] {
  const responses = asRecord(value) ?? {};
  const result: OpResponse[] = [];
  for (const [status, raw] of Object.entries(responses)) {
    const record = dereference(document, raw);
    if (!record) continue;
    const media = pickMedia(asRecord(record.content));
    const headers = readHeaderNames(record.headers, document);
    result.push({
      status,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(media?.contentType ? { contentType: media.contentType } : {}),
      ...(media?.schema ? { schema: asSchema(media.schema, resolve) } : {}),
      ...(media && media.example !== undefined ? { example: media.example } : {}),
      headers,
    });
  }
  return result;
}

function readHeaderNames(value: unknown, document: Record<string, unknown>): string[] {
  const headers = asRecord(value) ?? {};
  const names: string[] = [];
  for (const [name, raw] of Object.entries(headers)) {
    const record = dereference(document, raw);
    if (!record) continue;
    names.push(name);
  }
  return names;
}

function readParams(value: unknown, document: Record<string, unknown>, resolve: ParsedSpec["resolve"]): Param[] {
  if (!Array.isArray(value)) return [];
  const params: Param[] = [];
  for (const entry of value) {
    const record = dereference(document, entry);
    if (!record || typeof record.name !== "string") continue;
    const location = record.in;
    if (location !== "path" && location !== "query" && location !== "header" && location !== "cookie") continue;
    const schema = asSchema(record.schema, resolve);
    params.push({
      name: record.name,
      in: location,
      required: location === "path" ? true : record.required === true,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(schema ? { schema } : {}),
      ...(record.example !== undefined ? { example: record.example } : {}),
    });
  }
  return params;
}

function mergeParams(shared: Param[], own: Param[]): Param[] {
  const map = new Map<string, Param>();
  for (const param of shared) map.set(`${param.in}:${param.name}`, param);
  for (const param of own) map.set(`${param.in}:${param.name}`, param);
  return [...map.values()];
}

function readCallbackFlag(value: unknown): { count: number; typed: boolean } {
  const callbacks = asRecord(value);
  if (!callbacks) return { count: 0, typed: false };
  let typed = false;
  for (const expression of Object.values(callbacks)) {
    const pathItem = asRecord(expression);
    if (!pathItem) continue;
    for (const method of METHODS) {
      const op = asRecord(pathItem[method]);
      const content = asRecord(asRecord(op?.requestBody)?.content);
      if (content && Object.keys(content).length > 0) typed = true;
    }
  }
  return { count: Object.keys(callbacks).length, typed };
}

function readWebhooks(value: Record<string, unknown> | undefined, resolve: ParsedSpec["resolve"]): WebhookOp[] {
  if (!value) return [];
  const hooks: WebhookOp[] = [];
  for (const [name, pathItemRaw] of Object.entries(value)) {
    const pathItem = asRecord(pathItemRaw);
    if (!pathItem) continue;
    for (const method of METHODS) {
      const op = asRecord(pathItem[method]);
      if (!op) continue;
      const body = asRecord(op.requestBody);
      const content = asRecord(body?.content);
      const media = pickMedia(content);
      const schema = media?.schema ? asSchema(media.schema, resolve) : undefined;
      hooks.push({
        name,
        method,
        ...(typeof op.description === "string"
          ? { description: op.description }
          : typeof op.summary === "string"
            ? { description: op.summary }
            : {}),
        typed: !!schema,
      });
    }
  }
  return hooks;
}

interface MediaPick {
  contentType?: string;
  schema?: JsonSchema;
  example?: unknown;
}

function pickMedia(content: Record<string, unknown> | undefined): MediaPick | undefined {
  if (!content) return undefined;
  const preferred =
    JSON_TYPES.map((type) => [type, content[type]] as const).find(([, value]) => value !== undefined) ??
    Object.entries(content).find(([type]) => type.includes("json")) ??
    Object.entries(content)[0];
  if (!preferred) return undefined;
  const [contentType, raw] = preferred;
  const media = asRecord(raw);
  if (!media) return { contentType };
  const example = media.example !== undefined ? media.example : firstExample(media.examples);
  return {
    contentType,
    ...(asRecord(media.schema) || typeof media.schema === "object" ? { schema: media.schema as JsonSchema } : {}),
    ...(example !== undefined ? { example } : {}),
  };
}

function firstExample(value: unknown): unknown {
  const examples = asRecord(value);
  if (!examples) return undefined;
  const first = Object.values(examples)[0];
  const record = asRecord(first);
  if (record && "value" in record) return record.value;
  return undefined;
}

function asSchema(value: unknown, _resolve: ParsedSpec["resolve"]): JsonSchema | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as JsonSchema;
}

function dereference(document: Record<string, unknown>, value: unknown): Record<string, unknown> | undefined {
  let current = value;
  const seen = new Set<string>();
  for (let i = 0; i < 8; i += 1) {
    const record = asRecord(current);
    if (!record) return undefined;
    if (typeof record.$ref !== "string") return record;
    if (seen.has(record.$ref)) return undefined;
    seen.add(record.$ref);
    current = getPointer(document, record.$ref);
  }
  return undefined;
}

function getPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function swaggerToOpenApi(doc: Record<string, unknown>): Record<string, unknown> {
  const pathsIn = asRecord(doc.paths) ?? {};
  const paths: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(pathsIn)) {
    const pathItem = asRecord(item) ?? {};
    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(pathItem)) {
      if (key === "parameters") continue;
      if (!METHODS.has(key as HttpMethod)) continue;
      const op = asRecord(value);
      if (!op) continue;
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])];
      const body = params.map(asRecord).find((param) => param?.in === "body");
      const rest = params.filter((param) => asRecord(param)?.in !== "body" && asRecord(param)?.in !== "formData");
      const responses: Record<string, unknown> = {};
      const rawResponses = asRecord(op.responses) ?? {};
      for (const [status, response] of Object.entries(rawResponses)) {
        const record = asRecord(response) ?? {};
        const schema = rewriteRefs(record.schema);
        responses[status] = {
          description: typeof record.description === "string" ? record.description : status,
          ...(schema
            ? { content: { "application/json": { schema } } }
            : {}),
          ...(record.headers ? { headers: rewriteRefs(record.headers) } : {}),
        };
      }
      next[key] = {
        ...op,
        parameters: rewriteRefs(rest),
        responses,
        ...(body
          ? {
              requestBody: {
                required: body.required === true,
                description: body.description,
                content: {
                  "application/json": { schema: rewriteRefs(body.schema) },
                },
              },
            }
          : {}),
      };
    }
    paths[path] = next;
  }

  const schemes = asRecord(doc.securityDefinitions) ?? {};
  const securitySchemes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schemes)) {
    const scheme = asRecord(value);
    if (!scheme) continue;
    if (scheme.type === "basic") {
      securitySchemes[key] = { type: "http", scheme: "basic", description: scheme.description };
    } else if (scheme.type === "apiKey") {
      securitySchemes[key] = {
        type: "apiKey",
        in: scheme.in,
        name: scheme.name,
        description: scheme.description,
      };
    } else {
      securitySchemes[key] = { type: "http", scheme: "bearer", description: scheme.description };
    }
  }

  const host = typeof doc.host === "string" ? doc.host : "";
  const basePath = typeof doc.basePath === "string" ? doc.basePath : "";
  const scheme = Array.isArray(doc.schemes) && typeof doc.schemes[0] === "string" ? doc.schemes[0] : "https";

  return {
    openapi: "3.0.0",
    info: asRecord(doc.info) ?? { title: "Swagger API", version: "0.0.0" },
    ...(host ? { servers: [{ url: `${scheme}://${host}${basePath}` }] } : {}),
    paths,
    components: {
      schemas: rewriteRefs(asRecord(doc.definitions) ?? {}),
      securitySchemes,
    },
    security: doc.security,
  };
}

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteRefs(item));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "$ref" && typeof child === "string") {
      next[key] = child.replace("#/definitions/", "#/components/schemas/");
    } else {
      next[key] = rewriteRefs(child);
    }
  }
  return next;
}
