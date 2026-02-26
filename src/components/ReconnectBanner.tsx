/**
 * ReconnectBanner — Visible notification bar for connection state changes.
 *
 * Displays a banner when the SSE connection is lost or reconnecting:
 *   - "reconnecting" → amber banner with pulsing dots and status text
 *   - "disconnected" → red banner with manual reconnect button
 *   - "connected" (after reconnect) → brief green "restored" banner
 *   - "connecting" / steady "connected" → hidden
 *
 * Animates in/out with Framer Motion for a polished feel.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ConnectionStatus } from "@shared/types";
import { WifiOff, RefreshCw, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReconnectBannerProps {
  status: ConnectionStatus;
  /** Manually trigger a reconnect */
  onReconnect: () => void;
}

/** How long to show the "Connection restored" success banner (ms) */
const RESTORED_DISPLAY_MS = 3000;

/** After this many seconds of reconnecting, show the manual reconnect hint */
const SHOW_MANUAL_HINT_AFTER_MS = 15_000;

type BannerState = "hidden" | "reconnecting" | "disconnected" | "restored";

/** Style config for each visible banner state, mirroring StatusIndicator's pattern */
const BANNER_STYLES: Record<Exclude<BannerState, "hidden">, string> = {
  reconnecting: "bg-status-warning/10 text-status-warning border-b border-status-warning/20",
  disconnected: "bg-status-error/10 text-status-error border-b border-status-error/20",
  restored: "bg-status-live/10 text-status-live border-b border-status-live/20",
};

export function ReconnectBanner({ status, onReconnect }: ReconnectBannerProps) {
  const [banner, setBanner] = useState<BannerState>("hidden");
  const prevStatusRef = useRef<ConnectionStatus>(status);
  const [showManualHint, setShowManualHint] = useState(false);

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = status;

    if (status === "reconnecting") {
      setBanner("reconnecting");
      setShowManualHint(false);
      return;
    }

    if (status === "disconnected") {
      setBanner("disconnected");
      setShowManualHint(false);
      return;
    }

    if (
      status === "connected" &&
      (prevStatus === "reconnecting" || prevStatus === "disconnected")
    ) {
      // Show "restored" banner briefly
      setBanner("restored");
      setShowManualHint(false);
      const timer = setTimeout(() => setBanner("hidden"), RESTORED_DISPLAY_MS);
      return () => clearTimeout(timer);
    }

    // For "connecting" on first load or steady "connected", hide
    setBanner("hidden");
    setShowManualHint(false);
  }, [status]);

  // Timer to show manual reconnect hint after prolonged reconnecting
  useEffect(() => {
    if (banner !== "reconnecting") return;

    const timer = setTimeout(() => {
      setShowManualHint(true);
    }, SHOW_MANUAL_HINT_AFTER_MS);

    return () => clearTimeout(timer);
  }, [banner]);

  const handleManualReconnect = useCallback(() => {
    setShowManualHint(false);
    onReconnect();
  }, [onReconnect]);

  return (
    <AnimatePresence>
      {banner !== "hidden" && (
        <motion.div
          key="reconnect-banner"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <div
            role="status"
            aria-live="polite"
            className={cn(
              "flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium",
              BANNER_STYLES[banner],
            )}
          >
            {banner === "reconnecting" && (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Reconnecting to server...</span>
                {showManualHint && (
                  <>
                    <span className="text-status-warning/60">·</span>
                    <span className="text-xs text-status-warning/80">
                      Taking longer than expected.
                    </span>
                    <button
                      type="button"
                      onClick={handleManualReconnect}
                      className="ml-1 inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-status-warning transition-colors hover:bg-status-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-warning/60"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Retry now
                    </button>
                  </>
                )}
              </>
            )}

            {banner === "disconnected" && (
              <>
                <WifiOff className="h-4 w-4" />
                <span>Connection lost.</span>
                <span className="text-xs text-status-error/80">
                  Is the server running?
                </span>
                <button
                  type="button"
                  onClick={handleManualReconnect}
                  className="ml-2 inline-flex items-center gap-1 rounded border border-status-error/30 bg-status-error/10 px-3 py-1 text-xs font-medium text-status-error transition-colors hover:bg-status-error/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-error/60"
                >
                  <RefreshCw className="h-3 w-3" />
                  Reconnect
                </button>
              </>
            )}

            {banner === "restored" && (
              <>
                <CheckCircle2 className="h-4 w-4" />
                <span>Connection restored — state synced.</span>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
