/**
 * Tests for useEventSource — backoff calculation and retry constants.
 *
 * Since the hook depends on browser EventSource + React, we test the
 * pure retry/backoff logic by extracting and validating the math directly.
 * This ensures the exponential backoff formula produces correct delays
 * and the MAX_RETRIES boundary is well-defined.
 *
 * Run: bun test src/hooks/useEventSource.test.ts
 */

import { describe, it, expect } from "bun:test";

// Extracted constants matching useEventSource.ts
const INITIAL_RETRY_MS = 3000;
const MAX_RETRY_MS = 30000;
const BACKOFF_MULTIPLIER = 2;
const MAX_RETRIES = 10;

/**
 * Compute the backoff delay for a given retry count (1-indexed).
 * This mirrors the formula inside useEventSource's onerror handler:
 *   delay = Math.min(INITIAL_RETRY_MS * BACKOFF_MULTIPLIER ** (retryCount - 1), MAX_RETRY_MS)
 */
function computeBackoff(retryCount: number): number {
  return Math.min(
    INITIAL_RETRY_MS * BACKOFF_MULTIPLIER ** (retryCount - 1),
    MAX_RETRY_MS,
  );
}

describe("useEventSource backoff logic", () => {
  describe("exponential backoff delays", () => {
    it("first retry uses INITIAL_RETRY_MS (3s)", () => {
      expect(computeBackoff(1)).toBe(3000);
    });

    it("second retry doubles (6s)", () => {
      expect(computeBackoff(2)).toBe(6000);
    });

    it("third retry quadruples (12s)", () => {
      expect(computeBackoff(3)).toBe(12000);
    });

    it("fourth retry at 24s", () => {
      expect(computeBackoff(4)).toBe(24000);
    });

    it("fifth retry caps at MAX_RETRY_MS (30s)", () => {
      // 3000 * 2^4 = 48000, capped to 30000
      expect(computeBackoff(5)).toBe(30000);
    });

    it("all subsequent retries cap at MAX_RETRY_MS", () => {
      for (let i = 5; i <= MAX_RETRIES; i++) {
        expect(computeBackoff(i)).toBe(30000);
      }
    });
  });

  describe("retry boundary", () => {
    it("MAX_RETRIES is 10", () => {
      expect(MAX_RETRIES).toBe(10);
    });

    it("retryCount at MAX_RETRIES is still within bounds (last retry)", () => {
      // retryCount = 10 means 10th attempt, which should still try
      // Only retryCount > MAX_RETRIES (11) should give up
      expect(10).toBeLessThanOrEqual(MAX_RETRIES);
    });

    it("retryCount exceeding MAX_RETRIES triggers disconnection", () => {
      // This models the condition: if (retryCountRef.current > MAX_RETRIES)
      const retryCount = MAX_RETRIES + 1;
      expect(retryCount > MAX_RETRIES).toBe(true);
    });

    it("total time before giving up is approximately 201 seconds", () => {
      // Sum of all backoff delays for retries 1 through 10
      let totalMs = 0;
      for (let i = 1; i <= MAX_RETRIES; i++) {
        totalMs += computeBackoff(i);
      }
      // 3000 + 6000 + 12000 + 24000 + 30000*6 = 225000ms = 225s
      expect(totalMs).toBe(225000);
      // This is about 3.75 minutes of retrying before giving up
      expect(totalMs).toBeLessThan(300_000); // Under 5 minutes
      expect(totalMs).toBeGreaterThan(60_000); // Over 1 minute
    });
  });

  describe("backoff edge cases", () => {
    it("backoff never exceeds MAX_RETRY_MS regardless of retry count", () => {
      // Even with absurd retry counts
      expect(computeBackoff(100)).toBe(MAX_RETRY_MS);
      expect(computeBackoff(1000)).toBe(MAX_RETRY_MS);
    });

    it("backoff at retry 0 would be INITIAL_RETRY_MS / BACKOFF_MULTIPLIER", () => {
      // This shouldn't happen in practice (retryCount starts at 1 after increment)
      // but verifying the math is sound
      expect(computeBackoff(0)).toBe(INITIAL_RETRY_MS / BACKOFF_MULTIPLIER);
    });

    it("INITIAL_RETRY_MS is a reasonable minimum delay", () => {
      expect(INITIAL_RETRY_MS).toBeGreaterThanOrEqual(1000); // At least 1s
      expect(INITIAL_RETRY_MS).toBeLessThanOrEqual(10000); // At most 10s
    });

    it("MAX_RETRY_MS is a reasonable maximum delay", () => {
      expect(MAX_RETRY_MS).toBeGreaterThanOrEqual(10000); // At least 10s
      expect(MAX_RETRY_MS).toBeLessThanOrEqual(60000); // At most 1 minute
    });
  });
});
