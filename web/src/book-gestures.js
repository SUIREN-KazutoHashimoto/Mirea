// A horizontal gesture is a page turn, not a scroll, pinch, selection or tap.
export function swipeStep({ dx, dy, width, direction = 'ltr', canTurn = true }) {
  const distance = Math.abs(dx);
  if (!canTurn || distance < Math.max(35, Math.min(75, width * .08)) || distance < Math.abs(dy) * 1.6) return 0;
  return (dx < 0 ? 1 : -1) * (direction === 'rtl' ? -1 : 1);
}
