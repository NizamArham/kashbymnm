import "dotenv/config";
import express from "express";
import cors from "cors";
import { errorHandler } from "./lib/errors";

import { businessInfoRouter } from "./routes/businessInfo";
import { customersRouter } from "./routes/customers";
import { suppliersRouter } from "./routes/suppliers";
import { productsRouter } from "./routes/products";
import { categoriesRouter } from "./routes/categories";
import { findRouter } from "./routes/find";
import { analyticsRouter } from "./routes/analytics";
import { inventoryRouter } from "./routes/inventory";
import { salesRouter } from "./routes/sales";
import { purchasesRouter } from "./routes/purchases";
import { supplierPaymentsRouter } from "./routes/supplierPayments";
import { chequesRouter } from "./routes/cheques";
import { deliveriesRouter } from "./routes/deliveries";
import { courierReconciliationRouter } from "./routes/courierReconciliation";
import { cashBookRouter } from "./routes/cashBook";
import { authRouter } from "./routes/auth";
import { returnsRouter } from "./routes/returns";
import { attendanceRouter } from "./routes/attendance";
import { couponsRouter } from "./routes/coupons";
import { auditLogRouter } from "./routes/auditLog";
import { backupRouter } from "./routes/backup";
import { giftVouchersRouter } from "./routes/giftVouchers";
import { deliveryPartnersRouter } from "./routes/deliveryPartners";
import { webhooksRouter } from "./routes/webhooks";
import { exchangesRouter } from "./routes/exchanges";
import { startCourierSync } from "./lib/courierSync";

const app = express();
const PORT = process.env.PORT || 4000;
const HOST = "0.0.0.0";

// Fardar's status callback reaches this machine through a public tunnel
// (ngrok etc.), which would otherwise put the whole API on the internet.
// A tunnel stamps every request it forwards with X-Forwarded-For, which
// requests straight from this machine or the shop's network never carry —
// so anything that came through one may only reach the webhook routes.
app.use((req, res, next) => {
  const viaTunnel = Boolean(req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"]);
  if (viaTunnel && !req.path.startsWith("/api/webhooks/")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

app.use(cors()); // fine to leave open — this only ever runs on your own machine
app.use(express.json());





// Simple health check — useful to confirm the server is actually running
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.use("/api/auth", authRouter);
app.use("/api/business-info", businessInfoRouter);
app.use("/api/customers", customersRouter);
app.use("/api/suppliers", suppliersRouter);
app.use("/api/products", productsRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/find", findRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/sales", salesRouter);
app.use("/api/returns", returnsRouter);
app.use("/api/purchases", purchasesRouter);
app.use("/api/supplier-payments", supplierPaymentsRouter);
app.use("/api/cheques", chequesRouter);
app.use("/api/deliveries", deliveriesRouter);
app.use("/api/courier-reconciliation", courierReconciliationRouter);
app.use("/api/cash-book", cashBookRouter);
app.use("/api/attendance", attendanceRouter);
app.use("/api/coupons", couponsRouter);
app.use("/api/audit-log", auditLogRouter);
app.use("/api/backup", backupRouter);
app.use("/api/gift-vouchers", giftVouchersRouter);
app.use("/api/delivery-partners", deliveryPartnersRouter);
app.use("/api/exchanges", exchangesRouter);
// Called by outside services rather than logged-in staff, so each route
// guards itself (a secret in its address) — see routes/webhooks.ts.
app.use("/api/webhooks", webhooksRouter);

// Must be registered last — Express error-handling middleware.
app.use(errorHandler);

app.listen(Number(PORT), HOST, () => {
  console.log(`M&M Clothing server running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  startCourierSync();
});
