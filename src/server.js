const app = require("./app");
const config = require("./config");

app.listen(config.port, () => {
  console.log(`PlugLytics API listening on http://localhost:${config.port}`);
});
