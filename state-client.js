// Serializes this window's writes and keeps the baseline used for conflict detection.
(function (root) {
  root.createLimitTrackClient = function (bridge) {
    const { clone, normalizeState } = root.LimitTrackDomain;
    let baseline = null;
    let queue = Promise.resolve();
    let generation = 0;
    return {
      async read() {
        await queue.catch(() => {});
        baseline = normalizeState(await bridge.stateGet());
        return clone(baseline);
      },
      save(value, options = {}) {
        if (!baseline) return Promise.reject(new Error("Accounts have not loaded yet. Try again."));
        const base = clone(baseline), next = normalizeState(value), version = generation;
        baseline = clone(next);
        const pending = queue.catch(() => {}).then(async () => {
          if (version !== generation) throw new Error("A previous change could not be saved. Review your accounts and try again.");
          try { return await bridge.stateCommit(base, next, options); }
          catch (error) { generation++; throw error; }
        });
        queue = pending;
        return pending;
      },
    };
  };
})(globalThis);
