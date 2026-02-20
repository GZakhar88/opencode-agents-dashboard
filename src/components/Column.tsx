/**
 * Column — Single Kanban column displaying beads for one pipeline stage.
 *
 * Shows: column label header with count, scrollable list of bead cards.
 * Error column gets distinct warning styling for high visibility.
 * Uses shadcn ScrollArea for overflow handling.
 * Wraps card list in AnimatePresence for exit animations.
 */

import type { Stage, BeadState } from "@shared/types";
import { AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { COLUMN_LABELS } from "@/lib/constants";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BeadCard } from "@/components/BeadCard";
import { cn } from "@/lib/utils";

interface ColumnProps {
  columnId: Stage;
  beads: BeadState[];
}

/** Column header accent colors for visual distinction */
const COLUMN_ACCENT: Partial<Record<Stage, string>> = {
  backlog: "border-t-slate-500",
  orchestrator: "border-t-violet-500",
  builder: "border-t-blue-500",
  refactor: "border-t-cyan-500",
  reviewer: "border-t-amber-500",
  committer: "border-t-emerald-500",
  error: "border-t-red-500",
  done: "border-t-green-500",
};

export function Column({ columnId, beads }: ColumnProps) {
  const label = COLUMN_LABELS[columnId];
  const accent = COLUMN_ACCENT[columnId] ?? "border-t-border";
  const isErrorColumn = columnId === "error";
  const hasErrors = isErrorColumn && beads.length > 0;

  /** Shared color for error column text (icon, heading, badge) */
  const headerColor = hasErrors ? "text-red-400" : "text-muted-foreground";

  return (
    <div
      aria-label={`${label} column with ${beads.length} bead${beads.length !== 1 ? "s" : ""}`}
      className={cn(
        "flex w-[240px] min-w-[240px] flex-col rounded-lg border border-t-2 bg-muted/30",
        accent,
        hasErrors && "border-red-500/30 bg-red-500/[0.03]",
      )}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          {isErrorColumn && (
            <AlertTriangle
              className={cn(
                "h-3.5 w-3.5",
                hasErrors ? headerColor : "text-muted-foreground/50",
              )}
            />
          )}
          <h3
            className={cn(
              "text-xs font-semibold uppercase tracking-wider",
              headerColor,
            )}
          >
            {label}
          </h3>
        </div>
        {beads.length > 0 && (
          <span
            className={cn(
              "flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-medium",
              hasErrors
                ? "bg-red-500/15 text-red-400"
                : "bg-muted text-muted-foreground",
            )}
          >
            {beads.length}
          </span>
        )}
      </div>

      {/* Bead list (scrollable, animated) */}
      <ScrollArea className="flex-1">
        <div
          role="list"
          className="flex min-h-[120px] flex-col gap-2 px-2 pb-2"
        >
          <AnimatePresence mode="popLayout">
            {beads.map((bead) => (
              <div key={bead.id} role="listitem">
                <BeadCard bead={bead} />
              </div>
            ))}
          </AnimatePresence>
        </div>
      </ScrollArea>
    </div>
  );
}
