/**
 * PipelineHeader — Pipeline title and status badge.
 *
 * Displays: pipeline title, status badge (LIVE/IDLE/DONE), expand/collapse toggle.
 * Status colors: active=green, idle=gray, done=blue.
 */

import type { Pipeline, PipelineStatus } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp } from "lucide-react";
import { FOCUS_RING } from "@/lib/styles";
import { cn } from "@/lib/utils";

interface PipelineHeaderProps {
  pipeline: Pipeline;
  isExpanded: boolean;
  onToggle: () => void;
}

const STATUS_CONFIG: Record<
  PipelineStatus,
  { label: string; className: string }
> = {
  active: {
    label: "LIVE",
    className: "border-green-500/50 bg-green-500/10 text-green-400",
  },
  idle: {
    label: "IDLE",
    className: "border-gray-500/50 bg-gray-500/10 text-gray-400",
  },
  done: {
    label: "DONE",
    className: "border-blue-500/50 bg-blue-500/10 text-blue-400",
  },
};

export function PipelineHeader({ pipeline, isExpanded, onToggle }: PipelineHeaderProps) {
  const config = STATUS_CONFIG[pipeline.status] ?? STATUS_CONFIG.idle;

  return (
    <div className="flex items-center gap-3 py-2">
      {/* Expand/collapse toggle button */}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          FOCUS_RING,
        )}
        aria-label={isExpanded ? "Collapse board" : "Expand board"}
      >
        {isExpanded ? (
          <>
            <ChevronUp className="h-3 w-3" />
            <span>Collapse</span>
          </>
        ) : (
          <>
            <ChevronDown className="h-3 w-3" />
            <span>Expand</span>
          </>
        )}
      </button>
      <h3 className="text-sm font-medium text-foreground">
        {pipeline.title}
      </h3>
      <Badge
        variant="outline"
        className={cn("text-[10px] px-2 py-0", config.className)}
      >
        {config.label}
      </Badge>
      <span className="text-xs text-muted-foreground">
        {pipeline.beads.size} bead{pipeline.beads.size !== 1 ? "s" : ""}
      </span>
    </div>
  );
}
