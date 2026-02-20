/**
 * SSE connection hook with auto-reconnect.
 *
 * Connects to the dashboard server's SSE endpoint (`/api/events`)
 * and dispatches events to a callback. Handles:
 * - Initial connection with state:full snapshot delivery
 * - Auto-reconnect with exponential backoff (3s → 6s → 12s → max 30s)
 * - Connection status tracking (connecting / connected / reconnecting / disconnected)
 * - Graceful cleanup on unmount
 */

import { useEffect, useRef, useCallback, useState } from "react";
import type { ConnectionStatus, SSEEventType } from "@shared/types";

/** SSE event received from the server */
export interface SSEEvent {
  type: SSEEventType;
  data: unknown;
  id?: string;
}

/** Options for useEventSource */
export interface UseEventSourceOptions {
  /** SSE endpoint URL. Defaults to "/api/events" (proxied by Vite in dev). */
  url?: string;
  /** Called for every SSE event received */
  onEvent: (event: SSEEvent) => void;
  /** Called when connection status changes */
  onStatusChange?: (status: ConnectionStatus) => void;
  /** Whether the hook should connect. Set to false to disable. */
  enabled?: boolean;
}

/** Return value from useEventSource */
export interface UseEventSourceReturn {
  /** Current connection status */
  status: ConnectionStatus;
  /** Manually reconnect */
  reconnect: () => void;
  /** Manually disconnect */
  disconnect: () => void;
}

// Backoff constants
const INITIAL_RETRY_MS = 3000;
const MAX_RETRY_MS = 30000;
const BACKOFF_MULTIPLIER = 2;

/**
 * React hook that manages an SSE connection to the dashboard server.
 *
 * Usage:
 * ```tsx
 * const { status } = useEventSource({
 *   onEvent: (event) => dispatch(event),
 *   onStatusChange: (s) => console.log("SSE:", s),
 * });
 * ```
 */
export function useEventSource(
  options: UseEventSourceOptions
): UseEventSourceReturn {
  const {
    url = "/api/events",
    onEvent,
    onStatusChange,
    enabled = true,
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUnmountedRef = useRef(false);

  // Stable callback refs to avoid re-triggering effects
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const updateStatus = useCallback((newStatus: ConnectionStatus) => {
    if (isUnmountedRef.current) return;
    setStatus(newStatus);
    onStatusChangeRef.current?.(newStatus);
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const closeConnection = useCallback(() => {
    clearRetryTimer();
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, [clearRetryTimer]);

  const connect = useCallback(() => {
    if (isUnmountedRef.current) return;
    closeConnection();

    const isReconnect = retryCountRef.current > 0;
    updateStatus(isReconnect ? "reconnecting" : "connecting");

    const es = new EventSource(url);
    eventSourceRef.current = es;

    // --- Named event handlers ---
    // The server sends named events (e.g., "connected", "state:full", "bead:claimed").
    // EventSource only fires generic "message" for unnamed events.
    // For named events, we need addEventListener for each type.

    // All known SSE event types
    const eventTypes: SSEEventType[] = [
      "connected",
      "state:full",
      "project:disconnected",
      "bead:discovered",
      "bead:claimed",
      "bead:stage",
      "bead:done",
      "bead:error",
      "bead:changed",
      "bead:removed",
      "agent:active",
      "agent:idle",
      "beads:refreshed",
      "pipeline:started",
      "pipeline:done",
    ];

    const handleSSEEvent = (e: MessageEvent) => {
      if (isUnmountedRef.current) return;
      try {
        const data = JSON.parse(e.data);
        onEventRef.current({
          type: e.type as SSEEventType,
          data,
          id: e.lastEventId || undefined,
        });
      } catch {
        // Ignore unparseable events
      }
    };

    for (const eventType of eventTypes) {
      es.addEventListener(eventType, handleSSEEvent);
    }

    // --- Connection lifecycle ---

    es.onopen = () => {
      if (isUnmountedRef.current) return;
      retryCountRef.current = 0;
      updateStatus("connected");
    };

    es.onerror = () => {
      if (isUnmountedRef.current) return;

      // EventSource will auto-close on fatal errors
      // We handle reconnection ourselves for better control
      es.close();
      eventSourceRef.current = null;

      updateStatus("reconnecting");

      // Exponential backoff
      const delay = Math.min(
        INITIAL_RETRY_MS * Math.pow(BACKOFF_MULTIPLIER, retryCountRef.current),
        MAX_RETRY_MS
      );
      retryCountRef.current++;

      retryTimerRef.current = setTimeout(() => {
        if (!isUnmountedRef.current) {
          connect();
        }
      }, delay);
    };
  }, [url, closeConnection, updateStatus]);

  // Connect on mount / when enabled changes
  useEffect(() => {
    isUnmountedRef.current = false;

    if (enabled) {
      connect();
    } else {
      closeConnection();
      updateStatus("disconnected");
    }

    return () => {
      isUnmountedRef.current = true;
      closeConnection();
    };
  }, [enabled, connect, closeConnection, updateStatus]);

  const reconnect = useCallback(() => {
    retryCountRef.current = 0;
    connect();
  }, [connect]);

  const disconnect = useCallback(() => {
    closeConnection();
    updateStatus("disconnected");
  }, [closeConnection, updateStatus]);

  return { status, reconnect, disconnect };
}
