/**
 * ProgressSegment — Individual segment in the pipeline progress bar.
 *
 * Visual states:
 * - completed: filled with the stage's color at full opacity, slides in from left
 * - active: filled with the agent's color + slow breathing pulse
 * - upcoming: transparent/muted outline only
 *
 * Each segment represents one pipeline stage (column) from ColumnConfig.
 * The segment's color is driven by ColumnConfig.color (hex).
 *
 * Transitions between states use directional fill animations:
 * - upcoming → active: fill sweeps in from left
 * - active → completed: fill solidifies
 * - completed → upcoming (rollback): fill sweeps out to left
 */

import { motion, AnimatePresence } from "framer-motion";
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

const fillTransition = {
  duration: 0.4,
  ease: [0.4, 0, 0.2, 1] as [number, number, number, number],
};

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
          "relative h-2 w-full overflow-hidden transition-colors duration-500",
          isFirst && "rounded-l-full",
          isLast && "rounded-r-full",
        )}
        style={{
          backgroundColor: hexToRgba(color, 0.1),
        }}
      >
        {/* Directional fill overlay — sweeps in from left for completed/active.
             Uses a stable key ("fill") so that active↔completed transitions
             smoothly animate opacity/color without re-running the scaleX sweep.
             The scaleX enter/exit only fires when transitioning to/from upcoming. */}
        <AnimatePresence>
          {(isCompleted || isActive) && (
            <motion.div
              key="fill"
              className="absolute inset-0"
              style={{
                transformOrigin: "left center",
              }}
              initial={{ scaleX: 0, opacity: 0 }}
              animate={{
                scaleX: 1,
                opacity: isCompleted ? 0.85 : 1,
                backgroundColor: isCompleted ? color : hexToRgba(color, 0.4),
              }}
              exit={{ scaleX: 0, opacity: 0 }}
              transition={fillTransition}
            />
          )}
        </AnimatePresence>

        {/* Active breathing pulse overlay */}
        {isActive && (
          <motion.div
            className="absolute inset-0"
            style={{ backgroundColor: color }}
            animate={{
              opacity: [0.4, 0.8, 0.4],
            }}
            transition={{
              duration: 2.4,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        )}
      </div>

      {/* Label row */}
      <div className="flex items-center gap-1">
        <span
          className={cn(
            "font-mono text-[10px] font-medium uppercase tracking-wider transition-colors duration-300",
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
              "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[9px] font-semibold tabular-nums transition-colors duration-300",
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
