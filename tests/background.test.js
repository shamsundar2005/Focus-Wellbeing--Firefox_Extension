"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const Core = require("../focus-ledger-core.js");

class Event {
  constructor() { this.listeners = []; }
  addListener(listener) { this.listeners.push(listener); }
  fire(...args) { for (const listener of this.listeners) listener(...args); }
}

function createBrowser(storage, options = {}) {
  const events = {};
  const event = name => events[name] || (events[name] = new Event());
  const tabs = options.tabs || [{ id: 1, windowId: 1, active: true, url: "https://youtube.com/watch", title: "Video" }];
  const focusedWindow = options.focusedWindow || { id: 1, focused: true };
  const notifications = [];
  const errors = [];
  const browser = {
    storage: {
      local: {
        async get(keys) {
          if (keys === undefined) return structuredClone(storage);
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter(key => key in storage).map(key => [key, structuredClone(storage[key])]));
        },
        async set(values) { Object.assign(storage, structuredClone(values)); },
        async remove(key) { delete storage[key]; }
      },
      onChanged: event("storage.onChanged")
    },
    tabs: {
      onActivated: event("tabs.onActivated"),
      onUpdated: event("tabs.onUpdated"),
      onRemoved: event("tabs.onRemoved"),
      async query(query = {}) {
        let found = tabs.filter(tab => tab.active);
        if (query.windowId !== undefined) found = found.filter(tab => tab.windowId === query.windowId);
        else found = found.filter(tab => tab.windowId === focusedWindow.id);
        return structuredClone(found);
      },
      async update(tabId, change) {
        const tab = tabs.find(item => item.id === tabId);
        if (!tab) throw new Error("Missing tab");
        tab.url = change.url;
        this.onUpdated.fire(tabId, { url: change.url }, structuredClone(tab));
        return structuredClone(tab);
      },
      async getCurrent() { return { id: options.currentTabId || 1 }; },
      async remove(tabId) { this.onRemoved.fire(tabId); }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: event("windows.onFocusChanged"),
      async getLastFocused() { return structuredClone(focusedWindow); }
    },
    idle: {
      setDetectionInterval(seconds) { browser.idleDetectionInterval = seconds; },
      async queryState() { return browser.reportedIdleState || "active"; },
      onStateChanged: event("idle.onStateChanged")
    },
    alarms: {
      onAlarm: event("alarms.onAlarm"),
      async create(name, config) { browser.lastAlarm = { name, config }; }
    },
    notifications: {
      onButtonClicked: event("notifications.onButtonClicked"),
      async create(id, details) { notifications.push({ id, details }); return id; },
      async clear() {}
    },
    runtime: {
      onMessage: event("runtime.onMessage"),
      onStartup: event("runtime.onStartup"),
      onInstalled: event("runtime.onInstalled"),
      getURL(pathname) { return `moz-extension://focus-ledger/${pathname}`; }
    }
  };
  browser.notificationsCreated = notifications;
  browser.errors = errors;
  return browser;
}

function loadBackground({ now, storage = {}, tabs, focusedWindow } = {}) {
  let time = now === undefined ? Date.now() : now;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const browser = createBrowser(storage, { tabs, focusedWindow });
  const errors = browser.errors;
  const context = {
    browser,
    FocusLedgerCore: Core,
    Date: ClockDate,
    URL,
    Math,
    console: { error(...args) { errors.push(args); } },
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), context);
  const settle = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await Promise.resolve();
  };
  const request = async (message, sender = {}) => {
    const handler = browser.runtime.onMessage.listeners[0];
    return handler(message, sender);
  };
  const syncQueue = async () => {
    await request({ type: "getLog" });
    await settle();
  };
  return {
    browser,
    storage,
    errors,
    request,
    syncQueue,
    advance(milliseconds) { time += milliseconds; },
    now() { return time; },
    async alarm() { browser.alarms.onAlarm.fire({ name: "focus-ledger-flush" }); await syncQueue(); },
    async close() {}
  };
}

test("tracks only the focused window and switches when focus changes", async () => {
  const tracker = loadBackground({
    tabs: [
      { id: 1, windowId: 1, active: true, url: "https://youtube.com/watch", title: "Video" },
      { id: 2, windowId: 2, active: true, url: "https://docs.google.com/document", title: "Document" }
    ]
  });
  await tracker.syncQueue();
  tracker.advance(60000);
  tracker.browser.windows.onFocusChanged.fire(2);
  await tracker.syncQueue();
  assert.equal(tracker.storage.activityLog.length, 1);
  assert.equal(tracker.storage.activityLog[0].domain, "youtube.com");
  assert.equal(tracker.storage.activityLog[0].durationMs, 60000);
  for (let index = 0; index < 4; index += 1) {
    tracker.advance(30000);
    await tracker.alarm();
  }
  tracker.browser.windows.onFocusChanged.fire(-1);
  await tracker.syncQueue();
  assert.equal(tracker.storage.activityLog.length, 2);
  assert.equal(tracker.storage.activityLog[1].domain, "docs.google.com");
  assert.equal(tracker.storage.activityLog[1].durationMs, 120000);
});

test("idle state is recorded separately without stopping foreground-page time", async () => {
  const tracker = loadBackground();
  await tracker.syncQueue();
  tracker.advance(60000);
  tracker.browser.idle.onStateChanged.fire("idle");
  await tracker.syncQueue();
  for (let index = 0; index < 4; index += 1) {
    tracker.advance(30000);
    await tracker.alarm();
  }
  const report = Core.aggregate(tracker.storage.activityLog, tracker.storage.activityLog[0].startedAt, tracker.now() + 1);
  assert.equal(report.total, 180000);
  assert.equal(report.activeBrowserMs, 60000);
  assert.equal(report.userIdleMs, 120000);
  tracker.browser.idle.onStateChanged.fire("active");
  await tracker.syncQueue();
  tracker.advance(30000);
  await tracker.alarm();
  assert.equal(tracker.storage.activityLog.at(-1).userIdle, false);
});

test("checkpoint alarms persist time, and restarting does not count the closed-browser gap", async () => {
  const first = loadBackground();
  await first.syncQueue();
  first.advance(30000);
  await first.alarm();
  first.advance(30000);
  await first.alarm();
  assert.equal(first.storage.activityLog.reduce((sum, item) => sum + item.durationMs, 0), 60000);
  first.advance(60 * 60 * 1000);
  const restarted = loadBackground({ now: first.now(), storage: first.storage });
  restarted.browser.runtime.onStartup.fire();
  await restarted.syncQueue();
  restarted.advance(20000);
  await restarted.alarm();
  assert.equal(restarted.storage.activityLog.reduce((sum, item) => sum + item.durationMs, 0), 80000);
});

test("sleep or a delayed alarm never counts an unobserved multi-minute gap", async () => {
  const tracker = loadBackground();
  await tracker.syncQueue();
  tracker.advance(2 * 60 * 60 * 1000);
  tracker.browser.reportedIdleState = "idle";
  await tracker.alarm();
  assert.equal(tracker.storage.activityLog.reduce((sum, item) => sum + item.durationMs, 0), 30000);
  assert.equal(tracker.storage.activeCheckpoint.lastFlushedAt, tracker.now());
  assert.equal(tracker.storage.activeCheckpoint.userIdle, true);
});

test("storage write failures reject the request and produce an explicit notification", async () => {
  const tracker = loadBackground();
  await tracker.syncQueue();
  const originalSet = tracker.browser.storage.local.set;
  tracker.browser.storage.local.set = async () => { throw new Error("quota exceeded"); };
  await assert.rejects(tracker.request({ type: "saveSettings", settings: { theme: "light" } }), /quota exceeded/);
  tracker.browser.storage.local.set = originalSet;
  await tracker.syncQueue();
  assert.equal(tracker.browser.notificationsCreated.some(item => item.id === "focus-ledger-error"), true);
  assert.equal(tracker.storage.settings, undefined);
  assert.equal(tracker.errors.some(args => String(args[0]).includes("operation failed")), true);
});

test("activity is split at local midnight and historical records without start time remain readable", async () => {
  const midnight = new Date(2026, 0, 6, 0, 0, 0).getTime();
  const tracker = loadBackground({ now: midnight - 30000 });
  await tracker.syncQueue();
  tracker.advance(60000);
  await tracker.alarm();
  assert.equal(tracker.storage.activityLog.length, 2);
  assert.equal(tracker.storage.activityLog[0].durationMs, 30000);
  assert.equal(tracker.storage.activityLog[1].durationMs, 30000);

  tracker.storage.activityLog = [{ domain: "example.com", endedAt: midnight, durationMs: 120000 }];
  const response = await tracker.request({ type: "getLog" });
  const old = Core.aggregate(response.log, midnight - 120000, midnight + 1, response.settings.rules);
  assert.equal(old.total, 120000);
  assert.equal(response.settings.focusGoalMinutes, 120);
});

test("limit notifications are threshold-deduplicated and retain add-time behavior", async () => {
  const tracker = loadBackground();
  await tracker.syncQueue();
  const response = await tracker.request({
    type: "saveSettings",
    settings: { theme: "system", rules: { productive: [], distracting: ["youtube.com"], neutral: [] }, limits: { "youtube.com": 1 } }
  });
  assert.equal(response.saved, true);
  tracker.advance(30000);
  await tracker.alarm();
  tracker.advance(30000);
  await tracker.alarm();
  tracker.advance(1000);
  await tracker.alarm();
  assert.equal(tracker.browser.notificationsCreated.length, 1);
  tracker.advance(30000);
  await tracker.alarm();
  assert.equal(tracker.browser.notificationsCreated.length, 1);
  tracker.browser.notifications.onButtonClicked.fire(tracker.browser.notificationsCreated[0].id, 0);
  await tracker.syncQueue();
  const settings = await tracker.request({ type: "getLog" });
  assert.equal(settings.settings.limits["youtube.com"], 16);
});

test("focus sessions pause, resume, finish, and permit explicit restriction bypass", async () => {
  const tracker = loadBackground();
  await tracker.syncQueue();
  const response = await tracker.request({
    type: "startFocusSession",
    durationMinutes: 1,
    productiveDomains: ["docs.google.com"],
    distractingDomains: ["youtube.com"],
    restrictions: true,
    strictMode: true
  });
  assert.equal(response.session.status, "running");

  const tab = { id: 1, windowId: 1, active: true, url: "https://docs.google.com", title: "Notes" };
  tracker.browser.tabs.onUpdated.fire(1, { url: "https://m.youtube.com/watch?v=local" }, { ...tab, url: "https://m.youtube.com/watch?v=local" });
  await tracker.syncQueue();
  assert.match(tracker.browser.tabs && tracker.storage.pendingFocusNavigation["1"].url, /youtube\.com/);
  const allowed = await tracker.request({ type: "resolveFocusNavigation", tabId: 1 });
  assert.equal(allowed.opened, true);
  await tracker.syncQueue();
  assert.equal(tracker.storage.pendingFocusNavigation["1"], undefined);

  tracker.advance(10000);
  await tracker.request({ type: "toggleFocusPause" });
  tracker.advance(20000);
  await tracker.request({ type: "toggleFocusPause" });
  tracker.advance(50000);
  await tracker.alarm();
  const state = await tracker.request({ type: "getLog" });
  assert.equal(state.settings.focusSession, null);
  assert.equal(state.settings.focusSessions.at(-1).completed, true);
  assert.equal(state.settings.focusSessions.at(-1).elapsedMs, 60000);
});
