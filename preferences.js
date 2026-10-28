(function (root) {
  const defaults = { theme: "system", font: "system", widgetVisible: false, widgetProviderId: null };
  let current = { ...defaults };
  const listeners = new Set();
  function apply(value) {
    const next = { ...defaults, ...value };
    const changed = JSON.stringify(current) !== JSON.stringify(next);
    current = next;
    document.documentElement.dataset.theme = current.theme;
    document.documentElement.dataset.font = current.font;
    if (changed) for (const listener of listeners) listener({ ...current });
    return { ...current };
  }
  const ready = root.limittrack.preferencesGet().then(apply);
  // The owning renderer surfaces initialization errors in its own UI.
  ready.catch(() => {});
  root.limittrack.onPreferencesChanged(apply);
  root.LimitTrackPreferences = {
    ready,
    current: () => ({ ...current }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    update: async (patch) => apply(await root.limittrack.preferencesUpdate(patch)),
  };
})(window);
