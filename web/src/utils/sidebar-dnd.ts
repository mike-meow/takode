import type { Modifier } from "@dnd-kit/core";

/** Restrict drag movement to vertical axis only. */
export const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});
