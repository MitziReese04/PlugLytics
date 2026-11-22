const jwt = require("jsonwebtoken");
const db = require("../db");
const config = require("../config");
const { sendError } = require("../utils/envelope");

function authenticate(req, res, next) {
  const header = req.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return sendError(res, 401, "AUTH_REQUIRED", "A Bearer token is required");
  }

  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret, { algorithms: ["HS256"] });
    const user = db.prepare(
      "SELECT id, email, role, name, is_active FROM users WHERE id = ?"
    ).get(payload.sub);

    if (!user || !user.is_active) {
      return sendError(res, 401, "AUTH_INVALID", "The account is unavailable");
    }

    req.user = user;
    next();
  } catch (error) {
    return sendError(res, 401, "AUTH_INVALID", "The token is invalid or expired");
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return sendError(
        res,
        403,
        "FORBIDDEN",
        `This endpoint requires one of these roles: ${roles.join(", ")}`
      );
    }
    next();
  };
}

module.exports = { authenticate, authorize };
