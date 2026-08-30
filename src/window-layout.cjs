const BASE_WINDOW_WIDTH = 456;
const BASE_WINDOW_HEIGHT = 700;
const BASE_COMPACT_HEIGHT = 390;
const ORB_WIDTH = 432;
const ORB_HEIGHT = 260;
const POOL_ORB_WIDTH = 760;
const POOL_ORB_HEIGHT = 400;

function physicalLongEdge(display) {
  const width = Number(display?.size?.width) || 0;
  const height = Number(display?.size?.height) || 0;
  const scaleFactor = Math.max(1, Number(display?.scaleFactor) || 1);
  return Math.max(width, height) * scaleFactor;
}

function uiScaleForDisplay(display) {
  const longEdge = physicalLongEdge(display);
  if (longEdge >= 3000) return 1.2;
  if (longEdge >= 2200) return 1.1;
  return 1;
}

function windowModeOptions(settings = {}, fullscreen = false) {
  return {
    skipTaskbar: Boolean(settings.orbMode) && !fullscreen,
    alwaysOnTop: !fullscreen,
  };
}

function cappedScale(baseHeight, display) {
  const desiredZoom = uiScaleForDisplay(display);
  const availableHeight = Number(display?.workArea?.height) || Number(display?.size?.height) || baseHeight;
  const heightBudget = Math.max(baseHeight, availableHeight - 40);
  return Math.max(1, Math.min(desiredZoom, heightBudget / baseHeight));
}

function windowMetrics(settings = {}, display = {}) {
  if (settings.orbMode) {
    const poolMode = settings.orbDisplayMode === "pool";
    const baseWidth = poolMode ? POOL_ORB_WIDTH : ORB_WIDTH;
    const baseHeight = poolMode ? POOL_ORB_HEIGHT : ORB_HEIGHT;
    const zoomFactor = cappedScale(baseHeight, display);
    return {
      width: Math.round(baseWidth * zoomFactor),
      height: Math.round(baseHeight * zoomFactor),
      zoomFactor,
    };
  }

  const zoomFactor = cappedScale(BASE_WINDOW_HEIGHT, display);
  return {
    width: Math.round(BASE_WINDOW_WIDTH * zoomFactor),
    height: Math.round((settings.compact ? BASE_COMPACT_HEIGHT : BASE_WINDOW_HEIGHT) * zoomFactor),
    zoomFactor,
  };
}

function smartDockBounds(bounds, workArea, reveal = 12) {
  const center = bounds.x + bounds.width / 2;
  const edge = center < workArea.x + workArea.width / 2 ? "left" : "right";
  const restoreBounds = {
    ...bounds,
    x: edge === "left" ? workArea.x + 8 : workArea.x + workArea.width - bounds.width - 8,
  };
  return {
    edge,
    restoreBounds,
    dockedBounds: {
      ...restoreBounds,
      x: edge === "left"
        ? workArea.x - restoreBounds.width + reveal
        : workArea.x + workArea.width - reveal,
    },
  };
}

module.exports = {
  physicalLongEdge,
  smartDockBounds,
  uiScaleForDisplay,
  windowModeOptions,
  windowMetrics,
};
