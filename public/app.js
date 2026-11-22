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
    const error = new Error(body.error?.message || `PlugLytics API request failed (HTTP ${response.status}).`);
    error.status = response.status;
    error.code = body.error?.code;
    error.details = body.error?.details;
    throw error;
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
  if (state.role === "student") await loadInvoices();
  if (state.role === "admin") await loadAdminInvoices();
  if (state.role === "admin") await loadAdminPayments();
  if (state.role === "admin") await loadAdminWebhooks();
  if (state.role === "admin") await loadAdminRefunds();
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

      if (widget.id === "finance-overview") {
        const chart = PlugLyticsCharts.financeOverviewChart(rows[0]);
        if (!chart) {
          card.innerHTML += tableHtml(rows);
          canvas.remove();
          continue;
        }
        if (chart.collectionRate !== null) {
          // insertAdjacentHTML keeps the existing canvas element (innerHTML += would replace it).
          canvas.insertAdjacentHTML("beforebegin", `<p class="finance-rate"><strong>${escapeHtml(chart.collectionRate.toFixed(1))}%</strong> collection rate <span>(collected / net billed)</span></p>`);
        }
        const styles = getComputedStyle(document.body);
        const primary = styles.getPropertyValue("--primary").trim() || "#45a29e";
        const muted = styles.getPropertyValue("--muted").trim();
        state.charts.push(new Chart(canvas, {
          type: "bar",
          data: {
            labels: chart.labels,
            datasets: [{
              label: "Amount",
              data: chart.values,
              backgroundColor: chart.keys.map((key) => (key === "scholarshipsAndDiscounts" ? "#d99a2b" : primary)),
              borderRadius: 5,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: (item) => Number(item.raw).toLocaleString() } },
            },
            scales: {
              x: { ticks: { color: muted } },
              y: { beginAtZero: true, ticks: { color: muted, callback: (value) => Number(value).toLocaleString() } },
            },
          },
        }));
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
      const valueKey = (widget.id === "student-grades" && numericKeys.includes("gpa") ? "gpa" : numericKeys[0]);

      if (!valueKey) {
        card.innerHTML += tableHtml(rows);
        canvas.remove();
        continue;
      }

      state.charts.push(new Chart(canvas, {
        type: "bar",
        data: {
          labels: PlugLyticsCharts.chartLabels(rows, labelKey, valueKey),
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

// ---------------------------------------------------------------------------
// Student payments: invoices and Stellar testnet payment requests
// ---------------------------------------------------------------------------

const PAYMENT_POLL_MS = 5000;
const payment = { current: null, timer: null, checking: false };

const INVOICE_STATUS_LABELS = { due: "Due", partial: "Partly paid", settled: "Paid" };
const FAILURE_LABELS = {
  expired: "the payment request expired before a payment arrived",
  cancelled: "the payment request was cancelled",
  underpaid: "less than the requested amount arrived",
  wrong_asset: "the payment used a different asset",
};

function setPaymentsMessage(text, isError = false) {
  const message = byId("paymentsMessage");
  message.textContent = text;
  message.classList.toggle("widget-error", isError);
}

function formatMoney(amount, currency) {
  const value = Number(amount);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch (error) {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function isOpenRequest(request) {
  return request && request.status === "pending" && Date.parse(request.expiresAt) > Date.now();
}

async function loadInvoices() {
  byId("paymentsSection").hidden = false;
  try {
    const result = await api("/payments/invoices");
    renderInvoices(result.data);
  } catch (error) {
    byId("invoiceRows").innerHTML = "";
    setPaymentsMessage(`Unable to load your invoices: ${error.message}`, true);
  }
}

function renderInvoices(invoices) {
  const rows = byId("invoiceRows");
  if (!invoices.length) {
    rows.innerHTML = `<tr><td colspan="5" class="muted-cell">You have no invoices.</td></tr>`;
    return;
  }
  rows.innerHTML = invoices.map((invoice) => {
    let action = `<span class="muted-cell">—</span>`;
    if (invoice.status !== "settled") {
      action = isOpenRequest(invoice.latestPaymentRequest)
        ? `<button type="button" class="outline-button" data-open-payment="${escapeHtml(invoice.latestPaymentRequest.id)}">View pending payment</button>`
        : `<button type="button" data-pay-invoice="${escapeHtml(invoice.id)}">Pay with Stellar (Testnet)</button>`;
    }
    return `<tr>
      <td>${escapeHtml(invoice.term)}</td>
      <td>${escapeHtml(formatMoney(invoice.finalAmount, invoice.currency))}</td>
      <td>${escapeHtml(formatMoney(invoice.outstanding, invoice.currency))}</td>
      <td><span class="invoice-status invoice-status-${escapeHtml(invoice.status)}">${escapeHtml(INVOICE_STATUS_LABELS[invoice.status] || invoice.status)}</span></td>
      <td class="action-cell">${action}</td>
    </tr>`;
  }).join("");
}

function detailRow(label, field, value) {
  return `<div class="payment-detail">
    <dt>${escapeHtml(label)}</dt>
    <dd><code>${escapeHtml(value)}</code>
      <button type="button" class="outline-button copy-button" data-copy-field="${field}" aria-label="Copy ${escapeHtml(label.toLowerCase())}">Copy</button>
    </dd>
  </div>`;
}

function showPayment(data) {
  payment.current = data;
  byId("paymentPanel").hidden = false;
  byId("paymentDetails").innerHTML = [
    detailRow("Destination address", "destination", data.destination),
    detailRow("Amount", "amount", data.amount),
    detailRow("Asset", "asset", data.asset),
    detailRow("Memo", "memo", data.memo),
  ].join("");
  updatePaymentStatus(data);
}

function updatePaymentStatus(data) {
  payment.current = { ...payment.current, ...data };
  byId("cancelPaymentRequest").hidden = data.status !== "pending";
  const status = byId("paymentStatus");
  status.className = `payment-status payment-status-${data.status}`;
  if (data.status === "completed") {
    status.textContent = "Completed – payment received";
  } else if (data.status === "failed") {
    status.textContent = `Failed – ${FAILURE_LABELS[data.reason] || data.reason || "unknown reason"}`;
  } else {
    status.textContent = "Waiting for payment…";
  }
  byId("paymentExpiry").textContent = data.status === "pending" && data.expiresAt
    ? `Expires at ${new Date(data.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Checking every few seconds.`
    : "";
}

function stopPaymentPolling() {
  if (payment.timer) clearInterval(payment.timer);
  payment.timer = null;
}

function startPaymentPolling() {
  stopPaymentPolling();
  payment.timer = setInterval(checkPayment, PAYMENT_POLL_MS);
}

async function checkPayment() {
  if (!payment.current || payment.checking) return;
  payment.checking = true;
  const id = payment.current.id;
  try {
    const result = await api(`/payments/${encodeURIComponent(id)}`);
    if (payment.current?.id !== id) return;
    updatePaymentStatus(result.data);
    if (result.data.status !== "pending") {
      stopPaymentPolling();
      await loadInvoices();
    }
  } catch (error) {
    // Horizon or the network may be briefly unavailable, so keep trying.
    // Stop only if the request cannot be read at all.
    setPaymentsMessage(`Could not check the payment: ${error.message}`, true);
    if (error.status === 401 || error.status === 403 || error.status === 404) stopPaymentPolling();
  } finally {
    payment.checking = false;
  }
}

async function openPayment(id) {
  setPaymentsMessage("");
  const result = await api(`/payments/${encodeURIComponent(id)}`);
  showPayment(result.data);
  if (result.data.status === "pending") startPaymentPolling();
  else await loadInvoices();
}

async function payInvoice(invoiceId, button) {
  setPaymentsMessage("");
  button.disabled = true;
  button.textContent = "Creating payment…";
  try {
    const result = await api("/payments", {
      method: "POST",
      body: JSON.stringify({ invoiceId: Number(invoiceId) }),
    });
    showPayment(result.data);
    startPaymentPolling();
    await loadInvoices();
  } catch (error) {
    if (error.code === "PAYMENT_ALREADY_PENDING" && error.details?.paymentId) {
      await openPayment(error.details.paymentId);
      return;
    }
    const messages = {
      STELLAR_NOT_CONFIGURED: "Stellar testnet payments are not set up on this server yet.",
      INVOICE_NOTHING_DUE: "This invoice has nothing left to pay.",
    };
    setPaymentsMessage(messages[error.code] || `Unable to create the payment: ${error.message}`, true);
    button.disabled = false;
    button.textContent = "Pay with Stellar (Testnet)";
    if (error.code === "INVOICE_NOTHING_DUE") await loadInvoices();
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "absolute";
    field.style.left = "-9999px";
    document.body.appendChild(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = original; }, 1500);
}

byId("paymentsSection").addEventListener("click", async (event) => {
  const payButton = event.target.closest("[data-pay-invoice]");
  if (payButton) {
    await payInvoice(payButton.dataset.payInvoice, payButton);
    return;
  }
  const openButton = event.target.closest("[data-open-payment]");
  if (openButton) {
    try {
      await openPayment(openButton.dataset.openPayment);
    } catch (error) {
      setPaymentsMessage(`Unable to open the payment: ${error.message}`, true);
    }
    return;
  }
  const copyButton = event.target.closest("[data-copy-field]");
  if (copyButton && payment.current) {
    await copyText(String(payment.current[copyButton.dataset.copyField] ?? ""), copyButton);
  }
});

async function cancelPaymentRequest() {
  if (!payment.current || payment.current.status !== "pending") return;
  if (!window.confirm("Cancel this payment request? Do not send the payment after cancelling: it will not be matched to your invoice.")) return;
  const button = byId("cancelPaymentRequest");
  button.disabled = true;
  stopPaymentPolling();
  setPaymentsMessage("");
  try {
    const result = await api(`/payments/${encodeURIComponent(payment.current.id)}/cancel`, { method: "POST" });
    updatePaymentStatus(result.data);
    setPaymentsMessage("The payment request was cancelled. You can create a new one at any time.");
  } catch (error) {
    if (error.code === "PAYMENT_ALREADY_COMPLETED") {
      setPaymentsMessage("A payment has already arrived for this request, so it was not cancelled.");
    } else {
      setPaymentsMessage(`Unable to cancel the payment request: ${error.message}`, true);
    }
    // Show the request's real status, and keep checking if it is still pending.
    try {
      const latest = await api(`/payments/${encodeURIComponent(payment.current.id)}`);
      updatePaymentStatus(latest.data);
      if (latest.data.status === "pending") startPaymentPolling();
    } catch (refreshError) {
      startPaymentPolling();
    }
  } finally {
    button.disabled = false;
    await loadInvoices();
  }
}

byId("cancelPaymentRequest").addEventListener("click", cancelPaymentRequest);

byId("closePaymentPanel").addEventListener("click", () => {
  stopPaymentPolling();
  payment.current = null;
  byId("paymentPanel").hidden = true;
});

// ---------------------------------------------------------------------------
// Admin: Stellar payment requests
// ---------------------------------------------------------------------------

const adminPayments = { page: 1, total: 0, pageSize: 25 };

const PAYMENT_STATUS_LABELS = { pending: "Pending", completed: "Completed", failed: "Failed" };
const REASON_LABELS = { expired: "expired", cancelled: "cancelled", underpaid: "underpaid", wrong_asset: "wrong asset" };

// Only testnet requests can be created so far; a production request would
// link to the public network instead.
function explorerTxUrl(hash, network) {
  const explorerNetwork = network === "production" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${explorerNetwork}/tx/${encodeURIComponent(hash)}`;
}

function shortHash(hash) {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

function setAdminPaymentsMessage(text, isError = false) {
  const message = byId("adminPaymentsMessage");
  message.textContent = text;
  message.classList.toggle("widget-error", isError);
}

async function loadAdminPayments() {
  byId("adminPaymentsSection").hidden = false;
  const params = new URLSearchParams({ page: String(adminPayments.page) });
  const status = byId("adminPaymentStatus").value;
  if (status) params.set("status", status);
  setAdminPaymentsMessage("");
  try {
    const result = await api(`/payments?${params.toString()}`);
    adminPayments.total = result.meta.total;
    adminPayments.pageSize = result.meta.pageSize || adminPayments.pageSize;
    renderAdminPayments(result.data);
  } catch (error) {
    byId("adminPaymentRows").innerHTML = "";
    byId("adminPaymentsCount").textContent = "";
    setAdminPaymentsMessage(`Unable to load Stellar payments: ${error.message}`, true);
  }
}

function renderAdminPayments(rows) {
  const status = byId("adminPaymentStatus").value;
  const pages = Math.max(1, Math.ceil(adminPayments.total / adminPayments.pageSize));
  byId("adminPaymentsCount").textContent =
    `${adminPayments.total} payment request${adminPayments.total === 1 ? "" : "s"}${status ? ` (${PAYMENT_STATUS_LABELS[status].toLowerCase()})` : ""}`;
  byId("adminPaymentsPage").textContent = `Page ${adminPayments.page} of ${pages}`;
  byId("adminPaymentsPrev").disabled = adminPayments.page <= 1;
  byId("adminPaymentsNext").disabled = adminPayments.page >= pages;

  const body = byId("adminPaymentRows");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted-cell">No payment requests${status ? " with this status" : " yet"}.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((row) => {
    const label = PAYMENT_STATUS_LABELS[row.status] || row.status;
    const reason = row.reason ? ` · ${REASON_LABELS[row.reason] || row.reason}` : "";
    const followUp = row.relatedPaymentId
      ? `<small class="muted-cell">Follow-up of <code>${escapeHtml(row.relatedPaymentId)}</code>${row.acceptedBy ? ` · by ${escapeHtml(row.acceptedBy)}` : ""}</small>`
      : "";
    const refundable = row.transactionHash && row.amountReceived
      && (row.status === "completed" || (row.status === "failed" && row.reason === "underpaid"));
    const refundButton = refundable
      ? `<button type="button" class="outline-button" data-refund-payment="${escapeHtml(row.id)}" data-received="${escapeHtml(row.amountReceived)}" data-asset="${escapeHtml(row.asset)}" data-payer="${escapeHtml(row.sourceAccount || "")}">Refund</button>`
      : "";
    const actions = refundButton + (row.status === "failed"
      ? [
        row.reason === "expired"
          ? `<button type="button" class="outline-button" data-fix-payment="late" data-payment-id="${escapeHtml(row.id)}" data-memo="${escapeHtml(row.memo)}" data-amount="${escapeHtml(row.amount)}" data-asset="${escapeHtml(row.asset)}">Accept late payment</button>`
          : "",
        `<button type="button" class="outline-button" data-fix-payment="no_memo" data-payment-id="${escapeHtml(row.id)}" data-memo="${escapeHtml(row.memo)}" data-amount="${escapeHtml(row.amount)}" data-asset="${escapeHtml(row.asset)}">Match transaction</button>`,
      ].join("")
      : "");
    const tx = row.transactionHash
      ? `<a href="${escapeHtml(explorerTxUrl(row.transactionHash, row.network))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(row.transactionHash)}"><code>${escapeHtml(shortHash(row.transactionHash))}</code><span class="visually-hidden"> (opens stellar.expert in a new tab)</span></a>`
      : `<span class="muted-cell">—</span>`;
    return `<tr>
      <td>${escapeHtml(new Date(row.createdAt).toLocaleString())}</td>
      <td><span class="payment-status payment-status-${escapeHtml(row.status)}">${escapeHtml(label + reason)}</span>${followUp}</td>
      <td><code>${escapeHtml(row.amount)}</code></td>
      <td>${escapeHtml(row.asset)}</td>
      <td><code>${escapeHtml(row.memo)}</code></td>
      <td>${tx}</td>
      <td class="action-cell webhook-actions">${actions}</td>
    </tr>`;
  }).join("");
}

// Admin: accept a late payment, or match a payment that arrived without a memo.
const paymentFix = { mode: null, paymentId: null };

function openPaymentFix(button) {
  paymentFix.mode = button.dataset.fixPayment;
  paymentFix.paymentId = button.dataset.paymentId;
  const late = paymentFix.mode === "late";
  byId("paymentFixHeading").textContent = late ? "Accept late payment" : "Match a payment without a memo";
  byId("paymentFixIntro").textContent = late
    ? `For ${paymentFix.paymentId} (memo ${button.dataset.memo}, ${button.dataset.amount} ${button.dataset.asset}). The transaction must carry this memo and at least this amount. The expired request stays as it is; a new completed payment is created and linked to it.`
    : `For ${paymentFix.paymentId} (${button.dataset.amount} ${button.dataset.asset}). The transaction must have no memo (or one no payment request uses) and at least this amount. The request stays as it is; a new completed payment is created and linked to it.`;
  const form = byId("paymentFixForm");
  form.reset();
  byId("paymentFixErrors").innerHTML = "";
  byId("paymentFixPanel").hidden = false;
  form.elements.transactionHash.focus();
}

function closePaymentFix() {
  paymentFix.mode = null;
  paymentFix.paymentId = null;
  byId("paymentFixPanel").hidden = true;
}

async function submitPaymentFix(event) {
  event.preventDefault();
  const form = byId("paymentFixForm");
  const transactionHash = form.elements.transactionHash.value.trim();
  const note = form.elements.note.value.trim();
  const problems = [];
  if (!/^[0-9a-fA-F]{64}$/.test(transactionHash)) problems.push("Transaction hash: paste the 64-character hash");
  if (!note) problems.push("Note: say why, for audits");
  const show = (list) => { byId("paymentFixErrors").innerHTML = list.map((text) => `<li>${escapeHtml(text)}</li>`).join(""); };
  show(problems);
  if (problems.length) return;

  const action = paymentFix.mode === "late" ? "accept-late-payment" : "match-transaction";
  const button = byId("submitPaymentFix");
  button.disabled = true;
  try {
    const result = await api(`/payments/${encodeURIComponent(paymentFix.paymentId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ transactionHash, note }),
    });
    const original = paymentFix.paymentId;
    closePaymentFix();
    setAdminPaymentsMessage(`Created ${result.data.id} (completed, ${result.data.amountReceived} ${result.data.asset} received), linked to ${original}.`);
    await loadAdminPayments();
  } catch (error) {
    show([error.message]);
  } finally {
    button.disabled = false;
  }
}

byId("adminPaymentRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-fix-payment]");
  if (button) openPaymentFix(button);
});
byId("cancelPaymentFix").addEventListener("click", closePaymentFix);
byId("paymentFixForm").addEventListener("submit", submitPaymentFix);

byId("adminPaymentStatus").addEventListener("change", () => {
  adminPayments.page = 1;
  loadAdminPayments();
});
byId("adminPaymentsRefresh").addEventListener("click", () => loadAdminPayments());
byId("adminPaymentsPrev").addEventListener("click", () => {
  if (adminPayments.page > 1) {
    adminPayments.page -= 1;
    loadAdminPayments();
  }
});
byId("adminPaymentsNext").addEventListener("click", () => {
  adminPayments.page += 1;
  loadAdminPayments();
});

// ---------------------------------------------------------------------------
// Admin: invoices with pricing fields
// ---------------------------------------------------------------------------

const adminInvoices = { page: 1, total: 0, pageSize: 25, options: null, editing: null };

const INVOICE_FIELD_LABELS = {
  studentNumber: "Student number", studentId: "Student", termId: "Term", dueAt: "Due date", issuedAt: "Issue date",
  currency: "Currency", basePrice: "Base price", scholarshipAmount: "Scholarship amount",
  scholarshipType: "Scholarship type", scholarshipName: "Scholarship name", discountPercent: "Discount (%)",
  discountCode: "Discount code", platformFee: "Platform fee", transactionFee: "Transaction fee",
  instructorCost: "Instructor cost", finalAmount: "Final amount",
};
const INVOICE_NUMBER_FIELDS = ["basePrice", "scholarshipAmount", "discountPercent", "platformFee", "transactionFee", "instructorCost"];
const INVOICE_TEXT_FIELDS = ["scholarshipType", "scholarshipName", "discountCode"];
const LOCK_LABELS = {
  completed_payment: "Paid – locked",
  pending_payment_request: "Payment pending – locked",
};

function invoiceForm() {
  return byId("invoiceForm");
}

function setInvoicesMessage(text, isError = false) {
  const message = byId("adminInvoicesMessage");
  message.textContent = text;
  message.classList.toggle("widget-error", isError);
}

function formatAmount(amount, currency) {
  return /^[A-Z]{3}$/.test(currency || "") ? formatMoney(amount, currency) : Number(amount).toFixed(2);
}

async function loadAdminInvoices() {
  byId("adminInvoicesSection").hidden = false;
  try {
    if (!adminInvoices.options) {
      adminInvoices.options = (await api("/invoices/options")).data;
      const termOptions = adminInvoices.options.terms
        .map((term) => `<option value="${escapeHtml(term.id)}">${escapeHtml(term.name)}${term.isCurrent ? " (current)" : ""}</option>`)
        .join("");
      byId("invoiceTermFilter").innerHTML = `<option value="">All terms</option>${termOptions}`;
      invoiceForm().elements.termId.innerHTML = termOptions;
      invoiceForm().elements.scholarshipType.innerHTML = `<option value="">None</option>` +
        adminInvoices.options.scholarshipTypes.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type.replace("_", " "))}</option>`).join("");
    }
    await loadInvoiceList();
  } catch (error) {
    setInvoicesMessage(`Unable to load invoices: ${error.message}`, true);
  }
}

async function loadInvoiceList() {
  const params = new URLSearchParams({ page: String(adminInvoices.page) });
  const student = byId("invoiceStudentFilter").value.trim();
  const termId = byId("invoiceTermFilter").value;
  if (student) params.set("student", student);
  if (termId) params.set("termId", termId);
  try {
    const result = await api(`/invoices?${params.toString()}`);
    adminInvoices.total = result.meta.total;
    adminInvoices.pageSize = result.meta.pageSize || adminInvoices.pageSize;
    renderInvoiceList(result.data);
  } catch (error) {
    byId("adminInvoiceRows").innerHTML = "";
    setInvoicesMessage(`Unable to load invoices: ${error.message}`, true);
  }
}

function renderInvoiceList(rows) {
  const pages = Math.max(1, Math.ceil(adminInvoices.total / adminInvoices.pageSize));
  byId("adminInvoicesCount").textContent = `${adminInvoices.total} invoice${adminInvoices.total === 1 ? "" : "s"}`;
  byId("adminInvoicesPage").textContent = `Page ${adminInvoices.page} of ${pages}`;
  byId("adminInvoicesPrev").disabled = adminInvoices.page <= 1;
  byId("adminInvoicesNext").disabled = adminInvoices.page >= pages;
  const body = byId("adminInvoiceRows");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted-cell">No invoices match these filters.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((row) => {
    const status = row.editable
      ? `<span class="payment-status payment-status-pending">Editable</span>`
      : `<span class="invoice-status invoice-status-partial">${escapeHtml(LOCK_LABELS[row.lockReason] || "Locked")}</span>`;
    const action = row.editable
      ? `<button type="button" class="outline-button" data-edit-invoice="${escapeHtml(row.id)}">Edit</button>`
      : `<span class="muted-cell">—</span>`;
    return `<tr>
      <td>${escapeHtml(row.id)}</td>
      <td>${escapeHtml(row.studentNumber)} <small class="muted-cell">${escapeHtml(row.studentName)}</small></td>
      <td>${escapeHtml(row.termName)}</td>
      <td>${escapeHtml(formatAmount(row.basePrice, row.currency))}</td>
      <td><strong>${escapeHtml(formatAmount(row.finalAmount, row.currency))}</strong></td>
      <td>${status}</td>
      <td class="action-cell">${action}</td>
    </tr>`;
  }).join("");
}

function showInvoiceErrors(messages) {
  byId("invoiceFormErrors").innerHTML = messages.map((message) => `<li>${escapeHtml(message)}</li>`).join("");
}

function apiErrorMessages(error) {
  const messages = [];
  const fieldErrors = error.details?.fieldErrors || {};
  for (const [field, list] of Object.entries(fieldErrors)) {
    for (const text of list) messages.push(`${INVOICE_FIELD_LABELS[field] || field}: ${text}`);
  }
  for (const text of error.details?.formErrors || []) messages.push(text);
  return messages.length ? messages : [error.message];
}

function updateInvoicePreview() {
  const form = invoiceForm();
  const fields = Object.fromEntries(INVOICE_NUMBER_FIELDS.map((name) => [name, form.elements[name].value]));
  const preview = byId("invoicePreview");
  const currency = form.elements.currency.value.trim().toUpperCase() || "USD";
  if (form.elements.basePrice.value.trim() === "") {
    preview.className = "invoice-preview";
    preview.innerHTML = `<span>Enter a base price to see the final amount.</span>`;
    return;
  }
  const result = PlugLyticsPricing.previewFinalAmount(fields);
  if (!result) {
    preview.className = "invoice-preview invoice-preview-warning";
    preview.innerHTML = `<span>Enter numbers only to see the final amount.</span>`;
    return;
  }
  const negative = result.finalAmount < 0;
  preview.className = `invoice-preview${negative ? " invoice-preview-warning" : ""}`;
  preview.innerHTML = `
    <span class="invoice-preview-label">Final amount</span>
    <strong>${escapeHtml(formatAmount(result.finalAmount, currency))}</strong>
    <small>${escapeHtml(formatAmount(result.basePrice, currency))} base
      − ${escapeHtml(formatAmount(result.scholarshipAmount, currency))} scholarship
      − ${escapeHtml(formatAmount(result.discountAmount, currency))} discount
      + ${escapeHtml(formatAmount(result.fees, currency))} fees</small>
    ${negative ? `<small class="invoice-preview-note">The final amount cannot be below zero, so this cannot be saved.</small>` : ""}`;
}

function setInvoiceFormMode(editing) {
  const form = invoiceForm();
  form.querySelectorAll("[data-create-only]").forEach((element) => { element.hidden = Boolean(editing); });
  form.querySelectorAll("[data-edit-only]").forEach((element) => { element.hidden = !editing; });
  byId("invoiceFormHeading").textContent = editing ? `Edit invoice #${editing.id}` : "New invoice";
  if (editing) {
    form.querySelector(".invoice-form-fixed").textContent =
      `${editing.studentNumber} · ${editing.studentName} · ${editing.termName}`;
  }
}

function openInvoiceForm(invoice = null) {
  const form = invoiceForm();
  form.reset();
  adminInvoices.editing = invoice;
  setInvoiceFormMode(invoice);
  showInvoiceErrors([]);
  setInvoicesMessage("");
  if (invoice) {
    for (const name of INVOICE_NUMBER_FIELDS) form.elements[name].value = invoice[name] ?? 0;
    for (const name of INVOICE_TEXT_FIELDS) form.elements[name].value = invoice[name] ?? "";
    form.elements.currency.value = invoice.currency;
    form.elements.dueAt.value = (invoice.dueAt || "").slice(0, 10);
  } else {
    for (const name of INVOICE_NUMBER_FIELDS) form.elements[name].value = name === "basePrice" ? "" : 0;
    form.elements.currency.value = "USD";
    const current = adminInvoices.options?.terms.find((term) => term.isCurrent);
    if (current) form.elements.termId.value = String(current.id);
    const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    form.elements.dueAt.value = due.toISOString().slice(0, 10);
  }
  byId("invoiceFormPanel").hidden = false;
  updateInvoicePreview();
  form.querySelector(invoice ? "[name=basePrice]" : "[name=studentNumber]").focus();
}

function closeInvoiceForm() {
  adminInvoices.editing = null;
  byId("invoiceFormPanel").hidden = true;
}

function readInvoiceFields() {
  const form = invoiceForm();
  const fields = {};
  for (const name of INVOICE_NUMBER_FIELDS) {
    const raw = form.elements[name].value.trim();
    fields[name] = raw === "" && name !== "basePrice" ? 0 : Number(raw === "" ? NaN : raw);
  }
  for (const name of INVOICE_TEXT_FIELDS) {
    const raw = form.elements[name].value.trim();
    fields[name] = raw === "" ? null : raw;
  }
  fields.currency = form.elements.currency.value.trim().toUpperCase();
  const due = form.elements.dueAt.value;
  fields.dueAt = due ? `${due}T23:59:00Z` : "";
  return fields;
}

async function saveInvoice(event) {
  event.preventDefault();
  const form = invoiceForm();
  const fields = readInvoiceFields();
  const problems = [];
  if (!Number.isFinite(fields.basePrice)) problems.push("Base price: enter a number");
  if (!fields.dueAt) problems.push("Due date: choose a date");
  if (!/^[A-Z]{3}$/.test(fields.currency)) problems.push("Currency: use a 3-letter code such as USD or PHP");
  for (const name of INVOICE_NUMBER_FIELDS) {
    if (name !== "basePrice" && !Number.isFinite(fields[name])) problems.push(`${INVOICE_FIELD_LABELS[name]}: enter a number`);
  }
  if (problems.length) {
    showInvoiceErrors(problems);
    return;
  }

  const button = byId("saveInvoiceButton");
  button.disabled = true;
  showInvoiceErrors([]);
  try {
    let result;
    if (adminInvoices.editing) {
      // Send only the fields that changed.
      const original = adminInvoices.editing;
      const changes = {};
      for (const name of [...INVOICE_NUMBER_FIELDS, ...INVOICE_TEXT_FIELDS, "currency"]) {
        if ((fields[name] ?? null) !== (original[name] ?? null)) changes[name] = fields[name];
      }
      if (fields.dueAt.slice(0, 10) !== (original.dueAt || "").slice(0, 10)) changes.dueAt = fields.dueAt;
      if (!Object.keys(changes).length) {
        showInvoiceErrors(["Nothing has changed."]);
        return;
      }
      result = await api(`/invoices/${encodeURIComponent(original.id)}`, { method: "PATCH", body: JSON.stringify(changes) });
    } else {
      const number = form.elements.studentNumber.value.trim();
      if (!number) {
        showInvoiceErrors(["Student number: enter one, for example STU-0001"]);
        return;
      }
      const student = (await api(`/invoices/students?number=${encodeURIComponent(number)}`)).data;
      result = await api("/invoices", {
        method: "POST",
        body: JSON.stringify({ studentId: student.id, termId: Number(form.elements.termId.value), ...fields }),
      });
      adminInvoices.page = 1;
    }
    const saved = result.data;
    closeInvoiceForm();
    setInvoicesMessage(`Invoice #${saved.id} saved. Final amount: ${formatAmount(saved.finalAmount, saved.currency)}.`);
    await loadInvoiceList();
  } catch (error) {
    showInvoiceErrors(apiErrorMessages(error));
    if (error.code === "INVOICE_HAS_COMPLETED_PAYMENT" || error.code === "PAYMENT_ALREADY_PENDING") await loadInvoiceList();
  } finally {
    button.disabled = false;
  }
}

byId("newInvoiceButton").addEventListener("click", () => openInvoiceForm());
byId("cancelInvoiceForm").addEventListener("click", closeInvoiceForm);
byId("invoiceForm").addEventListener("input", updateInvoicePreview);
byId("invoiceForm").addEventListener("submit", saveInvoice);
byId("invoiceFilters").addEventListener("submit", (event) => {
  event.preventDefault();
  adminInvoices.page = 1;
  loadInvoiceList();
});
byId("invoiceTermFilter").addEventListener("change", () => {
  adminInvoices.page = 1;
  loadInvoiceList();
});
byId("adminInvoiceRows").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-edit-invoice]");
  if (!button) return;
  try {
    const invoice = (await api(`/invoices/${encodeURIComponent(button.dataset.editInvoice)}`)).data;
    if (!invoice.editable) {
      setInvoicesMessage(`Invoice #${invoice.id} can no longer be edited (${LOCK_LABELS[invoice.lockReason] || "locked"}).`, true);
      await loadInvoiceList();
      return;
    }
    openInvoiceForm(invoice);
  } catch (error) {
    setInvoicesMessage(`Unable to open the invoice: ${error.message}`, true);
  }
});
byId("adminInvoicesPrev").addEventListener("click", () => {
  if (adminInvoices.page > 1) {
    adminInvoices.page -= 1;
    loadInvoiceList();
  }
});
byId("adminInvoicesNext").addEventListener("click", () => {
  adminInvoices.page += 1;
  loadInvoiceList();
});

// ---------------------------------------------------------------------------
// Admin: webhook endpoints (one signing secret per endpoint)
// ---------------------------------------------------------------------------

const adminWebhooks = { schools: [], events: [], loaded: false };

function setWebhooksMessage(text, isError = false) {
  const message = byId("adminWebhooksMessage");
  message.textContent = text;
  message.classList.toggle("widget-error", isError);
}

// Shows a secret once. It is not kept anywhere after the panel is closed.
function showWebhookSecret(secret, note) {
  byId("webhookSecretValue").textContent = secret;
  byId("webhookSecretNote").textContent = note;
  byId("webhookSecretPanel").hidden = false;
  byId("dismissWebhookSecret").focus();
}

function hideWebhookSecret() {
  byId("webhookSecretValue").textContent = "";
  byId("webhookSecretNote").textContent = "";
  byId("webhookSecretPanel").hidden = true;
}

async function loadAdminWebhooks() {
  byId("adminWebhooksSection").hidden = false;
  try {
    if (!adminWebhooks.loaded) {
      const [schools, events] = await Promise.all([api("/api-keys/schools"), api("/webhooks/events")]);
      adminWebhooks.schools = schools.data;
      adminWebhooks.events = events.data;
      byId("webhookForm").elements.schoolId.innerHTML = adminWebhooks.schools
        .map((school) => `<option value="${escapeHtml(school.id)}">${escapeHtml(school.name)}</option>`).join("");
      byId("webhookEventOptions").innerHTML = adminWebhooks.events.map((event) => `
        <label class="webhook-event"><input type="checkbox" name="events" value="${escapeHtml(event)}" checked> <code>${escapeHtml(event)}</code></label>`).join("");
      adminWebhooks.loaded = true;
    }
    await loadWebhookList();
  } catch (error) {
    setWebhooksMessage(`Unable to load webhooks: ${error.message}`, true);
  }
}

async function loadWebhookList() {
  try {
    const result = await api("/webhooks");
    renderWebhookList(result.data);
  } catch (error) {
    byId("adminWebhookRows").innerHTML = "";
    setWebhooksMessage(`Unable to load webhooks: ${error.message}`, true);
  }
}

function renderWebhookList(rows) {
  const body = byId("adminWebhookRows");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted-cell">No webhook URLs registered yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((row) => {
    const allEvents = adminWebhooks.events.length && row.events.length === adminWebhooks.events.length;
    const events = allEvents ? "All events" : row.events.join(", ");
    const previous = row.previousSecretExpiresAt
      ? `<small class="muted-cell">Previous secret valid until ${escapeHtml(new Date(row.previousSecretExpiresAt).toLocaleString())}</small>`
      : "";
    const disabled = row.status === "disabled"
      ? `<small><span class="payment-status payment-status-failed">Disabled – the receiver answered 410 Gone</span></small>`
      : "";
    return `<tr>
      <td class="webhook-url-cell"><code>${escapeHtml(row.url)}</code>${row.description ? `<small class="muted-cell">${escapeHtml(row.description)}</small>` : ""}${disabled}</td>
      <td>${escapeHtml(row.schoolName)}</td>
      <td class="webhook-events-cell">${escapeHtml(events)}</td>
      <td>${escapeHtml(new Date(row.secretLastRotatedAt).toLocaleString())}${previous}</td>
      <td class="action-cell webhook-actions">
        <button type="button" class="outline-button" data-rotate-webhook="${escapeHtml(row.id)}">Rotate secret</button>
        <button type="button" class="outline-button cancel-payment-button" data-delete-webhook="${escapeHtml(row.id)}" data-url="${escapeHtml(row.url)}">Delete</button>
      </td>
    </tr>`;
  }).join("");
}

async function registerWebhook(event) {
  event.preventDefault();
  const form = byId("webhookForm");
  const url = form.elements.url.value.trim();
  const description = form.elements.description.value.trim();
  const events = [...form.querySelectorAll("input[name=events]:checked")].map((input) => input.value);
  const problems = [];
  if (!url) problems.push("URL: enter the school's webhook URL");
  if (!events.length) problems.push("Events: choose at least one event");
  const showErrors = (list) => {
    byId("webhookFormErrors").innerHTML = list.map((text) => `<li>${escapeHtml(text)}</li>`).join("");
  };
  showErrors(problems);
  if (problems.length) return;

  const button = byId("registerWebhookButton");
  button.disabled = true;
  try {
    const body = { schoolId: Number(form.elements.schoolId.value), url, events };
    if (description) body.description = description;
    const result = await api("/webhooks", { method: "POST", body: JSON.stringify(body) });
    form.elements.url.value = "";
    form.elements.description.value = "";
    showWebhookSecret(result.data.secret, `For ${result.data.url}`);
    setWebhooksMessage(`Webhook registered for ${result.data.schoolName}.`);
    await loadWebhookList();
  } catch (error) {
    const fieldErrors = error.details?.fieldErrors || {};
    const list = Object.entries(fieldErrors).flatMap(([field, texts]) => texts.map((text) => `${field}: ${text}`));
    showErrors(list.length ? list : [error.message]);
  } finally {
    button.disabled = false;
  }
}

byId("webhookForm").addEventListener("submit", registerWebhook);
byId("dismissWebhookSecret").addEventListener("click", hideWebhookSecret);
byId("copyWebhookSecret").addEventListener("click", (event) => copyText(byId("webhookSecretValue").textContent, event.currentTarget));
byId("adminWebhookRows").addEventListener("click", async (event) => {
  const rotate = event.target.closest("[data-rotate-webhook]");
  const remove = event.target.closest("[data-delete-webhook]");
  try {
    if (rotate) {
      if (!window.confirm("Create a new signing secret? The old one keeps working for 24 hours, so the school has time to update their app.")) return;
      const result = await api(`/webhooks/${encodeURIComponent(rotate.dataset.rotateWebhook)}/rotate-secret`, { method: "POST" });
      showWebhookSecret(result.data.secret,
        `The previous secret keeps working until ${new Date(result.data.previousSecretExpiresAt).toLocaleString()}.`);
      setWebhooksMessage("Signing secret rotated.");
      await loadWebhookList();
    } else if (remove) {
      if (!window.confirm(`Delete the webhook for ${remove.dataset.url}? PlugLytics stops sending events to it, and its secret is deleted.`)) return;
      await api(`/webhooks/${encodeURIComponent(remove.dataset.deleteWebhook)}`, { method: "DELETE" });
      setWebhooksMessage("Webhook deleted.");
      await loadWebhookList();
    }
  } catch (error) {
    setWebhooksMessage(`Unable to update the webhook: ${error.message}`, true);
  }
});

// ---------------------------------------------------------------------------
// Admin: refunds (request, approve, reject, send on testnet)
// ---------------------------------------------------------------------------

const refundForm = { paymentId: null };
const REFUND_STATUS_CLASSES = {
  requested: "payment-status-pending",
  approved: "invoice-status-partial",
  issued: "payment-status-completed",
  rejected: "payment-status-failed",
};

function setRefundsMessage(text, isError = false) {
  const message = byId("adminRefundsMessage");
  message.textContent = text;
  message.classList.toggle("widget-error", isError);
}

function openRefundForm(button) {
  refundForm.paymentId = button.dataset.refundPayment;
  const form = byId("refundForm");
  form.reset();
  form.elements.amount.value = button.dataset.received;
  byId("refundFormErrors").innerHTML = "";
  byId("refundFormIntro").textContent = `For ${refundForm.paymentId}: ${button.dataset.received} ${button.dataset.asset} arrived`
    + `${button.dataset.payer ? ` from ${button.dataset.payer}` : " (payer not known: give the destination in writing)"}.`
    + " The refund is sent in the same asset, after it is approved.";
  byId("refundFormPanel").hidden = false;
  form.elements.amount.focus();
}

function closeRefundForm() {
  refundForm.paymentId = null;
  byId("refundFormPanel").hidden = true;
}

async function submitRefundForm(event) {
  event.preventDefault();
  const form = byId("refundForm");
  const body = {
    paymentId: refundForm.paymentId,
    amount: form.elements.amount.value.trim(),
    reason: form.elements.reason.value,
    note: form.elements.note.value.trim(),
  };
  const destination = form.elements.destination.value.trim();
  const destinationMemo = form.elements.destinationMemo.value.trim();
  if (destination) body.destination = destination;
  if (destinationMemo) body.destinationMemo = destinationMemo;
  const show = (list) => { byId("refundFormErrors").innerHTML = list.map((text) => `<li>${escapeHtml(text)}</li>`).join(""); };
  const problems = [];
  if (!body.amount) problems.push("Amount: enter the amount to refund");
  if (!body.note) problems.push("Note: say who asked, and why");
  if (destinationMemo && !destination) problems.push("Destination memo: only with a destination given in writing");
  show(problems);
  if (problems.length) return;

  const button = byId("submitRefundForm");
  button.disabled = true;
  try {
    const result = await api("/refunds", { method: "POST", body: JSON.stringify(body) });
    closeRefundForm();
    setRefundsMessage(`Refund ${result.data.id} requested (${result.data.amount} ${result.data.asset}).`
      + (result.data.needsSecondApproval ? " It needs two admins to approve it." : " It needs one approval."));
    await loadAdminRefunds();
    byId("adminRefundsSection").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    const fieldErrors = error.details?.fieldErrors || {};
    const list = Object.entries(fieldErrors).flatMap(([field, texts]) => texts.map((text) => `${field}: ${text}`));
    show(list.length ? list : [error.message]);
  } finally {
    button.disabled = false;
  }
}

async function loadAdminRefunds() {
  byId("adminRefundsSection").hidden = false;
  const status = byId("adminRefundStatus").value;
  try {
    const result = await api(`/refunds${status ? `?status=${encodeURIComponent(status)}` : ""}`);
    renderRefunds(result.data);
  } catch (error) {
    byId("adminRefundRows").innerHTML = "";
    setRefundsMessage(`Unable to load refunds: ${error.message}`, true);
  }
}

function refundStatusText(row) {
  if (row.status === "requested" && row.needsSecondApproval && row.approvedBy) return "Requested · 1 of 2 approvals";
  if (row.status === "requested") return row.needsSecondApproval ? "Requested · needs 2 approvals" : "Requested · needs 1 approval";
  return row.status.charAt(0).toUpperCase() + row.status.slice(1);
}

function renderRefunds(rows) {
  const body = byId("adminRefundRows");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted-cell">No refunds yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((row) => {
    const tx = row.transactionHash
      ? `<a href="${escapeHtml(explorerTxUrl(row.transactionHash, "sandbox"))}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(shortHash(row.transactionHash))}</code><span class="visually-hidden"> (opens stellar.expert in a new tab)</span></a>`
      : "";
    const people = [row.requestedBy && `requested by ${row.requestedBy}`, row.approvedBy && `approved by ${row.approvedBy}`,
      row.secondApprovedBy && `and ${row.secondApprovedBy}`, row.rejectedBy && `rejected by ${row.rejectedBy}: ${row.rejectionNote}`]
      .filter(Boolean).join(", ");
    const actions = [];
    if (row.status === "requested") {
      actions.push(`<button type="button" class="outline-button" data-refund-action="approve" data-refund-id="${escapeHtml(row.id)}">Approve</button>`);
    }
    if (row.status === "approved") {
      actions.push(`<button type="button" data-refund-action="issue" data-refund-id="${escapeHtml(row.id)}" data-amount="${escapeHtml(row.amount)}" data-asset="${escapeHtml(row.asset)}" data-destination="${escapeHtml(row.destination)}">Send testnet refund</button>`);
    }
    if (row.status === "requested" || (row.status === "approved" && !row.sendInProgress)) {
      actions.push(`<button type="button" class="outline-button cancel-payment-button" data-refund-action="reject" data-refund-id="${escapeHtml(row.id)}">Reject</button>`);
    }
    return `<tr>
      <td>${escapeHtml(new Date(row.requestedAt).toLocaleString())}</td>
      <td><code>${escapeHtml(row.paymentId)}</code></td>
      <td><code>${escapeHtml(row.amount)}</code> ${escapeHtml(row.asset)}</td>
      <td>${escapeHtml(row.reason.replace("_", " "))}<small class="muted-cell">${escapeHtml(row.note)}</small></td>
      <td class="webhook-url-cell"><code>${escapeHtml(shortHash(row.destination))}</code><small class="muted-cell">${row.destinationSource === "written" ? "given in writing" : "original payer"} · memo <code>${escapeHtml(row.paymentMemo)}</code></small></td>
      <td><span class="payment-status ${REFUND_STATUS_CLASSES[row.status] || ""}">${escapeHtml(refundStatusText(row))}</span>
        ${tx ? `<small>${tx}</small>` : ""}
        ${row.lastError && row.status !== "issued" ? `<small class="widget-error">${escapeHtml(row.lastError)}</small>` : ""}
        <small class="muted-cell">${escapeHtml(people)}</small></td>
      <td class="action-cell webhook-actions">${actions.join("")}</td>
    </tr>`;
  }).join("");
}

async function refundAction(button) {
  const id = button.dataset.refundId;
  const action = button.dataset.refundAction;
  let body = {};
  if (action === "reject") {
    const note = window.prompt("Why is this refund rejected? (saved for audits)");
    if (!note || !note.trim()) return;
    body = { note: note.trim() };
  }
  if (action === "issue" && !window.confirm(
    `Send ${button.dataset.amount} ${button.dataset.asset} on the Stellar TESTNET to ${button.dataset.destination}? This creates a new payment from the merchant account.`
  )) return;

  button.disabled = true;
  try {
    const result = await api(`/refunds/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify(body) });
    const labels = { approve: "approved", reject: "rejected", issue: "sent" };
    setRefundsMessage(result.data.status === "issued"
      ? `Refund ${id} sent: transaction ${shortHash(result.data.transactionHash)}.`
      : `Refund ${id} ${labels[action]} (${refundStatusText(result.data)}).`);
  } catch (error) {
    setRefundsMessage(`Unable to ${action} the refund: ${error.message}`, true);
  } finally {
    await loadAdminRefunds();
  }
}

byId("refundForm").addEventListener("submit", submitRefundForm);
byId("cancelRefundForm").addEventListener("click", closeRefundForm);
byId("adminRefundStatus").addEventListener("change", loadAdminRefunds);
byId("adminRefundsRefresh").addEventListener("click", loadAdminRefunds);
byId("adminRefundRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-refund-action]");
  if (button) refundAction(button);
});
byId("adminPaymentRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-refund-payment]");
  if (button) openRefundForm(button);
});
