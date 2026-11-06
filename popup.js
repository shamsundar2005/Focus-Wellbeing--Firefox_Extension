"use strict";

const Core = FocusLedgerCore;
let selectedPeriod = "today";
let state;
let currentSite;
const $ = selector => document.querySelector(selector);
const make = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};

function currentRange() {
  return selectedPeriod === "today"
    ? { start: Core.localDayStart(), end: Date.now() }
    : { start: state.sessionStartedAt, end: Date.now() };
}

function renderSummary(report) {
  const summary = $("#summary");
  summary.replaceChildren(...Core.categories.map(category => {
    const label = { productive: "productive", distracting: "distraction", neutral: "neutral" }[category];
    const box = make("div", `mini-stat ${category === "productive" ? "good" : category === "distracting" ? "bad" : "neutral"}`);
    box.append(make("strong", "", Core.formatDuration(report.totals[category])), make("span", "", label));
    return box;
  }));
}

function renderTopSites(report) {
  const sites = Object.entries(report.domains).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const list = $("#top-sites");
  list.replaceChildren(...(sites.length ? sites.map(([domain, duration], index) => {
    const row = make("li");
    row.append(make("span", "rank", String(index + 1)), make("strong", "", domain), make("span", "", Core.formatDuration(duration)));
    return row;
  }) : [make("li", "empty", "No usage recorded yet.")]));
}

function renderFocusGoal(todayReport) {
  const progress = Core.goalProgress(todayReport.totals.productive, state.settings.focusGoalMinutes);
  $("#focus-goal").textContent = `${Core.formatDuration(progress.goalMs)} target`;
  $("#focus-value").textContent = `${Core.formatDuration(progress.completedMs)} focused`;
  $("#focus-progress").style.width = `${progress.percent}%`;
  $("#focus-remaining").textContent = progress.complete ? "Goal complete" : `${Core.formatDuration(progress.remainingMs)} remaining`;
  const active = state.settings.focusSession;
  $("#focus-action").textContent = active && active.status === "running"
    ? (active.pausedAt ? "Resume session →" : "Pause session →")
    : "Plan a session →";
}

function renderCurrentSite() {
  $("#current-domain").textContent = currentSite && currentSite.domain ? currentSite.domain : "No trackable page active";
  $("#current-category").textContent = currentSite ? currentSite.category : "";
  $("#timer-status").textContent = currentSite && currentSite.limitMinutes
    ? `${Core.formatDuration(currentSite.spentMs)} of ${currentSite.limitMinutes} min today`
    : "No limit set";
  $("#timer-minutes").value = currentSite && currentSite.limitMinutes ? currentSite.limitMinutes : "";
  $("#add-time").disabled = !currentSite || !currentSite.limitMinutes;
  $("#remove-timer").disabled = !currentSite || !currentSite.limitMinutes;
  document.querySelectorAll("[data-category]").forEach(button => {
    const selected = button.dataset.category === (currentSite && currentSite.category);
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

async function render() {
  try {
    state = await browser.runtime.sendMessage({ type: "getLog" });
    currentSite = await browser.runtime.sendMessage({ type: "getCurrentSite" });
    document.documentElement.dataset.theme = state.settings.theme || "system";
    $("#status-message").textContent = state.invalidRecords
      ? `${state.invalidRecords} malformed local record(s) were excluded.`
      : "";
    const range = currentRange();
    const report = Core.aggregate(state.log, range.start, range.end, state.settings.rules);
    $("#period-title").textContent = selectedPeriod === "today" ? "Today, so far" : "This session, so far";
    document.querySelectorAll("[data-popup-period]").forEach(button => button.classList.toggle("active", button.dataset.popupPeriod === selectedPeriod));
    renderSummary(report);
    renderTopSites(report);
    renderFocusGoal(Core.aggregate(state.log, Core.localDayStart(), Date.now(), state.settings.rules));
    renderCurrentSite();
  } catch (error) {
    console.error("Could not load Focus Wellbeing popup:", error);
    $("#status-message").textContent = "Local activity could not be loaded. Reopen the popup to retry.";
  }
}

async function setTimer(minutes) {
  const result = await browser.runtime.sendMessage({ type: "setCurrentSiteLimit", minutes });
  if (result && result.error) throw new Error(result.error);
  await render();
}

document.querySelectorAll("[data-popup-period]").forEach(button => button.addEventListener("click", () => {
  selectedPeriod = button.dataset.popupPeriod;
  render();
}));
$("#open").addEventListener("click", () => browser.runtime.openOptionsPage());
$("#focus-action").addEventListener("click", async () => {
  try {
    if (state.settings.focusSession && state.settings.focusSession.status === "running") {
      const result = await browser.runtime.sendMessage({ type: "toggleFocusPause" });
      if (result && result.error) throw new Error(result.error);
      await render();
    } else {
      await browser.runtime.openOptionsPage();
    }
  } catch (error) { $("#status-message").textContent = error.message; }
});
document.querySelectorAll("[data-category]").forEach(button => button.addEventListener("click", async () => {
  if (!currentSite || !currentSite.domain) return;
  try {
    const result = await browser.runtime.sendMessage({ type: "setCurrentCategory", category: button.dataset.category });
    if (result && result.error) throw new Error(result.error);
    await render();
  } catch (error) { $("#status-message").textContent = error.message; }
}));
$("#save-timer").addEventListener("click", () => {
  const value = Number($("#timer-minutes").value);
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    $("#timer-minutes").setCustomValidity("Choose a daily limit between 1 and 1440 minutes.");
    $("#timer-minutes").reportValidity();
    return;
  }
  $("#timer-minutes").setCustomValidity("");
  setTimer(value).catch(error => { $("#status-message").textContent = error.message; });
});
$("#timer-minutes").addEventListener("input", () => $("#timer-minutes").setCustomValidity(""));
$("#add-time").addEventListener("click", () => setTimer(Math.min(1440, (currentSite.limitMinutes || 0) + 15)).catch(error => { $("#status-message").textContent = error.message; }));
$("#remove-timer").addEventListener("click", () => setTimer(0).catch(error => { $("#status-message").textContent = error.message; }));

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.activityLog || changes.settings)) render();
});
render();
