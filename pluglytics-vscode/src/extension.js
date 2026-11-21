const vscode = require("vscode");

function getBaseUrl() {
  return vscode.workspace
    .getConfiguration("pluglytics")
    .get("baseUrl", "http://localhost:3000")
    .replace(/\/$/, "");
}

function activate(context) {
  const openDashboard = vscode.commands.registerCommand(
    "pluglytics.openDashboard",
    () => vscode.env.openExternal(vscode.Uri.parse(`${getBaseUrl()}/public`))
  );

  const openDocs = vscode.commands.registerCommand(
    "pluglytics.openDocs",
    () => vscode.env.openExternal(vscode.Uri.parse(`${getBaseUrl()}/docs`))
  );

  const startApi = vscode.commands.registerCommand(
    "pluglytics.startApi",
    async () => {
      const task = new vscode.Task(
        { type: "npm", script: "dev" },
        vscode.TaskScope.Workspace,
        "PlugLytics API",
        "PlugLytics",
        new vscode.ShellExecution("npm run dev"),
        []
      );
      await vscode.tasks.executeTask(task);
    }
  );

  const healthCheck = vscode.commands.registerCommand(
    "pluglytics.healthCheck",
    async () => {
      try {
        const response = await fetch(`${getBaseUrl()}/api/v1/health`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        vscode.window.showInformationMessage(
          `PlugLytics is healthy: ${body.data.database}`
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `PlugLytics API is unavailable: ${error.message}`
        );
      }
    }
  );

  context.subscriptions.push(openDashboard, openDocs, startApi, healthCheck);
}

function deactivate() {}

module.exports = { activate, deactivate };
