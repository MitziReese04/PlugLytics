const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  return request === "vscode" ? {} : originalLoad.call(this, request, parent, isMain);
};

const {
  extractDates,
  isLocalBaseUrl,
  openDashboardPage,
  readApiResponse,
  waitForApi,
} = require("../src/extension");
Module._load = originalLoad;

const epochDate = Math.floor(Date.UTC(2025, 3, 10) / 1000);
const epochMilliseconds = Date.UTC(2025, 4, 12);
function createVscodeStub() {
  const openedUrls = [];
  const executedTasks = [];
  return {
    openedUrls,
    executedTasks,
    Task: class Task {
      constructor(...args) {
        this.args = args;
      }
    },
    ShellExecution: class ShellExecution {
      constructor(command) {
        this.command = command;
      }
    },
    TaskScope: { Workspace: "workspace" },
    ProgressLocation: { Notification: "notification" },
    tasks: {
      executeTask: async (task) => executedTasks.push(task),
    },
    window: {
      withProgress: async (_options, callback) => callback(),
    },
    Uri: {
      parse: (value) => ({ value }),
    },
    env: {
      openExternal: async (uri) => openedUrls.push(uri.value),
    },
  };
}

function healthyResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { database: "connected" } }),
  };
}

async function run() {
  assert.deepEqual(
    extractDates({
      courses: [{ start_at: "2025-01-02T10:00:00Z", endDate: "2025-05-01" }],
      assignments: [{ due_at: "2025-04-04T12:00:00Z" }],
      activity: { created_at: epochDate, updated_at: epochMilliseconds },
      score: 2025,
    }),
    ["2025-01-02", "2025-04-04", "2025-04-10", "2025-05-01", "2025-05-12"]
  );

  await assert.rejects(
    readApiResponse(
      { ok: false, status: 403, json: async () => { throw new SyntaxError("Unexpected token F"); } },
      "Sign-in"
    ),
    /non-JSON response \(HTTP 403\).*pluglytics\.baseUrl/
  );

  assert.equal(isLocalBaseUrl("http://localhost:3000"), true);
  assert.equal(isLocalBaseUrl("http://127.0.0.1:3000"), true);
  assert.equal(isLocalBaseUrl("https://pluglytics.example"), false);

  const vscodeStub = createVscodeStub();
  let healthChecks = 0;
  await openDashboardPage({
    baseUrl: "http://localhost:3000",
    queryParams: { from: "2026-01-01", to: "2026-03-31" },
    vscodeApi: vscodeStub,
    fetchImpl: async () => {
      healthChecks += 1;
      if (healthChecks === 1) throw new Error("ECONNREFUSED");
      return healthyResponse();
    },
  });
  assert.equal(vscodeStub.executedTasks.length, 1);
  assert.equal(vscodeStub.executedTasks[0].args[4].command, "npm run dev");
  assert.equal(
    vscodeStub.openedUrls[0],
    "http://localhost:3000/public/dashboard.html?from=2026-01-01&to=2026-03-31"
  );

  const unavailableRemote = createVscodeStub();
  await assert.rejects(
    openDashboardPage({
      baseUrl: "https://pluglytics.example",
      vscodeApi: unavailableRemote,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    /Unable to connect to the PlugLytics API.*offline/
  );
  assert.equal(unavailableRemote.executedTasks.length, 0);

  const health = await waitForApi("http://localhost:3000", {
    timeoutMs: 100,
    intervalMs: 0,
    fetchImpl: async () => healthyResponse(),
  });
  assert.equal(health.data.database, "connected");

  await assert.rejects(
    waitForApi("http://localhost:3000", {
      timeoutMs: 0,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
    /did not start.*Last connection error: ECONNREFUSED/
  );
}

run()
  .then(() => console.log("Extension date and API error tests passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
