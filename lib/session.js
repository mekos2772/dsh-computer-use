// Session state for one plugin instance: remembers the latest get_app_state snapshot
// so element_index stays resolvable across tool calls without re-reading the tree,
// plus the Codex-style action trail for effects (last cursor point + history).
export class ComputerUseSession {
  constructor() {
    this.state = null;
    /** screenshot-relative pixel points of past actions, newest first, capped */
    this.trail = [];
    /** last action point in screenshot pixels: {x, y, kind} */
    this.lastAction = null;
    /** last action point in SCREEN pixels (for the desktop overlay start position) */
    this.lastScreenPoint = null;
    /**
     * attached-image width / capture width. DSH's attachment pipeline can
     * downscale the screenshot, so the model's pixel coordinates live in the
     * ATTACHED image space; divide them by this factor before kernel math.
     */
    this.modelScale = 1;
    /**
     * Numbered crosshair markers of the latest annotated screenshot:
     * [{ id, x, y }] in window-relative CAPTURE pixels (never rescaled by
     * modelScale). click({marker}) looks the id up here and snaps to the
     * interactive element containing the point.
     */
    this.markers = [];
  }

  reset() {
    this.state = null;
    this.trail = [];
    this.lastAction = null;
    this.lastScreenPoint = null;
    this.modelScale = 1;
    this.markers = [];
  }

  store(state) {
    this.state = state;
  }

  get window() {
    return this.state?.window ?? null;
  }

  /** Convert a screen-space point to screenshot-relative pixels using the stored window bounds. */
  toScreenshotPoint(x, y) {
    const w = this.window?.bounds;
    if (!w) return null;
    return { x: Math.round(x - w.x), y: Math.round(y - w.y) };
  }

  /** Convert screenshot-relative coordinates from the latest snapshot to screen pixels. */
  toScreenPoint(x, y) {
    const w = this.window?.bounds;
    if (!w || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.round(w.x + x), y: Math.round(w.y + y) };
  }

  /** Return the screen-space center of an element from the latest snapshot. */
  elementScreenPoint(index) {
    const frame = this.resolveElement(index)?.frame;
    if (!frame || frame.width <= 0 || frame.height <= 0) return null;
    return this.toScreenPoint(frame.x + frame.width / 2, frame.y + frame.height / 2);
  }

  /** Return the center of the latest target window in screen pixels. */
  windowScreenPoint() {
    const w = this.window?.bounds;
    if (!w) return null;
    return { x: Math.round(w.x + w.width / 2), y: Math.round(w.y + w.height / 2) };
  }

  /** Record one action outcome for trail/effects. kind: click|scroll|drag|press_key|type_text */
  recordAction(kind, screenX, screenY) {
    if (screenX == null || screenY == null) return null;
    this.lastScreenPoint = { x: Math.round(screenX), y: Math.round(screenY) };
    const pt = this.toScreenshotPoint(screenX, screenY);
    if (pt) {
      this.lastAction = { ...pt, kind };
      this.trail.unshift({ ...pt, kind });
      if (this.trail.length > 6) this.trail.length = 6;
    }
    return pt;
  }

  resolvePath(index) {
    if (!this.state || !Array.isArray(this.state.elements)) return null;
    const el = this.state.elements.find((e) => e.index === index);
    return el ? el.path : null;
  }

  resolveElement(index) {
    if (!this.state || !Array.isArray(this.state.elements)) return null;
    return this.state.elements.find((e) => e.index === index) ?? null;
  }

  requireElement(index, toolName) {
    const el = this.resolveElement(index);
    if (!el) {
      throw new Error(
        `${toolName}: element_index ${index} is not in the latest snapshot. ` +
        'Call get_app_state first (the tree changes between calls).',
      );
    }
    return el;
  }
}
