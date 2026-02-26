/**
 * useIsMobile — Reactive viewport width hook.
 *
 * Returns true when the viewport is below the mobile breakpoint (640px).
 * Uses matchMedia for efficient, debounce-free listener.
 * SSR-safe: defaults to false on the server.
 */

import { useState, useEffect } from "react";

const MOBILE_BREAKPOINT = 640;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < MOBILE_BREAKPOINT;
  });

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
    };

    // Set initial value from media query (handles SSR hydration mismatch)
    setIsMobile(mql.matches);

    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  return isMobile;
}
