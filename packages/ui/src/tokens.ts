/**
 * Chart palette — the semantic color tokens (ui-design-system.md §2) in their
 * concrete dark-theme values, for chart libraries that need literal colors
 * (Recharts). Components must import these instead of inlining hex.
 */
export const CHART_TOKENS = {
  accent: "#38BDF8",
  warn: "#F5A524",
  danger: "#F31260",
  ok: "#30A46C",
  muted: "#8A97AD",
  border: "#24314F",
} as const;
