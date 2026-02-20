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
    className: "border-amber-500/50 bg-amber-500/10 text-amber-400",
    dot: "bg-amber-400 animate-pulse",
  },
  connected: {
    label: "Connected",
    className: "border-green-500/50 bg-green-500/10 text-green-400",
    dot: "bg-green-400",
  },
  reconnecting: {
    label: "Reconnecting",
    className: "border-amber-500/50 bg-amber-500/10 text-amber-400",
    dot: "bg-amber-400 animate-pulse",
  },
  disconnected: {
    label: "Disconnected",
    className: "border-red-500/50 bg-red-500/10 text-red-400",
    dot: "bg-red-400",
  },
};

export function StatusIndicator({ status }: StatusIndicatorProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.disconnected;

  return (
    <Badge variant="outline" className={cn("gap-1.5", config.className)}>
      <span className={cn("h-2 w-2 rounded-full", config.dot)} />
      {config.label}
    </Badge>
  );
}
