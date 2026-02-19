/**
 * Returns true if the device is touch-only (no hover, coarse pointer).
 * This maps to "device has a virtual keyboard" — used to adjust
 * composer behavior: Enter inserts newline, blur after send.
 */
export function isTouchDevice(): boolean {
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}
