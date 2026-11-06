# Focus Wellbeing

Focus Wellbeing is a local-first Firefox extension for understanding browser time and building a daily focus routine. The dashboard uses a dark, low-contrast visual style and adapts to narrow screens; the toolbar popup stays compact.

## What it does

- Tracks the active tab in the focused browser window, including across multiple windows.
- Tracks normal HTTP(S) pages only; private tabs, browser pages, and extension pages are excluded.
- Continues to count a foreground page while the operating system reports idle, and marks that interval as system-idle time so it can be distinguished from active-computer time.
- Flushes tracking checkpoints every 30 seconds and at tab, window, focus, and idle-state transitions. A gap over 60 seconds is treated as unobserved (for example, sleep); at most one 30-second checkpoint interval is recovered, so a sleep/wake gap is not counted as browsing.
- Keeps historical activity locally without an automatic 14-day deletion window.
- Recalculates reports from one shared aggregation module for the popup and dashboard. Reports include session, local-day, Monday-to-current-week, and inclusive custom date ranges.
- Classifies productive, distracting, and neutral websites. A more-specific subdomain rule takes precedence; duplicate normalized domains are kept in only one category.
- Supports daily website limits, one notification for each reached threshold, and the existing add-15-minutes/remove-limit actions.
- Adds daily productive-time goals, pauseable focus sessions, daily progress and streak summaries, activity timelines, and local-rule insights.
- Optionally shows a focus reminder before a selected distracting website opens. Strict mode adds a five-second pause, but the user can always continue or leave the session.

## Focus and activity calculations

- **Deep work / daily goal progress:** all productive browser time recorded during the selected local calendar day divided by the configurable daily target.
- **Attention quality:** productive browser time divided by total tracked browser time, multiplied by 100.
- **Focus stability:** the percentage of tracked hours that contain at least one minute of productive browsing.
- **Daily streak:** consecutive local calendar days meeting the current daily goal. The current day is included only after it meets the goal; otherwise the streak is counted back from yesterday.
- **Idle time:** browser time in a focused foreground tab while Firefox's idle API reports the user idle. It remains part of website/browser time (for example, passive video watching) and is separately recorded as `userIdle`.

All time boundaries use local calendar days while stored timestamps remain epoch milliseconds. Activity segments are split at local midnight. The extension cannot determine whether a foreground video or reading page is engaging, so it reports foreground browser time and separately annotates operating-system idle time instead of guessing that the user stopped watching or reading.

## Local data and migration

All data stays in `browser.storage.local`; there is no server, analytics endpoint, or AI service.

- `activityLog` keeps domain, shortened title, category-at-capture, timestamps, duration, and an optional `userIdle` flag. URL paths, query strings, and page contents are not stored.
- `settings` keeps normalized category rules, limits, theme, daily focus goal, focus session state/history, and notification-threshold markers.
- `activeCheckpoint` records the current domain timing boundary so periodic writes are recoverable without counting an unobserved browser-closed gap.
- `pendingFocusNavigation` temporarily stores the URL a user chose to open behind a focus reminder. It is local and removed when resolved or when its tab closes.

Older activity entries without a `startedAt` or `userIdle` field remain readable: reports derive the start from the existing end and duration and treat missing idle flags as active-computer time. Existing history is not pruned or rewritten on migration. Clearing history removes activity and completed-session history while retaining settings and any running session.

## Permissions

The extension uses `tabs` to identify the focused active tab and handle focus reminders, `idle` to annotate system-idle intervals, `storage` for local-only state, `notifications` for website limits, and `alarms` to checkpoint active tracking and finish timed focus sessions. No host permissions or network access are added.

## Install for development (Firefox)

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on**.
3. Choose this folder's `manifest.json`.
4. Pin the Focus Wellbeing toolbar button if needed.
5. Open the toolbar popup and choose **Open dashboard**.

Temporary add-ons are removed when Firefox restarts; load the manifest again after a restart. Standard current Chrome releases no longer support this existing Manifest V2 extension architecture. A Chrome port would require a separately scoped Manifest V3 migration; this project intentionally remains on Manifest V2.

## Tests

The shared calculations have dependency-free Node tests:

```powershell
node --test tests\core.test.js tests\background.test.js
```

For manual extension checks, use the checklist in [Manual QA](#manual-qa).

## Manual QA

1. Load the add-on in Firefox and open the dashboard. Verify the empty states contain no fabricated activity.
2. Open a normal site in the focused window for over a minute; verify the popup and dashboard show matching time and a valid domain. Switch tabs and confirm the prior site is committed once.
3. Open a second Firefox window, focus it, and wait. Confirm only its active tab accrues time; refocus the first window and verify tracking switches cleanly.
4. Leave a page open until Firefox reports idle. Confirm the page continues to accrue browser time and the dashboard's deep-work detail annotates the idle portion. Return to activity and confirm subsequent intervals are no longer marked idle. In a test profile, sleep the computer for several minutes; confirm the entire sleep gap is not added as browsing.
5. Change the system date across local midnight in a test profile or use records around midnight; confirm daily and custom-range totals split at local boundaries and weekly totals begin Monday.
6. Add the same normalized domain to two category lists and save. Confirm it appears only once and a specific subdomain rule overrides a parent rule. Reclassify the active site in the popup and verify reports update immediately.
7. Set a short website limit, exceed it, and confirm only one notification appears for that threshold. Use **Add 15 minutes**, exceed the new threshold, then use **Remove limit** and verify the site setting is gone.
8. Set a daily goal and start a short focus session. Pause, resume, and end it; verify elapsed time and completion history. Repeat with reminders enabled and visit a selected distracting domain; use both **Return** and **Continue anyway**. Confirm strict mode delays the latter briefly but never locks the user out.
9. Restart Firefox with a session in progress. Confirm the session state is available again, no closed-browser interval is added as tracked website time, and the user can pause or end the session.
10. Switch dark/light/system themes, resize the dashboard to a narrow viewport, and use the custom range around a local midnight. Verify no horizontal overflow and no empty/null domain rows.
