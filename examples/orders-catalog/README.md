# Orders & Catalog

Small HTTP API used by the readiness examples. It covers a product catalog and customer orders.

The OpenAPI document in `openapi.yaml` is the contract. `src/routes.ts` is an illustrative router with the same paths, not a server you can boot. `schema.graphql` is a parallel read model.

The sample lives in [tz0127302-cell/mcp-ready](https://github.com/tz0127302-cell/mcp-ready). Run a readiness report from the repository root:

```bash
npm run mcp-ready -- scan examples/orders-catalog
```
