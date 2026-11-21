const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  return request === "vscode" ? {} : originalLoad.call(this, request, parent, isMain);
};

const { extractDates } = require("../src/extension");
Module._load = originalLoad;

const epochDate = Math.floor(Date.UTC(2025, 3, 10) / 1000);
const epochMilliseconds = Date.UTC(2025, 4, 12);
assert.deepEqual(
  extractDates({
    courses: [{ start_at: "2025-01-02T10:00:00Z", endDate: "2025-05-01" }],
    assignments: [{ due_at: "2025-04-04T12:00:00Z" }],
    activity: { created_at: epochDate, updated_at: epochMilliseconds },
    score: 2025,
  }),
  ["2025-01-02", "2025-04-04", "2025-04-10", "2025-05-01", "2025-05-12"]
);

console.log("Extension date extraction tests passed.");
