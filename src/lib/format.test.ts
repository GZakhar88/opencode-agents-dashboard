/**
 * Tests for src/lib/format.ts — formatElapsed and formatLastSeen
 *
 * Tests the pure formatting utility functions.
 * Run: bun test src/lib/format.test.ts
 */

import { describe, it, expect } from "bun:test";
import { formatElapsed, formatLastSeen } from "./format";

describe("formatElapsed", () => {
  it("returns '0s' for zero milliseconds", () => {
    expect(formatElapsed(0)).toBe("0s");
  });

  it("returns '0s' for negative values", () => {
    expect(formatElapsed(-1000)).toBe("0s");
    expect(formatElapsed(-1)).toBe("0s");
  });

  it("formats seconds only", () => {
    expect(formatElapsed(1000)).toBe("1s");
    expect(formatElapsed(5000)).toBe("5s");
    expect(formatElapsed(59000)).toBe("59s");
  });

  it("formats sub-second as 0s", () => {
    expect(formatElapsed(500)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(60000)).toBe("1m 0s");
    expect(formatElapsed(90000)).toBe("1m 30s");
    expect(formatElapsed(150000)).toBe("2m 30s");
    expect(formatElapsed(3599000)).toBe("59m 59s");
  });

  it("formats hours and minutes (drops seconds)", () => {
    expect(formatElapsed(3600000)).toBe("1h 0m");
    expect(formatElapsed(4500000)).toBe("1h 15m");
    expect(formatElapsed(7200000)).toBe("2h 0m");
    expect(formatElapsed(86400000)).toBe("24h 0m");
  });

  it("handles large values", () => {
    // 100 hours
    expect(formatElapsed(360000000)).toBe("100h 0m");
  });
});

describe("formatLastSeen", () => {
  it("formats seconds ago", () => {
    const now = Date.now();
    const result = formatLastSeen(now - 5000);
    expect(result).toBe("5s ago");
  });

  it("formats 0 seconds for very recent timestamps", () => {
    const result = formatLastSeen(Date.now());
    expect(result).toBe("0s ago");
  });

  it("formats minutes ago", () => {
    const now = Date.now();
    const result = formatLastSeen(now - 120000); // 2 minutes
    expect(result).toBe("2m ago");
  });

  it("formats hours ago", () => {
    const now = Date.now();
    const result = formatLastSeen(now - 7200000); // 2 hours
    expect(result).toBe("2h ago");
  });

  it("handles boundary between seconds and minutes", () => {
    const now = Date.now();
    expect(formatLastSeen(now - 59000)).toBe("59s ago"); // 59 seconds
    expect(formatLastSeen(now - 60000)).toBe("1m ago"); // exactly 1 minute
  });

  it("handles boundary between minutes and hours", () => {
    const now = Date.now();
    expect(formatLastSeen(now - 3540000)).toBe("59m ago"); // 59 minutes
    expect(formatLastSeen(now - 3600000)).toBe("1h ago"); // exactly 1 hour
  });

  it("handles future timestamps (negative diff) gracefully", () => {
    // If lastHeartbeat is in the future (clock drift), should show "0s ago"
    const result = formatLastSeen(Date.now() + 5000);
    expect(result).toBe("0s ago");
  });
});
