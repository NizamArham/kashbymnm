import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../lib/auth";
import { RETURN_SPLIT_FALLBACK, RETURN_SPLIT_KEY, ReturnSplitDefaults, getSetting, setSetting } from "../lib/appSettings";

export const appSettingsRouter = Router();

appSettingsRouter.use(requireAuth);

const share = z.number().int().refine((n) => n === 0 || n === 50 || n === 100, "Choose Us, 50-50 or Customer");
const splitInput = z.object({ our_fault: share, customer_choice: share });

// GET /api/app-settings/courier-return-split — everyone reads it (the inspection report starts from it); only an admin changes it.
appSettingsRouter.get("/courier-return-split", (_req, res) => {
  res.json(getSetting<ReturnSplitDefaults>(RETURN_SPLIT_KEY, RETURN_SPLIT_FALLBACK));
});

appSettingsRouter.put("/courier-return-split", requireRole("admin"), (req, res) => {
  const data = splitInput.parse(req.body);
  setSetting(RETURN_SPLIT_KEY, data);
  res.json(data);
});
