const vscode = require("vscode");

function getBaseUrl() {
  return vscode.workspace
    .getConfiguration("pluglytics")
    .get("baseUrl", "http://localhost:3000")
    .replace(/\/$/, "");
}

function getLmsDateOptionsUrl() {
  return vscode.workspace
    .getConfiguration("pluglytics")
    .get("lmsDateOptionsUrl", "")
    .trim();
}

async function readApiResponse(response, action) {
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(
      `${action} returned a non-JSON response (HTTP ${response.status}). Check that pluglytics.baseUrl points to the running PlugLytics API.`
    );
  }
  if (!response.ok) {
    throw new Error(body.error?.message || `${action} failed (HTTP ${response.status}).`);
  }
  return body;
}

function isDateValue(value, key) {
  if (!/(date|time|due|start|end|created|updated|submitted|activity|deadline|enrol|term)/i.test(key)) {
    return null;
  }

  if (typeof value === "number") {
    if (value > 1_000_000_000_000 && value < 4_000_000_000_000) {
      return new Date(value).toISOString().slice(0, 10);
    }
    if (value > 1_000_000_000 && value < 4_000_000_000) {
      return new Date(value * 1000).toISOString().slice(0, 10);
    }
    return null;
  }

  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]+Z?)?$/.test(value)) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function extractDates(payload) {
  const found = new Set();
  function visit(value, key = "") {
    const date = isDateValue(value, key);
    if (date) found.add(date);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey));
    }
  }
  visit(payload);
  return [...found].sort();
}

async function fetchLmsDates(context) {
  const endpoint = getLmsDateOptionsUrl();
  if (!endpoint) return [];

  let url;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new Error("Configure a valid LMS date API URL in PlugLytics settings.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("The LMS date API URL must use HTTP or HTTPS.");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("Use HTTPS for the LMS date API to protect LMS data and tokens.");
  }

  const headers = { Accept: "application/json" };
  const token = await context.secrets.get("pluglytics.lmsApiToken");
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`LMS date request failed (HTTP ${response.status}).`);

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("The configured LMS endpoint did not return valid JSON.");
  }

  const dates = extractDates(payload);
  await context.globalState.update("pluglytics.lmsDates", dates);
  return dates;
}

async function getDateOptions(context) {
  const token = await context.secrets.get("pluglytics.jwt");
  if (!token) throw new Error("Connect your PlugLytics account first.");

  const response = await fetch(`${getBaseUrl()}/api/v1/me/filter-options`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await readApiResponse(response, "Date lookup");
  await context.globalState.update("pluglytics.dateOptions", body.data);
  body.data.lmsDates = [];
  body.data.lmsDateError = null;
  try {
    body.data.lmsDates = await fetchLmsDates(context);
  } catch (error) {
    body.data.lmsDateError = error.message;
  }
  return body.data;
}

async function connectAccount(context) {
  const email = await vscode.window.showInputBox({
    title: "Connect PlugLytics",
    prompt: "Enter your PlugLytics account email",
    placeHolder: "you@example.edu",
    ignoreFocusOut: true,
  });
  if (!email) return;

  const password = await vscode.window.showInputBox({
    title: "Connect PlugLytics",
    prompt: "Enter your PlugLytics password. It will not be saved.",
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return;

  const response = await fetch(`${getBaseUrl()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await readApiResponse(response, "Sign-in");
  if (!body.data?.token) throw new Error("Sign-in response did not contain an access token.");

  await context.secrets.store("pluglytics.jwt", body.data.token);
  const options = await getDateOptions(context);
  vscode.window.showInformationMessage(
    `Connected to PlugLytics. Found ${options.terms.length} terms, ${options.dates.length} PlugLytics dates, and ${options.lmsDates.length} LMS dates.`
  );
  if (options.lmsDateError) {
    vscode.window.showWarningMessage(`LMS dates could not be fetched: ${options.lmsDateError}`);
  }
}

async function chooseDateRange(context) {
  let options;
  try {
    options = await getDateOptions(context);
  } catch (error) {
    if (error.message !== "Connect your PlugLytics account first.") {
      vscode.window.showErrorMessage(error.message);
      return;
    }
    const action = await vscode.window.showErrorMessage(error.message, "Connect account");
    if (action === "Connect account") {
      await connectAccount(context);
      return chooseDateRange(context);
    }
    return;
  }
  if (options.lmsDateError) {
    vscode.window.showWarningMessage(`LMS dates could not be fetched: ${options.lmsDateError}`);
  }

  const items = options.terms.map((term) => ({
    label: term.name,
    description: `${term.startDate} – ${term.endDate}`,
    detail: `Filter dashboard to ${term.name}`,
    from: term.startDate,
    to: term.endDate,
  }));
  if (options.dateRange.from && options.dateRange.to) {
    items.unshift({
      label: "All available dates",
      description: `${options.dateRange.from} – ${options.dateRange.to}`,
      detail: "Show the complete date range available to your account",
      from: options.dateRange.from,
      to: options.dateRange.to,
    });
  }
  if (options.lmsDates.length) {
    const monthRanges = new Map();
    for (const date of options.lmsDates) {
      const month = date.slice(0, 7);
      if (!monthRanges.has(month)) monthRanges.set(month, { from: date, to: date });
      monthRanges.get(month).to = date;
    }
    const allLmsDates = options.lmsDates;
    items.unshift({
      label: "All LMS dates",
      description: `${allLmsDates[0]} – ${allLmsDates[allLmsDates.length - 1]}`,
      detail: "Filter to the full date range fetched from the configured LMS API",
      from: allLmsDates[0],
      to: allLmsDates[allLmsDates.length - 1],
    });
    for (const [month, range] of monthRanges) {
      items.unshift({
        label: `LMS activity · ${month}`,
        description: `${range.from} – ${range.to}`,
        detail: "Filter dashboard to dates found in the configured LMS API response",
        from: range.from,
        to: range.to,
      });
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    title: "Filter PlugLytics dashboard by date",
    placeHolder: "Choose an LMS term or available date range",
    matchOnDescription: true,
  });
  if (!selected) return;

  const url = new URL(`${getBaseUrl()}/public/dashboard.html`);
  url.searchParams.set("from", selected.from);
  url.searchParams.set("to", selected.to);
  await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
}

function activate(context) {
  const output = vscode.window.createOutputChannel("PlugLytics");
  context.subscriptions.push(output);

  const openDashboard = vscode.commands.registerCommand(
    "pluglytics.openDashboard",
    () => vscode.env.openExternal(vscode.Uri.parse(`${getBaseUrl()}/public/dashboard.html`))
  );
  const openDocs = vscode.commands.registerCommand(
    "pluglytics.openDocs",
    () => vscode.env.openExternal(vscode.Uri.parse(`${getBaseUrl()}/docs`))
  );
  const startApi = vscode.commands.registerCommand("pluglytics.startApi", async () => {
    const task = new vscode.Task(
      { type: "npm", script: "dev" },
      vscode.TaskScope.Workspace,
      "PlugLytics API",
      "PlugLytics",
      new vscode.ShellExecution("npm run dev"),
      []
    );
    await vscode.tasks.executeTask(task);
  });
  const healthCheck = vscode.commands.registerCommand("pluglytics.healthCheck", async () => {
    try {
      const response = await fetch(`${getBaseUrl()}/api/v1/health`);
      const body = await readApiResponse(response, "Health check");
      vscode.window.showInformationMessage(`PlugLytics is healthy: ${body.data.database}`);
    } catch (error) {
      vscode.window.showErrorMessage(`PlugLytics API is unavailable: ${error.message}`);
    }
  });
  const connect = vscode.commands.registerCommand(
    "pluglytics.connect",
    () => connectAccount(context).catch((error) => vscode.window.showErrorMessage(error.message))
  );
  const refreshDates = vscode.commands.registerCommand(
    "pluglytics.refreshDates",
    async () => {
      try {
        const options = await getDateOptions(context);
        vscode.window.showInformationMessage(
            `Date filters refreshed: ${options.terms.length} terms, ${options.dates.length} PlugLytics dates, and ${options.lmsDates.length} LMS dates.`
        );
        if (options.lmsDateError) {
          vscode.window.showWarningMessage(`LMS dates could not be fetched: ${options.lmsDateError}`);
        }
      } catch (error) {
        vscode.window.showErrorMessage(error.message);
      }
    }
  );
  const filterDates = vscode.commands.registerCommand(
    "pluglytics.chooseDateRange",
    () => chooseDateRange(context)
  );
  const configureLms = vscode.commands.registerCommand(
    "pluglytics.configureLms",
    async () => {
      const endpoint = await vscode.window.showInputBox({
        title: "Configure LMS date API",
        prompt: "Enter an LMS REST API endpoint that returns JSON course, term, assignment, or activity records.",
        value: getLmsDateOptionsUrl(),
        placeHolder: "https://lms.example.edu/api/...",
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value) return "Enter an LMS JSON API URL.";
          try {
            const url = new URL(value);
            if (url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
              return null;
            }
            return "Use HTTPS, except for a local development server.";
          } catch (error) {
            return "Enter a valid URL.";
          }
        },
      });
      if (!endpoint) return;
      await vscode.workspace.getConfiguration("pluglytics").update(
        "lmsDateOptionsUrl",
        endpoint,
        vscode.ConfigurationTarget.Global
      );
      try {
        const dates = await fetchLmsDates(context);
        vscode.window.showInformationMessage(`Fetched ${dates.length} date values from the configured LMS endpoint.`);
      } catch (error) {
        vscode.window.showErrorMessage(`LMS date fetch failed: ${error.message}`);
      }
    }
  );
  const setLmsToken = vscode.commands.registerCommand(
    "pluglytics.setLmsToken",
    async () => {
      const token = await vscode.window.showInputBox({
        title: "Set LMS API token",
        prompt: "Paste a read-only LMS API token. It will be stored in VS Code SecretStorage.",
        password: true,
        ignoreFocusOut: true,
      });
      if (!token) return;
      await context.secrets.store("pluglytics.lmsApiToken", token);
      vscode.window.showInformationMessage("LMS API token saved securely.");
    }
  );

  context.subscriptions.push(
    openDashboard,
    openDocs,
    startApi,
    healthCheck,
    connect,
    refreshDates,
    filterDates,
    configureLms,
    setLmsToken
  );

  context.secrets.get("pluglytics.jwt").then(async (token) => {
    if (!token) {
      try {
        const dates = await fetchLmsDates(context);
        if (dates.length) output.appendLine(`Fetched ${dates.length} dates from the configured LMS API.`);
      } catch (error) {
        output.appendLine(`Unable to fetch LMS dates: ${error.message}`);
        vscode.window.showWarningMessage(`Unable to fetch LMS dates: ${error.message}`);
      }
      if (context.globalState.get("pluglytics.connectionPromptShown")) return;
      await context.globalState.update("pluglytics.connectionPromptShown", true);
      const action = await vscode.window.showInformationMessage(
        "PlugLytics is ready. Connect your account to fetch available LMS dates.",
        "Connect account"
      );
      if (action === "Connect account") {
        await connectAccount(context).catch((error) => vscode.window.showErrorMessage(error.message));
      }
      return;
    }
    getDateOptions(context).then((options) => {
      output.appendLine(
        `Fetched ${options.terms.length} terms, ${options.dates.length} PlugLytics dates, and ${options.lmsDates.length} LMS dates.`
      );
      if (options.lmsDateError) {
        vscode.window.showWarningMessage(`Unable to refresh LMS dates: ${options.lmsDateError}`);
      }
        if (options.lmsDateError) {
          output.appendLine(`Unable to refresh LMS dates: ${options.lmsDateError}`);
        }
    }).catch((error) => {
      output.appendLine(`Unable to refresh available dates: ${error.message}`);
      vscode.window.showErrorMessage(`Unable to refresh PlugLytics dates: ${error.message}`);
    });
  });
}

function deactivate() {}

module.exports = { activate, deactivate, extractDates, readApiResponse };
