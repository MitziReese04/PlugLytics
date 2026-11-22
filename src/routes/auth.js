const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const db = require("../db");
const config = require("../config");
const { authenticate } = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/envelope");

const router = express.Router();
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Slows down password guessing: only failed sign-ins count, per client IP.
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_FAILURE_LIMIT,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (req, res) =>
    sendError(res, 429, "TOO_MANY_LOGIN_ATTEMPTS", "Too many failed sign-in attempts. Try again in 15 minutes."),
});

router.post("/login", loginLimiter, (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "VALIDATION_ERROR", "Invalid login data", parsed.error.flatten());
  }

  const user = db.prepare(
    "SELECT id, email, password_hash, role, name, is_active FROM users WHERE email = ?"
  ).get(parsed.data.email.toLowerCase());

  if (!user || !user.is_active || !bcrypt.compareSync(parsed.data.password, user.password_hash)) {
    return sendError(res, 401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }

  const token = jwt.sign(
    { sub: user.id, role: user.role },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: config.jwtExpiresIn }
  );

  return sendSuccess(res, {
    token,
    user: { id: user.id, email: user.email, role: user.role, name: user.name },
  });
});

router.get("/me", authenticate, (req, res) => {
  return sendSuccess(res, {
    id: req.user.id,
    email: req.user.email,
    role: req.user.role,
    name: req.user.name,
  });
});

module.exports = router;
