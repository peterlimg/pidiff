import { HStack, isViewportTUI, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";

/** Attach beside the existing viewport, keeping Pi's transcript, dock and focus intact. */
export function mountSplit(tui: TUI, panel: Component): () => void {
  if (tui.mode !== "fullscreen" || !isViewportTUI(tui)) {
    throw new Error("Split view requires fullscreen mode. Choose TUI mode → fullscreen in /settings, then run /diff again. Or launch pi --tui-mode fullscreen. Use /diff view for the modal viewer.");
  }
  // Pi 0.85 exposes setLayoutRoot but not its getter. Keep this single, guarded
  // compatibility read here; replace it with getLayoutRoot when Pi exports one.
  const original: unknown = Reflect.get(tui, "layoutRoot");
  if (!original || typeof (original as Component).render !== "function" || typeof (original as Component).invalidate !== "function") {
    throw new Error("This Pi version does not expose its existing layout. Split view was not mounted; use /diff view instead.");
  }
  let panelWidth = Math.round((Math.max(110, tui.terminal.columns) - 1) * 0.6);
  let active = true;
  let dragging = false;
  const visible = ({ width }: { width: number }) => width >= 110;
  function resize(width: number) {
    panelWidth = Math.max(44, Math.min(tui.terminal.columns - 41, Math.round(width)));
    split.removeChild(panel);
    split.addChild(panel, { basis: panelWidth, minSize: 44, visible });
    tui.requestRender();
  }
  const divider: Component = {
    render: () => Array.from({ length: tui.terminal.rows }, () => "│"),
    invalidate() {},
    handleMouse(event) {
      if (!active) return;
      if (event.type === "wheel") return { handled: true };
      if (event.type === "press" && event.button === "left") {
        dragging = true;
        return { handled: true, capture: true };
      }
      if (dragging && (event.type === "drag" || event.type === "release")) {
        if (tui.terminal.columns >= 110) resize(tui.terminal.columns - 1 - event.screenX);
        if (event.type === "release") dragging = false;
        return { handled: true };
      }
    },
  };
  const split = new HStack([
    { component: original as Component, basis: 0, grow: 1, minSize: 40 },
    { component: divider, basis: 1, shrink: 0, visible },
    { component: panel, basis: panelWidth, minSize: 44, visible },
  ]);
  tui.setLayoutRoot(split);
  const removeInput = tui.addInputListener((data) => {
    if (!active || tui.terminal.columns < 110 || tui.hasOverlay() || Reflect.get(tui, "layoutRoot") !== split) return;
    const wider = matchesKey(data, "ctrl+alt+shift+left");
    const narrower = matchesKey(data, "ctrl+alt+shift+right");
    if (!wider && !narrower) return;
    resize(Math.min(panelWidth, tui.terminal.columns - 41) + (wider ? 4 : -4));
    return { consume: true };
  });
  tui.requestRender();
  return () => {
    active = false;
    removeInput();
    // Do not overwrite a newer layout installed by Pi or another extension.
    if (isViewportTUI(tui) && Reflect.get(tui, "layoutRoot") === split) {
      tui.setLayoutRoot(original as Component);
      tui.requestRender();
    }
  };
}
