"use strict";

const Core = FocusLedgerCore;
let state;
let selectedPeriod = "today";
let selectedDayOffset = 0;
let refreshPromise = null;

const $ = selector => document.querySelector(selector);
const make = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};
const dayAtOffset = offset => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.getTime();
};
const formatClock = timestamp => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
const formatHour = hour => new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2026, 0, 1, hour));

function rangeForPeriod() {
  const now = Date.now();
  if (selectedPeriod === "session") return { start: state.sessionStartedAt, end: now, label: "This session" };
  if (selectedPeriod === "week") return { start: Core.mondayStart(now), end: now, label: "This week" };
  if (selectedPeriod === "custom") {
    const from = $("#range-start").value, to = $("#range-end").value;
    if (!from || !to || from > to) return { start: now, end: now, label: "Custom range" };
    const start = new Date(`${from}T00:00:00`).getTime();
    const end = Core.nextLocalDayStart(new Date(`${to}T00:00:00`).getTime());
    return { start, end, label: "Custom range" };
  }
  return { start: Core.localDayStart(now), end: now, label: "Today" };
}

function aggregateRange(start, end) {
  return Core.aggregate(state.log, start, end, state.settings.rules);
}

function renderDay() {
  const start = dayAtOffset(selectedDayOffset);
  const end = Core.nextLocalDayStart(start);
  const report = aggregateRange(start, end);
  const goalState = Core.goalProgress(report.totals.productive, state.settings.focusGoalMinutes);
  const goal = goalState.goalMs;
  const focusSessions = (state.settings.focusSessions || []).filter(session =>
    Core.localDayKey(session.startedAt) === Core.localDayKey(start) && session.completed);
  const activeSession = state.settings.focusSession;
  const isSelectedDayToday = selectedDayOffset === 0;
  const sessionsToday = focusSessions.length + (isSelectedDayToday && activeSession ? 1 : 0);
  const completedSessions = focusSessions.length;
  const progress = goalState.percent;
  const attention = Core.percent(report.totals.productive, report.total);
  const activeHours = report.hourly.filter(hour => hour.total > 0);
  const productiveHours = activeHours.filter(hour => hour.productive >= 60000);
  const stability = activeHours.length ? Math.round(productiveHours.length / activeHours.length * 100) : null;
  const peak = report.hourly.reduce((best, hour, index) => hour.productive > best.amount ? { hour: index, amount: hour.productive } : best, { hour: -1, amount: 0 });

  $("#date-day").textContent = new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(start);
  $("#date-month").textContent = new Intl.DateTimeFormat(undefined, { month: "short" }).format(start);
  $("#day-goal-summary").textContent = `${Core.formatDuration(report.totals.productive)} / ${Core.formatDuration(goal)} focused`;
  $("#day-session-summary").textContent = `${completedSessions} completed`;
  $("#deep-work-value").textContent = Core.formatDuration(report.totals.productive);
  $("#deep-work-footnote").textContent = `${isSelectedDayToday ? "Productive browsing today" : "Productive browsing"}${report.userIdleMs ? ` · ${Core.formatDuration(report.userIdleMs)} idle` : ""}`;
  $("#deep-work-footnote").title = `${Core.formatDuration(report.activeBrowserMs)} while the computer was active; ${Core.formatDuration(report.userIdleMs)} while the system reported idle.`;
  $("#attention-value").textContent = `${attention}%`;
  $("#attention-bar").style.width = `${attention}%`;
  $(".attention .metric-progress").setAttribute("aria-valuenow", String(attention));
  $("#stability-score").textContent = stability === null ? "No activity yet" : `Stability: ${stability}%`;
  $("#stability-score").title = "Share of tracked hours with at least one minute of productive browsing.";
  $("#attention-value").title = "Productive time divided by total tracked active browser time.";
  $("#peak-hour").textContent = peak.hour < 0 ? "No peak yet" : `Peak ${formatHour(peak.hour)}`;
  $("#goal-percent").textContent = `${progress}%`;
  $("#goal-ring").style.setProperty("--progress", `${progress}%`);
  $("#goal-ring").setAttribute("aria-valuenow", String(progress));
  $("#goal-completion").textContent = `${Core.formatDuration(goalState.completedMs)} of ${Core.formatDuration(goal)}`;
  $("#goal-remaining").textContent = goalState.complete ? "Daily goal complete" : `${Core.formatDuration(goalState.remainingMs)} remaining`;
  $("#completed-sessions").textContent = String(completedSessions);
  $("#distraction-time").textContent = Core.formatDuration(report.totals.distracting);
  $("#goal-minutes").value = String(state.settings.focusGoalMinutes);
  const motivation = report.totals.productive >= goal ? "Your focus goal is complete!" :
    report.totals.productive > 0 ? "Keep it going! You're making progress." : "A little focus goes a long way.";
  $("#motivation").textContent = motivation;
  $("#motivation-detail").textContent = report.total ? `${Core.formatDuration(report.total)} of browser activity tracked today.` : "Your activity stays private on this device.";
  renderHourlyChart(report.hourly);
  renderTimeline(report, start, activeSession, sessionsToday);
  renderInsights(report, goal);
  updateSessionControls(activeSession);
}

function renderHourlyChart(hourly) {
  const chart = $("#hour-chart");
  const max = Math.max(...hourly.map(hour => hour.productive), 0);
  chart.replaceChildren();
  for (let hour = 0; hour < 24; hour += 1) {
    const value = hourly[hour].productive;
    const bar = make("span", `hour-bar${value ? " has-value" : ""}`);
    bar.style.setProperty("--bar-height", `${max ? Math.max(8, value / max * 100) : 0}%`);
    bar.title = `${formatHour(hour)}: ${Core.formatDuration(value)} productive`;
    bar.setAttribute("aria-label", bar.title);
    chart.append(bar);
  }
}

function renderTimeline(report, start, activeSession, sessionCount) {
  const chart = $("#timeline-chart");
  chart.replaceChildren();
  const max = Math.max(...report.hourly.slice(8, 21).map(hour => hour.total), 0);
  for (let hour = 8; hour <= 20; hour += 1) {
    const cell = make("div", "timeline-hour");
    const bar = make("span", "timeline-bar");
    const total = report.hourly[hour].total;
    const productive = report.hourly[hour].productive;
    const distracting = report.hourly[hour].distracting;
    const neutral = report.hourly[hour].neutral;
    const height = max ? Math.max(2, total / max * 100) : 0;
    bar.style.height = `${height}%`;
    if (total) {
      bar.style.background = `linear-gradient(to top, var(--gold) 0 ${neutral / total * 100}%, var(--red) ${neutral / total * 100}% ${(neutral + distracting) / total * 100}%, var(--blue-glow) ${(neutral + distracting) / total * 100}% 100%)`;
      bar.title = `${formatHour(hour)} · ${Core.formatDuration(productive)} productive, ${Core.formatDuration(distracting)} distracting, ${Core.formatDuration(neutral)} neutral`;
    }
    cell.append(bar);
    chart.append(cell);
  }

  const sessions = (state.settings.focusSessions || []).filter(session =>
    Core.localDayKey(session.startedAt) === Core.localDayKey(start));
  if (selectedDayOffset === 0 && activeSession) sessions.push(activeSession);
  const list = $("#session-list");
  list.replaceChildren();
  sessions.sort((a, b) => a.startedAt - b.startedAt);
  for (const session of sessions) {
    const entry = make("article", `session-entry${session.status === "running" ? " session-running" : ""}`);
    const badge = make("span", "session-dot");
    const label = make("div", "session-entry-copy");
    const stateLabel = session.status === "running" ? (session.pausedAt ? "Paused" : "In progress") : session.completed ? "Completed" : "Ended early";
    const elapsedMs = session.status === "running" ? Core.sessionProgress(session).elapsedMs : session.elapsedMs || 0;
    const progress = {
      elapsedMs,
      durationMs: session.durationMs || 0,
      percent: session.completed ? 100 : Core.percent(elapsedMs, session.durationMs || 0)
    };
    const elapsed = progress.elapsedMs;
    const duration = progress.durationMs;
    label.append(make("strong", "", "Focus session"), make("span", "", `${formatClock(session.startedAt)} · ${stateLabel} · ${Core.formatDuration(elapsed)} / ${Core.formatDuration(duration)}`));
    if (session.productiveDomains && session.productiveDomains.length) {
      label.append(make("span", "", `Focus sites: ${session.productiveDomains.join(", ")}`));
    }
    const progressTrack = make("span", "session-progress");
    const progressFill = make("span");
    progressFill.style.width = `${progress.percent}%`;
    progressTrack.append(progressFill);
    label.append(progressTrack);
    entry.append(badge, label);
    if (session.status === "running") {
      const controls = make("div", "session-controls");
      const pause = make("button", "small-action", session.pausedAt ? "Resume" : "Pause");
      pause.addEventListener("click", async () => { await send({ type: "toggleFocusPause" }); await loadAndRender(); });
      const end = make("button", "small-action", "End");
      end.addEventListener("click", async () => { await send({ type: "endFocusSession" }); await loadAndRender(); });
      controls.append(pause, end);
      entry.append(controls);
    }
    list.append(entry);
  }
  $("#timeline-summary").textContent = `${sessionCount} focus ${sessionCount === 1 ? "session" : "sessions"} · ${Core.formatDuration(report.total)} tracked`;
  $("#timeline-empty").hidden = Boolean(report.total || sessions.length);
  $("#timeline-chart").setAttribute("aria-label", `Hourly activity for ${Core.localDayKey(start)}`);
}

function renderInsights(todayReport, goal) {
  const container = $("#insights");
  const items = [];
  const distractionEntries = Object.entries(todayReport.domains)
    .map(([domain, duration]) => ({ domain, duration, category: Core.classify(domain, state.settings.rules) }))
    .filter(item => item.category === "distracting")
    .sort((a, b) => b.duration - a.duration);
  if (todayReport.totals.distracting) items.push(`${Core.formatDuration(todayReport.totals.distracting)} spent on distracting websites today.`);
  if (distractionEntries.length) items.push(`Most distracting: ${distractionEntries[0].domain} (${Core.formatDuration(distractionEntries[0].duration)}).`);

  let achievedDays = 0;
  const now = Date.now();
  let sevenDayActivity = 0;
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(Core.localDayStart(now));
    day.setDate(day.getDate() - offset);
    const dayStart = day.getTime();
    const dayReport = aggregateRange(dayStart, Core.nextLocalDayStart(dayStart));
    sevenDayActivity += dayReport.total;
    if (dayReport.totals.productive >= goal) achievedDays += 1;
  }
  if (!sevenDayActivity) {
    items.push("Your weekly insights will appear after you have tracked activity.");
  } else {
    items.push(`You reached your goal on ${achievedDays} of the last 7 days.`);
    const weekly = aggregateRange(Core.mondayStart(now), now);
    const peak = weekly.hourly.reduce((best, hour, index) => {
      const duration = hour.productive + weekly.hourly[(index + 1) % 24].productive + weekly.hourly[(index + 2) % 24].productive;
      return duration > best.amount ? { hour: index, amount: duration } : best;
    }, { hour: -1, amount: 0 });
    if (peak.hour >= 0) items.push(`Your most productive period this week was ${formatHour(peak.hour)} to ${formatHour((peak.hour + 3) % 24)}.`);
  }
  const streak = calculateStreak(goal, now);
  $("#daily-streak").textContent = `${streak} ${streak === 1 ? "day" : "days"}`;
  container.replaceChildren(...items.map(text => {
    const insight = make("p", "insight-item");
    insight.append(make("span", "insight-star", "✦"), make("span", "", text));
    return insight;
  }));
}

function calculateStreak(goal, now) {
  let count = 0;
  const date = new Date(Core.localDayStart(now));
  if (aggregateRange(date.getTime(), Core.nextLocalDayStart(date.getTime())).totals.productive < goal) date.setDate(date.getDate() - 1);
  for (let index = 0; index < 366; index += 1) {
    const start = date.getTime();
    const report = aggregateRange(start, Core.nextLocalDayStart(start));
    if (report.totals.productive < goal) break;
    count += 1;
    date.setDate(date.getDate() - 1);
  }
  return count;
}

function renderReports() {
  const range = rangeForPeriod();
  const report = aggregateRange(range.start, range.end);
  const categoryNames = { productive: "Deep work", distracting: "Distraction", neutral: "Neutral" };
  const warning = $("#data-warning");
  warning.hidden = !state.invalidRecords;
  warning.textContent = state.invalidRecords
    ? `${state.invalidRecords} malformed historical ${state.invalidRecords === 1 ? "record was" : "records were"} left in local storage and excluded from reports.`
    : "";
  $("#period-headline").textContent = report.total
    ? `${Core.formatDuration(report.totals.productive)} productive, ${Core.formatDuration(report.totals.distracting)} distracting, and ${Core.formatDuration(report.totals.neutral)} neutral.`
    : `No active browser time recorded in ${range.label.toLowerCase()}.`;
  $("#custom-range").hidden = selectedPeriod !== "custom";
  $("#category-cards").replaceChildren(...Core.categories.map(category => {
    const value = report.totals[category];
    const card = make("article", `category-card ${category}`);
    card.append(make("span", "category-label", categoryNames[category]), make("strong", "", Core.formatDuration(value)), make("small", "", `${Core.percent(value, report.total)}% of tracked time`));
    const track = make("span", "category-progress");
    const fill = make("span");
    fill.style.width = `${Core.percent(value, report.total)}%`;
    track.append(fill);
    card.append(track);
    return card;
  }));
  const categoryValues = Core.categories.map(category => Core.percent(report.totals[category], report.total));
  $("#donut").style.background = report.total
    ? `conic-gradient(var(--blue-glow) 0 ${categoryValues[0]}%, var(--red) ${categoryValues[0]}% ${categoryValues[0] + categoryValues[1]}%, var(--gold) ${categoryValues[0] + categoryValues[1]}% 100%)`
    : "var(--line)";
  $("#chart-total").textContent = report.total ? Core.formatDuration(report.total) : "No data";
  $("#chart-legend").replaceChildren(...Core.categories.map((category, index) => {
    const item = make("li", category);
    item.append(make("i"), make("span", "", categoryNames[category]), make("strong", "", `${categoryValues[index]}%`));
    return item;
  }));
  const domains = Object.entries(report.domains).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const list = $("#domains");
  if (!domains.length) {
    list.replaceChildren(make("li", "empty", "Your top websites will appear here after you browse."));
  } else {
    const max = Math.max(...domains.map(([, duration]) => duration));
    list.replaceChildren(...domains.map(([domain, duration], index) => {
      const item = make("li", "domain-row");
      const details = make("div", "domain-details");
      const top = make("div", "domain-top");
      top.append(make("span", "domain-rank", String(index + 1).padStart(2, "0")), make("strong", "", domain), make("span", "domain-duration", Core.formatDuration(duration)));
      const track = make("span", "domain-progress");
      const fill = make("span");
      fill.style.width = `${duration / max * 100}%`;
      track.append(fill);
      details.append(top, track);
      item.append(details);
      return item;
    }));
  }
  document.querySelectorAll("[data-period]").forEach(button => button.classList.toggle("active", button.dataset.period === selectedPeriod));
}

function renderSettings() {
  document.documentElement.dataset.theme = state.settings.theme || "system";
  $("#theme").value = state.settings.theme || "system";
  for (const category of Core.categories) $(`#${category}`).value = state.settings.rules[category].join("\n");
  renderLimits();
  populateSessionSites();
}

function renderLimits() {
  const entries = Object.entries(state.settings.limits || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const list = $("#limits");
  if (!entries.length) {
    list.replaceChildren(make("li", "empty", "No daily limits set."));
    return;
  }
  list.replaceChildren(...entries.map(([domain, minutes]) => {
    const row = make("li");
    row.append(make("strong", "", domain), make("span", "", `${minutes} min/day`));
    const remove = make("button", "small-action", "Remove");
    remove.addEventListener("click", async () => {
      const next = { ...state.settings.limits };
      delete next[domain];
      await saveSettings({ limits: next });
    });
    row.append(remove);
    return row;
  }));
}

function populateSessionSites() {
  for (const [selector, category] of [["#session-productive", "productive"], ["#session-distracting", "distracting"]]) {
    const select = $(selector);
    const values = [...new Set(state.settings.rules[category])];
    select.replaceChildren(...(values.length ? values.map(domain => {
      const option = make("option", "", domain);
      option.value = domain;
      option.selected = category === "distracting";
      return option;
    }) : [make("option", "", `No ${category} websites configured`)]));
  }
}

function updateSessionControls(session) {
  const start = $("#start-session");
  const deepAction = $("#deep-work-action");
  if (session && session.status === "running") {
    const label = session.pausedAt ? "Resume focus" : "Pause focus";
    start.querySelector("span").textContent = label;
    deepAction.innerHTML = `${label} <span>→</span>`;
    $("#deep-work-footnote").textContent = session.pausedAt ? "Focus session paused" : "Focus session in progress";
    start.setAttribute("aria-label", label);
  } else {
    start.querySelector("span").textContent = "Start focus";
    deepAction.innerHTML = `Start a session <span>→</span>`;
    start.setAttribute("aria-label", "Start focus session");
  }
}

async function send(message) {
  const result = await browser.runtime.sendMessage(message);
  if (result && result.error) throw new Error(result.error);
  return result;
}

async function saveSettings(patch) {
  const response = await send({ type: "saveSettings", settings: { ...state.settings, ...patch } });
  if (!response || !response.saved) throw new Error("Settings could not be saved.");
  await loadAndRender();
}

async function loadAndRender() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    state = await browser.runtime.sendMessage({ type: "getLog" });
    renderDay();
    renderReports();
    renderSettings();
  })().catch(error => {
    console.error("Could not load Focus Wellbeing dashboard:", error);
    $("#period-headline").textContent = "Your local activity could not be loaded. Please try reloading the dashboard.";
  }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function openSessionDialog() {
  if (state.settings.focusSession && state.settings.focusSession.status === "running") {
    toggleSessionPause().catch(showError);
    return;
  }
  $("#session-error").textContent = "";
  $("#session-duration").value = "25";
  $("#session-restrictions").checked = false;
  $("#session-strict").checked = false;
  $(".strict-option").hidden = true;
  populateSessionSites();
  $("#session-dialog").showModal();
}

async function toggleSessionPause() {
  await send({ type: "toggleFocusPause" });
  await loadAndRender();
}

function showError(error) {
  const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
  const field = $("#session-dialog").open ? $("#session-error") : $("#period-headline");
  field.textContent = message;
}

$("#start-session").addEventListener("click", openSessionDialog);
$("#deep-work-action").addEventListener("click", openSessionDialog);
$("#add-event").addEventListener("click", openSessionDialog);
$("#close-session").addEventListener("click", () => $("#session-dialog").close());
$("#session-restrictions").addEventListener("change", event => {
  $(".strict-option").hidden = !event.target.checked;
  if (!event.target.checked) $("#session-strict").checked = false;
});
$("#session-form").addEventListener("submit", async event => {
  event.preventDefault();
  const selected = selector => [...$(selector).selectedOptions].map(option => option.value).filter(value => Core.normalizeDomain(value));
  try {
    await send({
      type: "startFocusSession",
      durationMinutes: Number($("#session-duration").value),
      productiveDomains: selected("#session-productive"),
      distractingDomains: selected("#session-distracting"),
      restrictions: $("#session-restrictions").checked,
      strictMode: $("#session-strict").checked && $("#session-restrictions").checked
    });
    $("#session-dialog").close();
    await loadAndRender();
  } catch (error) {
    $("#session-error").textContent = error.message;
  }
});

$("#save-goal").addEventListener("click", async () => {
  const goal = Number($("#goal-minutes").value);
  try {
    if (!Number.isInteger(goal) || goal < 1 || goal > 1440) throw new Error("Set a daily target between 1 and 1440 minutes.");
    await saveSettings({ focusGoalMinutes: goal });
  } catch (error) { showError(error); }
});
document.querySelectorAll("[data-goal]").forEach(button => button.addEventListener("click", async () => {
  $("#goal-minutes").value = button.dataset.goal;
  await saveSettings({ focusGoalMinutes: Number(button.dataset.goal) }).catch(showError);
}));

$("#theme").addEventListener("change", event => saveSettings({ theme: event.target.value }).catch(showError));
$("#save-rules").addEventListener("click", async () => {
  const rules = {};
  for (const category of Core.categories) {
    rules[category] = $(`#${category}`).value.split(/\r?\n/).map(Core.normalizeDomain).filter(Boolean);
  }
  try { await saveSettings({ rules: Core.normalizeRules(rules) }); }
  catch (error) { showError(error); }
});
$("#limit-form").addEventListener("submit", async event => {
  event.preventDefault();
  const domain = Core.normalizeDomain($("#limit-domain").value);
  const minutes = Number($("#limit-minutes").value);
  if (!domain || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    $("#limit-domain").setCustomValidity(domain ? "" : "Enter a valid website domain.");
    $("#limit-domain").reportValidity();
    return;
  }
  const limits = { ...state.settings.limits, [domain]: minutes };
  try { await saveSettings({ limits }); event.target.reset(); }
  catch (error) { showError(error); }
});
$("#limit-domain").addEventListener("input", event => event.target.setCustomValidity(""));

$("#clear").addEventListener("click", async () => {
  if (!confirm("Delete locally stored activity and completed focus-session history? Your settings and any running session will be kept.")) return;
  try { await send({ type: "clearLog" }); await loadAndRender(); }
  catch (error) { showError(error); }
});

document.querySelectorAll("[data-period]").forEach(button => button.addEventListener("click", () => {
  selectedPeriod = button.dataset.period;
  renderReports();
}));
$("#apply-range").addEventListener("click", () => {
  const start = $("#range-start").value, end = $("#range-end").value;
  if (!start || !end || start > end) {
    $("#period-headline").textContent = "Choose a valid date range with an end date on or after the start date.";
    return;
  }
  renderReports();
});
$("#previous-day").addEventListener("click", () => { selectedDayOffset -= 1; $("#next-day").disabled = false; loadAndRender(); });
$("#next-day").addEventListener("click", () => {
  if (selectedDayOffset >= 0) return;
  selectedDayOffset += 1;
  $("#next-day").disabled = selectedDayOffset === 0;
  loadAndRender();
});
$("#next-day").disabled = true;

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.activityLog || changes.settings)) loadAndRender();
});
loadAndRender();
window.setInterval(loadAndRender, 30000);
