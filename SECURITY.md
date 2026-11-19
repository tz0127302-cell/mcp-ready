# Security

mcp-ready reads local files and prints a report. It does not upload your spec.

- Do not point `scan` at a tree that contains secrets if you are going to paste the JSON report into a ticket. The scanner does not redact file contents it quotes.
- Generated servers default to fixture data. Live mode sends `API_TOKEN` and `API_KEY` only when you set `MCP_READY_MOCK=0` and then call a tool. Those values are not written into generated files.
- This project does not audit an API for vulnerabilities. A high score means the contract is easier for an agent to call, not that the service is safe.

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/tz0127302-cell/mcp-ready/security/advisories/new). This repository does not ship a production service.
