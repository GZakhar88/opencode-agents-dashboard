/**
 * ProgressSegment — Individual segment in the pipeline progress bar.
 *
 * Visual states:
 * - completed: filled with the stage's color at full opacity
 * - active: filled with the agent's color + pulsing animation
 * - upcoming: transparent/muted outline only
 *
 * Each segment represents one pipeline stage (column) from ColumnConfig.
 * The segment's color is driven by ColumnConfig.color (hex).
 */

import { motion } from "framer-motion";
import { cn, hexToRgba } from "@/lib/utils";

export type SegmentState = "completed" | "active" | "upcoming";

interface ProgressSegmentProps {
  /** Column/stage label */
  label: string;
  /** Hex color from ColumnConfig */
  color: string;
  /** Visual fill state */
  state: SegmentState;
  /** Number of beads currently in this stage */
  beadCount: number;
  /** Whether this is the first segment */
  isFirst: boolean;
  /** Whether this is the last segment */
  isLast: boolean;
  /** Click handler for expanding to this stage */
  onClick?: () => void;
}

export function ProgressSegment({
  label,
  color,
  state,
  beadCount,
  isFirst,
  isLast,
  onClick,
}: ProgressSegmentProps) {
  const isCompleted = state === "completed";
  const isActive = state === "active";
  const isUpcoming = state === "upcoming";

  const Wrapper = onClick ? "button" : "div";

  return (
    <Wrapper
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn(
        "group relative flex flex-1 flex-col items-center gap-1 transition-all duration-200",
        onClick ? "cursor-pointer" : "cursor-default",
      )}
      aria-label={`${label}: ${state}${beadCount > 0 ? `, ${beadCount} bead${beadCount !== 1 ? "s" : ""}` : ""}`}
    >
      {/* Segment bar */}
      <div
        className={cn(
          "relative h-2 w-full overflow-hidden transition-all duration-300",
          isFirst && "rounded-l-full",
          isLast && "rounded-r-full",
        )}
        style={{
          backgroundColor: isUpcoming
            ? hexToRgba(color, 0.1)
            : isCompleted
              ? hexToRgba(color, 0.7)
              : hexToRgba(color, 0.4),
        }}
      >
        {/* Active pulse overlay */}
        {isActive && (
          <motion.div
            className="absolute inset-0"
            style={{ backgroundColor: color }}
            animate={{
              opacity: [0.5, 0.9, 0.5],
            }}
            transition={{
              duration: 1.8,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        )}

        {/* Completed fill */}
        {isCompleted && (
          <div
            className="absolute inset-0"
            style={{ backgroundColor: color, opacity: 0.85 }}
          />
        )}
      </div>

      {/* Label row */}
      <div className="flex items-center gap-1">
        <span
          className={cn(
            "text-[10px] font-medium uppercase tracking-wider transition-colors duration-200",
            isActive && "text-foreground",
            isCompleted && "text-muted-foreground",
            isUpcoming && "text-muted-foreground/50",
          )}
        >
          {label}
        </span>
        {beadCount > 0 && (
          <span
            className={cn(
              "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums",
              isActive && "text-foreground",
              isCompleted && "text-muted-foreground",
              isUpcoming && "text-muted-foreground/50",
            )}
            style={{
              backgroundColor: isActive
                ? hexToRgba(color, 0.2)
                : isCompleted
                  ? hexToRgba(color, 0.12)
                  : hexToRgba(color, 0.06),
            }}
          >
            {beadCount}
          </span>
        )}
      </div>
    </Wrapper>
  );
}
