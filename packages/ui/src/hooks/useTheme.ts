"use client";

import { useSyncExternalStore } from "react";

import { THEME_EVENT, type Theme } from "../theme";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}

function getSnapshot(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function getServerSnapshot(): Theme {
  // SSR/HTML stream: dark is the committed default (ADR-0020); hydration
  // re-reads the real value from <html>.
  return "dark";
}

/** Reactive current theme — re-renders consumers (e.g. charts) on toggle. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
