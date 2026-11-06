"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../focus-ledger-core.js");

test("normalizes website URLs and excludes unsupported or malformed URLs", () => {
  assert.equal(Core.normalizeDomain("https://WWW.YouTube.com/watch?v=secret"), "youtube.com");
  assert.equal(Core.normalizeDomain("sub.example.com:8443/path"), "sub.example.com");
  assert.equal(Core.normalizeDomain("about:config"), "");
  assert.equal(Core.normalizeDomain("not a domain"), "");
  assert.equal(Core.normalizeDomain(""), "");
});

test("classification is normalized, mutually exclusive, and prefers the closest subdomain rule", () => {
  const rules = Core.normalizeRules({
    productive: ["https://www.example.com/", "github.com"],
    distracting: ["example.com", "youtube.com", "youtube.com"],
    neutral: ["wikipedia.org"]
  });
  assert.equal(rules.productive.filter(domain => domain === "example.com").length, 1);
  assert.equal(rules.distracting.includes("example.com"), false);
  assert.equal(Core.classify("docs.example.com", rules), "productive");
  assert.equal(Core.classify("m.youtube.com", rules), "distracting");
  assert.equal(Core.classify("other.test", rules), "neutral");
});

test("aggregates valid records consistently and skips invalid domains", () => {
  const start = new Date(2026, 0, 5, 10).getTime();
  const report = Core.aggregate([
    { domain: "youtube.com", category: "productive", startedAt: start, endedAt: start + 120000, durationMs: 120000 },
    { domain: "example.com", startedAt: start + 120000, endedAt: start + 180000, durationMs: 60000 },
    { domain: "chrome://settings", startedAt: start, endedAt: start + 90000, durationMs: 90000 }
  ], start, start + 300000, { distracting: ["youtube.com"] });
  assert.equal(report.total, 180000);
  assert.equal(report.totals.distracting, 120000);
  assert.equal(report.totals.neutral, 60000);
  assert.equal(report.domains["youtube.com"], 120000);
  assert.equal(report.hourly[10].total, 180000);
});

test("clips entries to custom range boundaries rather than filtering only by end time", () => {
  const start = Date.UTC(2026, 1, 1);
  const report = Core.aggregate([{ domain: "example.com", startedAt: start, endedAt: start + 3600000, durationMs: 3600000 }], start + 600000, start + 1800000);
  assert.equal(report.total, 1200000);
});

test("overlapping or duplicate historical records never double-count time", () => {
  const start = Date.UTC(2026, 1, 1);
  const report = Core.aggregate([
    { domain: "youtube.com", startedAt: start, endedAt: start + 60000, durationMs: 60000 },
    { domain: "youtube.com", startedAt: start, endedAt: start + 60000, durationMs: 60000 },
    { domain: "github.com", startedAt: start + 30000, endedAt: start + 90000, durationMs: 60000 }
  ], start, start + 120000, { distracting: ["youtube.com"], productive: ["github.com"] });
  assert.equal(report.total, 90000);
  assert.equal(report.domains["youtube.com"], 60000);
  assert.equal(report.domains["github.com"], 30000);
  assert.equal(report.totals.productive + report.totals.distracting + report.totals.neutral, report.total);
});

test("splits hourly data at hour boundaries", () => {
  const start = new Date(2026, 0, 5, 9, 30).getTime();
  const report = Core.aggregate([{ domain: "example.com", startedAt: start, endedAt: start + 3600000, durationMs: 3600000 }], start, start + 3600000);
  assert.equal(report.hourly[9].total, 1800000);
  assert.equal(report.hourly[10].total, 1800000);
});

test("local day helpers respect calendar boundaries and Monday week starts", () => {
  const value = new Date(2026, 0, 4, 23, 45).getTime();
  assert.equal(Core.localDayKey(value), "2026-01-04");
  assert.equal(Core.localDayStart(value), new Date(2026, 0, 4).getTime());
  assert.equal(Core.nextLocalDayStart(value), new Date(2026, 0, 5).getTime());
  assert.equal(Core.mondayStart(value), new Date(2025, 11, 29).getTime());
});

test("hourly aggregation remains complete across daylight-saving transitions", () => {
  for (const date of [new Date(2026, 2, 8, 1, 30), new Date(2026, 10, 1, 1, 30)]) {
    const start = date.getTime();
    const report = Core.aggregate([
      { domain: "example.com", startedAt: start, endedAt: start + 3600000, durationMs: 3600000 }
    ], start, start + 3600000);
    assert.equal(report.total, 3600000);
    assert.equal(report.hourly.reduce((sum, hour) => sum + hour.total, 0), report.total);
  }
});

test("format and percentage helpers handle empty and fractional totals", () => {
  assert.equal(Core.formatDuration(0), "0m");
  assert.equal(Core.formatDuration(5400000), "1h 30m");
  assert.equal(Core.percent(2, 3), 66.7);
  assert.equal(Core.percent(1, 0), 0);
});

test("focus elapsed time pauses without advancing", () => {
  const session = { startedAt: 1000, pausedAt: 5000, pausedDurationMs: 1000 };
  assert.equal(Core.sessionElapsed(session, 10000), 3000);
});

test("daily goal progress clamps overachievement and reports remaining time", () => {
  const progress = Core.goalProgress(90 * 60000, 120);
  assert.deepEqual(progress, {
    goalMs: 120 * 60000,
    completedMs: 90 * 60000,
    remainingMs: 30 * 60000,
    percent: 75,
    complete: false
  });
  const complete = Core.goalProgress(150 * 60000, 120);
  assert.equal(complete.remainingMs, 0);
  assert.equal(complete.percent, 100);
  assert.equal(complete.complete, true);
});

test("focus session progress respects paused and completed durations", () => {
  const paused = Core.sessionProgress({ startedAt: 1000, pausedAt: 5000, pausedDurationMs: 1000, durationMs: 8000 }, 20000);
  assert.equal(paused.elapsedMs, 3000);
  assert.equal(paused.remainingMs, 5000);
  assert.equal(paused.percent, 37.5);
  const ended = Core.sessionProgress({ startedAt: 1000, durationMs: 8000 }, 20000);
  assert.equal(ended.elapsedMs, 19000);
  assert.equal(ended.remainingMs, 0);
  assert.equal(ended.percent, 100);
});
