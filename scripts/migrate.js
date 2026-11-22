// Creates any missing tables, indexes, views and triggers from src/schema.sql.
// Unlike `npm run seed`, it never deletes or replaces data, so it is safe to run
// on every start of a production server.
//
// Limitation: schema.sql only uses CREATE ... IF NOT EXISTS, so this does not
// change tables that already exist (for example, adding a column). Those changes
// still need a hand-written migration. TODO: add versioned migrations before the pilot.
const fs = require("fs");
const path = require("path");
const db = require("../src/db");

const schema = fs.readFileSync(path.resolve(__dirname, "../src/schema.sql"), "utf8");
db.exec(schema);
const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
console.log(`Schema is up to date at ${db.name} (${tables} tables).`);
db.close();
