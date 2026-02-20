/**
 * Shared formatting utilities for durations and timestamps.
 */

/**
 * Format milliseconds into a human-readable duration string.
 * Examples: "5s", "2m 30s", "1h 15m"
 */
export function formatElapsed(ms: number): string {
  if (ms < 0) return "0s";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Format a timestamp as a relative "time ago" string.
 * Examples: "5s ago", "2m ago", "1h ago"
 */
export function formatLastSeen(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 0) return "0s ago";
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
