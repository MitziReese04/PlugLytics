const app = require("./app");
const config = require("./config");
const { startWebhookWorker } = require("./webhookDelivery");

app.listen(config.port, () => {
  console.log(`PlugLytics API listening on http://localhost:${config.port}`);
  // Sends queued webhooks every 15 seconds and right after new events.
  startWebhookWorker();
});
