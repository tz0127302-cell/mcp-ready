export type HttpMethod = "get" | "put" | "post" | "delete" | "patch" | "head" | "options";

export type SecurityRequirement = Record<string, string[]>;

export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  example?: unknown;
  default?: unknown;
  nullable?: boolean;
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  title?: string;
}

export interface SecurityScheme {
  key: string;
  type: string;
  description?: string;
  /** Location for apiKey schemes: header, query, or cookie. */
  in?: string;
  paramName?: string;
  scheme?: string;
  bearerFormat?: string;
  hasFlows: boolean;
}

export interface Param {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema?: JsonSchema;
  example?: unknown;
}

export interface RequestBody {
  required: boolean;
  description?: string;
  contentType?: string;
  schema?: JsonSchema;
  example?: unknown;
}

export interface OpResponse {
  status: string;
  description?: string;
  contentType?: string;
  schema?: JsonSchema;
  example?: unknown;
  headers: string[];
}

export interface Operation {
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  /**
   * Undefined inherits the document security array.
   * An empty array means the operation is explicitly public.
   */
  security?: SecurityRequirement[];
  parameters: Param[];
  requestBody?: RequestBody;
  responses: OpResponse[];
  callbackCount: number;
  callbacksTyped: boolean;
}

export interface WebhookOp {
  name: string;
  method: string;
  description?: string;
  typed: boolean;
}

export interface ServerObject {
  url: string;
  description?: string;
}

export interface ParsedSpec {
  sourcePath: string;
  openapi: string;
  legacySwagger: boolean;
  info: { title: string; version: string; description?: string };
  servers: ServerObject[];
  security: SecurityRequirement[];
  securitySchemes: SecurityScheme[];
  operations: Operation[];
  webhooks: WebhookOp[];
  schemaNames: string[];
  notes: string[];
  resolve(schema: JsonSchema | undefined, seen?: Set<string>): JsonSchema | undefined;
}
