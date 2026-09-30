import type { Theme } from "./theme";

/**
 * Chart palette — the semantic color tokens (ui-design-system.md §2) as
 * concrete values, for chart libraries that need literal colors (Recharts).
 * Components read them through chartTokens(theme)/useTheme() instead of
 * inlining hex. Graphics stay >= 3:1 against the surface in both themes;
 * text drawn with these values (labels) uses muted, which is AA in both.
 */
export interface ChartTokens {
  accent: string;
  warn: string;
  danger: string;
  ok: string;
  muted: string;
  border: string;
  /** Tooltip/popover background (surface-raised in ui-design-system.md §2). */
  raised: string;
}

const DARK: ChartTokens = {
  accent: "#38BDF8",
  warn: "#F5A524",
  danger: "#F31260",
  ok: "#30A46C",
  muted: "#8A97AD",
  border: "#24314F",
  raised: "#1A2540",
};

const LIGHT: ChartTokens = {
  accent: "#0369A1",
  warn: "#9A5B0B",
  danger: "#F31260",
  ok: "#15803D",
  muted: "#4D5D77",
  border: "#B9C6DA",
  raised: "#FFFFFF",
};

export function chartTokens(theme: Theme = "dark"): ChartTokens {
  return theme === "light" ? LIGHT : DARK;
}
