#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DISCLAIMER } from "./disclaimer.js";
import { McpReadyError } from "./errors.js";
import { generateServer } from "./generate.js";
import { initProject } from "./init.js";
import { renderJson } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderTerminal } from "./report/terminal.js";
import { scan } from "./scan.js";
import { packageVersion } from "./version.js";

interface Io {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

const HELP = `mcp-ready ${"${version}"} — score how agent-ready an API is, and scaffold a starter MCP server

Agents route work toward services they can call. mcp-ready reads an OpenAPI
document or a source tree, scores MCP readiness from 0 to 100, and can write
a stdio MCP server that runs against fixtures with no credentials.

${DISCLAIMER}

USAGE
  mcp-ready scan <path> [options]
  mcp-ready generate --spec <openapi> --out <dir> [options]
  mcp-ready init [path] [options]
  mcp-ready --help
  mcp-ready --version

SCAN
  Score an OpenAPI 3 file and/or a project directory. The directory walk looks
  for OpenAPI, GraphQL schemas, route handlers, README, llms.txt, and an MCP
  manifest. The happy path is offline.

  mcp-ready scan examples/orders-catalog/openapi.yaml
  mcp-ready scan examples/orders-catalog --json
  mcp-ready scan examples/orders-catalog/openapi.yaml --markdown --out readiness.md
  mcp-ready scan . --fail-under 70

  --json              Print the report as JSON on stdout
  --markdown          Print a Markdown report on stdout
  --out <file>        Also write that report to a file
  --fail-under <n>    Exit 2 when the score is below n (alias: --min-score)
  --no-color          Plain text, also implied when stdout is not a TTY
  --ascii             ASCII score bar

GENERATE
  Write a TypeScript MCP server that maps operations to tools. Deprecated,
  catch-all, and generic action endpoints are skipped. The server starts in
  mock mode.

  mcp-ready generate --spec examples/orders-catalog/openapi.yaml --out ./orders-mcp

  --spec <file>       OpenAPI 3 document (required)
  --out <dir>         Directory to create (required)
  --name <name>       Server name. Defaults to the API title
  --max-tools <n>     Maximum tools to emit (default 24)
  --force             Overwrite generated files in a non-empty directory

INIT
  Add llms.txt, mcp.manifest.json, and AGENTS.md to a project. Existing files
  are left in place unless --force is set.

  mcp-ready init examples/orders-catalog
  mcp-ready init . --name "Orders API" --url https://api.example.com

  --name <name>       Title for llms.txt. Defaults to the OpenAPI title
  --url <url>         Public API origin to link from llms.txt
  --description <text>
  --force             Overwrite the three generated files

EXIT CODES
  0  success, or help/version
  1  usage error, unreadable spec, or init found nothing to write
  2  scan score is below --fail-under
`;

export async function main(argv: string[] = process.argv.slice(2), io: Io = process): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help || args.command === "help") {
      io.stdout.write(HELP.replace("${version}", packageVersion()));
      return 0;
    }
    if (args.version) {
      io.stdout.write(`${packageVersion()}\n`);
      return 0;
    }
    if (!args.command) {
      io.stderr.write(HELP.replace("${version}", packageVersion()));
      return 1;
    }
    if (args.command === "scan") return await runScan(args, io);
    if (args.command === "generate") return await runGenerate(args, io);
    if (args.command === "init") return await runInit(args, io);
    throw new McpReadyError(`Unknown command "${args.command}". Run mcp-ready --help.`);
  } catch (error) {
    if (error instanceof McpReadyError) {
      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`mcp-ready: ${message}\n`);
    if (process.env.DEBUG && error instanceof Error && error.stack) io.stderr.write(`${error.stack}\n`);
    return 1;
  }
}

async function runScan(args: ParsedArgs, io: Io): Promise<number> {
  const target = args.positionals[0];
  if (!target) throw new McpReadyError("scan requires a path. Example: mcp-ready scan examples/orders-catalog/openapi.yaml");
  if (args.positionals.length > 1) throw new McpReadyError("scan accepts one path.");
  if (args.json && args.markdown) throw new McpReadyError("Pass only one of --json or --markdown.");
  const report = await scan(target);
  const body = args.json
    ? renderJson(report)
    : args.markdown
      ? renderMarkdown(report)
      : renderTerminal(report, {
          color: wantColor(args.noColor, io),
          ascii: args.ascii,
          width: process.stdout.columns,
        });
  io.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
  if (args.out) {
    await writeFile(path.resolve(args.out), body.endsWith("\n") ? body : `${body}\n`);
    io.stderr.write(`Wrote ${args.out}\n`);
  }
  if (args.failUnder !== undefined && report.score < args.failUnder) {
    io.stderr.write(`Score ${report.score} is below ${args.failUnder}.\n`);
    return 2;
  }
  return 0;
}

async function runGenerate(args: ParsedArgs, io: Io): Promise<number> {
  if (!args.spec) throw new McpReadyError("generate requires --spec <openapi>.");
  if (!args.out) throw new McpReadyError("generate requires --out <dir>.");
  const result = await generateServer({
    specPath: args.spec,
    outDir: args.out,
    ...(args.name ? { name: args.name } : {}),
    ...(args.maxTools !== undefined ? { maxTools: args.maxTools } : {}),
    force: args.force,
  });
  if (args.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`Wrote ${result.tools.length} tool(s) to ${result.outDir}\n`);
  for (const tool of result.tools) io.stdout.write(`  ${tool.name}  ${tool.method} ${tool.path}\n`);
  if (result.skipped.length > 0) {
    io.stdout.write(`Skipped ${result.skipped.length}:\n`);
    for (const item of result.skipped) io.stdout.write(`  ${item.method} ${item.path}  ${item.reason}\n`);
  }
  io.stdout.write("Mock mode is on. cd into the directory, npm install, then npm start.\n");
  return 0;
}

async function runInit(args: ParsedArgs, io: Io): Promise<number> {
  if (args.positionals.length > 1) throw new McpReadyError("init accepts one path.");
  const result = await initProject({
    target: args.positionals[0] ?? ".",
    ...(args.name ? { name: args.name } : {}),
    ...(args.url ? { url: args.url } : {}),
    ...(args.description ? { description: args.description } : {}),
    force: args.force,
  });
  if (args.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`Wrote ${result.written.join(", ")}\n`);
  if (result.skipped.length > 0) io.stdout.write(`Left existing ${result.skipped.join(", ")} in place. Pass --force to overwrite.\n`);
  io.stdout.write(`${result.suggestedTools} suggested tool(s) listed from the OpenAPI document.\n`);
  return 0;
}

function wantColor(noColor: boolean, io: Io): boolean {
  if (noColor) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return io.stdout === process.stdout && Boolean(process.stdout.isTTY);
}

interface ParsedArgs {
  command?: string;
  positionals: string[];
  help: boolean;
  version: boolean;
  json: boolean;
  markdown: boolean;
  noColor: boolean;
  ascii: boolean;
  force: boolean;
  out?: string;
  spec?: string;
  name?: string;
  url?: string;
  description?: string;
  failUnder?: number;
  maxTools?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
    help: false,
    version: false,
    json: false,
    markdown: false,
    noColor: false,
    ascii: false,
    force: false,
  };
  const flags = new Map<string, "bool" | "string" | "number">([
    ["help", "bool"],
    ["version", "bool"],
    ["json", "bool"],
    ["markdown", "bool"],
    ["no-color", "bool"],
    ["ascii", "bool"],
    ["force", "bool"],
    ["out", "string"],
    ["spec", "string"],
    ["name", "string"],
    ["url", "string"],
    ["description", "string"],
    ["fail-under", "number"],
    ["min-score", "number"],
    ["max-tools", "number"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") {
      parsed.positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--") && token !== "-h" && token !== "-V") {
      if (!parsed.command) parsed.command = token;
      else parsed.positionals.push(token);
      continue;
    }
    const raw = token === "-h" ? "--help" : token === "-V" ? "--version" : token;
    const eq = raw.indexOf("=");
    const key = (eq === -1 ? raw : raw.slice(0, eq)).replace(/^--/, "");
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const kind = flags.get(key);
    if (!kind) throw new McpReadyError(`Unknown option --${key}. Run mcp-ready --help.`);
    if (kind === "bool") {
      if (inline !== undefined) throw new McpReadyError(`--${key} does not take a value.`);
      assignBool(parsed, key);
      continue;
    }
    const value = inline ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new McpReadyError(`--${key} requires a value.`);
    if (inline === undefined) index += 1;
    if (kind === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new McpReadyError(`--${key} expects a number.`);
      if (key === "fail-under" || key === "min-score") parsed.failUnder = number;
      if (key === "max-tools") parsed.maxTools = number;
      continue;
    }
    assignString(parsed, key, value);
  }
  return parsed;
}

function assignBool(parsed: ParsedArgs, key: string): void {
  if (key === "help") parsed.help = true;
  if (key === "version") parsed.version = true;
  if (key === "json") parsed.json = true;
  if (key === "markdown") parsed.markdown = true;
  if (key === "no-color") parsed.noColor = true;
  if (key === "ascii") parsed.ascii = true;
  if (key === "force") parsed.force = true;
}

function assignString(parsed: ParsedArgs, key: string, value: string): void {
  if (key === "out") parsed.out = value;
  if (key === "spec") parsed.spec = value;
  if (key === "name") parsed.name = value;
  if (key === "url") parsed.url = value;
  if (key === "description") parsed.description = value;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
