(function (root) {
  const selectors = [
    ".brand-mark", ".brand-copy", ".window-actions > button", ".sync-strip", ".tab", "footer",
    ".overview-heading", ".quota-glance > button", ".hero-metric", ".hero-metric > span", ".hero-metric > strong", ".hero-metric > small",
    ".quota-card", ".quota-icon", ".quota-title", ".quota-title h3", ".quota-remain", ".quota-progress", ".quota-stats", ".quota-message",
    ".detail-card", ".section-heading", ".segmented", ".chart-card", ".chart-card svg", ".model-row", ".model-donut-panel", ".model-donut-visual",
  ];
  function stageGeometry(plan, fullscreen) {
    const box = fullscreen ? plan.stage : plan.widget;
    const scale = fullscreen ? 1 : plan.zoom;
    return { x: box.x - plan.stage.x, y: box.y - plan.stage.y,
      width: box.width / scale, height: box.height / scale, scale };
  }
  function clipGeometry(plan, fullscreen) {
    const box = fullscreen ? plan.stage : plan.widget;
    return `${box.y - plan.stage.y}px ${plan.stage.x + plan.stage.width - box.x - box.width}px ${plan.stage.y + plan.stage.height - box.y - box.height}px ${box.x - plan.stage.x}px round ${fullscreen ? 0 : 22 * plan.zoom}px`;
  }
  function create(document) {
    let transition = null;
    const named = new Set();
    const style = document.body.style;
    function stage(plan, fullscreen) {
      const box = stageGeometry(plan, fullscreen);
      document.documentElement.classList.add("morph-stage");
      style.width = `${box.width}px`;
      style.height = `${box.height}px`;
      style.transformOrigin = "0 0";
      style.transform = `translate(${box.x}px, ${box.y}px) scale(${box.scale})`;
    }
    function mark() {
      for (const node of named) node.style.removeProperty("view-transition-name");
      named.clear();
      const counts = new Map();
      function name(node, key) {
        node.style.setProperty("view-transition-name", key);
        named.add(node);
      }
      const surface = document.querySelector(document.body.classList.contains("orb-mode") ? ".orb-view" : ".shell");
      const content = document.querySelector(".content");
      const contentBox = content?.getBoundingClientRect();
      function visible(node) {
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height) return false;
        // Do not allocate compositor snapshots for hundreds of offscreen rows.
        return !contentBox || !content.contains(node) || (box.bottom > contentBox.top && box.top < contentBox.bottom);
      }
      if (surface) name(surface, "morph-shell");
      for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
          const anchor = node.closest("[id]")?.id || "shell";
          const prefix = `${anchor}-${selector}`.replace(/[^a-zA-Z0-9_-]/g, "-");
          const index = counts.get(prefix) || 0;
          counts.set(prefix, index + 1);
          if (!visible(node) || named.has(node)) continue;
          name(node, `morph-${prefix}-${index}`);
        }
      }
      // Give individual text runs their own geometry instead of stretching a whole card's typography.
      for (const node of surface?.querySelectorAll("span, strong, b, small, h1, h2, h3, label") || []) {
        if (named.has(node) || node.children.length || !node.textContent.trim()) continue;
        if (!visible(node)) continue;
        let cursor = node;
        const parts = [];
        while (cursor && cursor !== surface) {
          if (cursor.id) { parts.unshift(cursor.id); break; }
          parts.unshift(`${cursor.tagName}-${Array.prototype.indexOf.call(cursor.parentElement.children, cursor)}`);
          cursor = cursor.parentElement;
        }
        name(node, `morph-text-${parts.join("-").replace(/[^a-zA-Z0-9_-]/g, "-")}`);
      }
    }
    function cleanup() {
      transition?.skipTransition();
      transition = null;
      for (const node of named) node.style.removeProperty("view-transition-name");
      named.clear();
      for (const property of ["width", "height", "transform", "transform-origin"]) style.removeProperty(property);
      document.documentElement.classList.remove("morph-stage");
      document.documentElement.style.removeProperty("--morph-from");
      document.documentElement.style.removeProperty("--morph-to");
    }
    return {
      stage,
      cleanup,
      async animate(plan, update) {
        mark();
        document.documentElement.style.setProperty("--morph-from", clipGeometry(plan, !plan.fullscreen));
        document.documentElement.style.setProperty("--morph-to", clipGeometry(plan, plan.fullscreen));
        transition = document.startViewTransition(() => {
          stage(plan, plan.fullscreen);
          update();
          mark();
        });
        // A skipped transition still runs the layout update and must commit the native window.
        transition.ready.catch(() => {});
        await transition.updateCallbackDone;
        await transition.finished;
      },
    };
  }
  const api = { create, stageGeometry, clipGeometry };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FullscreenMorph = api;
})(typeof window === "object" ? window : this);
