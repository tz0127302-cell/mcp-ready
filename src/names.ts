export function toToolName(operationId: string): string {
  const snake = operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  const named = /^[a-zA-Z]/.test(snake) ? snake : `op_${snake}`;
  return named.slice(0, 64) || "tool";
}

export function toServerName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "mcp-server";
}

export function toArgName(name: string): string {
  const pieces = name
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap(splitCamel);
  if (pieces.length === 0) return "value";
  const camel = pieces
    .map((part, index) => {
      const lower = part.toLowerCase();
      if (index === 0) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
  if (!/^[A-Za-z]/.test(camel)) return `p_${camel}`;
  return camel;
}

function splitCamel(part: string): string[] {
  return part.split(/(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
}
