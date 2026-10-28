# LimitTrack v1.2.0

A clearer desktop companion for tracking your AI coding accounts and their reset times.

## New and improved

- Add accounts directly inside a tool section, with the tool already selected. Add several accounts in succession without repeating tool selection.
- Configure the floating widget for All tools or one specific tool. The choice is remembered, and its account list, availability count, and next reset stay scoped to that tool.
- Refined typography with locally bundled Inter Variable, clearer headings, larger labels, and stable countdown numerals.
- System light/dark appearance and offline styles, with reduced-motion support.
- Honest availability states: Not checked, Marked available, Waiting, and Expected ready. Recorded reset times are distinguished from estimates.
- Search by tool or account, filter by status, and undo individual limit, confirmation, and reset-time changes.
- Widget navigation opens the relevant account; changes refresh across both windows.
- Main-process reset notifications reconcile after sleep and restart, with persisted delivery records to prevent repeated alerts.
- Validated, conflict-aware saves, atomic local persistence, recovery copies, and backup import previews with a pre-import recovery copy.

## Downloads

- Windows: choose the **Setup** executable for the installer, or the other Windows executable for the portable app.
- macOS: use the `.dmg` image.
- Linux: use the `.AppImage` or `.deb` package.

The application remains local-only and does not connect to provider accounts or measure remaining quota. Newly added accounts start as Not checked. A timer reaching zero means Expected ready; confirm availability in the provider's tool.

Notifications require the app to be running and may be suppressed by operating-system settings. Installers are unsigned; Windows SmartScreen or macOS Gatekeeper may show a warning.
