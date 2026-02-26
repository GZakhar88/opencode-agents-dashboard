/**
 * ElapsedTime — Live elapsed time display.
 *
 * Shows human-readable elapsed time (e.g., "5s", "2m 30s", "1h 15m")
 * that updates every second via setInterval.
 */

import { useState, useEffect } from "react";
import { formatElapsed } from "@/lib/format";

interface ElapsedTimeProps {
  /** Start time as a timestamp in milliseconds */
  startTime: number;
}

export function ElapsedTime({ startTime }: ElapsedTimeProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const elapsed = now - startTime;

  return (
    <span className="font-mono text-xs tabular-nums text-muted-foreground">
      {formatElapsed(elapsed)}
    </span>
  );
}
