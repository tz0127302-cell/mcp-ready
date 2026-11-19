import type { GradeId } from "./rubric.js";

export type CheckStatus = "pass" | "partial" | "fail";

export type ScanMode = "openapi" | "graphql" | "source" | "empty";

export interface CheckResult {
  id: string;
  title: string;
  score: number;
  maxScore: number;
  status: CheckStatus;
  summary: string;
  findings: string[];
  recommendations: string[];
}

export interface RouteHit {
  file: string;
  framework: string;
  method: string;
  path?: string;
}

export interface Discovery {
  openapiFiles: string[];
  graphqlFiles: string[];
  readmeFiles: string[];
  llmsTxtFiles: string[];
  manifestFiles: string[];
  skillFiles: string[];
  routeHandlers: RouteHit[];
  graphql: {
    queries: string[];
    mutations: string[];
    subscriptions: string[];
  };
  sourceSignals: {
    auth: boolean;
    errors: "none" | "handler" | "catch";
    idempotency: boolean;
    paginationCursor: boolean;
    paginationOffset: boolean;
    webhooks: boolean;
    schemas: boolean;
    rateLimits: boolean;
    readmeMentionsAgents: boolean;
  };
  filesScanned: number;
  notes: string[];
}

export interface SpecSummary {
  path: string;
  openapi: string;
  title: string;
  version: string;
  operations: number;
  legacySwagger: boolean;
}

export interface ScanReport {
  tool: "mcp-ready";
  version: string;
  disclaimer: string;
  target: string;
  mode: ScanMode;
  score: number;
  grade: GradeId;
  gradeLabel: string;
  spec: SpecSummary | null;
  discovery: Discovery;
  checks: CheckResult[];
  recommendations: string[];
  generatedAt: string;
}

export interface GenerateOptions {
  specPath: string;
  outDir: string;
  name?: string;
  maxTools?: number;
  force?: boolean;
}

export interface GeneratedTool {
  name: string;
  operationId: string;
  method: string;
  path: string;
  description: string;
}

export interface SkippedOperation {
  method: string;
  path: string;
  operationId?: string;
  reason: string;
}

export interface GenerateResult {
  outDir: string;
  serverName: string;
  packageName: string;
  files: string[];
  tools: GeneratedTool[];
  skipped: SkippedOperation[];
}

export interface InitOptions {
  target: string;
  name?: string;
  url?: string;
  description?: string;
  force?: boolean;
}

export interface InitResult {
  target: string;
  written: string[];
  skipped: string[];
  suggestedTools: number;
}
