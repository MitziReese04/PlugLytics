const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("./config");

// Resolve relative paths from the project root, so scripts and the server agree.
const projectRoot = path.resolve(__dirname, "..");
const dbPath = path.isAbsolute(config.databasePath)
  ? config.databasePath
  : path.resolve(projectRoot, config.databasePath);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// On Vercel the app folder is read-only, so start from a copy of the seeded demo DB.
if (
  process.env.VERCEL &&
  (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0)
) {
  try {
    fs.writeFileSync(
      dbPath,
      fs.readFileSync(path.join(__dirname, "..", "data", "pluglytics.db"))
    );
  } catch (err) {
    console.error("Could not copy seeded database:", err.message);
  }
}

const db = new Database(dbPath);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

module.exports = db;
