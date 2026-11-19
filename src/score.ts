import path from "node:path";
import { effectiveSchema, schemaQuality } from "./openapi/schema.js";
import {
  hasIdempotencyKey,
  isCatchAllPath,
  isCollectionOperation,
  isFreeformObject,
  isGenericAction,
  isMutating,
  isRateLimitHeader,
  isWriteWithBody,
  looksLikeProblem,
  mentionsIdempotent,
  operationProse,
  paramKind,
  schemaHasNextField,
} from "./openapi/shape.js";
import type { JsonSchema, Operation, ParsedSpec } from "./openapi/types.js";
import { RUBRIC, statusFor, type CheckId } from "./rubric.js";
import type { CheckResult, Discovery } from "./types.js";

const CHECK = Object.fromEntries(RUBRIC.map((item) => [item.id, item])) as Record<
  CheckId,
  (typeof RUBRIC)[number]
>;

export function scoreOpenApi(spec: ParsedSpec, discovery: Discovery): CheckResult[] {
  return [
    scoreAuth(spec),
    scoreErrors(spec),
    scoreIdempotency(spec),
    scorePagination(spec),
    scoreWebhooks(spec),
    scoreSchemas(spec),
    scoreToolSizing(spec),
    scoreRateLimits(spec),
    scoreAgentDocs(discovery, spec.operations),
  ];
}

export function scoreGraphql(discovery: Discovery): CheckResult[] {
  const fields = discovery.graphql.queries.length + discovery.graphql.mutations.length;
  return [
    make(
      "auth",
      discovery.sourceSignals.auth ? 6 : 2,
      discovery.sourceSignals.auth
        ? "Source mentions credentials. The GraphQL schema still does not describe the HTTP auth scheme."
        : "No HTTP auth story next to this GraphQL schema. Agents cannot tell which header to send.",
      [],
      ["Document bearer, API key, or public access in OpenAPI security schemes or in AGENTS.md."],
    ),
    make(
      "structured-errors",
      fields > 0 ? 4 : 0,
      "GraphQL failures usually travel in an errors array. That is a partial substitute for problem+json.",
      [],
      ["Document the error shape agents should branch on, including auth failures."],
    ),
    make(
      "idempotency",
      discovery.graphql.mutations.length === 0 ? 4 : discovery.sourceSignals.idempotency ? 4 : 0,
      discovery.graphql.mutations.length === 0
        ? "No mutations in the schema."
        : discovery.sourceSignals.idempotency
          ? "An idempotency key is mentioned in source."
          : `${discovery.graphql.mutations.length} mutation(s) have no idempotency argument.`,
      discovery.graphql.mutations.slice(0, 6).map((name) => `Mutation ${name}`),
      discovery.graphql.mutations.length > 0 && !discovery.sourceSignals.idempotency
        ? ["Add an idempotencyKey argument on create mutations so agents can retry safely."]
        : [],
    ),
    make(
      "pagination",
      discovery.sourceSignals.paginationCursor || /Connection/.test(discovery.graphql.queries.join(" "))
        ? 6
        : discovery.sourceSignals.paginationOffset
          ? 3
          : 0,
      discovery.sourceSignals.paginationCursor
        ? "Cursor-style arguments are present."
        : "No cursor pagination showed up on query fields.",
      [],
      discovery.sourceSignals.paginationCursor ? [] : ["Page list fields with cursor and limit arguments and a next cursor on the connection type."],
    ),
    make(
      "webhooks",
      discovery.graphql.subscriptions.length > 0 ? 6 : 0,
      discovery.graphql.subscriptions.length > 0
        ? `${discovery.graphql.subscriptions.length} subscription field(s) can stand in for webhooks.`
        : "No subscriptions. Agents will poll.",
      discovery.graphql.subscriptions.slice(0, 6),
      discovery.graphql.subscriptions.length > 0 ? [] : ["Add a Subscription type or OpenAPI webhooks for events agents should not poll."],
    ),
    make(
      "schemas",
      fields > 0 ? 10 : 0,
      fields > 0
        ? `${fields} query and mutation field(s) are typed in the schema.`
        : "No query or mutation fields were found.",
      [],
      [],
    ),
    make(
      "tool-sizing",
      fields >= 2 ? 8 : fields === 1 ? 4 : 0,
      fields > 0
        ? "Fields are reasonably tool-sized. The HTTP surface is often still a single POST /graphql."
        : "No fields to map onto tools.",
      [`Queries: ${discovery.graphql.queries.join(", ") || "none"}`, `Mutations: ${discovery.graphql.mutations.join(", ") || "none"}`],
      ["Expose one MCP tool per field instead of a single graphql proxy tool."],
    ),
    make(
      "rate-limits",
      discovery.sourceSignals.rateLimits ? 4 : 0,
      discovery.sourceSignals.rateLimits ? "Source mentions rate limits." : "No rate-limit policy found.",
      [],
      discovery.sourceSignals.rateLimits ? [] : ["Document 429 responses and Retry-After so agents back off."],
    ),
    scoreAgentDocs(discovery, []),
  ];
}

export function graphqlExtraRecommendation(): string {
  return "Publish an OpenAPI 3 document as well. GraphQL fields can become tools, but HTTP auth, status codes, and rate limits live outside the schema.";
}

export function scoreSource(discovery: Discovery): CheckResult[] {
  const routes = discovery.routeHandlers;
  const mutating = routes.filter((route) => ["post", "put", "patch", "delete"].includes(route.method));
  const catchAll = routes.filter((route) => !route.path || route.path.includes("*") || route.method === "*");
  const specificRatio = routes.length === 0 ? 0 : (routes.length - catchAll.length) / routes.length;

  return [
    make(
      "auth",
      discovery.sourceSignals.auth ? 6 : 0,
      discovery.sourceSignals.auth
        ? "Credential handling showed up in source. An OpenAPI security scheme is still required for a full score."
        : routes.length > 0
          ? "Route handlers do not show an auth check."
          : "No route handlers or auth middleware found.",
      [],
      ["Declare securitySchemes in OpenAPI so agents know whether to send a bearer token, an API key, or nothing."],
    ),
    make(
      "structured-errors",
      discovery.sourceSignals.errors === "handler" ? 6 : discovery.sourceSignals.errors === "catch" ? 3 : 0,
      discovery.sourceSignals.errors === "handler"
        ? "An error handler or problem+json response is present in source."
        : discovery.sourceSignals.errors === "catch"
          ? "A catch block sets an HTTP status. Prefer one shared error schema."
          : "No structured error handler found.",
      [],
      ["Return a shared problem+json body (type, title, status, detail) from every error path."],
    ),
    make(
      "idempotency",
      routes.length === 0 ? 0 : mutating.length === 0 || discovery.sourceSignals.idempotency ? 4 : 0,
      routes.length === 0
        ? "No routes to protect."
        : discovery.sourceSignals.idempotency
          ? "Source mentions an idempotency key."
          : mutating.length === 0
            ? "Only read routes were found."
            : "Mutating routes have no idempotency key.",
      [],
      mutating.length > 0 && !discovery.sourceSignals.idempotency
        ? ["Accept Idempotency-Key on POST routes and document it in OpenAPI."]
        : [],
    ),
    make(
      "pagination",
      discovery.sourceSignals.paginationCursor ? 4 : discovery.sourceSignals.paginationOffset ? 2 : 0,
      discovery.sourceSignals.paginationCursor
        ? "Source mentions cursor pagination."
        : discovery.sourceSignals.paginationOffset
          ? "Source mentions limit or offset, not a cursor."
          : "No pagination parameters found in source.",
      [],
      discovery.sourceSignals.paginationCursor ? [] : ["Add cursor and limit parameters and return nextCursor until the list is exhausted."],
    ),
    make(
      "webhooks",
      discovery.sourceSignals.webhooks ? 3 : 0,
      discovery.sourceSignals.webhooks ? "Source mentions webhooks." : "No webhooks found in source.",
      [],
      discovery.sourceSignals.webhooks ? [] : ["Document webhooks or callbacks so agents can wait for events instead of polling."],
    ),
    make(
      "schemas",
      discovery.sourceSignals.schemas ? 6 : 0,
      discovery.sourceSignals.schemas
        ? "A schema library (zod, joi, or similar) is imported. Publish those shapes in OpenAPI too."
        : "No request or response schema library found.",
      [],
      ["Publish an OpenAPI document with component schemas. Source types are not a contract agents can list."],
    ),
    make(
      "tool-sizing",
      routes.length === 0 ? 0 : Math.round(specificRatio * 8),
      routes.length === 0
        ? "No route handlers found."
        : `${routes.length - catchAll.length} specific route(s) and ${catchAll.length} catch-all route(s).`,
      routes.slice(0, 6).map((route) => `${route.method.toUpperCase()} ${route.path ?? "(no path)"} in ${route.file}`),
      catchAll.length > 0
        ? ["Replace catch-all routes with one operation per action before mapping them to MCP tools."]
        : ["Give each route an OpenAPI operationId and a one-sentence description."],
    ),
    make(
      "rate-limits",
      discovery.sourceSignals.rateLimits ? 4 : 0,
      discovery.sourceSignals.rateLimits ? "Source mentions rate limits or HTTP 429." : "No rate-limit policy found in source.",
      [],
      discovery.sourceSignals.rateLimits ? [] : ["Document a 429 response and Retry-After."],
    ),
    scoreAgentDocs(discovery, []),
  ];
}

export function sourceExtraRecommendation(): string {
  return "Add an OpenAPI 3 document. mcp-ready scores auth, schemas, pagination, and tool shape from the contract, and generate needs one.";
}

export function scoreEmpty(): CheckResult[] {
  return RUBRIC.map((item) =>
    make(
      item.id,
      0,
      "Nothing to score yet.",
      [],
      item.id === "agent-docs"
        ? ["Run mcp-ready init to add llms.txt and a starter manifest, then add an OpenAPI document."]
        : ["Add an OpenAPI 3 document or source that exposes route handlers."],
    ),
  );
}

function scoreAuth(spec: ParsedSpec): CheckResult {
  const schemes = spec.securitySchemes;
  const concrete = schemes.some((scheme) =>
    ["http", "apiKey", "oauth2", "openIdConnect"].includes(scheme.type),
  );
  const described = schemes.length > 0 && schemes.every((scheme) => (scheme.description ?? "").trim().length >= 20);
  const securedOps = spec.operations.filter((op) => securityFor(op, spec).length > 0);
  const explicitPublic = spec.operations.filter((op) => op.security !== undefined && op.security.length === 0);
  const covered = spec.operations.filter((op) => op.security !== undefined || spec.security.length > 0).length;
  const allCovered = spec.operations.length === 0 || covered === spec.operations.length;
  const with401 = securedOps.filter((op) => hasStatus(op, "401")).length;
  const with403 = securedOps.filter((op) => hasStatus(op, "403")).length;
  const publicStory =
    schemes.length === 0 &&
    spec.operations.length > 0 &&
    spec.operations.every((op) => op.security !== undefined && op.security.length === 0);

  let score = 0;
  const findings: string[] = [];
  const recommendations: string[] = [];

  if (publicStory) {
    const text = `${spec.info.description ?? ""}\n${spec.operations.map((op) => operationProse(op)).join("\n")}`;
    const documented = /public|no auth|without credentials|no credentials/i.test(text);
    score = documented ? 8 : 4;
    findings.push(
      documented
        ? "Every operation sets security: [] and the text says the API is public."
        : "Every operation sets security: [] but the description never says the API is public.",
    );
    if (!documented) {
      recommendations.push("Say in info.description that callers send no credentials, and keep security: [] on each operation.");
    }
    return make("auth", score, findings[0] ?? "Public API.", findings, recommendations);
  }

  if (concrete) {
    score += 3;
    findings.push(`Security schemes: ${schemes.map((scheme) => scheme.key).join(", ")}.`);
  } else {
    recommendations.push("Declare components.securitySchemes (bearer, API key, or OAuth) and apply them with security.");
  }
  if (spec.security.length > 0 || securedOps.length > 0) {
    score += 3;
    findings.push(
      spec.security.length > 0
        ? "A global security requirement is set."
        : `${securedOps.length} operation(s) declare their own security.`,
    );
  } else if (schemes.length > 0) {
    recommendations.push("Security schemes exist but are not applied. Set top-level security or per-operation security.");
  }
  if (allCovered && (concrete || explicitPublic.length === spec.operations.length)) {
    score += 2;
    findings.push(`${explicitPublic.length} operation(s) are explicitly public. The rest inherit or declare security.`);
  } else if (spec.operations.length > 0) {
    recommendations.push("Set security or security: [] on every operation so agents know which calls need a credential.");
  }
  if (described) {
    score += 1;
  } else if (schemes.length > 0) {
    recommendations.push("Add a sentence to each security scheme: who issues the credential, and which header it goes in.");
  }
  if (securedOps.length > 0 && with401 === securedOps.length) {
    score += 2;
    findings.push("Every secured operation documents 401.");
  } else if (with401 > 0) {
    score += 1;
    findings.push(`${with401} of ${securedOps.length} secured operations document 401.`);
    recommendations.push("Document a 401 response on every secured operation so agents refresh a credential instead of retrying.");
  } else if (securedOps.length > 0) {
    recommendations.push("Document a 401 response on secured operations.");
  }
  if (with403 > 0) {
    score += 1;
    findings.push("403 is documented.");
  } else if (securedOps.length > 0) {
    recommendations.push("Document a 403 response so agents can tell a permission failure from a bad request.");
  }

  const summary =
    score >= 12
      ? "Auth is explicit: schemes, coverage, and 401/403 responses."
      : score === 0
        ? "No security schemes and no security requirements."
        : "Auth is partly documented.";
  return make("auth", score, summary, findings, recommendations);
}

function scoreErrors(spec: ParsedSpec): CheckResult {
  if (spec.operations.length === 0) {
    return make("structured-errors", 0, "No operations to attach error schemas to.", [], [
      "Document 4xx and 5xx responses with a problem+json schema.",
    ]);
  }
  const covered = spec.operations.filter((op) =>
    op.responses.some(
      (response) =>
        /^[45]\d\d$/.test(response.status) &&
        !!response.schema &&
        schemaQuality(response.schema, spec) >= 0.6,
    ),
  );
  const ratio = covered.length / spec.operations.length;
  let score = Math.round(ratio * 8);
  const findings = [`${covered.length} of ${spec.operations.length} operations declare a structured error body.`];
  const recommendations: string[] = [];
  const problemComponent = spec.schemaNames.some((name) =>
    looksLikeProblem(spec.resolve({ $ref: `#/components/schemas/${name}` })),
  );
  const problemMedia = spec.operations.some((op) =>
    op.responses.some((response) => (response.contentType ?? "").includes("problem+json")),
  );
  if (problemComponent) {
    score += 2;
    findings.push("A shared problem schema (type, title, status, detail) is in components.");
  } else {
    recommendations.push("Add a shared Problem schema with type, title, status, and detail, and $ref it from error responses.");
  }
  if (problemMedia) {
    score += 2;
    findings.push("application/problem+json is used.");
  } else {
    recommendations.push("Return errors as application/problem+json so agents can branch on status and type.");
  }
  if (covered.length < spec.operations.length) {
    const missing = spec.operations.filter((op) => !covered.includes(op)).map(labelOf);
    recommendations.push(`Add a structured error response on ${joinList(missing)}.`);
  }
  const summary =
    score >= 12 ? "Errors are a shared, typed problem document." : "Error bodies are incomplete.";
  return make("structured-errors", score, summary, findings, recommendations);
}

function scoreIdempotency(spec: ParsedSpec): CheckResult {
  const mutating = spec.operations.filter((op) => isMutating(op.method) && !op.deprecated);
  if (spec.operations.length === 0) {
    return make("idempotency", 0, "No operations.", [], []);
  }
  if (mutating.length === 0) {
    return make("idempotency", 10, "No mutating operations to protect.", [], []);
  }
  const credits = mutating.map((op) => {
    if (op.method === "put" || op.method === "delete") return 1;
    if (op.method === "patch") return hasIdempotencyKey(op) || mentionsIdempotent(op) ? 1 : 0.5;
    return hasIdempotencyKey(op) || mentionsIdempotent(op) ? 1 : 0;
  });
  const avg = credits.reduce((sum: number, credit) => sum + credit, 0) / credits.length;
  const missing = mutating.filter((op, index) => (credits[index] ?? 0) < 1).map(labelOf);
  const recommendations =
    missing.length > 0
      ? [`Add an Idempotency-Key header on ${joinList(missing)}. Agents retry creates.`]
      : [];
  return make(
    "idempotency",
    avg * 10,
    missing.length === 0
      ? "Mutating operations are safe to retry."
      : `${mutating.length - missing.length} of ${mutating.length} mutating operations ${mutating.length - missing.length === 1 ? "is" : "are"} safe to retry.`,
    missing.length ? [`Needs an idempotency key: ${joinList(missing)}.`] : ["PUT and DELETE count as idempotent by HTTP semantics."],
    recommendations,
  );
}

function scorePagination(spec: ParsedSpec): CheckResult {
  if (spec.operations.length === 0) {
    return make("pagination", 0, "No operations.", [], []);
  }
  const collections = spec.operations.filter((op) => isCollectionOperation(op, successSchema(op, spec)));
  if (collections.length === 0) {
    return make("pagination", 10, "No collection endpoints.", ["List operations are the ones that need cursors."], []);
  }
  const credits = collections.map((op) => paginationCredit(op, successSchema(op, spec)));
  const avg = credits.reduce((sum: number, credit) => sum + credit, 0) / credits.length;
  const weak = collections.filter((op, index) => (credits[index] ?? 0) < 1).map(labelOf);
  return make(
    "pagination",
    avg * 10,
    weak.length === 0
      ? "Collection endpoints expose a cursor and a next field."
      : `${collections.length - weak.length} of ${collections.length} collections are fully cursor-paginated.`,
    weak.length ? [`Partial or missing pagination: ${joinList(weak)}.`] : [],
    weak.length
      ? [`Add cursor and limit query parameters and a nextCursor field on ${joinList(weak)}.`]
      : [],
  );
}

function paginationCredit(op: Operation, success: JsonSchema | undefined): number {
  const kinds = new Set(op.parameters.filter((param) => param.in === "query").map((param) => paramKind(param.name)));
  const cursor = kinds.has("cursor");
  const limit = kinds.has("limit");
  const offset = kinds.has("offset");
  const next = schemaHasNextField(success);
  if (cursor && next) return 1;
  if (cursor) return 0.8;
  if (offset && limit) return 0.7;
  if (limit) return 0.45;
  if (offset) return 0.35;
  return 0;
}

function scoreWebhooks(spec: ParsedSpec): CheckResult {
  const typedHooks = spec.webhooks.filter((hook) => hook.typed);
  const typedCallbacks = spec.operations.some((op) => op.callbacksTyped);
  const anyCallback = spec.operations.some((op) => op.callbackCount > 0);
  const mentioned = /webhook/i.test(
    `${spec.info.description ?? ""}\n${spec.operations.map((op) => operationProse(op)).join("\n")}`,
  );
  if (typedHooks.length > 0 || typedCallbacks) {
    return make(
      "webhooks",
      8,
      typedHooks.length > 0
        ? `${typedHooks.length} typed webhook(s) are declared.`
        : "Operation callbacks include a request body schema.",
      spec.webhooks.map((hook) => hook.name),
      [],
    );
  }
  if (spec.webhooks.length > 0 || anyCallback) {
    return make("webhooks", 5, "Webhooks or callbacks exist without a typed payload.", [], [
      "Give each webhook a JSON schema so agents know the event body.",
    ]);
  }
  if (mentioned) {
    return make("webhooks", 2, "The description mentions webhooks, but the contract does not declare them.", [], [
      "Move webhook documentation into the OpenAPI webhooks (or callbacks) object.",
    ]);
  }
  return make("webhooks", 0, "No webhooks or callbacks.", [], [
    "Declare OpenAPI webhooks for events an agent would otherwise poll for.",
  ]);
}

function scoreSchemas(spec: ParsedSpec): CheckResult {
  if (spec.operations.length === 0) {
    return make("schemas", 0, "No operations.", [], []);
  }
  const scores = spec.operations.map((op) => operationSchemaQuality(op, spec));
  const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const weak = spec.operations.filter((op, index) => (scores[index] ?? 0) < 0.8).map(labelOf);
  return make(
    "schemas",
    avg * 14,
    weak.length === 0
      ? "Request and response bodies are concrete schemas."
      : `${spec.operations.length - weak.length} of ${spec.operations.length} operations are well typed.`,
    weak.length ? [`Loose or missing schemas: ${joinList(weak)}.`] : [`${spec.schemaNames.length} component schema(s).`],
    weak.length ? [`Replace free-form objects with properties on ${joinList(weak)}.`] : [],
  );
}

function operationSchemaQuality(op: Operation, spec: ParsedSpec): number {
  const success = op.responses.find((response) => /^2\d\d$/.test(response.status) && response.schema);
  const successQ = success?.schema ? schemaQuality(success.schema, spec) : 0.2;
  if (!isWriteWithBody(op.method)) return successQ;
  const bodyQ = op.requestBody?.schema ? schemaQuality(op.requestBody.schema, spec) : 0;
  return successQ * 0.65 + bodyQ * 0.35;
}

function scoreToolSizing(spec: ParsedSpec): CheckResult {
  if (spec.operations.length === 0) {
    return make("tool-sizing", 0, "No operations.", [], []);
  }
  const scores = spec.operations.map((op) => toolPoints(op, spec));
  const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const bad = spec.operations.filter((op, index) => (scores[index] ?? 1) < 0.8);
  const recommendations: string[] = [];
  const generic = bad.filter((op) => isCatchAllPath(op.path) || isGenericAction(op));
  if (generic.length > 0) {
    recommendations.push(`Split ${joinList(generic.map(labelOf))} into one operation per action. Catch-alls make poor tools.`);
  }
  const unnamed = bad.filter((op) => !op.operationId || operationProse(op).length < 20);
  if (unnamed.length > 0) {
    recommendations.push(`Add an operationId and a one-sentence description on ${joinList(unnamed.map(labelOf))}.`);
  }
  return make(
    "tool-sizing",
    avg * 12,
    bad.length === 0
      ? "Operations are small enough to be tools."
      : bad.length === 1
        ? "1 operation is too vague or too wide to be a tool."
        : `${bad.length} operations are too vague or too wide to be a tool.`,
    bad.slice(0, 6).map((op) => toolFinding(op, spec)),
    recommendations,
  );
}

function toolPoints(op: Operation, spec: ParsedSpec): number {
  let score = 1;
  if (!op.operationId) score -= 0.25;
  if (isCatchAllPath(op.path)) score -= 0.75;
  else if (isGenericAction(op)) score -= 0.5;
  const prose = operationProse(op);
  if (prose.length === 0) score -= 0.35;
  else if (prose.length < 20) score -= 0.2;
  const agentParams = op.parameters.filter(
    (param) => param.in === "path" || param.in === "query" || (param.in === "header" && !isAuthHeader(param.name)),
  );
  if (agentParams.length > 12) score -= 0.25;
  if (op.requestBody?.schema && isFreeformObject(effectiveSchema(op.requestBody.schema, spec))) score -= 0.25;
  return Math.max(0, Math.min(1, score));
}

function toolFinding(op: Operation, spec: ParsedSpec): string {
  const reasons: string[] = [];
  if (!op.operationId) reasons.push("missing operationId");
  if (isCatchAllPath(op.path)) reasons.push("catch-all path");
  else if (isGenericAction(op)) reasons.push("generic action");
  if (operationProse(op).length < 20) reasons.push("thin description");
  if (op.requestBody?.schema && isFreeformObject(effectiveSchema(op.requestBody.schema, spec))) {
    reasons.push("free-form body");
  }
  return `${labelOf(op)} (${reasons.join(", ") || "wide surface"})`;
}

function scoreRateLimits(spec: ParsedSpec): CheckResult {
  const has429 = spec.operations.some((op) => hasStatus(op, "429"));
  const hasHeaders = spec.operations.some((op) => op.responses.some((response) => response.headers.some(isRateLimitHeader)));
  const hasText = /rate[- ]limit|throttl/i.test(
    `${spec.info.description ?? ""}\n${spec.operations.map((op) => operationProse(op)).join("\n")}`,
  );
  const score = (has429 ? 4 : 0) + (hasHeaders ? 4 : 0) + (hasText ? 2 : 0);
  const findings = [
    has429 ? "429 is documented." : "No 429 response.",
    hasHeaders ? "Rate-limit or Retry-After headers are declared." : "No rate-limit headers.",
    hasText ? "The description mentions the rate-limit policy." : "The description does not mention rate limits.",
  ];
  const recommendations: string[] = [];
  if (!has429 || !hasHeaders) {
    recommendations.push("Document a 429 response with X-RateLimit-Remaining and Retry-After.");
  }
  if (!hasText) recommendations.push("Describe the rate-limit window in info.description.");
  return make(
    "rate-limits",
    score,
    score >= 10 ? "Agents can see when to slow down." : "Rate limits are only partly documented.",
    findings,
    recommendations,
  );
}

function scoreAgentDocs(discovery: Discovery, operations: Operation[]): CheckResult {
  let score = 0;
  const findings: string[] = [];
  const recommendations: string[] = [];
  if (discovery.llmsTxtFiles.length > 0) {
    score += 5;
    findings.push(`llms.txt at ${discovery.llmsTxtFiles[0]}`);
  } else {
    recommendations.push("Add llms.txt so agents can discover this API without scraping HTML. mcp-ready init writes a starter.");
  }
  if (discovery.manifestFiles.length > 0) {
    score += 3;
    findings.push(`Manifest at ${discovery.manifestFiles[0]}`);
  } else {
    recommendations.push("Add mcp.manifest.json with the server command and tool list. mcp-ready init writes one.");
  }
  if (discovery.skillFiles.length > 0) {
    score += 2;
    findings.push(`Skill hint at ${discovery.skillFiles[0]}`);
  } else {
    recommendations.push("Add AGENTS.md that says when to read and when to call a mutating tool. mcp-ready init writes a starter.");
  }
  if (operations.length === 0) {
    if (discovery.sourceSignals.readmeMentionsAgents) {
      score += 2;
      findings.push("README talks to agents.");
    }
  } else {
    const described = operations.filter((op) => operationProse(op).length >= 20).length;
    const coverage = described / operations.length;
    if (coverage >= 0.8) score += 2;
    else if (coverage >= 0.4) score += 1;
    findings.push(`${described} of ${operations.length} operations have a sentence of description.`);
    if (coverage < 0.8) {
      recommendations.push("Write a one-sentence description on every operation. It becomes the MCP tool description.");
    }
  }
  const summary =
    score >= 12
      ? "Agents can find a contract, a manifest, and a skill hint."
      : score === 0
        ? "No llms.txt, manifest, or skill hint."
        : "Agent-facing docs are incomplete.";
  return make("agent-docs", score, summary, findings, recommendations);
}

function successSchema(op: Operation, spec: ParsedSpec): JsonSchema | undefined {
  const response = op.responses.find((item) => /^2\d\d$/.test(item.status) && item.schema);
  return response?.schema ? effectiveSchema(response.schema, spec) : undefined;
}

function securityFor(op: Operation, spec: ParsedSpec) {
  return op.security ?? spec.security;
}

function hasStatus(op: Operation, status: string): boolean {
  return op.responses.some((response) => response.status === status);
}

function isAuthHeader(name: string): boolean {
  const token = name.toLowerCase();
  return token === "authorization" || token === "proxy-authorization" || token === "x-api-key" || token === "api-key";
}

function labelOf(op: Operation): string {
  return `${op.method.toUpperCase()} ${op.path}`;
}

function joinList(items: string[]): string {
  const unique = [...new Set(items)];
  if (unique.length <= 4) return unique.join(", ");
  return `${unique.slice(0, 4).join(", ")}, +${unique.length - 4} more`;
}

function make(
  id: CheckId,
  score: number,
  summary: string,
  findings: string[],
  recommendations: string[],
): CheckResult {
  const def = CHECK[id];
  const clamped = Math.max(0, Math.min(def.max, Math.round(score)));
  return {
    id: def.id,
    title: def.title,
    score: clamped,
    maxScore: def.max,
    status: statusFor(clamped, def.max),
    summary,
    findings: findings.filter(Boolean).slice(0, 6),
    recommendations: [...new Set(recommendations.filter(Boolean))].slice(0, 3),
  };
}

export function rankRecommendations(checks: CheckResult[], extras: string[] = []): string[] {
  const ordered = [...checks].sort((a, b) => b.maxScore - b.score - (a.maxScore - a.score));
  const out: string[] = [];
  const push = (value: string) => {
    if (value && !out.includes(value)) out.push(value);
  };
  for (const extra of extras) push(extra);
  for (const check of ordered) {
    for (const recommendation of check.recommendations) push(recommendation);
  }
  return out.slice(0, 6);
}

export function displayPath(filePath: string, cwd: string): string {
  const relative = path.relative(cwd, filePath);
  if (!relative || relative.startsWith("..")) return filePath;
  return relative.split(path.sep).join("/");
}
