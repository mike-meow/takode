const SHELL_DESKTOP_BREAKPOINT = 768;
const TASK_PANEL_DESKTOP_BREAKPOINT = 1024;
const COMPOSER_NARROW_BREAKPOINT = 640;

export function getEffectiveViewportWidth(zoomLevel: number): number {
  if (typeof window === "undefined") {
    return Number.POSITIVE_INFINITY;
  }
  const safeZoom = Number.isFinite(zoomLevel) && zoomLevel > 0 ? zoomLevel : 1;
  return window.innerWidth / safeZoom;
}

export function isDesktopShellLayout(zoomLevel: number): boolean {
  return getEffectiveViewportWidth(zoomLevel) >= SHELL_DESKTOP_BREAKPOINT;
}

export function isDesktopTaskPanelLayout(zoomLevel: number): boolean {
  return getEffectiveViewportWidth(zoomLevel) >= TASK_PANEL_DESKTOP_BREAKPOINT;
}

export function isNarrowComposerLayout(zoomLevel: number): boolean {
  return getEffectiveViewportWidth(zoomLevel) < COMPOSER_NARROW_BREAKPOINT;
}
