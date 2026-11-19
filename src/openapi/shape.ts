import type { JsonSchema, Operation } from "./types.js";

const GENERIC_SEGMENTS = new Set([
  "execute",
  "proxy",
  "invoke",
  "rpc",
  "graphql",
  "action",
  "actions",
]);

const CATCH_ALL_PARAMS = new Set(["path", "proxy", "splat", "rest", "wildcard", "any"]);

export function isCatchAllPath(path: string): boolean {
  if (path.includes("*")) return true;
  if (/\{\+[^}]+\}/.test(path) || /\{[^}]+\+\}/.test(path)) return true;
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 1 && GENERIC_SEGMENTS.has(segments[0]!.toLowerCase())) return true;
  for (const segment of segments) {
    const match = /^\{([^}]+)\}$/.exec(segment);
    if (!match?.[1]) continue;
    const name = match[1].replace(/^\+|\+$/g, "").toLowerCase();
    if (CATCH_ALL_PARAMS.has(name)) return true;
  }
  return false;
}

export function isGenericAction(op: { operationId?: string; path: string }): boolean {
  const id = (op.operationId ?? "").replace(/[_-]+/g, "").toLowerCase();
  if (/(execute|proxy|invoke|graphql)/.test(id)) return true;
  const segments = op.path.split("/").filter(Boolean);
  const last = segments[segments.length - 1]?.toLowerCase() ?? "";
  return GENERIC_SEGMENTS.has(last);
}

/** Description used for scoring. A summary is only a fallback when description is empty. */
export function operationProse(op: { description?: string; summary?: string }): string {
  const description = op.description?.trim() ?? "";
  if (description.length > 0) return description;
  return op.summary?.trim() ?? "";
}

export function isMutating(method: string): boolean {
  return method === "post" || method === "put" || method === "patch" || method === "delete";
}

export function isWriteWithBody(method: string): boolean {
  return method === "post" || method === "put" || method === "patch";
}

const IDEMPOTENCY_NAMES = new Set([
  "idempotency-key",
  "x-idempotency-key",
  "idempotencykey",
]);

export function hasIdempotencyKey(op: Operation): boolean {
  return op.parameters.some(
    (param) =>
      (param.in === "header" || param.in === "query") && IDEMPOTENCY_NAMES.has(normalizeToken(param.name)),
  );
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[_\s]/g, "-");
}

export function mentionsIdempotent(op: Operation): boolean {
  return /idempoten/i.test(operationProse(op));
}

const CURSOR_PARAMS = new Set([
  "cursor",
  "pagetoken",
  "page-token",
  "starting-after",
  "startingafter",
  "continuation",
  "continuationtoken",
  "nextcursor",
]);

const LIMIT_PARAMS = new Set(["limit", "pagesize", "page-size", "perpage", "per-page", "max", "first"]);

const OFFSET_PARAMS = new Set(["offset", "page", "pagenumber", "page-number", "skip"]);

export function paramKind(name: string): "cursor" | "limit" | "offset" | "other" {
  const token = name.toLowerCase().replace(/_/g, "");
  const dashed = name.toLowerCase().replace(/_/g, "-");
  if (CURSOR_PARAMS.has(token) || CURSOR_PARAMS.has(dashed) || CURSOR_PARAMS.has(name.toLowerCase())) {
    return "cursor";
  }
  if (LIMIT_PARAMS.has(token) || LIMIT_PARAMS.has(dashed)) return "limit";
  if (OFFSET_PARAMS.has(token) || OFFSET_PARAMS.has(dashed)) return "offset";
  return "other";
}

const NEXT_FIELDS = new Set([
  "nextcursor",
  "next",
  "nextpage",
  "hasmore",
  "continuationtoken",
  "endcursor",
]);

export function schemaHasNextField(schema: JsonSchema | undefined, depth = 0): boolean {
  if (!schema || depth > 4) return false;
  const props = schema.properties ?? {};
  for (const key of Object.keys(props)) {
    const token = key.toLowerCase().replace(/_/g, "");
    if (NEXT_FIELDS.has(token)) return true;
  }
  if (props.links && schemaHasNextField(props.links, depth + 1)) return true;
  if (props.pagination && schemaHasNextField(props.pagination, depth + 1)) return true;
  if (props.pageInfo && schemaHasNextField(props.pageInfo, depth + 1)) return true;
  return false;
}

export function schemaHasArray(schema: JsonSchema | undefined, depth = 0): boolean {
  if (!schema || depth > 5) return false;
  const types = schemaTypes(schema);
  if (types.includes("array")) return true;
  for (const child of Object.values(schema.properties ?? {})) {
    if (schemaHasArray(child, depth + 1)) return true;
  }
  if (schema.items && schemaHasArray(schema.items, depth + 1)) return true;
  return false;
}

export function schemaTypes(schema: JsonSchema): string[] {
  if (Array.isArray(schema.type)) return schema.type.filter((item) => item !== "null");
  if (typeof schema.type === "string" && schema.type !== "null") return [schema.type];
  if (schema.properties) return ["object"];
  if (schema.items) return ["array"];
  if (schema.enum) return ["string"];
  return [];
}

export function isNullable(schema: JsonSchema): boolean {
  if (schema.nullable) return true;
  return Array.isArray(schema.type) && schema.type.includes("null");
}

const RATE_HEADERS = new Set([
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-rate-limit-limit",
  "x-rate-limit-remaining",
  "x-rate-limit-reset",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "ratelimit",
  "retry-after",
]);

export function isRateLimitHeader(name: string): boolean {
  return RATE_HEADERS.has(name.toLowerCase());
}

export function looksLikeProblem(schema: JsonSchema | undefined): boolean {
  if (!schema?.properties) return false;
  const keys = new Set(Object.keys(schema.properties).map((key) => key.toLowerCase()));
  let hits = 0;
  for (const name of ["type", "title", "status", "detail", "instance"]) {
    if (keys.has(name)) hits += 1;
  }
  return hits >= 2;
}

export function isFreeformObject(schema: JsonSchema | undefined, depth = 0): boolean {
  if (!schema || depth > 6) return false;
  const types = schemaTypes(schema);
  const propCount = Object.keys(schema.properties ?? {}).length;
  if ((types.includes("object") || schema.properties) && propCount === 0) {
    if (schema.additionalProperties === undefined || schema.additionalProperties === true) return true;
  }
  for (const child of Object.values(schema.properties ?? {})) {
    if (isFreeformObject(child, depth + 1)) return true;
  }
  return false;
}

export function isCollectionOperation(op: Operation, success: JsonSchema | undefined): boolean {
  if (op.method !== "get" || op.deprecated) return false;
  const id = op.operationId ?? "";
  if (/^(list|search|find)(?![a-z])/i.test(id) || /^(list|search|find)[A-Z_]/.test(id)) return true;
  const terminal = op.path.split("/").filter(Boolean).at(-1) ?? "";
  const terminalIsParam = terminal.startsWith("{");
  if (!terminalIsParam && success && schemaHasArray(success)) return true;
  return false;
}
