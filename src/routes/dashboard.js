const express = require("express");
const { z } = require("zod");
const db = require("../db");
const { authenticate } = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/envelope");

const router = express.Router();
router.use(authenticate);

const layoutSchema = z.object({
  widgets: z.array(z.object({
    id: z.string().min(1),
    chartType: z.string().min(1).optional(),
  })).default([]),
  filters: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  theme: z.enum(["light", "dark"]).default("light"),
});

router.get("/dashboard", (req, res) => {
  const row = db.prepare(
    "SELECT layout_json FROM dashboard_preferences WHERE user_id = ? AND is_default = 1"
  ).get(req.user.id);
  const layout = row ? JSON.parse(row.layout_json) : { widgets: [], filters: {}, theme: "light" };
  return sendSuccess(res, layout);
});

router.put("/dashboard", (req, res) => {
  const parsed = layoutSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid dashboard layout", parsed.error.flatten());
  db.prepare(`
    INSERT INTO dashboard_preferences (user_id, name, layout_json, is_default)
    VALUES (?, 'default', ?, 1)
    ON CONFLICT(user_id, name) DO UPDATE SET layout_json = excluded.layout_json, updated_at = CURRENT_TIMESTAMP
  `).run(req.user.id, JSON.stringify(parsed.data));
  return sendSuccess(res, parsed.data);
});

router.post("/dashboard/presets", (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(50),
    layout: layoutSchema,
  }).safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid preset", parsed.error.flatten());
  try {
    db.prepare(`
      INSERT INTO dashboard_preferences (user_id, name, layout_json, is_default)
      VALUES (?, ?, ?, 0)
    `).run(req.user.id, parsed.data.name, JSON.stringify(parsed.data.layout));
  } catch (error) {
    return sendError(res, 409, "PRESET_EXISTS", "A preset with this name already exists");
  }
  return sendSuccess(res, parsed.data, {}, 201);
});

router.get("/dashboard/render", async (req, res) => {
  const row = db.prepare(
    "SELECT layout_json FROM dashboard_preferences WHERE user_id = ? AND is_default = 1"
  ).get(req.user.id);
  const layout = row ? JSON.parse(row.layout_json) : { widgets: [], filters: {} };
  return sendSuccess(res, {
    layout,
    widgets: layout.widgets.map((widget) => ({ id: widget.id, chartType: widget.chartType || "bar", data: [] })),
  });
});

module.exports = router;
