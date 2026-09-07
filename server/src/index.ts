import express from "express";
import cors from "cors";
import { errorHandler } from "./lib/errors";

import { businessInfoRouter } from "./routes/businessInfo";
import { customersRouter } from "./routes/customers";
import { suppliersRouter } from "./routes/suppliers";
import { productsRouter } from "./routes/products";
import { inventoryRouter } from "./routes/inventory";
import { salesRouter } from "./routes/sales";
import { purchasesRouter } from "./routes/purchases";
import { supplierPaymentsRouter } from "./routes/supplierPayments";
import { deliveriesRouter } from "./routes/deliveries";
import { courierPaymentsRouter } from "./routes/courierPayments";
import { cashBookRouter } from "./routes/cashBook";
import { authRouter } from "./routes/auth";
import { returnsRouter } from "./routes/returns";
import { attendanceRouter } from "./routes/attendance";

const app = express();
const PORT = process.env.PORT || 4000;

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
app.use("/api/inventory", inventoryRouter);
app.use("/api/sales", salesRouter);
app.use("/api/returns", returnsRouter);
app.use("/api/purchases", purchasesRouter);
app.use("/api/supplier-payments", supplierPaymentsRouter);
app.use("/api/deliveries", deliveriesRouter);
app.use("/api/courier-payments", courierPaymentsRouter);
app.use("/api/cash-book", cashBookRouter);
app.use("/api/attendance", attendanceRouter);

// Must be registered last — Express error-handling middleware.
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`M&M Clothing server running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
