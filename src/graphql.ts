export interface GraphqlFields {
  queries: string[];
  mutations: string[];
  subscriptions: string[];
}

const EMPTY: GraphqlFields = { queries: [], mutations: [], subscriptions: [] };

export function extractGraphqlFields(source: string): GraphqlFields {
  return {
    queries: fieldsIn(source, "Query"),
    mutations: fieldsIn(source, "Mutation"),
    subscriptions: fieldsIn(source, "Subscription"),
  };
}

export function mergeGraphql(parts: GraphqlFields[]): GraphqlFields {
  const merged = { queries: new Set<string>(), mutations: new Set<string>(), subscriptions: new Set<string>() };
  for (const part of parts) {
    for (const name of part.queries) merged.queries.add(name);
    for (const name of part.mutations) merged.mutations.add(name);
    for (const name of part.subscriptions) merged.subscriptions.add(name);
  }
  return {
    queries: [...merged.queries],
    mutations: [...merged.mutations],
    subscriptions: [...merged.subscriptions],
  };
}

export function emptyGraphql(): GraphqlFields {
  return { ...EMPTY, queries: [], mutations: [], subscriptions: [] };
}

function fieldsIn(source: string, typeName: string): string[] {
  const block = extractTypeBlock(source, typeName);
  if (!block) return [];
  const names: string[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\(|:)/.exec(trimmed);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

function extractTypeBlock(source: string, typeName: string): string | undefined {
  const matcher = new RegExp(`(?:^|\\n)\\s*(?:extend\\s+)?type\\s+${typeName}\\b[^\\{]*\\{`, "m");
  const found = matcher.exec(source);
  if (!found || found.index === undefined) return undefined;
  const start = found.index + found[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i);
    }
  }
  return undefined;
}
