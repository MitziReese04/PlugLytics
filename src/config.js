require("dotenv").config();

module.exports = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.JWT_SECRET || "pluglytics-development-secret",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  databasePath: process.env.DATABASE_PATH || "./data/pluglytics.db",
  // Number of reverse proxies in front of the app (Render uses 1). 0 = trust none.
  // Needed so rate limiting sees each visitor's IP instead of the proxy's.
  trustProxy: Number(process.env.TRUST_PROXY || 0),
};
