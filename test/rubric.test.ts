import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toArgName, toServerName, toToolName } from "../src/names.js";
import { gradeFor, rubricMax, RUBRIC } from "../src/rubric.js";

describe("rubric", () => {
  it("sums to 100", () => {
    assert.equal(rubricMax(), 100);
    assert.equal(
      RUBRIC.reduce((sum, item) => sum + item.max, 0),
      100,
    );
    const ids = RUBRIC.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("grades the bands used in the report", () => {
    assert.equal(gradeFor(100).id, "agent-ready");
    assert.equal(gradeFor(90).label, "Agent-ready");
    assert.equal(gradeFor(75).id, "nearly-ready");
    assert.equal(gradeFor(55).id, "gaps");
    assert.equal(gradeFor(54).id, "at-risk");
    assert.equal(gradeFor(30).id, "at-risk");
    assert.equal(gradeFor(29).id, "not-ready");
  });
});

describe("names", () => {
  it("turns operation ids into tool names", () => {
    assert.equal(toToolName("listProducts"), "list_products");
    assert.equal(toToolName("createOrder"), "create_order");
    assert.equal(toToolName("GET /orders/{orderId}"), "get_orders_order_id");
  });

  it("keeps argument names readable", () => {
    assert.equal(toArgName("Idempotency-Key"), "idempotencyKey");
    assert.equal(toArgName("productId"), "productId");
    assert.equal(toServerName("Orders & Catalog API"), "orders-catalog-api");
  });
});
