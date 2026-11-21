const express = require("express");
const db = require("../db");
const { sendSuccess } = require("../utils/envelope");

const router = express.Router();

router.get("/", (req, res) => {
  const result = db.prepare("SELECT 1 AS ok").get();
  return sendSuccess(res, { status: "ok", database: result.ok === 1 ? "ok" : "error" });
});

module.exports = router;
