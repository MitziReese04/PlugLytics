const state = {
  token: localStorage.getItem("pluglytics_token"),
  role: null,
  catalog: [],
  widgets: [],
  charts: [],
  filterOptions: null,
};

const byId = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(`/api/v1${path}`, { ...options, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || "Request failed");
  return body;
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

function roleNav(role) {
  const links = {
    student: ["Progress", "Grades", "Deadlines", "Standing", "Risk"],
    instructor: ["Sections", "Distribution", "Assignments", "Engagement", "At-risk"],
    admin: ["Enrollment", "Finance", "Academics", "Operations"],
  };
  byId("roleNav").innerHTML = (links[role] || []).map((label, index) =>
    `<button class="${index === 0 ? "active" : ""}" type="button">${label}</button>`
  ).join("");
  byId("roleLabel").textContent = `${role} workspace`;
}

async function startSession() {
  const me = await api("/auth/me");
  state.role = me.data.role;
  byId("loginScreen").hidden = true;
  byId("app").hidden = false;
  roleNav(state.role);

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
  byId("themeSelect").value = saved.data.theme || "light";
  applyTheme(saved.data.theme || "light");
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
    return `<label class="widget-option">
      <input type="checkbox" data-widget="${widget.id}" ${selected ? "checked" : ""}>
      <span>${widget.title}</span>
      <button type="button" data-move="${widget.id}" title="Move widget down">↓</button>
    </label>`;
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

function tableHtml(rows) {
  if (!rows.length) return `<div class="widget-card-empty">No data for these filters</div>`;
  const keys = Object.keys(rows[0]).slice(0, 5);
  return `<table><thead><tr>${keys.map((key) => `<th>${key}</th>`).join("")}</tr></thead>
    <tbody>${rows.slice(0, 8).map((row) =>
      `<tr>${keys.map((key) => `<td>${row[key] ?? ""}</td>`).join("")}</tr>`
    ).join("")}</tbody></table>`;
}

async function renderWidgets() {
  destroyCharts();
  const grid = byId("widgetGrid");
  if (!state.widgets.length) {
    grid.innerHTML = `<div class="widget-card widget-card-empty">Select a widget to build your dashboard.</div>`;
    return;
  }

  grid.innerHTML = state.widgets.map((widget) => {
    const info = state.catalog.find((item) => item.id === widget.id);
    return `<article class="widget-card" id="card-${widget.id}">
      <h3>${info?.title || widget.id}</h3>
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
      let data = response.data;
      if (!Array.isArray(data) && typeof data === "object") data = [data];

      if (widget.id.includes("standing") || widget.id.includes("risk")) {
        card.innerHTML = `<h3>${state.catalog.find((item) => item.id === widget.id)?.title || widget.id}</h3>${tableHtml(data)}`;
        continue;
      }

      const canvas = card.querySelector("canvas");
      if (data.length > 8) {
        card.innerHTML = `<h3>${state.catalog.find((item) => item.id === widget.id)?.title || widget.id}</h3>${tableHtml(data)}`;
        continue;
      }

      const numericKeys = data.length ? Object.keys(data[0]).filter((key) =>
        typeof data[0][key] === "number"
      ) : [];
      const labelKey = Object.keys(data[0] || {}).find((key) => typeof data[0][key] === "string") || "label";
      const valueKey = numericKeys[0];

      if (!valueKey) {
        card.innerHTML = `<h3>${state.catalog.find((item) => item.id === widget.id)?.title || widget.id}</h3>${tableHtml(data)}`;
        continue;
      }

      state.charts.push(new Chart(canvas, {
        type: "bar",
        data: {
          labels: data.map((row) => row[labelKey]),
          datasets: [{
            label: valueKey,
            data: data.map((row) => row[valueKey]),
            backgroundColor: "#6558d9",
            borderRadius: 5,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
        },
      }));
    } catch (error) {
      card.innerHTML = `<h3>Unable to load widget</h3><p>${error.message}</p>`;
    }
  }
}

function applyTheme(theme) {
  document.body.classList.toggle("dark", theme === "dark");
  localStorage.setItem("pluglytics_theme", theme);
}

byId("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: byId("email").value,
        password: byId("password").value,
      }),
    }).then((response) => response.json());
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
  await api("/me/dashboard", { method: "PUT", body: JSON.stringify(layout) });
  byId("saveLayout").textContent = "Saved";
  setTimeout(() => byId("saveLayout").textContent = "Save layout", 1200);
});

if (state.token) {
  startSession().catch(() => {
    localStorage.removeItem("pluglytics_token");
  });
}
