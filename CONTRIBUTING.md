# Contributing

Thanks for looking at mcp-ready. The useful changes are small: a clearer check, a better fixture, or a generated server that is easier to edit.

## Setup

Node.js 20 or newer.

Clone https://github.com/tz0127302-cell/mcp-ready and install from that tree. The package is not on npm.

```bash
git clone https://github.com/tz0127302-cell/mcp-ready.git
cd mcp-ready
npm install
npm test
npm run typecheck
```

Run the CLI from source with:

```bash
npm run mcp-ready -- scan examples/orders-catalog/openapi.yaml
```

## Checks

Scoring lives in `src/score.ts`. The weights live in `src/rubric.ts` and must sum to 100. `npm test` fails if they do not.

When you change a check:

1. Update the rubric question in `src/rubric.ts` if the meaning changed.
2. Update the scoring table in `README.md` so it matches the code.
3. Keep `test/fixtures/agent-ready` at 100. That directory is the definition of a full score.
4. Keep the orders catalog in the "Ready with gaps" band. It is the documented demo.

Source-only and GraphQL-only scans are capped below a full OpenAPI score. Do not award the OpenAPI maximum from a regex.

## Generated servers

`mcp-ready generate` must keep working offline. The scaffold starts in mock mode and must not require a token, a network call, or a secret to boot. Tests in `test/generate.test.ts` start the server and call a tool through the MCP client.

## Commits

Use [conventional commits](https://www.conventionalcommits.org/): `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.

Do not commit secrets, `.env` files, or generated `orders-mcp/` directories.

## Disclaimer

mcp-ready is independent. Do not add copy that implies Anthropic, the MCP maintainers, or a registry operator ship or endorse this project.
