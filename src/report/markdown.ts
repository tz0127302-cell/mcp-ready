import { DISCLAIMER } from "../disclaimer.js";
import { RUBRIC } from "../rubric.js";
import type { ScanReport } from "../types.js";

export function renderMarkdown(report: ScanReport): string {
  const title = report.spec?.title ?? report.target;
  const lines: string[] = [];
  lines.push(`# MCP readiness: ${title}`);
  lines.push("");
  lines.push(`**Score: ${report.score}/100** — ${report.gradeLabel}`);
  lines.push("");
  if (report.spec) {
    lines.push(
      `OpenAPI ${report.spec.openapi} · version ${report.spec.version} · ${report.spec.operations} operations · \`${report.spec.path}\``,
    );
    lines.push("");
  } else {
    lines.push(`Mode: ${report.mode} · \`${report.target}\``);
    lines.push("");
  }
  lines.push("## Checklist");
  lines.push("");
  lines.push("| Check | Score | Status | Summary |");
  lines.push("| --- | --- | --- | --- |");
  for (const check of report.checks) {
    lines.push(`| ${check.title} | ${check.score}/${check.maxScore} | ${check.status} | ${escapeCell(check.summary)} |`);
  }
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  for (const check of report.checks) {
    if (check.findings.length === 0) continue;
    lines.push(`### ${check.title}`);
    lines.push("");
    for (const finding of check.findings) lines.push(`- ${finding}`);
    lines.push("");
  }
  lines.push("## Top fixes");
  lines.push("");
  if (report.recommendations.length === 0) {
    lines.push("Nothing to change. Keep the contract this explicit as the API grows.");
  } else {
    report.recommendations.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
  }
  lines.push("");
  lines.push("## Signals");
  lines.push("");
  lines.push(`- Mode: ${report.mode}`);
  lines.push(`- OpenAPI files: ${report.discovery.openapiFiles.length ? report.discovery.openapiFiles.join(", ") : "none"}`);
  lines.push(`- GraphQL files: ${report.discovery.graphqlFiles.length ? report.discovery.graphqlFiles.join(", ") : "none"}`);
  const gql = report.discovery.graphql;
  if (gql.queries.length || gql.mutations.length || gql.subscriptions.length) {
    lines.push(`- GraphQL fields: ${gql.queries.length} queries, ${gql.mutations.length} mutations, ${gql.subscriptions.length} subscriptions`);
  }
  lines.push(`- Route handlers: ${report.discovery.routeHandlers.length}`);
  lines.push(`- llms.txt: ${report.discovery.llmsTxtFiles[0] ?? "not found"}`);
  lines.push(`- MCP manifest: ${report.discovery.manifestFiles[0] ?? "not found"}`);
  lines.push(`- Skill hint: ${report.discovery.skillFiles[0] ?? "not found"}`);
  lines.push("");
  lines.push("## Rubric");
  lines.push("");
  for (const item of RUBRIC) {
    lines.push(`- **${item.title}** (${item.max}): ${item.question}`);
  }
  lines.push("");
  lines.push(`_${DISCLAIMER}_`);
  lines.push("");
  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
