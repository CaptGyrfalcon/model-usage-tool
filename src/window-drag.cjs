// Use Electron's screen coordinates (DIPs), independent of renderer zoom and DPI.
function createWindowDrag({ getWindow, getCursor, isFullscreen, getSize }) {
  let drag = null;
  const available = (window) => window && !window.isDestroyed() && !isFullscreen() && !window.isFullScreen();
  return {
    start() {
      const window = getWindow();
      const cursor = getCursor();
      drag = available(window) ? { window, cursor, lastCursor: cursor, bounds: window.getBounds(), moving: false } : null;
    },
    move() {
      const window = getWindow();
      if (!drag || drag.window !== window || !available(window)) { drag = null; return; }
      const cursor = getCursor();
      // Moving the native window can generate another pointermove even when
      // the physical mouse is stationary. Do not feed it back into Windows.
      if (cursor.x === drag.lastCursor.x && cursor.y === drag.lastCursor.y) return;
      const dx = cursor.x - drag.cursor.x;
      const dy = cursor.y - drag.cursor.y;
      if (!drag.moving && Math.max(Math.abs(dx), Math.abs(dy)) < 4) return;
      drag.moving = true;
      drag.lastCursor = cursor;
      // Supply stable dimensions rather than repeatedly round-tripping the
      // native size through setPosition on scaled Windows displays.
      const { width, height } = getSize ? getSize(window) : drag.bounds;
      window.setBounds({ x: Math.round(drag.bounds.x + dx), y: Math.round(drag.bounds.y + dy), width, height }, false);
    },
    end() { drag = null; },
  };
}

module.exports = { createWindowDrag };
