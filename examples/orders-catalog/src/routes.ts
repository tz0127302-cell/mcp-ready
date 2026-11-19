/**
 * Illustrative router. mcp-ready scans these calls; this file is not a server.
 * The shapes mirror examples/orders-catalog/openapi.yaml.
 */

interface Response {
  status(code: number): { json(body: unknown): void };
  json(body: unknown): void;
  header(name: string): string | undefined;
}

interface Request {
  header(name: string): string | undefined;
  query: Record<string, unknown>;
  params: Record<string, string>;
}

type Next = () => void;

const router = {
  use(_handler: (req: Request, res: Response, next: Next) => void) {},
  get(_path: string, _handler: (req: Request, res: Response) => void) {},
  post(_path: string, _handler: (req: Request, res: Response) => void) {},
};

router.use((req, res, next) => {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ title: "Unauthorized", status: 401 });
    return;
  }
  next();
});

router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/products", (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  const cursor = req.query.cursor;
  res.json({ data: [], nextCursor: null, limit, cursor });
});

router.get("/products/:productId", (req, res) => {
  res.json({ id: req.params.productId, name: "Field Notebook", priceCents: 1800 });
});

router.get("/orders", (req, res) => {
  res.json({ data: [], nextCursor: null, limit: req.query.limit });
});

router.post("/orders", (req, res) => {
  const key = req.header("Idempotency-Key");
  res.status(201).json({ id: "ord_1001", key });
});

router.get("/orders/:orderId", (req, res) => {
  res.json({ id: req.params.orderId, status: "placed" });
});

router.post("/orders/:orderId/cancel", (req, res) => {
  res.json({ id: req.params.orderId, status: "cancelled" });
});

router.use((err, _req, res, _next) => {
  res.status(500).json({ type: "about:blank", title: "Error", status: 500, detail: String(err) });
});
