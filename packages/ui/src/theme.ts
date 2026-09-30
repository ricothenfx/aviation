/**
 * Theme plumbing (ADR-0020): dark is the default; light is a persisted opt-in.
 * The attribute lives on <html> so one CSS override block (packages/ui
 * theme.css) re-skins every semantic token; state is mirrored to localStorage
 * and broadcast on a window event so sibling consumers re-render.
 */
export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "aviation-theme";
export const THEME_EVENT = "aviation:theme-change";

/**
 * Inline <script> body for app root layouts: applies the stored (or default
 * dark) theme to <html> before first paint — no flash of the wrong theme.
 * Layouts must pair it with suppressHydrationWarning on <html>.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t!=="light"&&t!=="dark")t="dark";document.documentElement.setAttribute("data-theme",t)}catch(e){document.documentElement.setAttribute("data-theme","dark")}})();`;

/** Apply a theme now: mutate <html>, persist the choice, notify consumers. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode) — the toggle still works for
    // the session; persistence is best-effort by design.
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}
