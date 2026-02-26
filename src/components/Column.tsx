/**
 * Column — Single Kanban column displaying beads for one stage.
 *
 * Shows: column label header with count, list of bead cards.
 * All beads are shown at natural height (compact mode is handled
 * by the PipelineProgress component instead).
 * Error column gets distinct warning styling for high visibility.
 * Wraps card list in AnimatePresence for exit animations.
 *
 * Column accent color is driven by ColumnConfig.color (hex) from the server,
 * applied as an inline border-top style for full dynamic color support.
 *
 * Min-width is 200px in the filtered expanded Kanban context to allow
 * more columns to fit without horizontal scrolling.
 */

import type { BeadState, ColumnConfig } from "@shared/types";
import { AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { BeadCard } from "@/components/BeadCard";
import { cn } from "@/lib/utils";

interface ColumnProps {
  columnId: string;
  label: string;
  color: string;
  beads: BeadState[];
  /** All columns in the pipeline — passed to BeadCard for mini progress */
  columns?: ColumnConfig[];
}

export function Column({ columnId, label, color, beads, columns }: ColumnProps) {
  const isErrorColumn = columnId === "error";
  const hasErrors = isErrorColumn && beads.length > 0;

  /** Shared color for error column text (icon, heading, badge) */
  const headerColor = hasErrors ? "text-red-400" : "text-muted-foreground";

  return (
    <div
      aria-label={`${label} column with ${beads.length} bead${beads.length !== 1 ? "s" : ""}`}
      className={cn(
        "flex min-w-[200px] flex-1 flex-col rounded-lg border border-t-2 bg-muted/30",
        hasErrors && "border-red-500/30 bg-red-500/[0.03]",
      )}
      style={{
        borderTopColor: hasErrors ? undefined : color,
      }}
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

      {/* Bead list */}
      <div
        role="list"
        className="flex flex-col gap-2 px-2 pb-2"
      >
        <AnimatePresence mode="popLayout">
          {beads.map((bead) => (
            <div key={bead.id} role="listitem">
              <BeadCard bead={bead} columns={columns} />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
