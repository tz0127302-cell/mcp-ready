import { Router } from "express";
import { z } from "zod";

const router = Router();

router.use((req, res, next) => {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ title: "Unauthorized", status: 401 });
    return;
  }
  next();
});

router.get("/v1/products", (req, res) => {
  const limit = req.query.limit;
  const cursor = req.query.cursor;
  res.json({ data: [], nextCursor: null, limit, cursor });
});

router.post("/v1/orders", (req, res) => {
  const key = req.header("Idempotency-Key");
  res.status(201).json({ id: "ord_1", key });
});

router.get("/v1/orders/:orderId", (req, res) => {
  res.json({ id: req.params.orderId });
});

router.use((err: unknown, _req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }, _next: unknown) => {
  res.status(500).json({ type: "about:blank", title: "Error", status: 500, detail: String(err) });
});

export const CreateOrder = z.object({
  sku: z.string(),
  quantity: z.number().int(),
});

export default router;
