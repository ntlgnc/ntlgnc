/**
 * Format a USD price with appropriate decimals based on magnitude.
 */
export function fmtPrice(n: number): string {
  if (n >= 1000)
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1)
    return n.toFixed(2);
  if (n >= 0.01)
    return n.toFixed(4);
  return n.toFixed(6);
}

/**
 * Format a number with a leading sign: +1.23 or -1.23
 */
export function fmtSigned(n: number, digits = 2): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}`;
}

/**
 * Classify a percentage change as up/down/flat.
 */
export function clsChange(pct: number): "up" | "down" | "flat" {
  if (pct > 0.02) return "up";
  if (pct < -0.02) return "down";
  return "flat";
}
