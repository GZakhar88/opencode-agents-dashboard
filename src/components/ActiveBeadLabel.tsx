/**
 * ActiveBeadLabel — Current bead summary displayed below the progress bar.
 *
 * Shows: bead title, agent name (stage), priority badge, elapsed time.
 * Only renders when there is an active bead (one with an agentSessionId).
 * Uses subtle entrance animation for smooth appearance/disappearance.
 */

import type { BeadState, ColumnConfig } from "@shared/types";
import { motion, AnimatePresence } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { ElapsedTime } from "@/components/ElapsedTime";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "@/lib/constants";
import { cn, hexToRgba } from "@/lib/utils";

interface ActiveBeadLabelProps {
  /** The currently active bead (with agentSessionId set) */
  bead: BeadState | null;
  /** Column config to resolve stage → label + color */
  columns: ColumnConfig[];
}

export function ActiveBeadLabel({ bead, columns }: ActiveBeadLabelProps) {
  // Find the column config for the bead's current stage
  const stageColumn = bead
    ? columns.find((c) => c.id === bead.stage)
    : null;

  return (
    <AnimatePresence mode="wait">
      {bead && (
        <motion.div
          key={bead.id}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="flex items-center gap-2.5 px-1"
        >
          {/* Active indicator dot */}
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full animate-pulse"
            style={{ backgroundColor: stageColumn?.color ?? "#64748b" }}
          />

          {/* Bead title */}
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {bead.title}
          </span>

          {/* Agent/stage name */}
          {stageColumn && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: hexToRgba(stageColumn.color, 0.12),
                color: stageColumn.color,
              }}
            >
              {stageColumn.label}
            </span>
          )}

          {/* Priority badge */}
          <Badge
            className={cn(
              "shrink-0 border-0 text-[10px] px-1.5 py-0",
              PRIORITY_COLORS[bead.priority] ?? PRIORITY_COLORS[3],
            )}
          >
            {PRIORITY_LABELS[bead.priority] ?? `P${bead.priority}`}
          </Badge>

          {/* Elapsed time */}
          {bead.stage !== "ready" && bead.stage !== "done" && (
            <ElapsedTime startTime={bead.stageStartedAt} />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
