// Links a Canvas user to an existing PlugLytics account by hand.
// Needed for admins, who are never linked by email automatically.
//
//   npm run lti:link -- <pluglytics-email> <canvas-user-id>
//
// The Canvas user ID is shown on the "not linked" page when that person opens
// PlugLytics from Canvas.
const db = require("../src/db");
const { ensureTables } = require("../src/routes/lti");
const { getLtiSettings } = require("../src/lti/settings");

const [email, subject] = process.argv.slice(2);
if (!email || !subject) {
  console.error("Usage: npm run lti:link -- <pluglytics-email> <canvas-user-id>");
  process.exit(1);
}

ensureTables();
const user = db.prepare("SELECT id, email, role, is_active FROM users WHERE lower(email) = ?").get(email.trim().toLowerCase());
if (!user) {
  console.error(`No PlugLytics account has the email ${email}.`);
  process.exit(1);
}
if (!user.is_active) {
  console.error(`The PlugLytics account ${user.email} is not active.`);
  process.exit(1);
}

const { issuer } = getLtiSettings();
db.prepare(
  `INSERT INTO lti_accounts (issuer, subject, user_id) VALUES (?, ?, ?)
   ON CONFLICT(issuer, subject) DO UPDATE SET user_id = excluded.user_id`
).run(issuer, subject.trim(), user.id);
console.log(`Linked Canvas user ${subject.trim()} (${issuer}) to ${user.email} (${user.role}).`);
