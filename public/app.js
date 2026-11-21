const state = {
  token: localStorage.getItem("pluglytics_token"),
  role: null,
  email: null,
  catalog: [],
  widgets: [],
  charts: [],
  filterOptions: null,
  summary: [],
  calendarMonth: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`,
  calendarRequestId: 0,
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

function filterQuery(widget) {
  const params = new URLSearchParams();
  const filters = {
    term: byId("termFilter").value,
    from: byId("fromFilter").value,
    to: byId("toFilter").value,
    specialization: byId("specializationFilter").value,
    program: byId("programFilter").value,
    course: byId("courseFilter").value,
    section: byId("sectionFilter").value,
    instructor: byId("instructorFilter").value,
    yearLevel: byId("yearLevelFilter").value,
    status: byId("statusFilter").value,
    groupBy: byId("groupFilter").value,
  };
  const supported = new Set(widget?.supportedFilters || []);
  for (const [key, value] of Object.entries(filters)) {
    if (supported.has(key) && value) params.set(key, value);
  }
  return params.toString();
}

function endpointForWidget(id) {
  const map = {
    "student-progress": "/student/progress",
    "student-grades": "/student/grades",
    "student-deadlines": "/student/deadlines",
    "student-risk": "/student/risk",
    "student-attendance": "/student/attendance",
    "student-activity": "/student/activity-summary",
    "instructor-sections": "/instructor/sections",
    "section-performance": "/instructor/compare",
    "assignment-rate": "/instructor/assignments",
    "item-analysis": "/instructor/item-analysis",
    "engagement": "/instructor/engagement",
    "instructor-attendance": "/instructor/attendance",
    "instructor-at-risk": "/instructor/at-risk",
    "enrollment-summary": "/admin/enrollment/summary",
    "enrollment-specialization": "/admin/enrollment/by-specialization",
    "enrollment-year-level": "/admin/enrollment/year-level",
    "enrollment-retention": "/admin/enrollment/retention",
    "seat-utilization": "/admin/enrollment/seat-utilization",
    "finance-overview": "/admin/finance/overview",
    "finance-outstanding": "/admin/finance/outstanding",
    "income-specialization": "/admin/finance/income-by-specialization",
    "finance-refunds": "/admin/finance/refunds",
    "academic-quality": "/admin/academics/gpa-by-specialization",
    "pass-rates": "/admin/academics/pass-rates",
    "instructor-ratings": "/admin/academics/ratings",
    "course-popularity": "/admin/operations/course-popularity",
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
  byId("calendarSection").hidden = role !== "student";
  byId("curriculumDashboard").hidden = role !== "student";
  byId("courseOutlineLink").hidden = role !== "student";
}

async function startSession() {
  const me = await api("/auth/me");
  state.role = me.data.role;
  state.email = me.data.email;
  byId("loginScreen").hidden = true;
  byId("app").hidden = false;
  configureWorkspace(state.role);

  const catalog = await api("/widgets");
  const isSampleCurriculumStudent = state.email === "student@pluglytics.local";
  state.catalog = catalog.data.filter((widget) =>
    !(isSampleCurriculumStudent && widget.id === "student-progress")
  );
  const filterOptions = await api("/me/filter-options");
  state.filterOptions = filterOptions.data;
  const saved = await api("/me/dashboard");
  const availableWidgetIds = new Set(state.catalog.map((widget) => widget.id));
  state.widgets = (saved.data.widgets || []).filter((widget) => availableWidgetIds.has(widget.id));
  if (isSampleCurriculumStudent && (saved.data.widgets || []).length && !state.widgets.length) {
    state.widgets = state.catalog.filter((widget) => widget.default).map((widget) => ({ id: widget.id, chartType: "bar" }));
  }
  populateFilters(state.filterOptions, state.role);
  const query = new URLSearchParams(location.search);
  const savedFilters = saved.data.filters || {};
  byId("fromFilter").value = query.get("from") || savedFilters.from || "";
  byId("toFilter").value = query.get("to") || savedFilters.to || "";
  byId("termFilter").value = query.get("term") || savedFilters.term || "";
  byId("courseFilter").value = query.get("course") || savedFilters.course || "";
  byId("sectionFilter").value = query.get("section") || savedFilters.section || "";
  byId("specializationFilter").value = query.get("specialization") || savedFilters.specialization || "";
  byId("programFilter").value = query.get("program") || savedFilters.program || "";
  byId("instructorFilter").value = query.get("instructor") || savedFilters.instructor || "";
  byId("yearLevelFilter").value = query.get("yearLevel") || savedFilters.yearLevel || "";
  byId("statusFilter").value = query.get("status") || savedFilters.status || "";
  byId("groupFilter").value = savedFilters.groupBy || "";
  const theme = localStorage.getItem("pluglytics_theme") || saved.data.theme || "light";
  byId("themeSelect").value = theme;
  applyTheme(theme);
  renderCatalog();
  renderDemoEvents();
  await renderWidgets();
  if (state.role === "student") {
    await Promise.all([loadCalendar(), loadCurriculumOverview()]);
  }
}

function populateSelect(id, options, placeholder, map = (item) => [item.value, item.label]) {
  const select = byId(id);
  const selected = select.value;
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
    options.map((item) => {
      const [value, label] = map(item);
      return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
    }).join("");
  select.value = selected;
}

function populateFilters(options, role) {
  populateSelect("termFilter", options.terms || [], "All available terms", (term) => [term.code, term.name]);
  populateSelect("specializationFilter", options.specializations || [], "All specializations");
  populateSelect("programFilter", options.programs || [], "All programs");
  populateSelect("courseFilter", options.courses || [], "All courses");
  populateSelect("sectionFilter", options.sections || [], "All sections");
  populateSelect("instructorFilter", options.instructors || [], "All instructors");
  populateSelect("yearLevelFilter", options.yearLevels || [], "All year levels");
  populateSelect("statusFilter", options.statuses || [], "All statuses");

  const visibleFilters = role === "admin"
    ? ["specializationFilter", "programFilter", "courseFilter", "sectionFilter", "instructorFilter", "yearLevelFilter", "statusFilter"]
    : role === "instructor"
      ? ["courseFilter", "sectionFilter"]
      : ["courseFilter", "sectionFilter"];
  for (const id of ["specializationFilter", "programFilter", "courseFilter", "sectionFilter", "instructorFilter", "yearLevelFilter", "statusFilter"]) {
    byId(id).closest("label").hidden = !visibleFilters.includes(id);
  }
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
  return `<div class="widget-table-wrap" role="region" aria-label="Scrollable report table" tabindex="0">
    <table><thead><tr>${keys.map((key) => `<th>${escapeHtml(key)}</th>`).join("")}</tr></thead>
      <tbody>${rows.slice(0, 8).map((row) =>
        `<tr>${keys.map((key) => `<td>${escapeHtml(row[key])}</td>`).join("")}</tr>`
      ).join("")}</tbody></table>
  </div>`;
}

function addSummary(widgetId, data) {
  const rows = Array.isArray(data) ? data : [];
  let item;
  if (state.role === "student") {
    const summaries = {
      "student-progress": {
        label: "Enrolled course activity",
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
      "student-attendance": {
        label: "Attendance rate",
        value: rows.length && rows.some((row) => Number.isFinite(row.attendancePercent))
          ? `${(rows.reduce((total, row) => total + (Number(row.attendancePercent) || 0), 0) / rows.filter((row) => Number.isFinite(row.attendancePercent)).length).toFixed(1)}%`
          : "—",
        detail: `${rows.length} ${rows.length === 1 ? "course" : "courses"}`,
      },
      "student-risk": {
        label: "Progress check-in",
        value: data.atRisk ? "Needs attention" : "On track",
        detail: data.reasons?.length ? data.reasons.join(" · ") : "No current concerns",
      },
    };
    item = summaries[widgetId];
  } else if (state.role === "instructor") {
    if (widgetId === "instructor-sections") {
      item = { label: "Classes you teach", value: rows.length, detail: "Open a class folder for student details" };
    } else if (widgetId === "assignment-rate" && rows.length) {
      const rates = rows.filter((row) => Number.isFinite(row.submissionRate));
      item = {
        label: "Average submission rate",
        value: rates.length ? `${(rates.reduce((total, row) => total + row.submissionRate, 0) / rates.length).toFixed(1)}%` : "—",
        detail: `${rows.length} assessments`,
      };
    } else if (widgetId === "instructor-attendance" && rows.length) {
      const rates = rows.filter((row) => Number.isFinite(row.attendanceRate));
      item = {
        label: "Average attendance",
        value: rates.length ? `${(rates.reduce((total, row) => total + row.attendanceRate, 0) / rates.length).toFixed(1)}%` : "—",
        detail: `${rows.length} sections`,
      };
    }
  } else if (state.role === "admin") {
    const row = rows[0] || {};
    if (widgetId === "enrollment-summary") {
      item = { label: "Enrolled students", value: row.enrolledStudents ?? "—", detail: `${row.waitlisted ?? 0} waitlisted` };
    } else if (widgetId === "finance-overview") {
      item = {
        label: "Tuition collected",
        value: row.collected == null ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(row.collected),
        detail: `${row.collectionRate ?? 0}% of ${row.billed == null ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(row.billed)} billed`,
      };
    }
  }
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

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function renderCalendarGrid(year, month, gridStart, dayCount, events) {
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const eventsByDate = new Map();
  for (const event of events) {
    const key = event.start.slice(0, 10);
    if (!eventsByDate.has(key)) eventsByDate.set(key, []);
    eventsByDate.get(key).push(event);
  }

  const weekdayHeaders = `<div class="calendar-week" role="row">${weekdayNames.map((day) =>
    `<div class="calendar-weekday" role="columnheader">${day}</div>`
  ).join("")}</div>`;
  const weeks = Array.from({ length: dayCount / 7 }, (_, weekIndex) => {
    const cells = Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + weekIndex * 7 + dayIndex);
      const key = dateKey(date);
      const dayEvents = eventsByDate.get(key) || [];
      const inMonth = date.getMonth() === month;
      const today = key === dateKey(new Date());
      const eventItems = dayEvents.slice(0, 3).map((event) =>
        `<li class="calendar-event${event.isDemo ? " calendar-event-demo" : ""} calendar-event-${escapeHtml(event.type || "deadline")}" title="${escapeHtml(event.title)} - ${escapeHtml(event.courseTitle || event.courseCode || "")}">
          <span class="calendar-event-dot" aria-hidden="true"></span>
          <span>${escapeHtml(event.title)}</span>
        </li>`
      ).join("");
      const more = dayEvents.length > 3
        ? `<li class="calendar-more">+${dayEvents.length - 3} more</li>`
        : "";
      const accessibleDate = date.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      const eventDescription = dayEvents.length
        ? `, ${dayEvents.length} ${dayEvents.length === 1 ? "event" : "events"}`
        : "";
      return `<div class="calendar-day${inMonth ? "" : " other-month"}${today ? " today" : ""}" role="gridcell" aria-label="${escapeHtml(accessibleDate + eventDescription)}">
        <time datetime="${key}">${date.getDate()}</time>
        <ul class="calendar-event-list">${eventItems}${more}</ul>
      </div>`;
    }).join("");
    return `<div class="calendar-week" role="row">${cells}</div>`;
  }).join("");

  byId("calendarGrid").innerHTML = weekdayHeaders + weeks;
  const monthEvents = events.filter((event) => {
    const date = new Date(`${event.start.slice(0, 10)}T00:00:00`);
    return date.getFullYear() === year && date.getMonth() === month;
  });
  const empty = byId("calendarEmpty");
  empty.hidden = monthEvents.length > 0;
  empty.textContent = "No assignment deadlines match this month and the selected filters. Browse other months or adjust filters.";
}

function demoCalendarEvents(from, to) {
  if (state.email !== "student@pluglytics.local") return [];
  const term = byId("termFilter").value;
  const course = byId("courseFilter").value;
  const section = byId("sectionFilter").value;
  return (window.PLUGLYTICS_DEMO_DATA?.events.student || [])
    .filter((event) => event.date >= from && event.date <= to)
    .filter((event) => !term || term === "2026-2")
    .filter((event) => !course || event.courseCode === course)
    .filter((event) => !section || event.section === section)
    .map((event, index) => ({
      id: `demo-${index}`,
      title: event.title,
      start: `${event.date}T${event.time}:00`,
      courseCode: event.courseCode || "",
      type: event.type,
      isDemo: true,
    }));
}

function renderDemoEvents() {
  const roleEmails = {
    student: "student@pluglytics.local",
    instructor: "instructor@pluglytics.local",
    admin: "admin@pluglytics.local",
  };
  const isDemoRoleAccount = state.email === roleEmails[state.role];
  if (!isDemoRoleAccount) return;

  if (state.role === "student") {
    byId("calendarDescription").textContent = "Assignment deadlines plus clearly labeled illustrative demo events.";
    byId("calendarDataNote").textContent = "Demo events are static preview data and are not written to the LMS API.";
    byId("calendarDemoLegend").hidden = false;
    return;
  }

  const events = window.PLUGLYTICS_DEMO_DATA?.events[state.role] || [];
  byId("demoEventsHeading").textContent = state.role === "instructor"
    ? "Upcoming class, assignment, and meeting examples"
    : "Upcoming operations and finance examples";
  byId("demoEventsList").innerHTML = events.map((event) => {
    const date = new Date(`${event.date}T00:00:00`);
    const dateLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<li class="schedule-item">
      <div class="schedule-date"><span>${escapeHtml(dateLabel)}</span><strong>${escapeHtml(event.time)}</strong></div>
      <div class="schedule-details"><strong>${escapeHtml(event.title)}</strong>
        <small>${escapeHtml(event.type)}${event.courseCode ? ` · ${escapeHtml(event.courseCode)}` : ""} · Demo example</small>
      </div>
    </li>`;
  }).join("");
  byId("demoEventsSection").hidden = false;
}

async function loadCalendar() {
  const [year, monthNumber] = state.calendarMonth.split("-").map(Number);
  const month = monthNumber - 1;
  const firstDay = new Date(year, month, 1);
  const lastDate = new Date(year, month + 1, 0).getDate();
  const dayCount = Math.ceil((firstDay.getDay() + lastDate) / 7) * 7;
  const gridStart = new Date(year, month, 1 - firstDay.getDay());
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + dayCount - 1);
  byId("calendarMonthLabel").textContent = firstDay.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  byId("calendarGrid").setAttribute("aria-label", `${byId("calendarMonthLabel").textContent} calendar`);
  byId("calendarError").hidden = true;
  const requestId = ++state.calendarRequestId;
  const selectedFrom = byId("fromFilter").value ? new Date(`${byId("fromFilter").value}T00:00:00`) : gridStart;
  const selectedTo = byId("toFilter").value ? new Date(`${byId("toFilter").value}T00:00:00`) : gridEnd;
  const requestFrom = selectedFrom > gridStart ? selectedFrom : gridStart;
  const requestTo = selectedTo < gridEnd ? selectedTo : gridEnd;
  if (requestFrom > requestTo) {
    renderCalendarGrid(year, month, gridStart, dayCount, []);
    return;
  }
  const params = new URLSearchParams({
    from: dateKey(requestFrom),
    to: dateKey(requestTo),
  });
  for (const id of ["termFilter", "courseFilter", "sectionFilter"]) {
    const key = id.replace("Filter", "").toLowerCase();
    const value = byId(id).value;
    if (value) params.set(key, value);
  }
  try {
    const response = await api(`/student/calendar?${params}`);
    if (requestId !== state.calendarRequestId) return;
    renderCalendarGrid(year, month, gridStart, dayCount, [
      ...response.data,
      ...demoCalendarEvents(dateKey(requestFrom), dateKey(requestTo)),
    ]);
  } catch (error) {
    if (requestId !== state.calendarRequestId) return;
    renderCalendarGrid(year, month, gridStart, dayCount, demoCalendarEvents(dateKey(requestFrom), dateKey(requestTo)));
    byId("calendarError").textContent = `Unable to load calendar: ${error.message}`;
    byId("calendarError").hidden = false;
  }
}

function moveCalendarMonth(amount) {
  const [year, month] = state.calendarMonth.split("-").map(Number);
  const next = new Date(year, month - 1 + amount, 1);
  state.calendarMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  loadCalendar();
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

function ordinal(value) {
  const suffix = value % 10 === 1 && value % 100 !== 11 ? "st"
    : value % 10 === 2 && value % 100 !== 12 ? "nd"
      : value % 10 === 3 && value % 100 !== 13 ? "rd" : "th";
  return `${value}${suffix}`;
}

function renderCurriculumOverview(data) {
  const section = byId("curriculumDashboard");
  const completed = data.courses.filter((course) => course.status === "completed");
  const inProgress = data.courses.filter((course) => course.status === "in_progress");
  const remaining = data.courses.filter((course) => course.status === "remaining");
  byId("curriculumDashboardHeading").textContent = data.specialization
    ? `${data.specialization} course map`
    : `${data.programName} course map`;
  byId("curriculumDashboardSubheading").textContent = `${data.programName} · ${data.curriculumVersion || "Program catalog"}`;
  byId("dashboardCompletionPercent").textContent = `${data.completionPercent}%`;
  byId("dashboardCompletionFill").style.width = `${data.completionPercent}%`;
  byId("curriculumDashboard").querySelector('[role="progressbar"]').setAttribute("aria-valuenow", data.completionPercent);
  byId("dashboardCompletedUnits").textContent = data.completedUnits;
  byId("dashboardTotalUnits").textContent = data.totalUnits;
  byId("dashboardRemainingUnits").textContent = data.remainingUnits;
  byId("dashboardCompletedCourses").textContent = completed.length;
  byId("dashboardRemainingCourses").textContent = remaining.length;
  byId("curriculumDashboardSource").textContent = data.source === "demo_curriculum"
    ? "Demo map from the February 2025 Software Development curriculum sheet. Course completion statuses are illustrative."
    : "Using the program catalog and recorded enrollments. This account does not yet have LMS curriculum data synced.";

  const years = new Map();
  for (const course of data.courses) {
    const yearKey = course.year ? String(course.year) : "catalog";
    const termKey = course.term ? String(course.term) : "catalog";
    if (!years.has(yearKey)) years.set(yearKey, new Map());
    const terms = years.get(yearKey);
    if (!terms.has(termKey)) terms.set(termKey, []);
    terms.get(termKey).push(course);
  }
  const orderedYears = [...years.entries()].sort(([left], [right]) => {
    if (left === "catalog") return 1;
    if (right === "catalog") return -1;
    return Number(left) - Number(right);
  });
  byId("curriculumDashboardTerms").innerHTML = orderedYears.map(([yearKey, terms]) => {
    const orderedTerms = [...terms.entries()].sort(([left], [right]) => {
      if (left === "catalog") return 1;
      if (right === "catalog") return -1;
      return Number(left) - Number(right);
    });
    const yearCourses = [...terms.values()].flat();
    const yearUnits = yearCourses.reduce((total, course) => total + (Number(course.units) || 0), 0);
    const yearHeading = yearKey === "catalog" ? "Program course catalog" : `${ordinal(Number(yearKey))} year`;
    const termCards = orderedTerms.map(([termKey, courses]) => {
      const units = courses.reduce((total, course) => total + (Number(course.units) || 0), 0);
      const finished = courses.filter((course) => course.status === "completed").length;
      const current = courses.some((course) => course.status === "in_progress");
      const heading = termKey === "catalog" ? "Courses" : `${ordinal(Number(termKey))} term`;
      const courseItems = courses.map((course) => {
        const code = course.courseCode || course.code;
        const status = ["completed", "in_progress"].includes(course.status) ? course.status : "remaining";
        const statusText = status === "completed" ? "Finished" : status === "in_progress" ? "In progress" : "Remaining";
        const type = course.type ? ` · ${course.type}` : "";
        return `<li class="curriculum-course status-${status}">
          <input type="checkbox" ${status === "completed" ? "checked" : ""} disabled aria-label="${escapeHtml(code)}: ${statusText}">
          <div class="curriculum-course-details">
            <strong><span>${escapeHtml(code)}</span> ${escapeHtml(course.title)}</strong>
            <small>${escapeHtml(course.units)} units${type}</small>
          </div>
          <span class="course-status-badge">${statusText}</span>
        </li>`;
      }).join("");
      return `<details class="curriculum-dashboard-term" ${current ? "open" : ""}>
        <summary><strong>${heading}</strong><span>${finished}/${courses.length} finished · ${units} units</span></summary>
        <ul>${courseItems}</ul>
      </details>`;
    }).join("");
    return `<section class="curriculum-dashboard-year">
      <header class="curriculum-dashboard-year-heading">
        <h3>${yearHeading}</h3><span>${yearCourses.length} courses · ${yearUnits} units</span>
      </header>
      <div class="curriculum-dashboard-year-terms">${termCards}</div>
    </section>`;
  }).join("");
  section.hidden = false;
}

async function loadCurriculumOverview() {
  try {
    const data = state.email === "student@pluglytics.local"
      ? await window.PLUGLYTICS_DEMO_DATA.loadCurriculum()
      : (await api("/student/curriculum")).data;
    renderCurriculumOverview(data);
  } catch (error) {
    byId("curriculumDashboardError").textContent = `Unable to load program course map: ${error.message}`;
    byId("curriculumDashboardError").hidden = false;
  }
}

function renderInstructorSections(card, rows, widget) {
  card.querySelector("canvas").remove();
  if (!rows.length) {
    card.innerHTML += `<div class="widget-card-empty">No classes match these filters.</div>`;
    return;
  }
  const query = filterQuery(widget);
  const folders = rows.map((row) => `<details class="instructor-section-folder" data-section-id="${row.id}">
    <summary>
      <span><strong>${escapeHtml(row.courseCode)} · ${escapeHtml(row.title)}</strong><small>${escapeHtml(row.term)} · ${escapeHtml(row.name)}</small></span>
      <span class="section-folder-count">${escapeHtml(row.activeStudents)} students · ${escapeHtml(row.utilizationPercent)}% capacity</span>
    </summary>
    <div class="section-folder-content"><p>Open this class to load its roster and progress details.</p></div>
  </details>`).join("");
  card.innerHTML += `<div class="instructor-section-folders">${folders}</div>`;
  card.querySelectorAll(".instructor-section-folder").forEach((folder) => {
    folder.addEventListener("toggle", async () => {
      if (!folder.open || folder.dataset.loaded === "true") return;
      folder.dataset.loaded = "true";
      const content = folder.querySelector(".section-folder-content");
      content.innerHTML = `<p>Loading student progress…</p>`;
      try {
        const sectionId = encodeURIComponent(folder.dataset.sectionId);
        const response = await api(`/instructor/sections/${sectionId}/roster${query ? `?${query}` : ""}`);
        const students = response.data.students || [];
        const rosterRows = students.map((student) => `<tr>
          <td>${escapeHtml(student.studentName)}</td>
          <td>${escapeHtml(student.currentGrade == null ? "—" : `${student.currentGrade}%`)}</td>
          <td>${escapeHtml(student.quizAverage == null ? "—" : `${student.quizAverage}%`)}</td>
          <td>${escapeHtml(student.attendanceRate == null ? "—" : `${student.attendanceRate}%`)}</td>
          <td>${escapeHtml(student.assignmentsSubmitted)} / ${escapeHtml(student.assignmentCount)}</td>
          <td>${escapeHtml(student.assignmentsLate)}</td>
          <td>${escapeHtml(student.assignmentsMissed)}</td>
          <td>${escapeHtml(student.quizzesSubmitted)}</td>
          <td>${escapeHtml(student.quizzesMissed)}</td>
        </tr>`).join("");
        content.innerHTML = students.length
          ? `<div class="roster-table-wrap"><table><thead><tr><th>Student</th><th>Current grade</th><th>Quiz average</th><th>Attendance</th><th>Assignments submitted</th><th>Assignments late</th><th>Assignments missed</th><th>Quizzes submitted</th><th>Quizzes missed</th></tr></thead><tbody>${rosterRows}</tbody></table></div>`
          : `<p>No enrolled students match this class.</p>`;
      } catch (error) {
        folder.dataset.loaded = "false";
        content.innerHTML = `<p class="widget-error">Unable to load class roster: ${escapeHtml(error.message)}</p>`;
      }
    });
  });
}

function renderMetricCard(card, rows, widgetId) {
  card.querySelector("canvas").remove();
  if (!rows.length) {
    card.innerHTML += `<div class="widget-card-empty">No data for these filters.</div>`;
    return;
  }
  const row = rows[0];
  const metrics = {
    "enrollment-summary": [
      ["Enrolled students", row.enrolledStudents],
      ["Waitlisted", row.waitlisted],
    ],
    "finance-overview": [
      ["Tuition billed", row.billed],
      ["Tuition collected", row.collected],
      ["Collection rate", `${row.collectionRate ?? 0}%`],
    ],
    "finance-refunds": [["Refund total", row.refunds]],
  }[widgetId] || [];
  card.innerHTML += `<div class="metric-card-grid">${metrics.map(([label, value]) => `
    <div><small>${escapeHtml(label)}</small><strong>${escapeHtml(value == null ? "—" : typeof value === "number" && widgetId !== "finance-overview"
      ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
      : value)}</strong></div>
  `).join("")}</div>`;
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

  for (const widget of state.widgets) {
    const card = byId(`card-${widget.id}`);
    try {
      const endpoint = endpointForWidget(widget.id);
      if (!endpoint) continue;
      const query = filterQuery(state.catalog.find((item) => item.id === widget.id));
      const response = await api(`${endpoint}${query ? `?${query}` : ""}`);
      const data = response.data;
      const rows = Array.isArray(data) ? data : (data && typeof data === "object" ? [data] : []);
      addSummary(widget.id, data);

      if (widget.id === "instructor-sections") {
        renderInstructorSections(card, rows, state.catalog.find((item) => item.id === widget.id));
        continue;
      }

      if (["enrollment-summary", "finance-overview", "finance-refunds"].includes(widget.id)) {
        renderMetricCard(card, rows, widget.id);
        continue;
      }

      if (widget.id === "student-progress") {
        renderProgressCard(card, rows);
        continue;
      }

      if (widget.id === "student-deadlines") {
        renderScheduleCard(card, rows);
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
      if (["assignment-rate", "instructor-attendance", "instructor-at-risk", "finance-outstanding", "income-specialization", "enrollment-retention", "seat-utilization", "pass-rates", "instructor-ratings", "course-popularity"].includes(widget.id)) {
        card.innerHTML += tableHtml(rows);
        canvas.remove();
        continue;
      }
      if (rows.length > 8) {
        card.innerHTML += tableHtml(rows);
        canvas.remove();
        continue;
      }

      const numericKeys = rows.length ? Object.keys(rows[0]).filter((key) =>
        typeof rows[0][key] === "number" && !/id$/i.test(key)
      ) : [];
      const labelKey = Object.keys(rows[0] || {}).find((key) => typeof rows[0][key] === "string") || "label";
      const preferredValueKeys = {
        "student-grades": "gpa",
        "student-attendance": "attendancePercent",
        "student-activity": "minutesLearning",
        "section-performance": "averageScore",
        "assignment-rate": "submissionRate",
        "instructor-attendance": "attendanceRate",
        "enrollment-specialization": "enrolledStudents",
        "enrollment-year-level": "enrolledStudents",
        "finance-outstanding": "outstanding",
        "income-specialization": "income",
        "enrollment-retention": "retentionPercent",
        "seat-utilization": "utilizationPercent",
        "item-analysis": "percentIncorrect",
        "pass-rates": "passRate",
        "instructor-ratings": "averageRating",
        "course-popularity": "enrolledStudents",
      };
      const preferredValueKey = preferredValueKeys[widget.id];
      const valueKey = preferredValueKey && numericKeys.includes(preferredValueKey)
        ? preferredValueKey
        : numericKeys[0];

      if (!valueKey) {
        card.innerHTML += tableHtml(rows);
        canvas.remove();
        continue;
      }

      state.charts.push(new Chart(canvas, {
        type: widget.id === "student-grades" || widget.id === "section-performance" ? "line" : "bar",
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
  if (!panel.open) {
    panel.showModal();
    byId("customizeButton").setAttribute("aria-expanded", "true");
  }
});

function closeCustomizeDialog() {
  const panel = byId("customizePanel");
  if (panel.open) panel.close();
  byId("customizeButton").setAttribute("aria-expanded", "false");
}

byId("customizePanel").addEventListener("close", () => {
  byId("customizeButton").setAttribute("aria-expanded", "false");
});

byId("customizePanel").addEventListener("click", (event) => {
  if (event.target === byId("customizePanel")) closeCustomizeDialog();
});

byId("closeCustomizeButton").addEventListener("click", closeCustomizeDialog);

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

document.querySelectorAll("[data-demo-email]").forEach((button) => {
  button.addEventListener("click", () => {
    byId("email").value = button.dataset.demoEmail;
    byId("loginError").textContent = "";
    byId("password").focus();
  });
});

byId("logoutButton").addEventListener("click", () => {
  localStorage.removeItem("pluglytics_token");
  location.reload();
});

byId("applyFilters").addEventListener("click", () => {
  renderWidgets();
  if (state.role === "student") loadCalendar();
});
byId("themeSelect").addEventListener("change", (event) => applyTheme(event.target.value));
byId("previousMonth").addEventListener("click", () => moveCalendarMonth(-1));
byId("nextMonth").addEventListener("click", () => moveCalendarMonth(1));

byId("saveLayout").addEventListener("click", async () => {
  const layout = {
    widgets: state.widgets,
    filters: {
      term: byId("termFilter").value,
      from: byId("fromFilter").value,
      to: byId("toFilter").value,
      specialization: byId("specializationFilter").value,
      program: byId("programFilter").value,
      course: byId("courseFilter").value,
      section: byId("sectionFilter").value,
      instructor: byId("instructorFilter").value,
      yearLevel: byId("yearLevelFilter").value,
      status: byId("statusFilter").value,
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
    closeCustomizeDialog();
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
