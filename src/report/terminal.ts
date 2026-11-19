import pc from "picocolors";
import type { ScanReport } from "../types.js";

export interface TerminalOptions {
  color?: boolean;
  ascii?: boolean;
  width?: number;
}

export function renderTerminal(report: ScanReport, options: TerminalOptions = {}): string {
  const color = options.color ?? false;
  const ascii = options.ascii ?? false;
  const width = Math.max(64, Math.min(options.width ?? 78, 100));
  const paint = color ? pc : plain;
  const title = report.spec?.title ?? "No OpenAPI document";
  const lines: string[] = [];

  lines.push(paint.bold(paint.cyan(`mcp-ready ${report.version}`)));
  lines.push("");
  lines.push(paint.bold(title));
  if (report.spec) {
    const legacy = report.spec.legacySwagger ? " · converted from Swagger 2.0" : "";
    lines.push(
      paint.dim(
        `OpenAPI ${report.spec.openapi} · v${report.spec.version} · ${report.spec.operations} operations${legacy}`,
      ),
    );
    lines.push(paint.dim(report.spec.path));
  } else {
    lines.push(paint.dim(`Mode ${report.mode} · ${report.target}`));
  }
  lines.push("");

  const gradeColor =
    report.score >= 75 ? paint.green : report.score >= 55 ? paint.yellow : paint.red;
  lines.push(`${paint.bold("Score")}  ${gradeColor(paint.bold(`${report.score}/100`))}   ${gradeColor(report.gradeLabel)}`);
  lines.push(gradeColor(bar(report.score, 32, ascii)));
  lines.push("");
  lines.push(paint.bold("Checklist"));

  const titleWidth = Math.max(...report.checks.map((check) => check.title.length));
  for (const check of report.checks) {
    const status = statusLabel(check.status, paint);
    const ratio = `${check.score}/${check.maxScore}`.padStart(5);
    lines.push(`  ${status}  ${check.title.padEnd(titleWidth)}  ${paint.bold(ratio)}`);
    lines.push(`           ${paint.dim(truncate(check.summary, width - 11))}`);
  }

  lines.push("");
  lines.push(paint.bold("Signals"));
  lines.push(`  ${signal("llms.txt", report.discovery.llmsTxtFiles.length > 0, paint)}  ${report.discovery.llmsTxtFiles[0] ?? "missing"}`);
  lines.push(`  ${signal("manifest", report.discovery.manifestFiles.length > 0, paint)}  ${report.discovery.manifestFiles[0] ?? "missing"}`);
  lines.push(`  ${signal("skill", report.discovery.skillFiles.length > 0, paint)}  ${report.discovery.skillFiles[0] ?? "missing"}`);
  const routes = report.discovery.routeHandlers.length;
  const gql = report.discovery.graphql;
  lines.push(
    `  ${paint.dim("routes")}     ${routes} handler(s)` +
      (gql.queries.length + gql.mutations.length + gql.subscriptions.length > 0
        ? ` · graphql ${gql.queries.length} queries / ${gql.mutations.length} mutations / ${gql.subscriptions.length} subscriptions`
        : ""),
  );
  if (report.discovery.notes.length > 0) {
    for (const note of report.discovery.notes) lines.push(`  ${paint.dim(note)}`);
  }

  lines.push("");
  lines.push(paint.bold("Top fixes"));
  if (report.recommendations.length === 0) {
    lines.push("  None. Keep new endpoints this explicit.");
  } else {
    report.recommendations.forEach((item, index) => {
      lines.push(wrap(`${index + 1}. ${item}`, width, "     "));
    });
  }
  lines.push("");
  lines.push(paint.dim("Next: mcp-ready generate --spec <openapi> --out ./mcp-server"));
  lines.push(paint.dim("      mcp-ready init ."));
  lines.push(paint.dim("      mcp-ready scan <path> --json"));
  lines.push("");
  return lines.join("\n");
}

function bar(score: number, width: number, ascii: boolean): string {
  const filled = Math.max(0, Math.min(width, Math.round((score / 100) * width)));
  const on = ascii ? "#" : "█";
  const off = ascii ? "-" : "░";
  return on.repeat(filled) + off.repeat(width - filled);
}

function statusLabel(status: string, paint: Palette): string {
  if (status === "pass") return paint.green("PASS   ");
  if (status === "partial") return paint.yellow("PARTIAL");
  return paint.red("FAIL   ");
}

function signal(label: string, ok: boolean, paint: Palette): string {
  const mark = ok ? paint.green("yes") : paint.red("no ");
  return `${paint.dim(label.padEnd(8))} ${mark}`;
}

function truncate(value: string, max: number): string {
  if (max < 8) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function wrap(value: string, width: number, hanging: string): string {
  const limit = Math.max(20, width - hanging.length);
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > limit && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.map((line, index) => (index === 0 ? `  ${line}` : `${hanging}${line}`)).join("\n");
}

interface Palette {
  bold: (value: string) => string;
  dim: (value: string) => string;
  green: (value: string) => string;
  yellow: (value: string) => string;
  red: (value: string) => string;
  cyan: (value: string) => string;
}

const plain: Palette = {
  bold: (value) => value,
  dim: (value) => value,
  green: (value) => value,
  yellow: (value) => value,
  red: (value) => value,
  cyan: (value) => value,
};
