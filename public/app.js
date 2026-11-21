const state = {
  token: localStorage.getItem("pluglytics_token"),
  role: null,
  catalog: [],
  widgets: [],
  charts: [],
  filterOptions: null,
  summary: [],
};

const byId = (id) => document.getElementById(id);

let apiBaseError = "";

function getApiBaseUrl() {
  const configuredUrl = new URLSearchParams(location.search).get("apiBaseUrl");
  if (!configuredUrl) {
    if (location.protocol === "file:") {
      apiBaseError =
        "Open the dashboard through the PlugLytics server, not directly from disk. Run `npm run dev`, then visit http://localhost:3000/public/dashboard.html.";
      return "";
    }
    return location.origin;
  }

  try {
    const url = new URL(configuredUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      apiBaseError = "The apiBaseUrl parameter must use HTTP or HTTPS.";
      return "";
    }
    return url.origin;
  } catch (error) {
    apiBaseError = "The apiBaseUrl parameter must be a valid HTTP or HTTPS URL.";
    return "";
  }
}

const apiBaseUrl = getApiBaseUrl();

if (location.protocol === "file:") {
  byId("loginForm").hidden = true;
  byId("fileProtocolHelp").hidden = false;
}

async function requestApi(path, options = {}) {
  if (!apiBaseUrl) {
    throw new Error(apiBaseError || "The PlugLytics API URL is not configured.");
  }

  let response;
  try {
    response = await fetch(`${apiBaseUrl}/api/v1${path}`, options);
  } catch (error) {
    throw new Error(
      `Could not reach the PlugLytics API at ${apiBaseUrl}. Start it with \`npm run dev\` and open the dashboard from that server. If the API is hosted on another origin, configure CORS for the website.`
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (!response.ok) {
      throw new Error(
        `The PlugLytics API returned a non-JSON response (HTTP ${response.status}). Confirm the API URL and open the dashboard from the PlugLytics server, not a static or file URL.`
      );
    }
    throw new Error("The PlugLytics API returned invalid JSON.");
  }

  if (!response.ok) {
    throw new Error(body.error?.message || `PlugLytics API request failed (HTTP ${response.status}).`);
  }
  return body;
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return requestApi(path, { ...options, headers });
}

function filterQuery() {
  const params = new URLSearchParams();
  const term = byId("termFilter").value;
  const course = byId("courseFilter").value.trim();
  const section = byId("sectionFilter").value.trim();
  const groupBy = byId("groupFilter").value;
  const from = byId("fromFilter").value;
  const to = byId("toFilter").value;
  if (term) params.set("term", term);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (course) params.set("course", course);
  if (section) params.set("section", section);
  if (groupBy) params.set("groupBy", groupBy);
  return params.toString();
}

function endpointForWidget(id) {
  const map = {
    "student-progress": "/student/progress",
    "student-grades": "/student/grades",
    "student-deadlines": "/student/deadlines",
    "student-standing": "/student/standing",
    "student-risk": "/student/risk",
    "section-performance": "/instructor/compare",
    "assignment-rate": "/instructor/assignments",
    "item-analysis": "/instructor/item-analysis",
    "engagement": "/instructor/engagement",
    "enrollment-summary": "/admin/enrollment/summary",
    "finance-overview": "/admin/finance/overview",
    "academic-quality": "/admin/academics/gpa-by-specialization",
  };
  return map[id];
}

function configureWorkspace(role) {
  const titles = {
    student: "Student learning overview",
    instructor: "Teaching overview",
    admin: "Academic overview",
  };
  const title = titles[role] || "Learning overview";
  byId("roleLabel").textContent = `${role} workspace`;
  byId("dashboardHeading").textContent = "Your dashboard";
  byId("pageTitle").textContent = title;
}

async function startSession() {
  const me = await api("/auth/me");
  state.role = me.data.role;
  byId("loginScreen").hidden = true;
  byId("app").hidden = false;
  configureWorkspace(state.role);

  const catalog = await api("/widgets");
  state.catalog = catalog.data;
  const filterOptions = await api("/me/filter-options");
  state.filterOptions = filterOptions.data;
  const saved = await api("/me/dashboard");
  state.widgets = saved.data.widgets || [];
  populateTerms(state.filterOptions.terms || []);
  const query = new URLSearchParams(location.search);
  const savedFilters = saved.data.filters || {};
  byId("fromFilter").value = query.get("from") || savedFilters.from || "";
  byId("toFilter").value = query.get("to") || savedFilters.to || "";
  byId("termFilter").value = query.get("term") || savedFilters.term || "";
  byId("courseFilter").value = query.get("course") || savedFilters.course || "";
  byId("sectionFilter").value = query.get("section") || savedFilters.section || "";
  const theme = localStorage.getItem("pluglytics_theme") || saved.data.theme || "light";
  byId("themeSelect").value = theme;
  applyTheme(theme);
  renderCatalog();
  await renderWidgets();
}

function populateTerms(terms) {
  const select = byId("termFilter");
  const selected = select.value;
  select.innerHTML = `<option value="">All available terms</option>` +
    terms.map((term) => `<option value="${term.code}">${term.name}</option>`).join("");
  select.value = selected;
}

function renderCatalog() {
  byId("widgetCatalog").innerHTML = state.catalog.map((widget) => {
    const selected = state.widgets.find((item) => item.id === widget.id);
    return `<div class="widget-option">
      <input id="feature-${widget.id}" type="checkbox" data-widget="${widget.id}" ${selected ? "checked" : ""}>
      <label for="feature-${widget.id}"><strong>${escapeHtml(widget.title)}</strong><small>${escapeHtml(widget.description)}</small></label>
      <button type="button" data-move="${widget.id}" title="Move ${escapeHtml(widget.title)} down" aria-label="Move ${escapeHtml(widget.title)} down">↓</button>
    </div>`;
  }).join("");

  byId("widgetCatalog").querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.widgets.push({ id: input.dataset.widget, chartType: "bar" });
      } else {
        state.widgets = state.widgets.filter((item) => item.id !== input.dataset.widget);
      }
      renderWidgets();
    });
  });

  byId("widgetCatalog").querySelectorAll("[data-move]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = state.widgets.findIndex((item) => item.id === button.dataset.move);
      if (index < 0 || index === state.widgets.length - 1) return;
      [state.widgets[index], state.widgets[index + 1]] = [state.widgets[index + 1], state.widgets[index]];
      renderWidgets();
    });
  });
}

function destroyCharts() {
  state.charts.forEach((chart) => chart.destroy());
  state.charts = [];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function tableHtml(rows) {
  if (!rows.length) return `<div class="widget-card-empty">No data for these filters</div>`;
  const keys = Object.keys(rows[0]).slice(0, 5);
  return `<table><thead><tr>${keys.map((key) => `<th>${escapeHtml(key)}</th>`).join("")}</tr></thead>
    <tbody>${rows.slice(0, 8).map((row) =>
      `<tr>${keys.map((key) => `<td>${escapeHtml(row[key])}</td>`).join("")}</tr>`
    ).join("")}</tbody></table>`;
}

function addSummary(widgetId, data) {
  if (state.role !== "student") return;
  const rows = Array.isArray(data) ? data : [];
  const summaries = {
    "student-progress": {
      label: "Course progress",
      value: rows.length
        ? `${Math.round(rows.reduce((total, row) => total + (Number(row.progressPercent) || 0), 0) / rows.length)}%`
        : "—",
      detail: `${rows.length} ${rows.length === 1 ? "course" : "courses"}`,
    },
    "student-grades": {
      label: "Grade average",
      value: rows.length && rows.some((row) => Number.isFinite(row.gpa))
        ? `${(rows.reduce((total, row) => total + (Number(row.gpa) || 0), 0) / rows.filter((row) => Number.isFinite(row.gpa)).length).toFixed(1)} GPA`
        : "—",
      detail: "Across available terms",
    },
    "student-deadlines": {
      label: "Upcoming deadlines",
      value: rows.filter((row) => row.status === "upcoming" || row.status === "overdue").length,
      detail: "Not yet submitted",
    },
    "student-standing": {
      label: "Class standing",
      value: data.percentileBand === "unavailable" ? "—" : data.percentileBand,
      detail: data.percentileBand === "unavailable" ? "Not enough data yet" : "Anonymous cohort view",
    },
    "student-risk": {
      label: "Progress check-in",
      value: data.atRisk ? "Needs attention" : "On track",
      detail: data.reasons?.length ? data.reasons.join(" · ") : "No current concerns",
    },
  };
  const item = summaries[widgetId];
  if (item) state.summary.push(item);
}

function renderSummary() {
  const grid = byId("summaryGrid");
  grid.hidden = !state.summary.length;
  grid.innerHTML = state.summary.map((item) => `
    <article class="summary-card">
      <p>${escapeHtml(item.label)}</p>
      <strong>${escapeHtml(item.value)}</strong>
      <small>${escapeHtml(item.detail)}</small>
    </article>
  `).join("");
}

function renderProgressCard(card, rows) {
  card.querySelector("canvas").remove();
  const items = rows.map((row) => {
    const progress = Math.max(0, Math.min(100, Number(row.progressPercent) || 0));
    return `<li class="course-progress-item">
      <div class="course-progress-heading"><strong>${escapeHtml(row.title || row.courseCode)}</strong>
        <span>${progress}%</span></div>
      <div class="progress-track" role="progressbar" aria-label="${escapeHtml(row.title || row.courseCode)} progress" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100">
        <span style="width:${progress}%"></span>
      </div>
      <small>${escapeHtml(row.term || row.courseCode || "Course")}${Number.isFinite(row.averageScore) ? ` · ${escapeHtml(row.averageScore)}% average` : ""}</small>
    </li>`;
  }).join("");
  card.innerHTML += rows.length
    ? `<ul class="course-progress-list">${items}</ul>`
    : `<div class="widget-card-empty">No course progress for these filters</div>`;
}

function renderScheduleCard(card, rows) {
  card.querySelector("canvas").remove();
  const items = rows.slice(0, 6).map((row) => {
    const due = new Date(row.dueAt);
    const validDate = !Number.isNaN(due.getTime());
    const day = validDate ? due.toLocaleDateString(undefined, { day: "2-digit" }) : "—";
    const month = validDate ? due.toLocaleDateString(undefined, { month: "short" }) : "";
    return `<li class="schedule-item">
      <div class="schedule-date"><span>${escapeHtml(month)}</span><strong>${escapeHtml(day)}</strong></div>
      <div class="schedule-details"><strong>${escapeHtml(row.assignment)}</strong>
        <small>${escapeHtml(row.title || row.courseCode)}${row.status === "submitted" ? " · Submitted" : ""}</small>
      </div>
      ${row.status === "overdue" ? '<span class="status-badge overdue">Overdue</span>' : ""}
    </li>`;
  }).join("");
  card.innerHTML += rows.length
    ? `<ul class="schedule-list">${items}</ul>`
    : `<div class="widget-card-empty">You’re all caught up</div>`;
}

async function renderWidgets() {
  destroyCharts();
  state.summary = [];
  const grid = byId("widgetGrid");
  byId("summaryGrid").innerHTML = "";
  if (!state.widgets.length) {
    grid.innerHTML = `<div class="widget-card widget-card-empty">Select a widget to build your dashboard.</div>`;
    renderSummary();
    return;
  }

  grid.innerHTML = state.widgets.map((widget) => {
    const info = state.catalog.find((item) => item.id === widget.id);
    return `<article class="widget-card widget-${widget.id}" id="card-${widget.id}">
      <div class="widget-card-heading"><div><h2>${escapeHtml(info?.title || widget.id)}</h2>
        ${info?.description ? `<p>${escapeHtml(info.description)}</p>` : ""}
      </div></div>
      <canvas></canvas>
    </article>`;
  }).join("");

  const query = filterQuery();
  for (const widget of state.widgets) {
    const card = byId(`card-${widget.id}`);
    try {
      const endpoint = endpointForWidget(widget.id);
      if (!endpoint) continue;
      const response = await api(`${endpoint}${query ? `?${query}` : ""}`);
      const data = response.data;
      const rows = Array.isArray(data) ? data : (data && typeof data === "object" ? [data] : []);
      addSummary(widget.id, data);

      if (widget.id === "student-progress") {
        renderProgressCard(card, rows);
        continue;
      }

      if (widget.id === "student-deadlines") {
        renderScheduleCard(card, rows);
        continue;
      }

      if (widget.id === "student-standing") {
        card.querySelector("canvas").remove();
        card.innerHTML += `<div class="insight-value">${escapeHtml(data.percentileBand || "Unavailable")}</div>
          <p>${escapeHtml(data.reason || (data.cohortSize ? `Based on an anonymous group of ${data.cohortSize} learners.` : "Anonymous cohort comparison."))}</p>`;
        continue;
      }

      if (widget.id === "student-risk") {
        card.querySelector("canvas").remove();
        const reasons = Array.isArray(data.reasons) ? data.reasons : [];
        card.innerHTML += `<div class="insight-value ${data.atRisk ? "needs-attention" : ""}">${data.atRisk ? "Needs attention" : "On track"}</div>
          <p>${escapeHtml(reasons.length ? reasons.join(" · ") : "No current concerns based on available activity.")}</p>`;
        continue;
      }

      const canvas = card.querySelector("canvas");
      if (rows.length > 8) {
        card.innerHTML += tableHtml(rows);
        canvas.remove();
        continue;
      }

      const numericKeys = rows.length ? Object.keys(rows[0]).filter((key) =>
        typeof rows[0][key] === "number" && !/id$/i.test(key)
      ) : [];
      const labelKey = Object.keys(rows[0] || {}).find((key) => typeof rows[0][key] === "string") || "label";
      const valueKey = (widget.id === "student-grades" && numericKeys.includes("gpa") ? "gpa" : numericKeys[0]);

      if (!valueKey) {
        card.innerHTML += tableHtml(rows);
        canvas.remove();
        continue;
      }

      state.charts.push(new Chart(canvas, {
        type: "bar",
        data: {
          labels: rows.map((row) => row[labelKey]),
          datasets: [{
            label: valueKey,
            data: rows.map((row) => row[valueKey]),
            backgroundColor: "#45a29e",
            borderRadius: 5,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: getComputedStyle(document.body).getPropertyValue("--muted") } },
            y: { ticks: { color: getComputedStyle(document.body).getPropertyValue("--muted") } },
          },
        },
      }));
    } catch (error) {
      card.innerHTML = `<div class="widget-card-heading"><h2>${escapeHtml(state.catalog.find((item) => item.id === widget.id)?.title || widget.id)}</h2></div>
        <p class="widget-error">Unable to load this feature: ${escapeHtml(error.message)}</p>`;
    }
  }
  renderSummary();
}

function applyTheme(theme) {
  document.body.classList.toggle("dark", theme === "dark");
  localStorage.setItem("pluglytics_theme", theme);
}

byId("customizeButton").addEventListener("click", () => {
  const panel = byId("customizePanel");
  const open = panel.hidden;
  panel.hidden = !open;
  byId("customizeButton").setAttribute("aria-expanded", String(open));
});

byId("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await requestApi("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: byId("email").value,
        password: byId("password").value,
      }),
    });
    if (!result.data?.token) throw new Error(result.error?.message || "Login failed");
    state.token = result.data.token;
    localStorage.setItem("pluglytics_token", state.token);
    await startSession();
  } catch (error) {
    byId("loginError").textContent = error.message;
  }
});

byId("logoutButton").addEventListener("click", () => {
  localStorage.removeItem("pluglytics_token");
  location.reload();
});

byId("applyFilters").addEventListener("click", renderWidgets);
byId("themeSelect").addEventListener("change", (event) => applyTheme(event.target.value));

byId("saveLayout").addEventListener("click", async () => {
  const layout = {
    widgets: state.widgets,
    filters: {
      term: byId("termFilter").value,
      from: byId("fromFilter").value,
      to: byId("toFilter").value,
      course: byId("courseFilter").value,
      section: byId("sectionFilter").value,
      groupBy: byId("groupFilter").value,
    },
    theme: byId("themeSelect").value,
  };
  const button = byId("saveLayout");
  const status = byId("saveStatus");
  button.disabled = true;
  status.textContent = "Saving your dashboard...";
  try {
    await api("/me/dashboard", { method: "PUT", body: JSON.stringify(layout) });
    status.textContent = "Dashboard preferences saved.";
  } catch (error) {
    status.textContent = `Unable to save dashboard: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

if (state.token) {
  startSession().catch(() => {
    localStorage.removeItem("pluglytics_token");
  });
}
