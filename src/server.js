const app = require("./app");
const config = require("./config");
const { startWebhookWorker } = require("./webhookDelivery");
const { startReconciliationWorker } = require("./stellarReconcile");

app.listen(config.port, () => {
  console.log(`PlugLytics API listening on http://localhost:${config.port}`);
  // Sends queued webhooks every 15 seconds and right after new events.
  startWebhookWorker();
  // Daily (yesterday, after midnight UTC) and weekly (last week, on Monday) reconciliation.
  startReconciliationWorker();
});
