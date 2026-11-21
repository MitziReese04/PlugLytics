const byId = (id) => document.getElementById(id);
const token = localStorage.getItem("pluglytics_token");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function applyTheme(theme) {
  document.body.classList.toggle("dark", theme === "dark");
  byId("themeSelect").value = theme;
  localStorage.setItem("pluglytics_theme", theme);
}

function ordinal(value) {
  const suffix = value % 10 === 1 && value % 100 !== 11 ? "st"
    : value % 10 === 2 && value % 100 !== 12 ? "nd"
      : value % 10 === 3 && value % 100 !== 13 ? "rd" : "th";
  return `${value}${suffix}`;
}

function renderCurriculum(data) {
  byId("curriculumTitle").textContent = data.specialization
    ? `${data.programName} - ${data.specialization}`
    : data.programName;
  byId("curriculumVersion").textContent = data.curriculumVersion || "";
  byId("completionPercent").textContent = `${data.completionPercent}%`;
  byId("completionProgressFill").style.width = `${data.completionPercent}%`;
  byId("completionProgress").setAttribute("aria-valuenow", data.completionPercent);
  byId("completedUnits").textContent = data.completedUnits;
  byId("totalUnits").textContent = data.totalUnits;
  byId("remainingUnits").textContent = data.remainingUnits;

  const completed = data.courses.filter((course) => course.status === "completed").length;
  const inProgress = data.courses.filter((course) => course.status === "in_progress").length;
  const remaining = data.courses.filter((course) => course.status === "remaining").length;
  byId("completedCourses").textContent = completed;
  byId("inProgressCourses").textContent = inProgress;
  byId("remainingCourses").textContent = remaining;

  byId("curriculumSource").textContent = data.source === "demo_curriculum"
    ? "Demo sample based on the February 2025 Software Development curriculum sheet. Completion statuses are illustrative."
    : "Using the local program catalog and enrollment records. This account does not yet have LMS curriculum data synced.";

  const terms = new Map();
  for (const course of data.courses) {
    const key = course.year && course.term ? `${course.year}-${course.term}` : "catalog";
    if (!terms.has(key)) terms.set(key, []);
    terms.get(key).push(course);
  }

  byId("curriculumCourseList").innerHTML = [...terms.entries()].map(([key, courses]) => {
    const [year, term] = key === "catalog" ? [0, 0] : key.split("-").map(Number);
    const termUnits = courses.reduce((total, course) => total + course.units, 0);
    const courseItems = courses.map((course) => {
      const code = course.courseCode || course.code;
      const status = ["completed", "in_progress"].includes(course.status) ? course.status : "remaining";
      const statusText = status === "completed" ? "Finished"
        : status === "in_progress" ? "In progress" : "Remaining";
      const requirements = [];
      if (course.prerequisites?.length) requirements.push(`Prerequisites: ${course.prerequisites.join(", ")}`);
      if (course.corequisites?.length) requirements.push(`Corequisites: ${course.corequisites.join(", ")}`);
      const detail = [
        `${course.units} ${course.units === 1 ? "unit" : "units"}`,
        course.type,
        ...requirements,
      ].filter(Boolean).join(" · ");
      return `<li class="curriculum-course status-${status}">
        <input type="checkbox" ${status === "completed" ? "checked" : ""} disabled aria-label="${escapeHtml(code)}: ${statusText}">
        <div class="curriculum-course-details">
          <strong><span>${escapeHtml(code)}</span> ${escapeHtml(course.title)}</strong>
          <small>${escapeHtml(detail)}</small>
        </div>
        <span class="course-status-badge">${statusText}</span>
      </li>`;
    }).join("");
    const termLabel = year ? `${ordinal(year)} year · ${ordinal(term)} term` : "Program course catalog";
    return `<section class="curriculum-term">
      <header><h3>${termLabel}</h3><span>${termUnits} units</span></header>
      <ul>${courseItems}</ul>
    </section>`;
  }).join("");
  byId("curriculumContent").hidden = false;
}

async function loadCurriculum() {
  if (!token) {
    byId("curriculumError").textContent = "Sign in from the dashboard before opening your course outline.";
    byId("curriculumError").hidden = false;
    return;
  }

  try {
    async function getApiData(path) {
      const response = await fetch(`${location.origin}/api/v1${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new Error(`The curriculum service returned an invalid response (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        throw new Error(body.error?.message || `Could not load curriculum (HTTP ${response.status}).`);
      }
      return body.data;
    }

    const user = await getApiData("/auth/me");
    const curriculum = user.email === "student@pluglytics.local"
      ? await window.PLUGLYTICS_DEMO_DATA.loadCurriculum()
      : await getApiData("/student/curriculum");
    renderCurriculum(curriculum);
  } catch (error) {
    byId("curriculumError").textContent = `Unable to load your course outline: ${error.message}`;
    byId("curriculumError").hidden = false;
  }
}

applyTheme(localStorage.getItem("pluglytics_theme") || "light");
byId("themeSelect").addEventListener("change", (event) => applyTheme(event.target.value));
loadCurriculum();
