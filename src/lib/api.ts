/**
 * HTTP client for the dashboard server API.
 * Used for initial state fetch; live updates come via SSE.
 */

import { SERVER_URL } from "./constants";

/**
 * Fetch the full dashboard state from the server.
 * Used on initial load and after SSE reconnection.
 */
export async function fetchState(): Promise<unknown> {
  const res = await fetch(`${SERVER_URL}/api/state`);
  if (!res.ok) {
    throw new Error(`Failed to fetch state: ${res.status} ${res.statusText}`);
  }
  return res.json();
}
