# LimitTrack v1.5.0

## Desktop widget, redesigned
- Three layouts: **Compact** (one tool), **Standard** (header, tool picker, large count, next reset) and **Multi-tool** (a short list, one count per tool). Choose them in Widgets, or right-click the widget.
- The available-account count is the headline everywhere, with a subtle status dot. The small print uses the app's own wording (Next reset in…, expected ready, Not checked).
- Choose which tool a Compact/Standard widget shows (also from the widget's own picker), or which tools a Multi-tool widget lists and how many rows (1 to 6).
- Translucent glass look in light and dark, following the app theme. Drag the header or icon to move it. New **Keep on top of other windows** option; off by default, the widget still lives on the desktop only.
- The widget is now read-only and shows counts, never email addresses. Per-account "Log limit" and "Confirm" actions stay in the app (click the count to open it).

## Performance (measured under Electron 31, Linux/Xvfb, 30 accounts; see AUDIT_AND_PLAN.md)
- Widget-only (tray + widget): memory 322 MB to 291 MB, CPU 0.43% to 0.13%. Widget renderer 74 MB to 52 MB.
- No per-second timer and no polling in the widget. Main works out per-tool counts once and pushes them only when they change; the page sleeps otherwise. The only timer is one timeout aligned to the next minute change of a visible countdown, cancelled while hidden.
- The widget no longer receives, parses or validates the account list, and no longer loads the write path. It is not sent a notification on every save.
- Unchanged saves (a window "moved" to where it was, a setting set to its current value) no longer rewrite the data file or rotate the backup, and a save serializes the data once instead of twice.
- The tray tooltip is only set when its text changes.
- With Keep on top on Windows, the native desktop-detection helper process is not started.

## Fixes
- A second launch during startup tried to open a window before the app was ready. It is now remembered and honoured once ready.
- The set of live notifications is capped so it cannot grow if the system never reports a toast as dismissed.

# LimitTrack v1.4.0

## New design
- Accounts page rebuilt to match the new reference: sidebar with a live "Next reset" card, available and tracked counters, search and status filter, and one card per tool with status pills and a primary action on every row.
- Windows gets a custom title bar with File, Edit, View, Window and Help menus. macOS and Linux keep the system frame and get the same entries as a normal application menu.
- Light and dark themes restyled; the sidebar collapses to an icon rail in narrow windows. The "..." menus are keyboard accessible (arrows, Home/End, Escape).

## Memory and CPU (aimed at 1 GB RAM laptops)
- Closing the window now frees its renderer process. In the tray, LimitTrack is just the main process. The window is rebuilt when opened.
- Starting at login builds no window at all until you open one.
- The desktop widget is destroyed when switched off (it was only hidden before) and pauses its timer while hidden.
- Reset checks sleep until the next reset instead of polling every 15 seconds; account data is parsed once and reused.
- The page timer runs only while the window is visible and only changes text that actually changed. Search and filters re-render just the list.
- The widget no longer measures layout and sends a message to the main process every second, and its position is written once after a drag instead of continuously.
- Removed the widget's backdrop blur, spell-check, and in release builds DevTools.
- New Settings > Performance > Graphics. Automatic uses software rendering on computers with about 2 GB of RAM or less; it can also be forced on or off (applies after restart).

## Fixes
- A toast expiring after 6 seconds rebuilt the whole page, closing open menus and dropping focus. Toasts now live in their own region.
- Typing in the search box recreated the input on every keystroke, which broke IME input and caret position.
- Saving a setting scrolled Settings back to the top.
- Revealing an account from an alert cleared the filters but left the old text in the search box.

## Notes
- Closing the window still keeps the app in the tray. If your Linux desktop has no tray, start LimitTrack again to reopen the window.

# LimitTrack v1.3.0

Reliability, editing, and trust improvements. See `AUDIT_AND_PLAN.md` for the full review.

New
- Launch at login (installed Windows and macOS apps): start quietly in the tray so alerts survive a restart.
- Reset alerts can be turned off, with a Send test alert button.
- Privacy mode masks email addresses in the app, widget, and notifications.
- Edit an account's email and reset cycle, and rename tools. Duplicate accounts and tool names are caught.
- First-run guide, recorded limit events in account details, and remembered window size and position.
- A one-time notice the first time you close the window, explaining that LimitTrack keeps running in the tray.

Fixed
- An empty, invalid, or past custom reset time no longer errors or silently becomes "Expected ready"; it shows a clear message.
- Open menus and delete confirmations no longer vanish when a timer expires.
- The tray tooltip has a single source and minute-level wording instead of competing updates.
- Bulk "Log limit" now has an undo.
- Launching a second copy no longer clears your search and filters, and restores a minimized window.
- The About dialog shows the real version, and the window's startup background now follows your chosen theme (intended to avoid a light flash in dark mode; needs a native visual check).

Under the hood
- Shared domain helpers replace duplicated limit-logging code in the app and widget.
- Strict Content-Security-Policy, sandboxed renderers, denied web permissions, and navigation guards on both windows.
- CI now runs the test suite on pull requests. New unit and jsdom interaction tests (48 total).

Not changed: the app ID (`com.yourname.limittrack`) is intentionally untouched because changing it alters installer and notification identity for existing installs. Installers remain unsigned.

Windows: use the Setup executable to install, or the other executable for the portable app. macOS: use the DMG. Linux: use the AppImage or DEB. Launch at login is not available on Linux.
