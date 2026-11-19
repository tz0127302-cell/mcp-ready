import type { JsonSchema, ParsedSpec } from "./types.js";
import { isNullable, schemaTypes } from "./shape.js";

export function effectiveSchema(
  schema: JsonSchema | undefined,
  spec: ParsedSpec,
  depth = 0,
  seen?: Set<string>,
): JsonSchema | undefined {
  if (!schema || depth > 8) return schema;
  const trail = seen ?? new Set<string>();
  let current = schema;
  if (schema.$ref) {
    if (trail.has(schema.$ref)) return { description: "Circular $ref" };
    trail.add(schema.$ref);
    const resolved = spec.resolve(schema);
    if (!resolved) return undefined;
    current = resolved;
  }
  if (!current.allOf || current.allOf.length === 0) return current;

  const properties: Record<string, JsonSchema> = { ...(current.properties ?? {}) };
  const required = new Set(current.required ?? []);
  let description = current.description;
  for (const part of current.allOf) {
    const flat = effectiveSchema(part, spec, depth + 1, trail);
    if (!flat) continue;
    Object.assign(properties, flat.properties ?? {});
    for (const key of flat.required ?? []) required.add(key);
    description = description ?? flat.description;
  }
  return {
    ...current,
    description,
    type: current.type ?? (Object.keys(properties).length > 0 ? "object" : current.type),
    properties,
    required: [...required],
    allOf: undefined,
  };
}

/** 0 = missing, 1 = an agent can rely on the shape. */
export function schemaQuality(schema: JsonSchema | undefined, spec: ParsedSpec, depth = 0): number {
  const flat = effectiveSchema(schema, spec, depth);
  if (!flat) return 0;
  if (flat.enum && flat.enum.length > 0) return 1;
  if ((flat.oneOf && flat.oneOf.length > 0) || (flat.anyOf && flat.anyOf.length > 0)) {
    const branches = flat.oneOf ?? flat.anyOf ?? [];
    if (branches.length === 0) return 0.4;
    const avg =
      branches.reduce((sum, branch) => sum + schemaQuality(branch, spec, depth + 1), 0) / branches.length;
    return Math.max(0.5, Math.min(1, avg));
  }
  const types = schemaTypes(flat);
  if (types.includes("array")) {
    if (!flat.items) return 0.3;
    const items = schemaQuality(flat.items, spec, depth + 1);
    return Math.min(1, 0.7 + 0.3 * items);
  }
  if (types.includes("object") || flat.properties) {
    const props = Object.values(flat.properties ?? {});
    if (props.length === 0) {
      if (flat.additionalProperties && typeof flat.additionalProperties === "object") return 0.45;
      return 0.25;
    }
    const scores = props.map((prop) => schemaQuality(prop, spec, depth + 1));
    const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    if (scores.every((score) => score >= 0.8)) return 1;
    return Math.min(1, 0.6 + 0.4 * avg);
  }
  if (types.some((type) => type === "string" || type === "number" || type === "integer" || type === "boolean")) {
    return 0.8;
  }
  if (Object.keys(flat).length === 0) return 0.2;
  return 0.35;
}

export function exampleFromSchema(schema: JsonSchema | undefined, spec: ParsedSpec, depth = 0): unknown {
  const flat = effectiveSchema(schema, spec, depth);
  if (!flat || depth > 6) return null;
  if (flat.example !== undefined) return flat.example;
  if (flat.default !== undefined) return flat.default;
  if (flat.enum && flat.enum.length > 0) return flat.enum[0];
  const types = schemaTypes(flat);
  if (types.includes("array")) {
    const item = flat.items ? exampleFromSchema(flat.items, spec, depth + 1) : null;
    return item === undefined ? [] : [item];
  }
  if (types.includes("object") || flat.properties) {
    const props = flat.properties ?? {};
    const required = new Set(flat.required ?? []);
    const result: Record<string, unknown> = {};
    const entries = Object.entries(props);
    const selected = [
      ...entries.filter(([key]) => required.has(key)),
      ...entries.filter(([key]) => !required.has(key)),
    ].slice(0, 12);
    for (const [key, child] of selected) {
      result[key] = exampleFromSchema(child, spec, depth + 1);
    }
    return result;
  }
  if (types.includes("integer") || types.includes("number") || flat.format === "int32" || flat.format === "int64") {
    return 1;
  }
  if (types.includes("boolean")) return true;
  if (types.includes("string")) {
    if (flat.format === "date-time") return "2026-11-16T12:00:00Z";
    if (flat.format === "date") return "2026-11-16";
    if (flat.format === "email") return "ada@example.com";
    if (flat.format === "uri" || flat.format === "url") return "https://example.com/resource";
    if (flat.format === "uuid") return "00000000-0000-4000-8000-000000000001";
    return "example";
  }
  if (isNullable(flat)) return null;
  return null;
}

function literal(value: string): string {
  return JSON.stringify(value);
}

/** Emit a Zod 4 expression. Cycles and exotic schemas become z.unknown(). */
export function zodFromSchema(schema: JsonSchema | undefined, spec: ParsedSpec, depth = 0, seen?: Set<string>): string {
  if (!schema || depth > 6) return "z.unknown()";
  const trail = seen ?? new Set<string>();
  if (schema.$ref) {
    if (trail.has(schema.$ref)) return "z.unknown()";
    trail.add(schema.$ref);
  }
  const flat = effectiveSchema(schema, spec, depth, trail);
  if (!flat) return "z.unknown()";

  let expr = zodBase(flat, spec, depth, trail);
  if (isNullable(flat)) expr = `${expr}.nullable()`;
  const description = flat.description?.trim();
  if (description) expr = `${expr}.describe(${literal(description)})`;
  return expr;
}

function zodBase(flat: JsonSchema, spec: ParsedSpec, depth: number, seen: Set<string>): string {
  if (flat.enum && flat.enum.length > 0 && flat.enum.every((item) => typeof item === "string")) {
    return `z.enum([${flat.enum.map((item) => literal(String(item))).join(", ")}])`;
  }
  const types = schemaTypes(flat);
  if (types.includes("array")) {
    return `z.array(${flat.items ? zodFromSchema(flat.items, spec, depth + 1, seen) : "z.unknown()"})`;
  }
  if (types.includes("object") || flat.properties) {
    const props = flat.properties ?? {};
    const keys = Object.keys(props);
    if (keys.length === 0) {
      if (flat.additionalProperties === true || flat.additionalProperties === undefined) {
        return "z.record(z.string(), z.unknown())";
      }
      return "z.object({})";
    }
    const required = new Set(flat.required ?? []);
    const lines = keys.map((key) => {
      let child = zodFromSchema(props[key], spec, depth + 1, seen);
      if (!required.has(key)) child = `${child}.optional()`;
      return `${indent(depth + 1)}${propertyKey(key)}: ${child}`;
    });
    return `z.object({\n${lines.join(",\n")}\n${indent(depth)}})`;
  }
  if (types.includes("integer") || flat.format === "int32" || flat.format === "int64") {
    return numberExpr(flat, true);
  }
  if (types.includes("number")) return numberExpr(flat, false);
  if (types.includes("boolean")) return "z.boolean()";
  if (types.includes("string")) return stringExpr(flat);
  return "z.unknown()";
}

function numberExpr(schema: JsonSchema, integer: boolean): string {
  let expr = integer ? "z.number().int()" : "z.number()";
  if (typeof schema.minimum === "number") expr += `.min(${schema.minimum})`;
  if (typeof schema.maximum === "number") expr += `.max(${schema.maximum})`;
  return expr;
}

function stringExpr(schema: JsonSchema): string {
  let expr = "z.string()";
  if (typeof schema.minLength === "number") expr += `.min(${schema.minLength})`;
  if (typeof schema.maxLength === "number") expr += `.max(${schema.maxLength})`;
  return expr;
}

function propertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function indent(level: number): string {
  return "  ".repeat(level);
}
