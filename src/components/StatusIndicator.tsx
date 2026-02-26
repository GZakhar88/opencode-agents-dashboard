/**
 * StatusIndicator — Global SSE connection status display.
 *
 * Shows the current connection status with color-coded Badge:
 *   connecting   → yellow/amber
 *   connected    → green
 *   reconnecting → yellow/amber (pulsing)
 *   disconnected → red
 */

import type { ConnectionStatus } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface StatusIndicatorProps {
  status: ConnectionStatus;
}

const STATUS_CONFIG: Record<
  ConnectionStatus,
  { label: string; className: string; dot: string }
> = {
  connecting: {
    label: "Connecting",
    className: "border-status-warning/50 bg-status-warning/10 text-status-warning",
    dot: "bg-status-warning animate-pulse",
  },
  connected: {
    label: "Connected",
    className: "border-status-live/50 bg-status-live/10 text-status-live",
    dot: "bg-status-live",
  },
  reconnecting: {
    label: "Reconnecting",
    className: "border-status-warning/50 bg-status-warning/10 text-status-warning",
    dot: "bg-status-warning animate-pulse",
  },
  disconnected: {
    label: "Disconnected",
    className: "border-status-error/50 bg-status-error/10 text-status-error",
    dot: "bg-status-error",
  },
};

export function StatusIndicator({ status }: StatusIndicatorProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.disconnected;

  return (
    <Badge variant="outline" className={cn("gap-1.5 font-mono text-[11px]", config.className)}>
      <span className={cn("h-2 w-2 rounded-full", config.dot)} />
      {config.label}
    </Badge>
  );
}
