// Makes a consistent copy of the SQLite database, checks it, and keeps the newest copies.
// Safe to run while the server is running (uses SQLite's online backup).
//
//   npm run backup
//
// Settings (optional, see .env.example):
//   BACKUP_DIR   folder for the copies (default: a "backups" folder next to the database)
//   BACKUP_KEEP  how many copies to keep (default: 7)
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const db = require("../src/db");

const dir = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(db.name), "backups"));
const keep = Math.max(1, Number(process.env.BACKUP_KEEP || 7));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
const target = path.join(dir, `pluglytics-${stamp}.db`);

async function main() {
  fs.mkdirSync(dir, { recursive: true });
  await db.backup(target);
  db.close();

  // Make the copy a single self-contained file (no -wal/-shm side files), then check it.
  const copy = new Database(target);
  copy.pragma("journal_mode = DELETE");
  const integrity = copy.pragma("integrity_check", { simple: true });
  const users = copy.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  copy.close();
  if (integrity !== "ok") throw new Error(`Backup failed the integrity check: ${integrity}`);

  // Keep only the newest copies. Names sort by time because of the timestamp.
  const old = fs.readdirSync(dir).filter((f) => /^pluglytics-\d{8}T\d{6}Z\.db$/.test(f)).sort().slice(0, -keep);
  old.forEach((f) => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dir, f + suffix), { force: true });
  });

  const sizeKb = Math.round(fs.statSync(target).size / 1024);
  console.log(`Backup written: ${target} (${sizeKb} KB, ${users} users, integrity ok). Removed ${old.length} old copies.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
