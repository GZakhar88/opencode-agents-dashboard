/**
 * useBreakpoint — Reactive viewport breakpoint hooks.
 *
 * useMaxColumns(): returns 1 (mobile), 2 (tablet), or 3 (desktop)
 * based on viewport width breakpoints.
 *
 * useIsMobile(): backward-compatible wrapper, returns true when viewport
 * is below the mobile breakpoint (640px).
 *
 * Uses matchMedia for efficient, debounce-free listeners.
 * SSR-safe: defaults to desktop (3 columns) on the server.
 */

import { useState, useEffect } from "react";

export const MOBILE_BREAKPOINT = 640;
export const TABLET_BREAKPOINT = 1024;

/**
 * Returns the maximum number of project columns for the current viewport:
 *   1 = mobile  (< 640px)
 *   2 = tablet  (640px – 1023px)
 *   3 = desktop (>= 1024px)
 */
export function useMaxColumns(): number {
  const [maxCols, setMaxCols] = useState(() => {
    if (typeof window === "undefined") return 3;
    const w = window.innerWidth;
    if (w < MOBILE_BREAKPOINT) return 1;
    if (w < TABLET_BREAKPOINT) return 2;
    return 3;
  });

  useEffect(() => {
    const mqlMobile = window.matchMedia(
      `(max-width: ${MOBILE_BREAKPOINT - 1}px)`,
    );
    const mqlTablet = window.matchMedia(
      `(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`,
    );

    const update = () => {
      if (mqlMobile.matches) {
        setMaxCols(1);
      } else if (mqlTablet.matches) {
        setMaxCols(2);
      } else {
        setMaxCols(3);
      }
    };

    // Set initial value (handles SSR hydration mismatch)
    update();

    mqlMobile.addEventListener("change", update);
    mqlTablet.addEventListener("change", update);
    return () => {
      mqlMobile.removeEventListener("change", update);
      mqlTablet.removeEventListener("change", update);
    };
  }, []);

  return maxCols;
}

/**
 * Backward-compatible mobile detection hook.
 * Returns true when the viewport is below the mobile breakpoint (640px).
 */
export function useIsMobile(): boolean {
  return useMaxColumns() === 1;
}
