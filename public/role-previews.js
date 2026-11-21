const previewTabs = [...document.querySelectorAll("[data-preview-role]")];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

for (const list of document.querySelectorAll("[data-preview-events]")) {
  const events = window.PLUGLYTICS_DEMO_DATA.events[list.dataset.previewEvents] || [];
  list.innerHTML = events.map((event) => {
    const date = new Date(`${event.date}T00:00:00`);
    const dateLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<li><time datetime="${event.date}">${dateLabel} · ${escapeHtml(event.time)}</time>
      <span><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.type)}${event.courseCode ? ` · ${escapeHtml(event.courseCode)}` : ""}</small></span></li>`;
  }).join("");
}

function selectPreview(tab) {
  for (const candidate of previewTabs) {
    const selected = candidate === tab;
    candidate.setAttribute("aria-selected", String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(`preview-panel-${candidate.dataset.previewRole}`);
    panel.hidden = !selected;
  }
}

for (const tab of previewTabs) {
  tab.addEventListener("click", () => selectPreview(tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = previewTabs.indexOf(tab);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? previewTabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : previewTabs.length - 1)) % previewTabs.length;
    previewTabs[nextIndex].focus();
    selectPreview(previewTabs[nextIndex]);
  });
}
