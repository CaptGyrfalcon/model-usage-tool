(function (root) {
  const api = {
    reduced: (preference, system) => preference === "reduce" || Boolean(system),
    canAnimate: ({ visible, orb, mode, reduced }) => visible && orb && mode === "pool" && !reduced,
    approach: (current, target, seconds) => current + (target - current) * (1 - Math.exp(-6.5 * Math.max(0, seconds))),
    weeklyLevel: (config) => config.weeklyRemaining ?? config.remaining ?? 0,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WidgetMotion = api;
})(typeof window === "object" ? window : this);
