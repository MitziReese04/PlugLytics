require("dotenv").config();

module.exports = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.JWT_SECRET || "pluglytics-development-secret",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  databasePath: process.env.DATABASE_PATH || "./data/pluglytics.db",
};
