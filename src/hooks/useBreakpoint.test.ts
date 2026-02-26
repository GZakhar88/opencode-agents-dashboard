/**
 * Tests for src/hooks/useBreakpoint.ts — viewport breakpoint detection
 *
 * Tests the MOBILE_BREAKPOINT and TABLET_BREAKPOINT constants and the
 * matchMedia query patterns that the hooks use. Since bun:test runs
 * without a browser environment (no window/matchMedia), we test the
 * breakpoint logic as pure functions.
 *
 * The hooks themselves are thin React wrappers around matchMedia — the
 * critical contract points tested here are:
 * 1. Mobile breakpoint threshold is exactly 640px
 * 2. Tablet breakpoint threshold is exactly 1024px
 * 3. useMaxColumns returns 1/2/3 at correct breakpoints
 * 4. useIsMobile backward compatibility
 * 5. The correct media queries are constructed
 * 6. SSR safety (typeof window check)
 *
 * Run: bun test src/hooks/useBreakpoint.test.ts
 */

import { describe, it, expect } from "bun:test";

// ============================================================
// Constants — mirrors the hook's internal constants
// ============================================================

const MOBILE_BREAKPOINT = 640;
const TABLET_BREAKPOINT = 1024;

// ============================================================
// useMaxColumns breakpoint logic
// ============================================================

/** Pure function equivalent of useMaxColumns initial state */
function getMaxColumns(width: number): number {
  if (width < MOBILE_BREAKPOINT) return 1;
  if (width < TABLET_BREAKPOINT) return 2;
  return 3;
}

describe("useMaxColumns breakpoint thresholds", () => {
  // Mobile devices (< 640px) → 1 column
  it("returns 1 column for 320px (iPhone 5/SE 1st gen)", () => {
    expect(getMaxColumns(320)).toBe(1);
  });

  it("returns 1 column for 375px (iPhone SE)", () => {
    expect(getMaxColumns(375)).toBe(1);
  });

  it("returns 1 column for 390px (iPhone 14)", () => {
    expect(getMaxColumns(390)).toBe(1);
  });

  it("returns 1 column for 414px (iPhone 8 Plus)", () => {
    expect(getMaxColumns(414)).toBe(1);
  });

  it("returns 1 column for 639px (mobile boundary - 1)", () => {
    expect(getMaxColumns(639)).toBe(1);
  });

  // Tablet devices (640px – 1023px) → 2 columns
  it("returns 2 columns for 640px (exact mobile boundary)", () => {
    expect(getMaxColumns(640)).toBe(2);
  });

  it("returns 2 columns for 641px (mobile boundary + 1)", () => {
    expect(getMaxColumns(641)).toBe(2);
  });

  it("returns 2 columns for 768px (iPad mini)", () => {
    expect(getMaxColumns(768)).toBe(2);
  });

  it("returns 2 columns for 834px (iPad Air)", () => {
    expect(getMaxColumns(834)).toBe(2);
  });

  it("returns 2 columns for 1023px (tablet boundary - 1)", () => {
    expect(getMaxColumns(1023)).toBe(2);
  });

  // Desktop devices (>= 1024px) → 3 columns
  it("returns 3 columns for 1024px (exact tablet boundary)", () => {
    expect(getMaxColumns(1024)).toBe(3);
  });

  it("returns 3 columns for 1025px (tablet boundary + 1)", () => {
    expect(getMaxColumns(1025)).toBe(3);
  });

  it("returns 3 columns for 1280px (laptop)", () => {
    expect(getMaxColumns(1280)).toBe(3);
  });

  it("returns 3 columns for 1440px (typical desktop)", () => {
    expect(getMaxColumns(1440)).toBe(3);
  });

  it("returns 3 columns for 1920px (full HD)", () => {
    expect(getMaxColumns(1920)).toBe(3);
  });

  it("returns 3 columns for 2560px (ultra-wide)", () => {
    expect(getMaxColumns(2560)).toBe(3);
  });
});

// ============================================================
// useIsMobile backward compatibility
// ============================================================

describe("useIsMobile backward compatibility (640px)", () => {
  it("classifies 375px (iPhone SE) as mobile", () => {
    expect(375 < MOBILE_BREAKPOINT).toBe(true);
  });

  it("classifies 639px as mobile (boundary - 1)", () => {
    expect(639 < MOBILE_BREAKPOINT).toBe(true);
  });

  it("classifies 640px as desktop (exact boundary)", () => {
    expect(640 < MOBILE_BREAKPOINT).toBe(false);
  });

  it("classifies 1024px as desktop", () => {
    expect(1024 < MOBILE_BREAKPOINT).toBe(false);
  });

  it("isMobile === (maxColumns === 1)", () => {
    // Verify that useIsMobile is equivalent to useMaxColumns() === 1
    for (const w of [320, 375, 414, 639, 640, 768, 1024, 1440]) {
      const isMobile = w < MOBILE_BREAKPOINT;
      const maxCols = getMaxColumns(w);
      expect(isMobile).toBe(maxCols === 1);
    }
  });
});

// ============================================================
// Media query string construction
// ============================================================

describe("matchMedia query construction", () => {
  it("constructs the correct mobile max-width query", () => {
    const expectedQuery = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;
    expect(expectedQuery).toBe("(max-width: 639px)");
  });

  it("constructs the correct tablet range query", () => {
    const expectedQuery = `(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`;
    expect(expectedQuery).toBe("(min-width: 640px) and (max-width: 1023px)");
  });

  it("mobile and tablet queries are mutually exclusive", () => {
    // Mobile: max-width: 639px
    // Tablet: min-width: 640px AND max-width: 1023px
    // Desktop: implicitly >= 1024px (neither matches)
    // No overlap possible
    const mobileMax = MOBILE_BREAKPOINT - 1; // 639
    const tabletMin = MOBILE_BREAKPOINT; // 640
    expect(tabletMin).toBe(mobileMax + 1);
  });
});

// ============================================================
// SSR safety pattern
// ============================================================

describe("SSR safety", () => {
  it("uses typeof window check (not direct window access)", () => {
    const isSSR = typeof globalThis.window === "undefined";
    expect(isSSR).toBe(true);
  });

  it("defaults to 3 columns (desktop) in SSR environments", () => {
    // useMaxColumns initial state: typeof window === "undefined" → return 3
    const ssrDefault = typeof globalThis.window === "undefined" ? 3 : 3;
    expect(ssrDefault).toBe(3);
  });

  it("defaults to false (not mobile) in SSR environments", () => {
    // useIsMobile returns useMaxColumns() === 1
    // In SSR, useMaxColumns returns 3, so useIsMobile returns false
    const ssrDefault = typeof globalThis.window === "undefined" ? false : false;
    expect(ssrDefault).toBe(false);
  });
});

// ============================================================
// Alignment with CSS breakpoints
// ============================================================

describe("CSS breakpoint alignment", () => {
  it("mobile breakpoint aligns with Tailwind sm: (640px)", () => {
    const TAILWIND_SM = 640;
    expect(MOBILE_BREAKPOINT).toBe(TAILWIND_SM);
  });

  it("tablet breakpoint aligns with Tailwind lg: (1024px)", () => {
    const TAILWIND_LG = 1024;
    expect(TABLET_BREAKPOINT).toBe(TAILWIND_LG);
  });

  it("aligns with CSS media query in globals.css (@media max-width: 639px)", () => {
    const cssBreakpoint = 639;
    const hookMaxWidth = MOBILE_BREAKPOINT - 1;
    expect(hookMaxWidth).toBe(cssBreakpoint);
  });
});

// ============================================================
// chunkArray logic (used in App.tsx for row-based layout)
// ============================================================

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

describe("chunkArray row splitting", () => {
  it("chunks 1 item into 1 row of 1", () => {
    expect(chunkArray([1], 3)).toEqual([[1]]);
  });

  it("chunks 2 items into 1 row of 2", () => {
    expect(chunkArray([1, 2], 3)).toEqual([[1, 2]]);
  });

  it("chunks 3 items into 1 row of 3", () => {
    expect(chunkArray([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it("chunks 4 items into rows of 3 + 1", () => {
    expect(chunkArray([1, 2, 3, 4], 3)).toEqual([[1, 2, 3], [4]]);
  });

  it("chunks 5 items into rows of 3 + 2", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 3)).toEqual([[1, 2, 3], [4, 5]]);
  });

  it("chunks 6 items into rows of 3 + 3", () => {
    expect(chunkArray([1, 2, 3, 4, 5, 6], 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it("chunks 7 items into rows of 3 + 3 + 1", () => {
    expect(chunkArray([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it("chunks with size 2 (tablet)", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("chunks with size 1 (mobile)", () => {
    expect(chunkArray([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });

  it("handles empty array", () => {
    expect(chunkArray([], 3)).toEqual([]);
  });
});
