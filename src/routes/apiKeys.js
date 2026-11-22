const crypto = require("crypto");
const express = require("express");
const { z } = require("zod");
const db = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/envelope");
const { generateApiKey } = require("../middleware/apiKey");

// Admin-only management of customer (school) API keys.
// See "Customer API keys" in docs/stellar/payments-api.md.
const router = express.Router();
router.use(authenticate, authorize("admin"));

const createSchema = z.object({
  schoolId: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
}).strict();
const listSchema = z.object({ schoolId: z.coerce.number().int().positive().optional() }).strict();

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function keyId() {
  const bytes = crypto.randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i += 1) out += BASE32[bytes[i] % 32];
  return `key_${out}`;
}

const KEY_COLUMNS = `
  k.id, k.school_id, s.name AS school_name, k.name, k.key_prefix, k.created_at, k.created_by,
  k.last_used_at, k.revoked_at
`;
const findKey = db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys k JOIN schools s ON s.id = k.school_id WHERE k.id = ?`);

// Never includes the key or its hash.
function toResponse(row) {
  return {
    id: row.id,
    schoolId: row.school_id,
    schoolName: row.school_name,
    name: row.name,
    keyPrefix: row.key_prefix,
    status: row.revoked_at ? "revoked" : "active",
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    revokedAt: row.revoked_at || null,
  };
}

// Schools, so an admin can pick which school a key is for.
router.get("/schools", (req, res) => {
  const schools = db.prepare("SELECT id, name, code FROM schools ORDER BY name").all();
  return sendSuccess(res, schools, { total: schools.length });
});

router.post("/", (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid API key", parsed.error.flatten());
  const { schoolId, name } = parsed.data;
  if (!db.prepare("SELECT 1 FROM schools WHERE id = ?").get(schoolId)) {
    return sendError(res, 404, "SCHOOL_NOT_FOUND", "No school has that ID");
  }
  const { key, prefix, hash } = generateApiKey();
  const id = keyId();
  db.prepare(`
    INSERT INTO api_keys (id, school_id, name, key_prefix, key_hash, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, schoolId, name, prefix, hash, req.user.id, new Date().toISOString());
  // The full key is returned only here, once. It cannot be shown again.
  return sendSuccess(res, { ...toResponse(findKey.get(id)), key }, {}, 201);
});

router.get("/", (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid filters", parsed.error.flatten());
  const { schoolId } = parsed.data;
  const rows = db.prepare(`
    SELECT ${KEY_COLUMNS} FROM api_keys k JOIN schools s ON s.id = k.school_id
    ${schoolId ? "WHERE k.school_id = @schoolId" : ""}
    ORDER BY k.created_at DESC, k.id DESC
  `).all(schoolId ? { schoolId } : {});
  return sendSuccess(res, rows.map(toResponse), { total: rows.length, filtersApplied: schoolId ? { schoolId } : {} });
});

// Revokes a key. It stops working at once and cannot be turned back on.
router.delete("/:id", (req, res) => {
  const row = findKey.get(req.params.id);
  if (!row) return sendError(res, 404, "API_KEY_NOT_FOUND", "No API key has that ID");
  if (row.revoked_at) return sendError(res, 409, "API_KEY_ALREADY_REVOKED", "This API key is already revoked");
  db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), row.id);
  return sendSuccess(res, toResponse(findKey.get(row.id)));
});

module.exports = router;
