export const RUBRIC = [
  {
    id: "auth",
    title: "Auth story",
    max: 12,
    question: "Can an agent tell what credential to send, or that the API is public?",
  },
  {
    id: "structured-errors",
    title: "Structured errors",
    max: 12,
    question: "Do failures come back as a schema an agent can branch on?",
  },
  {
    id: "idempotency",
    title: "Idempotency",
    max: 10,
    question: "Can an agent retry a create without duplicating the side effect?",
  },
  {
    id: "pagination",
    title: "Pagination",
    max: 10,
    question: "Can an agent walk a collection until the cursor runs out?",
  },
  {
    id: "webhooks",
    title: "Webhooks",
    max: 8,
    question: "Can an agent subscribe to events instead of polling?",
  },
  {
    id: "schemas",
    title: "Well-typed schemas",
    max: 14,
    question: "Are request and response bodies objects with real properties?",
  },
  {
    id: "tool-sizing",
    title: "Tool-sized endpoints",
    max: 12,
    question: "Is each operation one action, with an operationId and a sentence of context?",
  },
  {
    id: "rate-limits",
    title: "Rate-limit docs",
    max: 10,
    question: "Does the contract tell an agent when to back off?",
  },
  {
    id: "agent-docs",
    title: "Agent-facing docs",
    max: 12,
    question: "Is there an llms.txt, a manifest or skill hint, and descriptions on operations?",
  },
] as const;

export type CheckId = (typeof RUBRIC)[number]["id"];

export type GradeId = "agent-ready" | "nearly-ready" | "gaps" | "at-risk" | "not-ready";

export function rubricMax(): number {
  return RUBRIC.reduce((sum, item) => sum + item.max, 0);
}

export function gradeFor(score: number): { id: GradeId; label: string } {
  if (score >= 90) return { id: "agent-ready", label: "Agent-ready" };
  if (score >= 75) return { id: "nearly-ready", label: "Nearly ready" };
  if (score >= 55) return { id: "gaps", label: "Ready with gaps" };
  if (score >= 30) return { id: "at-risk", label: "At risk" };
  return { id: "not-ready", label: "Not agent-ready" };
}

export function statusFor(score: number, max: number): "pass" | "partial" | "fail" {
  if (score <= 0) return "fail";
  if (score >= max) return "pass";
  return "partial";
}
