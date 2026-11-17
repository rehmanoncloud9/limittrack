# LimitTrack audit and improvement plan (v1.2.2 → v1.3.0)

Prepared November 16, 2026 from a full source review plus the existing 24-test suite (all passing at the start). The UI was checked with a disposable jsdom harness and a mock bridge; native behavior (tray, notifications, login item, desktop widget) still needs a check on real Windows, macOS and Linux machines.

## One-paragraph product read

LimitTrack answers one question: *which of my AI-tool accounts can I use right now, and when does the next one come back?* The foundation is sound: honest status vocabulary (Not checked / Waiting / Expected ready / Available), main-process ownership of data, atomic saves, conflict detection, and a widget. The weak spots are **trust in the background** (it only notifies while running, and nothing helps it start with the computer), **small correctness holes** in editing flows, and **missing basics** (you can't fix a typo in an email, can't turn notifications off, no first-run guidance).

## Findings

### Bugs and correctness (fix now)

| # | Finding | Impact |
|---|---|---|
| B1 | Custom reset: an empty or invalid datetime reaches `new Date(x).toISOString()` and throws `RangeError` uncaught; a past time silently becomes "Expected ready" | Broken edit flow, misleading status |
| B2 | The one-second tick calls `render()` when a status changes, destroying an open ⋯ menu, a pending delete prompt, or a focused field | Menus vanish under the pointer; a delete confirmation disappears |
| B3 | Tray tooltip has two writers (renderer every second, main every 15 s) with different wording | Flicker and inconsistent text |
| B4 | A second launch (`second-instance`) resets the search and filter, and does not restore a minimized window | Surprising; window can stay hidden |
| B5 | Bulk "Log limit" has no undo and no confirmation toast; the single-account path has both | Easy to cause an irreversible-feeling mistake |
| B6 | About dialog hard-codes "1.2.2" | Wrong after the next release |
| B7 | Main window uses a fixed light `backgroundColor` | White flash on launch for dark-theme users |
| B8 | Limit logging, cycle lookup and unit handling are copy-pasted in `renderer.js` and `widget.js` | Drift risk; two places to fix every bug |
| B9 | Dead code: `statusStyles` (with a bad class name), `cycleProgress`, progress-bar lookups, unused `oc` | Noise |
| B10 | Duplicate tool names are allowed | Two "Codex" sections are indistinguishable |
| B11 | `ci.yml` builds installers but never runs `npm test` on PRs | Regressions can merge |

### Security and hardening

| # | Finding | Response |
|---|---|---|
| S1 | No Content-Security-Policy on either window | Add a strict CSP (self only; inline styles allowed because the UI uses a few) |
| S2 | Renderers are not sandboxed; the widget window has no navigation or window-open guard | `sandbox: true` (the preload only uses `contextBridge` and `ipcRenderer`), shared window hardening, deny all permission requests |

### Missing features and UX gaps

| # | Gap | Why it matters |
|---|---|---|
| F1 | **Launch at login** | Notifications only fire while the app runs; a reboot silently ends the product's main promise |
| F2 | **Notification controls**: on/off and a test button | Users must be able to silence and verify alerts |
| F3 | **Privacy mode** (mask emails everywhere, including notifications and widget) | Screenshots, screen sharing, shared offices |
| F4 | **Edit account** (fix email, per-account cycle) and **edit tool** (rename) | Typos currently force delete-and-re-add, losing history |
| F5 | **First-run guidance** | A new user sees three empty tool cards and no explanation of the model or of the default 7-day assumption |
| F6 | **Recorded limit events** in account details | History is stored (8 events) but never shown |
| F7 | **Remember main window size and position** | Window resets every launch |
| F8 | **First-close hint** | Closing the window hides to tray; first-time users think the app quit |
| F9 | Discoverability of shortcuts (`n`, `/`) | Shortcuts exist but are invisible |

### Deferred (decision needed, or not yet justified)

- **`appId` is still `com.yourname.limittrack`** (also the Windows AppUserModelId). It should be changed before wider distribution, but doing so changes the NSIS installer identity and notification identity, so existing installs would get a second copy. That is a deliberate migration decision for the owner, not a silent edit.
- Multiple limit windows per account (session and weekly), fixed weekly schedules, pinning, quiet hours, merge-style import, Mini/Expanded widgets: all remain on the P1/P2 roadmap in `PRODUCT_DESIGN_PLAN.md`.
- Code signing and notarization (SmartScreen / Gatekeeper warnings) is the biggest adoption blocker for a non-developer audience, but it costs money and is an owner decision.
- Linux GNOME ships without a tray; with close-to-tray the window can become unreachable. Needs a platform check and probably a "quit on close" setting.

## Implementation order

1. Shared domain helpers and tests (B1, B8, B10, F3 helpers)
2. Main process: hardening, preferences (notifications, privacy, launch at login), tray single owner, window state, close hint, version IPC (S1, S2, B3, B4, B6, B7, F1, F2, F7, F8)
3. Main window: edit flows, bulk undo, tick fix, first run, activity, settings UI (B1, B2, B5, B9, F3–F6, F9)
4. Widget: shared helpers and privacy (B8, F3)
5. CI, docs, version bump, release notes (B11)

## Acceptance

- All pre-existing tests still pass; new tests cover the domain helpers and each new main-process preference path.
- jsdom smoke test: add, edit, log limit (single and bulk) with undo, invalid reset rejected, privacy masking, tick does not close an open menu.
- No new Tailwind utilities (so `app.css` stays byte-identical and the release "styles are current" check keeps passing).

---

# Widget and performance audit (v1.4.0 → v1.5.0)

Method: read the whole codebase, then measured the original and the new build in real Electron 31.7.7 under Xvfb (Linux), 30 accounts, 30 s sampling after a 12 s settle. Memory is the summed PSS of every Electron process (browser, zygote, utility, GPU, renderers); CPU is the average over the window. Test suite: 55 tests at the start (all passing), 72 at the end (all passing).

## Measured results

| Scenario | v1.4.0 | v1.5.0 | Change |
|---|---|---|---|
| Tray + widget (main window closed) | 322 MB, 0.43% CPU | 291 MB, 0.13% CPU | −10% RAM, −70% CPU |
| Widget renderer alone | 74 MB | 52 MB | −30% |
| Main window + widget | 353–356 MB, ~1.0% CPU | 331 MB, 0.90% CPU | −7% RAM |
| Multi-tool, always on top, tray only | n/a | 295 MB, 0.10% CPU | |

## Findings and what was done

| # | Finding | Action |
|---|---|---|
| P1 | The widget re-read, re-normalized and re-rendered the whole account list on every change, including its own saves, and sorted every account each second | Main computes per-tool counts once (shared `Domain.summarizeProviders`, same availability rules) and pushes a few numbers only when they change |
| P2 | One-second tick in the widget | Removed. The available count can only change when data is committed (status "open" never comes from time passing); the only timer is one timeout aligned to the next minute change of a visible countdown, cancelled while hidden |
| P3 | The widget received `storage:changed` for every write and loaded the write path (`state-client`, normalization) | Not notified; no longer loads either |
| P4 | Entry animation, hover transitions, `overflow: auto` scroll container | Removed; static paint only |
| P5 | Store serialized the whole file twice per write and rewrote it (and rotated the backup) even when nothing changed | One serialization; unchanged saves are skipped. A regression test covers recovery from a corrupt file (the skip must not leave a corrupt primary in place; I introduced and fixed that edge case during this work) |
| P6 | Tray tooltip set every minute even if unchanged | Set only when the text changes |
| P7 | Windows native helper process kept running for a widget that does not need it | Not started when Keep on top is on |
| B1 | Second launch during startup could build a window before `ready` | Deferred until ready |
| B2 | Notification set could grow without bound if the OS never reports dismissal | Capped at 20 |
| B3 | Found while testing: pushing a summary before the page asked for one was wasted; page measured a hidden panel and would have reported a bogus size on start | Pushes wait for the page's first pull; page reports size only when it has content |

## Experiments I measured and rejected

- `--in-process-gpu` and `NetworkServiceInProcess2`: removed two processes but the memory moved into the browser process (329 and 319 MB vs 323 MB). No real gain, more risk.
- `--renderer-process-limit=1` (both windows share one renderer): −8 MB (2%) for coupling the two windows. Not worth it.
- Rewriting the Windows desktop helper to use `SetWinEventHook`: the saving is microseconds of CPU, it cannot be built or run in this environment, and the helper must compile with the old .NET Framework C# 5 compiler. Left unchanged.

## Design decisions to be aware of

- The widget is now **read-only**. The old widget had per-account "Log limit"/"Confirm"/Undo; that cannot exist in count-based layouts, and the redesign asked for minimal content. Those actions remain in the app, and clicking the count opens it. Data, merge logic and the commit path are untouched.
- Because it shows counts only, the widget never receives email addresses, so privacy mode is satisfied by construction.
- Translucency is a translucent fill with a light edge, not a blur of the wallpaper. A page cannot blur what is behind its own transparent window, and CSS blur would cost GPU/RAM.
- Drag handles are the header (Standard) and the icon tile (Compact, Multi-tool); the count/text opens the app. Right-click on the text opens a native menu. On Windows, right-click on a drag handle shows the system menu (Electron limitation).
- Always on top rebuilds the window (the desktop window type cannot be changed after creation). Default is unchanged: desktop only.
- Version bumped to 1.5.0. `appId` is still `com.yourname.limittrack` (see the earlier deferred item).

## Remaining issues

1. **Electron's floor dominates.** About 290 MB PSS here is Chromium itself (browser 162 MB, zygote and utility ~26 MB each, GPU 25 MB). That is a lot for a 1 GB laptop and no app-level switch fixed it. PSS also counts shared libraries pro rata, so private memory is lower, but I could not test on 1 GB hardware. The only large remaining lever is a different runtime (a native tray + widget), which is a separate project.
2. The main window still ticks every second while visible (0.9% CPU with it open). It already pauses when hidden; making its countdowns minute-resolution when over an hour would cut it further.
3. Not verified on real Windows or macOS: the transparent-window look, dragging in `type: "desktop"` windows on macOS, right-click behavior on drag regions, the Windows helper, and always-on-top levels. Linux/Xvfb was verified (screenshots and measurements), with no window manager, so dragging itself was not exercised.
4. The data file is still pretty-printed JSON rewritten in full on each real change; fine at hundreds of accounts, wasteful at thousands.
