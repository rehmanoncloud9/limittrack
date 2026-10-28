# LimitTrack product and design plan

Prepared October 27, 2026. Product direction and phased implementation plan.

Implementation update: account creation now lives inside each tool section, with repeated entry and remembered tool selection. The app has a redesigned floating reset overview, account navigation, system light/dark appearance, bundled offline styles, status filters, duplicate-account warnings, and undo for individual limit/status/reset changes. Shared validation and availability rules distinguish unknown, user-confirmed, and expected-ready accounts. The main process merges unrelated record changes, rejects conflicting changes, saves atomically, preserves recovery copies, validates import previews, and schedules reset notifications with resume/startup reconciliation and persisted delivery records. A single-instance guard protects the store from competing app processes.

The widget also supports a persisted All tools / single-tool selection, applied to its account list, availability count, next reset, and overflow count. A removed tool falls back to All tools, while an empty tool shows its own empty state.

The broader roadmap below remains a design target. Multiple limit windows, account label editing, pinning, privacy mode, dedicated Settings, configurable notification controls, and alternative widget sizes are still planned. Verification includes Node tests and disposable browser fixtures; actual native notification delivery and packaged cross-platform behavior require a separate platform check.

## Product direction

**Know which AI coding account to use next, without repeatedly checking every tool.**

LimitTrack should feel like a quiet desktop instrument: useful in a glance, quick to update, and honest about what it knows. Its main value is reducing uncertainty and interruption during development.

Working assumptions: individual developers are the primary audience; local storage remains the default; manual tracking remains supported; this release does not require provider credentials, a cloud service, or a framework rewrite. These are design assumptions, not validated customer research.

The first release should answer three questions:

1. Which accounts have I marked available?
2. Which blocked account is expected to reset next?
3. How quickly can I record a limit or correct its reset time?

## Baseline product: evidence before implementation

Reviewed README.md, package.json, main.js, preload.js, renderer.js, widget.html, and widget.js. This is a source review; visual and platform behavior still require a running-app review.

| Already present | Product implication |
| --- | --- |
| Multiple providers and accounts, custom hour/day cycles | Preserve the flexible foundation. |
| Exact reset editing and relative time presets | Improve discovery and clarity rather than duplicate these features. |
| Search, sorting, bulk limit logging | Retain these capabilities behind a calmer hierarchy. |
| Deletion confirmation and undo | Extend recovery to accidental limit logging and reset edits. |
| JSON import/export | Move backup controls out of About into Settings. |
| Tray tooltip and persistent floating widget position | Develop the desktop companion as the main differentiator. |
| Light/dark widget styles | Bring equivalent appearance control to the main app. |

### Gaps worth fixing before adding breadth

| Finding | Evidence | Consequence and planned response |
| --- | --- | --- |
| Missing reset time means “open” | getStatus in both renderers | A new or unverified account looks ready. Add an explicit Unknown state. |
| Every default provider starts with seven days | DEFAULT_STATE in both renderers | An assumed cycle appears authoritative. Require confirmation and label calculated resets as estimates. |
| One reset timestamp per account | Account schema | Cannot represent session and weekly limits together. Introduce independent limit windows. |
| Main window does not subscribe to storage broadcasts | Main renderer initialization; widget subscribes | Widget edits can leave the main app stale; stale whole-state writes can overwrite changes. Centralize mutations. |
| Notifications run in the main renderer's one-second tick | renderer.js tick | Background throttling, restart, and sleep need explicit handling. Move scheduling to the main process. |
| Storage read errors become an empty store; writes directly replace the file | readStore/writeStore in main.js | Corruption can resemble first launch. Add atomic persistence, recovery, and visible errors. |
| Main styling uses a remote Tailwind runtime | index.html | Offline startup depends on cached styling or network access. Bundle styles locally. |
| Widget shows only three accounts, with available accounts sorted first | visibleAccounts in widget.js | The next reset can disappear behind available accounts. Reserve space for a next-reset summary. |
| Widget action nodes are recreated every second | updateTick in widget.js | Keyboard focus can disappear. Retain buttons and update only changing text. |
| “Last used” displays lastHitAt | Main account row | A limit event is misrepresented as usage. Rename to “Limit logged.” |
| Fixed 24-hour “soon” threshold | getStatus in both renderers | Nearly every short cooldown is “soon.” Use configurable or cycle-relative urgency. |

## Experience architecture

Keep navigation small: **Overview**, **Accounts**, and **Settings**. Put recent activity inside account details initially; it does not need a separate destination.

### Overview

- Lead with a useful sentence: “2 accounts marked available” or “Next estimated reset in 42 min.”
- Show a preferred available account within the selected tool, with a visible reason such as “Pinned.” If none is available, show the earliest expected reset for that tool.
- Do not imply that different tools or plans are interchangeable. Users choose the tool context.
- Follow with a short upcoming-reset list, then account groups by tool.
- Replace the prominent decorative wall clock with relevant reset information.
- Offer All / Available / Waiting / Unknown filters. Search should match tool, account label, and email.
- Give each row one primary action; put edit, archive, and delete in a clearly labeled menu.

### Accounts and details

- Support a friendly account name, email, provider, optional plan label, and pinning.
- Provide Add account inside every tool section, with tool selection omitted in this context and email focused. Offer Add & add another for repeated entry; preserve the general entry point and its last selected tool.
- Allow editing existing accounts; warn about duplicates within the same provider.
- Show each limit window, reset rule, time source, last confirmation, and recent changes.
- Offer “Log limit,” “Set reset time,” and “Mark available.” Log limit should identify the affected window when several exist.
- Keep exact timestamp and timezone available alongside the relative countdown.
- Archive infrequently used accounts without deleting history.

### First run

1. Choose a tool or create a custom tool.
2. Add an account label and optional email; an identifier need not be an email address.
3. Choose “Available,” “Waiting until…,” or “I’m not sure.”
4. If using a calculated reset, confirm the duration and explain the assumption in plain language.
5. Offer a widget preview and an optional test notification after the first account is saved.

Do not force notification permission or startup settings before users have seen value.

## Premium widget specification

Interpret Apple-inspired as clear hierarchy, restrained materials, proportion, and focused interactions. Apple's widget guidance emphasizes essential, glanceable information, purposeful sizes, and opening the relevant detail: https://developer.apple.com/design/human-interface-guidelines/widgets

These are proposed Electron floating-window layouts, not native WidgetKit widgets. Preserve platform conventions on Windows, macOS, and Linux.

### Ship first: Compact

Target approximately 320 × 200 logical pixels, with bounded content-based height. Final dimensions should follow layout testing.

```text
LimitTrack                      More

2 marked available
Codex · Personal                 View

NEXT ESTIMATED RESET
42 min
Claude · Work              Today 14:30
```

Example data only. Show the tool filter or selected context when applicable.

- The headline expresses availability; the large numeral expresses the next reset.
- If no account is available, lead with the next reset. If all are available, show a calm completion state without an empty countdown.
- When all states are unknown, say “Check account status” and offer setup.
- A countdown reaching zero becomes “Expected ready”; confirmation remains a separate action.
- Clicking an account opens its details, with the correct limit window selected.
- Put Hide, Appearance, Privacy, and Pin on top in a menu; expose equivalent keyboard access.
- Keep content stable while hovered, keyboard-focused, or interacting. Do not reorder under the pointer.
- Use “View” as the safe default action; enable quick limit logging with undo when desired.

### Later: two purposeful alternatives

| Layout | Purpose | Information |
| --- | --- | --- |
| Mini, approximately 220 × 110 | Follow one pinned account | Tool, account label, status or countdown; one detail target. |
| Expanded, approximately 360 × 320 | Compare several accounts | Availability summary, next reset, up to four selected rows; overflow opens the main app. |

Use one selected layout at first. Multiple simultaneous widgets are deferred until the single-widget experience is proven.

### Visual language

- Warm neutral canvas, near-white light surfaces, charcoal dark surfaces, and one blue interaction accent.
- Green indicates user-confirmed availability; amber indicates an approaching reset; neutral tones indicate waiting or unknown states. Always pair color with text or a symbol.
- Start with a 4/8/12/16/24 spacing scale, 20–24 px widget corners, and 16 px internal padding.
- Use locally bundled Inter Variable across the app and widget, with Apple system and Segoe UI fallbacks. Share the family and rendering rules through typography.css; use a 13 px caption floor in the main app, 14–18 px account/tool headings, a 32 px app title, and a 40 px widget countdown. Use tabular numerals without monospace status text.
- Use 40 px widget countdown numerals with tabular figures, 14 px account names, and readable secondary text around 13 px. Keep small uppercase section labels restrained at 11 px.
- Use a thin boundary and one soft shadow. Keep translucency subtle and provide an opaque option; actual desktop blur requires platform verification.
- Use consistent line icons and stable provider colors. Keep branding secondary to status.
- Motion should explain a change: short fades around 150–220 ms, no perpetual glow or decorative movement. Respect reduced motion.
- Provide System / Light / Dark appearance, reduced transparency, keyboard focus, and readable contrast. Test text at 4.5:1 and essential graphical controls at 3:1.
- Design pointer controls at least 32 px where practical; do not depend on tiny hover-only actions.
- Add a privacy mode that replaces emails with user-defined labels, including in notifications and tray text.

## Necessary features and priorities

### P0 — Trust and daily usability

1. **Honest status model:** Unknown, Marked available, Waiting, and Expected ready; source and timestamp visible in details.
2. **Main-process ownership of state:** validated commands, serialized changes, atomic writes, recoverable backups, and subscriptions in both windows.
3. **Dependable notifications:** one scheduler, persisted delivery records, resume reconciliation, and a grouped summary for resets missed while closed.
4. **Compact widget redesign:** next reset always discoverable, persistent controls, account-specific navigation, light/dark, and privacy.
5. **Useful account editing:** label, provider, cycle, pin, duplicate warning, and undo for accidental limit actions.
6. **Offline appearance:** bundled CSS, consistent design tokens, and surfaced save errors.

P0 is complete when existing tracking remains usable, the widget and main window agree, and the interface never presents an estimate as provider-confirmed fact.

### P1 — Accurate reset models and personalization

1. Multiple limit windows per account, such as session and weekly. An account is waiting while any enabled blocking window is active; its expected availability is the latest blocking reset. Unknown blocking windows keep overall availability uncertain.
2. Reset rules: manual timestamp, elapsed duration, and fixed weekly schedule with an explicit timezone. Add calendar-month rules only with defined month-end behavior.
3. System / Light / Dark, widget size, provider filter, pinning, startup preference, and always-on-top control in Settings.
4. Notification controls: per account/window, optional reminder before reset, quiet hours, test notification, and privacy-safe content.
5. Versioned backup format, validation, import preview, merge/replace choice, and automatic pre-import backup.
6. Recent activity: show limit events, corrections, confirmations, and undo outcomes. Describe it as recorded activity, not measured usage.

Do not hard-code current provider limits as universal facts. Templates need provenance and a reviewed date, and users must be able to override them.

### P2 — Validate demand before building

- Mini and Expanded widget layouts.
- Tray quick actions, opt-in global shortcut, and opening a configured tool through validated destinations.
- Provider integrations only where supported, with explicit consent and secure credential handling.
- Optional local trends based on recorded events, labeled as incomplete manual data.

Defer cloud sync, billing dashboards, team administration, AI recommendations, automatic account switching, and exact remaining-usage percentages. The current data cannot support those claims.

## Engineering plan

Keep Electron and the existing JavaScript foundation. Extract domain logic before considering any UI framework change.

- **Domain:** one implementation of validation, reset rules, status calculation, formatting, and migration shared by both renderers and the main process as appropriate.
- **Persistence:** schemaVersion, validated records, atomic temp-file replacement, recovery copy, and commands that update individual entities instead of replacing stale snapshots.
- **IPC:** a narrow typed-by-contract API for account/window mutations and settings; validate inputs and sender windows in the main process.
- **Notifications:** main-process scheduling and native notifications; reconcile on startup and resume, persist deduplication keys, and honor quiet hours.
- **UI:** locally bundled CSS, shared tokens, stable keyed DOM updates, and explicit route/context handling from widget to account details.
- **Window behavior:** persist size mode and position, clamp after resize and monitor changes, and test display scaling and disconnected monitors.
- **Privacy:** preserve local-only operation; do not collect credentials for manual tracking. Validate external link schemes and keep emails out of diagnostics by default.

Proposed model: Provider → Account → LimitWindow, with ResetRule and ActivityEvent records. Keep settings separate from account data. Keep user confirmation separate from computed availability; a new limit event invalidates older availability confirmation.

Migration must preserve existing IDs, timestamps, providers, accounts, and history. Convert each existing reset into a legacy limit window; mark calculated resets as estimates. Preserve an absent reset as “not recorded” and invite confirmation instead of silently asserting availability. Save a recoverable copy before migration.

## Delivery sequence and review gates

| Stage | Deliverable | Gate before moving on |
| --- | --- | --- |
| 1. Baseline and flow review | Run current app with disposable data; inspect empty, populated, waiting, and reset states | Record actual platform behavior and agree on status vocabulary. |
| 2. Trust foundation | Shared model, persistence, migration, synchronization, scheduler | Timing, recovery, concurrent edits, and resume checks pass. |
| 3. Design prototype | Compact widget plus Overview and account details, using representative fixtures | Test comprehension, hierarchy, keyboard use, and light/dark readability. |
| 4. First polished release | P0 experience on the new foundation | Full existing workflow remains available; visual and functional gates below pass. |
| 5. Reset flexibility | P1 multiple windows, schedules, settings, and import safety | Validate compound availability and timezone behavior. |
| 6. Demand-led expansion | Selected P2 work | Evidence of repeated need from real users. |

No delivery dates are assumed. Estimate stages after confirming the primary supported operating systems and testing the existing app.

## Acceptance and validation

Functional checks:

- A change made in either window appears in the other without lost edits; keyboard focus survives countdown updates.
- Migration and malformed imports cannot silently discard existing records; failed writes are visible and recoverable.
- Test no reset, expired reset, invalid date, zero/negative durations, duplicate accounts, simultaneous edits, and multiple blocking windows.
- Test timezone changes and daylight-saving transitions for scheduled rules; elapsed durations remain elapsed durations.
- Verify resets after sleep, restart, and hidden-window operation; prevent duplicate alerts. No notification is expected while the application is fully quit.
- Verify backup restore, last-event undo, notification privacy, keyboard navigation, and correct detail navigation.

Visual checks:

- Review empty, single-account, many-account, all-waiting, all-available, unknown, error, and long-label fixtures.
- Review light/dark, opaque surfaces, reduced motion, 100/125/150/200% scaling, and multi-monitor placement.
- No clipped countdowns, unreadable secondary text, shifting controls, or unexplained progress rings. Any progress visualization means elapsed cooldown, never remaining provider quota.
- Verify the packaged app starts with the network disconnected and remains fully styled.

Proposed usability targets, to validate rather than claim achieved:

- At least four of five representative users identify a usable account or the next expected reset within five seconds.
- Users record a limit in at most two interactions when the affected window is unambiguous, with immediate undo.
- First-account setup takes under one minute in a moderated trial.
- No lost updates or duplicate notifications in the defined reliability scenarios.

Use moderated sessions and opt-in feedback initially; do not add telemetry by default. The strongest sign of success is that users can trust the widget and return to their work quickly.
