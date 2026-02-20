/**
 * Shared Tailwind class-name constants.
 *
 * Extracted to avoid duplicating long focus-visible / interactive-state
 * class strings across components.  Import and spread via `cn()`.
 */

/**
 * Standard focus-visible ring using the theme's --ring color.
 * Apply to any interactive element that needs keyboard-accessible focus.
 */
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
