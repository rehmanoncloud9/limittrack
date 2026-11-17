// LimitTrack desktop widget.
//
// The page is a thin view. The main process owns the account data and the availability rules; it sends
// this page a few numbers per tool ({ layout, rows: [{ id, name, available, ready, tracked, nextResetAt }] })
// whenever they change. Nothing here reads, parses or writes accounts, and there is no per-second timer:
// the only timer is a single timeout aligned to the next minute change of the one countdown that can be
// on screen (Standard layout, no account available), and it is cancelled while the widget is hidden.

(function () {
  "use strict";
  const bridge = window.limittrack;
  const { formatMinutes } = window.LimitTrackDomain;
  const panel = document.getElementById("panel");
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = [["antigravity", "i-layers"], ["windsurf", "i-code"], ["codex", "i-code"], ["cursor", "i-spark"], ["claude", "i-spark"]];
  const MARGIN = 16; // the page's 8px padding on each side; the window is the panel plus this

  let payload = null;
  let sent = { width: 0, height: 0 };
  let timer = null;
  let subtitleEl = null; // the one element the minute timer updates

  // ---------- small DOM helpers ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(id, size, className) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  }

  function button(className, action, label) {
    const node = el("button", className + " nodrag");
    node.type = "button";
    node.dataset.act = action;
    if (label) node.setAttribute("aria-label", label);
    return node;
  }

  // Known tools get a recognisable glyph; any other tool gets its first letter.
  function iconId(row) {
    if (row.id === null) return "i-grid";
    const key = (row.id + " " + row.name).toLowerCase();
    const hit = ICONS.find(([name]) => key.includes(name));
    return hit ? hit[1] : null;
  }

  function tile(row, size) {
    const node = el("span", "tile drag"); // the tile is a drag handle; the text beside it opens the app
    const id = iconId(row);
    if (id) node.appendChild(icon(id, size, "glyph"));
    else node.appendChild(el("span", "mono", (row.name.trim().charAt(0) || "?").toUpperCase()));
    return node;
  }

  function dot(row, extra) { return el("span", "dot" + (row.available > 0 ? " on" : "") + (extra ? " " + extra : "")); }

  // What the small print says: the app's own wording for each state, never invented urgency.
  function describe(row, nowMs) {
    if (row.available > 0) return { text: row.available === 1 ? "Available account" : "Available accounts" };
    if (row.ready > 0) return { text: row.ready + " expected ready" };
    if (row.nextResetAt !== null) return row.nextResetAt > nowMs ? { text: "Next reset in " + formatMinutes(row.nextResetAt - nowMs), timed: true } : { text: "Expected ready" };
    return { text: row.tracked === 0 ? "No accounts yet" : "Not checked" };
  }

  function summaryLabel(row, nowMs) {
    return row.name + ": " + row.available + " " + (row.available === 1 ? "account" : "accounts") + " available. " + describe(row, nowMs).text + ".";
  }

  // ---------- layouts ----------

  function standard(row, nowMs) {
    const header = el("div", "hd drag");
    const mark = el("span", "mark");
    mark.appendChild(icon("i-clock", 16));
    const gear = button("gear", "menu", "Widget options");
    gear.appendChild(icon("i-gear", 17));
    header.append(mark, el("span", "ttl", "LimitTrack"), gear);

    const picker = button("picker", "tools", "Tool shown: " + row.name + ". Change tool");
    picker.setAttribute("aria-haspopup", "menu");
    picker.append(tile(row, 20), el("span", "nm", row.name), icon("i-chevron", 16, "chev"));

    const stat = button("stat", "open", summaryLabel(row, nowMs) + " Open LimitTrack");
    subtitleEl = el("span", "sub", describe(row, nowMs).text);
    stat.append(dot(row), el("span", "num", String(row.available)), subtitleEl);

    return [header, picker, stat, el("span", "wave")];
  }

  function compact(row, nowMs) {
    const meta = button("cmeta", "open", summaryLabel(row, nowMs) + " Open LimitTrack");
    const count = el("span", "row");
    count.append(dot(row), el("span", "num", String(row.available)));
    meta.append(el("span", "nm", row.name), count);
    meta.title = summaryLabel(row, nowMs);
    return [tile(row, 26), meta];
  }

  function multi(rows, nowMs) {
    const list = el("ul", "items");
    for (const row of rows) {
      const item = el("li", "item");
      const open = button("open", "open", summaryLabel(row, nowMs) + " Open LimitTrack");
      open.title = summaryLabel(row, nowMs);
      open.append(el("span", "nm", row.name), dot(row), el("span", "num", String(row.available)));
      item.append(tile(row, 17), open);
      list.appendChild(item);
    }
    return [list];
  }

  function message(title, body, action, actionLabel) {
    const nodes = [el("div", "msg-title", title), el("div", "msg-body", body)];
    if (action) { const btn = button("msg-btn", action); btn.textContent = actionLabel; nodes.push(btn); }
    return nodes;
  }

  // ---------- rendering ----------

  function render() {
    const nowMs = Date.now();
    subtitleEl = null;
    // Until the first summary arrives (a few milliseconds) the panel stays hidden: no "Loading" flash and no size to report.
    if (!payload) { panel.hidden = true; return; }
    let layout = payload.layout;
    let nodes;
    if (!payload.rows.length) { layout = "message"; nodes = message("No tools yet", "Add a tool and an account in LimitTrack to see counts here.", "open", "Open LimitTrack"); }
    else if (layout === "multi") nodes = multi(payload.rows, nowMs);
    else if (layout === "compact") nodes = compact(payload.rows[0], nowMs);
    else nodes = standard(payload.rows[0], nowMs);
    panel.dataset.layout = layout;
    panel.replaceChildren(...nodes);
    panel.hidden = false;
    report();
    schedule();
  }

  // The window hugs the panel: tell main how big it is (only when that actually changed).
  function report() {
    if (panel.hidden) return; // nothing to measure before the first summary
    const width = Math.ceil(panel.offsetWidth) + MARGIN, height = Math.ceil(panel.offsetHeight) + MARGIN;
    if (width === sent.width && height === sent.height) return;
    sent = { width, height };
    bridge.widgetResize({ width, height });
  }

  // ---------- the one countdown ----------

  function currentSubtitle(nowMs) {
    return payload && payload.layout === "standard" && payload.rows.length ? describe(payload.rows[0], nowMs) : null;
  }

  function refresh() {
    const state = currentSubtitle(Date.now());
    if (state && subtitleEl && subtitleEl.textContent !== state.text) subtitleEl.textContent = state.text;
  }

  // Sleep until the displayed minute value is about to change. Nothing runs when no countdown is showing or the widget is hidden.
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (document.hidden) return;
    const nowMs = Date.now();
    const state = currentSubtitle(nowMs);
    if (!state || !state.timed) return;
    const row = payload.rows[0];
    const delay = ((row.nextResetAt - nowMs) % 60000) || 60000;
    timer = setTimeout(() => { refresh(); schedule(); }, delay + 40);
  }

  // ---------- events ----------

  panel.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    if (target.dataset.act === "open") bridge.widgetOpenMain();
    else if (target.dataset.act === "tools") bridge.widgetToolMenu();
    else if (target.dataset.act === "menu") bridge.widgetContextMenu();
  });
  // Right-click on any clickable part opens the widget's own menu (drag handles keep the system behaviour).
  panel.addEventListener("contextmenu", (event) => {
    if (!event.target.closest(".nodrag")) return;
    event.preventDefault();
    bridge.widgetContextMenu();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refresh(); report(); }
    schedule();
  });
  if (document.fonts) {
    document.fonts.ready.then(report);
    document.fonts.addEventListener("loadingdone", report);
  }

  bridge.onWidgetSummary((next) => { payload = next; render(); });
  bridge.widgetSummaryGet().then((next) => { payload = next; render(); })
    .catch(() => {
      payload = null;
      panel.dataset.layout = "message";
      panel.replaceChildren(...message("Could not load", "Open LimitTrack to check your accounts.", "open", "Open LimitTrack"));
      panel.hidden = false;
      report();
    });
})();
