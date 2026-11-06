"use strict";

const Core = FocusLedgerCore;
const LOG_KEY = "activityLog";
const SETTINGS_KEY = "settings";
const ACTIVE_KEY = "activeCheckpoint";
const PENDING_KEY = "pendingFocusNavigation";
const FLUSH_ALARM = "focus-ledger-flush";
const FLUSH_MINUTES = 0.5;
const FLUSH_INTERVAL_MS = FLUSH_MINUTES * 60 * 1000;
const MAX_UNOBSERVED_GAP_MS = FLUSH_INTERVAL_MS * 2;
const IDLE_SECONDS = 60;
const DEFAULT_SETTINGS = {
  schemaVersion: 2,
  rules: {
    productive: ["docs.google.com", "notion.so", "github.com", "stackoverflow.com", "developer.mozilla.org"],
    distracting: ["youtube.com", "netflix.com", "instagram.com", "facebook.com", "reddit.com", "x.com", "twitter.com", "tiktok.com"],
    neutral: ["google.com", "wikipedia.org"]
  },
  limits: {},
  theme: "system",
  focusGoalMinutes: 120,
  focusSession: null,
  focusSessions: [],
  limitNotifications: {}
};

let active = null;
let focusedWindowId = null;
let userIdle = false;
let queue = Promise.resolve();

function enqueue(operation) {
  const task = queue.then(operation);
  queue = task.catch(error => {
    console.error("Focus Wellbeing operation failed:", error);
    return browser.notifications.create("focus-ledger-error", {
      type: "basic",
      iconUrl: "icon.svg",
      title: "Focus Wellbeing could not finish an action",
      message: "A local background action failed. Check Firefox's extension console if the problem repeats."
    }).catch(notificationError => console.error("Could not display the Focus Wellbeing storage warning:", notificationError));
  });
  return task;
}

function domainFor(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? Core.normalizeDomain(parsed.hostname) : "";
  } catch (_) {
    return "";
  }
}

function normalizeSettings(saved = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  settings.schemaVersion = 2;
  settings.rules = Core.normalizeRules({ ...DEFAULT_SETTINGS.rules, ...(saved.rules || {}) });
  settings.limits = {};
  for (const [value, limit] of Object.entries(saved.limits || {})) {
    const domain = Core.normalizeDomain(value);
    const minutes = Number(limit);
    if (domain && Number.isFinite(minutes) && minutes > 0) settings.limits[domain] = Math.min(1440, Math.floor(minutes));
  }
  settings.focusGoalMinutes = Math.min(1440, Math.max(1, Number(settings.focusGoalMinutes) || DEFAULT_SETTINGS.focusGoalMinutes));
  settings.focusSession = settings.focusSession && settings.focusSession.status === "running" &&
    Number.isFinite(settings.focusSession.startedAt) && Number.isFinite(settings.focusSession.durationMs) &&
    settings.focusSession.durationMs > 0
    ? {
      ...settings.focusSession,
      pausedAt: Number.isFinite(settings.focusSession.pausedAt) ? settings.focusSession.pausedAt : null,
      pausedDurationMs: Math.max(0, Number(settings.focusSession.pausedDurationMs) || 0),
      productiveDomains: Array.isArray(settings.focusSession.productiveDomains) ? settings.focusSession.productiveDomains.map(Core.normalizeDomain).filter(Boolean) : [],
      distractingDomains: Array.isArray(settings.focusSession.distractingDomains) ? settings.focusSession.distractingDomains.map(Core.normalizeDomain).filter(Boolean) : []
    }
    : null;
  settings.focusSessions = Array.isArray(settings.focusSessions)
    ? settings.focusSessions.filter(item => item && typeof item === "object" && Number.isFinite(item.startedAt))
    : [];
  settings.limitNotifications = settings.limitNotifications && typeof settings.limitNotifications === "object" ? settings.limitNotifications : {};
  return settings;
}

async function getSettings() {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY] || {});
}

function canTrack(tab) {
  return Boolean(tab && !tab.incognito && domainFor(tab.url));
}

async function appendSegment(start, end, details, checkpoint) {
  if (end <= start) return;
  const stored = await browser.storage.local.get(LOG_KEY);
  const log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  let cursor = start;
  while (cursor < end) {
    const localEnd = Math.min(end, Core.nextLocalDayStart(cursor));
    const record = {
      domain: details.domain,
      title: details.title,
      category: details.category,
      startedAt: cursor,
      endedAt: localEnd,
      durationMs: localEnd - cursor,
      userIdle: Boolean(details.userIdle)
    };
    const previous = log[log.length - 1];
    if (previous && previous.domain === record.domain && previous.category === record.category &&
        previous.userIdle === record.userIdle && previous.endedAt === record.startedAt &&
        Core.localDayKey(previous.endedAt - 1) === Core.localDayKey(record.startedAt)) {
      previous.endedAt = record.endedAt;
      previous.durationMs += record.durationMs;
    } else {
      log.push(record);
    }
    cursor = localEnd;
  }
  await browser.storage.local.set({ [LOG_KEY]: log, [ACTIVE_KEY]: checkpoint });
}

async function checkLimit(domain) {
  const cfg = await getSettings();
  const limitMinutes = cfg.limits[domain];
  if (!limitMinutes) return;
  const todayKey = Core.localDayKey(Date.now());
  const marker = `${todayKey}|${domain}|${limitMinutes}`;
  if (cfg.limitNotifications[marker]) return;
  const logData = await browser.storage.local.get(LOG_KEY);
  const today = Core.aggregate(logData[LOG_KEY], Core.localDayStart(), Date.now() + 1, cfg.rules);
  if ((today.domains[domain] || 0) < limitMinutes * 60000) return;
  cfg.limitNotifications[marker] = true;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 31);
  for (const key of Object.keys(cfg.limitNotifications)) {
    if (key.slice(0, 10) < Core.localDayKey(cutoff.getTime())) delete cfg.limitNotifications[key];
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: cfg });
  await browser.notifications.create(`limit:${todayKey}:${domain}`, {
    type: "basic",
    iconUrl: "icon.svg",
    title: "Daily limit reached",
    message: `${domain} reached its ${limitMinutes}-minute daily limit.`,
    buttons: [{ title: "Add 15 minutes" }, { title: "Remove limit" }]
  });
}

async function flushActive(now = Date.now()) {
  if (!active || now <= active.lastFlushedAt) return;
  const previous = active.lastFlushedAt;
  const snapshot = { ...active };
  const gap = now - previous > MAX_UNOBSERVED_GAP_MS;
  const observedEnd = gap ? Math.min(now, previous + FLUSH_INTERVAL_MS) : now;
  if (gap) userIdle = (await browser.idle.queryState(IDLE_SECONDS)) !== "active";
  active.userIdle = userIdle;
  active.lastFlushedAt = now;
  try {
    await appendSegment(previous, observedEnd, snapshot, active);
  } catch (error) {
    active.lastFlushedAt = previous;
    active.userIdle = snapshot.userIdle;
    throw error;
  }
  await checkLimit(snapshot.domain);
}

async function closeActive() {
  if (!active) return;
  await flushActive();
  active = null;
  await browser.storage.local.remove(ACTIVE_KEY);
}

function eligible(tab) {
  return canTrack(tab) && Boolean(tab.active) && tab.windowId === focusedWindowId;
}

async function interceptDistraction(tabId, url) {
  const pending = await browser.storage.local.get(PENDING_KEY);
  const entries = pending[PENDING_KEY] || {};
  const pendingEntry = entries[String(tabId)];
  if (pendingEntry && (pendingEntry.dismissBack || (pendingEntry.approved && pendingEntry.url === url))) {
    delete entries[String(tabId)];
    await browser.storage.local.set({ [PENDING_KEY]: entries });
    return false;
  }
  const cfg = await getSettings();
  const session = cfg.focusSession;
  const domain = domainFor(url);
  if (!session || session.status !== "running" || session.pausedAt || !session.restrictions ||
      !domain || Core.classify(domain, cfg.rules) !== "distracting" ||
      !session.distractingDomains.some(rule => domain === rule || domain.endsWith(`.${rule}`))) return false;
  entries[String(tabId)] = { url, strictMode: Boolean(session.strictMode), createdAt: Date.now() };
  await browser.storage.local.set({ [PENDING_KEY]: entries });
  await browser.tabs.update(tabId, { url: browser.runtime.getURL(`warning.html?tabId=${encodeURIComponent(tabId)}`) });
  return true;
}

async function startFor(tab) {
  const nextDomain = eligible(tab) ? domainFor(tab.url) : "";
  const nextTitle = tab && typeof tab.title === "string" ? tab.title.slice(0, 160) : "";
  if (active && active.domain === nextDomain && active.title === nextTitle) return;
  await closeActive();
  if (!nextDomain) return;
  const cfg = await getSettings();
  active = {
    startedAt: Date.now(),
    lastFlushedAt: Date.now(),
    domain: nextDomain,
    title: nextTitle,
    category: Core.classify(nextDomain, cfg.rules),
    userIdle
  };
  await browser.storage.local.set({ [ACTIVE_KEY]: active });
}

async function refreshActiveTab(windowId = focusedWindowId) {
  if (windowId === null || windowId === browser.windows.WINDOW_ID_NONE) return closeActive();
  const [tab] = await browser.tabs.query({ active: true, windowId });
  await startFor(tab);
}

async function finishFocusSession(status, completedAt = Date.now()) {
  const cfg = await getSettings();
  const session = cfg.focusSession;
  if (!session || session.status !== "running") return;
  const elapsedMs = Core.sessionElapsed(session, completedAt);
  const completed = elapsedMs >= session.durationMs;
  session.status = completed ? "completed" : status;
  session.completedAt = completedAt;
  session.elapsedMs = elapsedMs;
  session.completed = completed;
  cfg.focusSessions = [...cfg.focusSessions.filter(item => item.id !== session.id), session];
  cfg.focusSession = null;
  await browser.storage.local.set({ [SETTINGS_KEY]: cfg });
}

async function tick() {
  await flushActive();
  const cfg = await getSettings();
  const session = cfg.focusSession;
  if (session && session.status === "running" && !session.pausedAt &&
      Date.now() >= session.startedAt + session.durationMs + (session.pausedDurationMs || 0)) {
    await finishFocusSession("completed");
  }
}

browser.tabs.onActivated.addListener(info => enqueue(async () => {
  const [tab] = await browser.tabs.query({ active: true, windowId: info.windowId });
  if (info.windowId === focusedWindowId && tab && await interceptDistraction(tab.id, tab.url)) {
    await closeActive();
    return;
  }
  await refreshActiveTab(info.windowId);
}));
browser.tabs.onUpdated.addListener((tabId, changes, tab) => enqueue(async () => {
  if (changes.url && tab.active && tab.windowId === focusedWindowId && await interceptDistraction(tabId, changes.url)) {
    await closeActive();
    return;
  }
  if (tab.active && tab.windowId === focusedWindowId && (changes.url || changes.title || changes.status === "complete")) {
    await refreshActiveTab(tab.windowId);
  }
}));
browser.tabs.onRemoved.addListener(tabId => enqueue(async () => {
  const pending = await browser.storage.local.get(PENDING_KEY);
  const entries = pending[PENDING_KEY] || {};
  if (entries[String(tabId)]) {
    delete entries[String(tabId)];
    await browser.storage.local.set({ [PENDING_KEY]: entries });
  }
  if (active) await refreshActiveTab();
}));
browser.windows.onFocusChanged.addListener(windowId => enqueue(async () => {
  await closeActive();
  focusedWindowId = windowId === browser.windows.WINDOW_ID_NONE ? null : windowId;
  if (focusedWindowId !== null) {
    const [tab] = await browser.tabs.query({ active: true, windowId: focusedWindowId });
    if (tab && await interceptDistraction(tab.id, tab.url)) return;
    await refreshActiveTab(focusedWindowId);
  }
}));
browser.idle.setDetectionInterval(IDLE_SECONDS);
browser.idle.onStateChanged.addListener(state => enqueue(async () => {
  const nextIdle = state !== "active";
  if (userIdle !== nextIdle) {
    await flushActive();
    userIdle = nextIdle;
    if (active) {
      active.userIdle = userIdle;
      active.lastFlushedAt = Date.now();
      await browser.storage.local.set({ [ACTIVE_KEY]: active });
    }
  }
}));
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === FLUSH_ALARM) enqueue(tick);
});
browser.runtime.onStartup.addListener(() => enqueue(async () => {
  active = null;
  await browser.storage.local.remove(ACTIVE_KEY);
  await browser.storage.local.set({ [PENDING_KEY]: {} });
  await browser.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_MINUTES });
  userIdle = (await browser.idle.queryState(IDLE_SECONDS)) !== "active";
  const win = await browser.windows.getLastFocused();
  focusedWindowId = win && win.focused ? win.id : null;
  if (focusedWindowId !== null) {
    const [tab] = await browser.tabs.query({ active: true, windowId: focusedWindowId });
    if (tab && await interceptDistraction(tab.id, tab.url)) return;
  }
  await refreshActiveTab();
}));
browser.runtime.onInstalled.addListener(() => enqueue(async () => {
  const cfg = await getSettings();
  await browser.storage.local.set({ [SETTINGS_KEY]: cfg });
  await browser.storage.local.set({ [PENDING_KEY]: {} });
  await browser.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_MINUTES });
  userIdle = (await browser.idle.queryState(IDLE_SECONDS)) !== "active";
  const win = await browser.windows.getLastFocused();
  focusedWindowId = win && win.focused ? win.id : null;
  if (focusedWindowId !== null) {
    const [tab] = await browser.tabs.query({ active: true, windowId: focusedWindowId });
    if (tab && await interceptDistraction(tab.id, tab.url)) return;
  }
  await refreshActiveTab();
}));

browser.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => enqueue(async () => {
  if (!notificationId.startsWith("limit:")) return;
  const cfg = await getSettings();
  const domain = notificationId.slice(notificationId.indexOf(":", 6) + 1);
  if (buttonIndex === 0) cfg.limits[domain] = Math.min(1440, Number(cfg.limits[domain] || 0) + 15);
  if (buttonIndex === 1) delete cfg.limits[domain];
  await browser.storage.local.set({ [SETTINGS_KEY]: cfg });
  await browser.notifications.clear(notificationId);
}));

browser.runtime.onMessage.addListener((message, sender) => enqueue(async () => {
  if (message.type === "getLog") {
    const stored = await browser.storage.local.get([LOG_KEY, SETTINGS_KEY]);
    const log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
    const cfg = normalizeSettings(stored[SETTINGS_KEY] || {});
    const invalidRecords = Array.isArray(stored[LOG_KEY]) ? log.filter(item => !Core.isValidItem(item)).length : stored[LOG_KEY] === undefined ? 0 : 1;
    const now = Date.now();
    const current = active && now > active.lastFlushedAt ? [{
      ...active,
      startedAt: active.lastFlushedAt,
      endedAt: now,
      durationMs: now - active.lastFlushedAt
    }] : [];
    return { log: log.concat(current), settings: cfg, sessionStartedAt: getSessionStart(), invalidRecords };
  }
  if (message.type === "getCurrentSite") {
    const tab = sender.tab || (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    const domain = domainFor(tab && tab.url);
    if (!domain) return { error: "This page cannot be tracked." };
    const cfg = await getSettings();
    const stored = await browser.storage.local.get(LOG_KEY);
    const today = Core.aggregate(stored[LOG_KEY], Core.localDayStart(), Date.now() + 1, cfg.rules);
    const activeTime = active && active.domain === domain
      ? Math.max(0, Date.now() - Math.max(active.lastFlushedAt, Core.localDayStart()))
      : 0;
    return {
      domain,
      category: Core.classify(domain, cfg.rules),
      limitMinutes: cfg.limits[domain] || 0,
      spentMs: (today.domains[domain] || 0) + activeTime
    };
  }
  if (message.type === "saveSettings") {
    const cfg = await getSettings();
    cfg.theme = ["system", "dark", "light"].includes(message.settings.theme) ? message.settings.theme : cfg.theme;
    cfg.rules = Core.normalizeRules(message.settings.rules || cfg.rules);
    cfg.limits = { ...cfg.limits };
    for (const [domain, minutes] of Object.entries(message.settings.limits || {})) {
      const normalized = Core.normalizeDomain(domain);
      const value = Number(minutes);
      if (!normalized) continue;
      if (value > 0 && Number.isFinite(value)) cfg.limits[normalized] = Math.min(1440, Math.floor(value));
      else delete cfg.limits[normalized];
    }
    if (message.settings.focusGoalMinutes !== undefined) {
      const goal = Number(message.settings.focusGoalMinutes);
      if (!Number.isFinite(goal) || goal < 1 || goal > 1440) return { error: "Choose a daily goal between 1 and 1440 minutes." };
      cfg.focusGoalMinutes = Math.floor(goal);
    }
    await browser.storage.local.set({ [SETTINGS_KEY]: cfg });
    if (active) {
      active.category = Core.classify(active.domain, cfg.rules);
      await browser.storage.local.set({ [ACTIVE_KEY]: active });
    }
    return { saved: true };
  }
  if (message.type === "setCurrentCategory") {
    const tab = sender.tab || (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    const domain = domainFor(tab && tab.url);
    if (!domain || !Core.categories.includes(message.category)) return { error: "This page cannot be classified." };
    const cfg = await getSettings();
    for (const category of Core.categories) cfg.rules[category] = cfg.rules[category].filter(rule => rule !== domain);
    cfg.rules[message.category].push(domain);
    await browser.storage.local.set({ [SETTINGS_KEY]: cfg });
    if (active && active.domain === domain) {
      active.category = message.category;
      await browser.storage.local.set({ [ACTIVE_KEY]: active });
    }
    return { domain, category: message.category };
  }
  if (message.type === "setCurrentSiteLimit") {
    const tab = sender.tab || (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    const domain = domainFor(tab && tab.url);
    const minutes = Number(message.minutes);
    if (!domain || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return { error: "Choose a valid daily limit." };
    const cfg = await getSettings();
    if (minutes > 0) cfg.limits[domain] = Math.floor(minutes);
    else delete cfg.limits[domain];
    await browser.storage.local.set({ [SETTINGS_KEY]: cfg });
    return { domain, limitMinutes: cfg.limits[domain] || 0 };
  }
  if (message.type === "startFocusSession") {
    const cfg = await getSettings();
    if (cfg.focusSession && cfg.focusSession.status === "running") return { error: "End your current focus session before starting another." };
    const durationMinutes = Number(message.durationMinutes);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 480) return { error: "Choose a session duration from 1 to 480 minutes." };
    const normalizeList = value => [...new Set((Array.isArray(value) ? value : []).map(Core.normalizeDomain).filter(Boolean))];
    const session = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      status: "running",
      startedAt: Date.now(),
      durationMs: durationMinutes * 60000,
      pausedDurationMs: 0,
      pausedAt: null,
      productiveDomains: normalizeList(message.productiveDomains),
      distractingDomains: normalizeList(message.distractingDomains),
      restrictions: Boolean(message.restrictions),
      strictMode: Boolean(message.strictMode)
    };
    cfg.focusSession = session;
    await browser.storage.local.set({ [SETTINGS_KEY]: cfg });
    return { session };
  }
  if (message.type === "toggleFocusPause") {
    const cfg = await getSettings(), session = cfg.focusSession;
    if (!session || session.status !== "running") return { error: "There is no active focus session." };
    if (session.pausedAt) {
      session.pausedDurationMs = (session.pausedDurationMs || 0) + Date.now() - session.pausedAt;
      session.pausedAt = null;
    } else {
      session.pausedAt = Date.now();
    }
    await browser.storage.local.set({ [SETTINGS_KEY]: cfg });
    return { session };
  }
  if (message.type === "endFocusSession") {
    await finishFocusSession("ended");
    return { ended: true };
  }
  if (message.type === "resolveFocusNavigation") {
    const tabId = Number(message.tabId);
    const stored = await browser.storage.local.get(PENDING_KEY);
    const entries = stored[PENDING_KEY] || {};
    const pending = entries[String(tabId)];
    if (!pending) return { error: "This focus warning has expired." };
    entries[String(tabId)] = { ...pending, approved: true };
    await browser.storage.local.set({ [PENDING_KEY]: entries });
    await browser.tabs.update(tabId, { url: pending.url });
    return { opened: true };
  }
  if (message.type === "dismissFocusNavigation") {
    const tabId = Number(message.tabId);
    const stored = await browser.storage.local.get(PENDING_KEY);
    const entries = stored[PENDING_KEY] || {};
    entries[String(tabId)] = { dismissBack: true };
    await browser.storage.local.set({ [PENDING_KEY]: entries });
    return { dismissed: true };
  }
  if (message.type === "clearLog") {
    const stored = await browser.storage.local.get(SETTINGS_KEY);
    const cfg = normalizeSettings(stored[SETTINGS_KEY] || {});
    cfg.focusSessions = [];
    await browser.storage.local.set({ [LOG_KEY]: [], [SETTINGS_KEY]: cfg });
    return { cleared: true };
  }
  return undefined;
}));

let sessionStartedAt;
function getSessionStart() {
  if (!sessionStartedAt) sessionStartedAt = Date.now();
  return sessionStartedAt;
}

browser.runtime.onStartup.addListener(() => { sessionStartedAt = Date.now(); });
browser.runtime.onInstalled.addListener(() => { sessionStartedAt = Date.now(); });

browser.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_MINUTES });
browser.windows.getLastFocused().then(win => {
  focusedWindowId = win && win.focused ? win.id : null;
  return refreshActiveTab();
}).catch(error => console.error("Could not initialize Focus Wellbeing tracking:", error));
