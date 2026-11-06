(function (root) {
  "use strict";

  const categories = ["productive", "distracting", "neutral"];

  function normalizeDomain(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    let url;
    try {
      const input = value.trim();
      url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    } catch (_) {
      return "";
    }
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    if (!host || host.length > 253 || /\s/.test(host)) return "";
    if (!host.split(".").every(label => label.length > 0 && label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) return "";
    return host;
  }

  function normalizeRules(rules = {}) {
    const normalized = { productive: [], distracting: [], neutral: [] };
    const claimed = new Set();
    for (const category of categories) {
      const values = Array.isArray(rules[category]) ? rules[category] : [];
      for (const value of values) {
        const domain = normalizeDomain(value);
        if (domain && !claimed.has(domain)) {
          normalized[category].push(domain);
          claimed.add(domain);
        }
      }
    }
    return normalized;
  }

  function classify(domain, rules = {}) {
    const normalized = normalizeDomain(domain);
    if (!normalized) return "";
    const candidates = [];
    for (const category of categories) {
      for (const rule of (rules[category] || [])) {
        const normalizedRule = normalizeDomain(rule);
        if (normalizedRule && (normalized === normalizedRule || normalized.endsWith(`.${normalizedRule}`))) {
          candidates.push({ category, length: normalizedRule.length });
        }
      }
    }
    candidates.sort((a, b) => b.length - a.length || categories.indexOf(a.category) - categories.indexOf(b.category));
    return candidates.length ? candidates[0].category : "neutral";
  }

  function localDayKey(timestamp) {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function localDateInput(timestamp) {
    return localDayKey(timestamp);
  }

  function localDayStart(timestamp = Date.now()) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function nextLocalDayStart(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 1);
    return date.getTime();
  }

  function mondayStart(timestamp = Date.now()) {
    const date = new Date(localDayStart(timestamp));
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return date.getTime();
  }

  function validItem(item) {
    return item && typeof item === "object" && normalizeDomain(item.domain) && Number.isFinite(Number(item.endedAt)) &&
      Number(item.endedAt) > 0 && Number.isFinite(Number(item.durationMs)) && Number(item.durationMs) > 0;
  }

  function itemInterval(item) {
    const end = Number(item.endedAt);
    const start = typeof item.startedAt === "number" && Number.isFinite(item.startedAt) ? item.startedAt : end - Number(item.durationMs);
    return { start, end };
  }

  function aggregate(items, rangeStart, rangeEnd, rules = {}) {
    const totals = { productive: 0, distracting: 0, neutral: 0 };
    const domains = {};
    const hourly = Array.from({ length: 24 }, () => ({ productive: 0, distracting: 0, neutral: 0, total: 0 }));
    let total = 0;
    let userIdleMs = 0;
    const ordered = (Array.isArray(items) ? items : [])
      .filter(validItem)
      .map(item => ({ item, ...itemInterval(item) }))
      .filter(entry => Number.isFinite(entry.start) && entry.end > entry.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    let lastEnd = rangeStart;
    for (const entry of ordered) {
      const { item, start, end } = entry;
      if (!Number.isFinite(start) || end <= start) continue;
      const clippedStart = Math.max(start, rangeStart, lastEnd);
      const clippedEnd = Math.min(end, rangeEnd);
      if (clippedEnd <= clippedStart) continue;
      const domain = normalizeDomain(item.domain);
      const category = classify(domain, rules);
      let cursor = clippedStart;
      while (cursor < clippedEnd) {
        const date = new Date(cursor);
        const hourEnd = new Date(cursor);
        hourEnd.setMinutes(60, 0, 0);
        const segmentEnd = Math.min(clippedEnd, hourEnd.getTime());
        const amount = segmentEnd - cursor;
        totals[category] += amount;
        domains[domain] = (domains[domain] || 0) + amount;
        hourly[date.getHours()][category] += amount;
        hourly[date.getHours()].total += amount;
        total += amount;
        if (item.userIdle) userIdleMs += amount;
        cursor = segmentEnd;
      }
      lastEnd = clippedEnd;
    }
    return { totals, domains, hourly, total, userIdleMs, activeBrowserMs: total - userIdleMs };
  }

  function formatDuration(ms) {
    const minutes = Math.floor(Math.max(0, ms) / 60000);
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  }

  function percent(value, total) {
    return total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
  }

  function sessionElapsed(session, now = Date.now()) {
    if (!session || !Number.isFinite(session.startedAt)) return 0;
    const stop = session.pausedAt || now;
    return Math.max(0, stop - session.startedAt - (session.pausedDurationMs || 0));
  }

  function goalProgress(productiveMs, goalMinutes) {
    const goalMs = Math.max(60000, Number(goalMinutes) * 60000);
    const completedMs = Math.max(0, Number(productiveMs) || 0);
    return {
      goalMs,
      completedMs,
      remainingMs: Math.max(0, goalMs - completedMs),
      percent: Math.min(100, percent(completedMs, goalMs)),
      complete: completedMs >= goalMs
    };
  }

  function sessionProgress(session, now = Date.now()) {
    const elapsedMs = sessionElapsed(session, now);
    const durationMs = session && Number.isFinite(session.durationMs) ? session.durationMs : 0;
    return {
      elapsedMs,
      durationMs,
      remainingMs: Math.max(0, durationMs - elapsedMs),
      percent: durationMs > 0 ? Math.min(100, percent(elapsedMs, durationMs)) : 0
    };
  }

  root.FocusLedgerCore = { categories, normalizeDomain, normalizeRules, classify, localDayKey, localDateInput, localDayStart, nextLocalDayStart, mondayStart, aggregate, formatDuration, percent, sessionElapsed, sessionProgress, goalProgress, isValidItem: validItem };
  if (typeof module !== "undefined" && module.exports) module.exports = root.FocusLedgerCore;
})(typeof globalThis !== "undefined" ? globalThis : this);
