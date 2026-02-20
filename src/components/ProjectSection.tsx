/**
 * ProjectSection — Collapsible project container.
 *
 * Displays: project name, directory path, connection status badge.
 * Renders all pipelines for this project, each with PipelineHeader + Board.
 * Uses shadcn Collapsible for expand/collapse.
 */

import { useState, useEffect } from "react";
import type { ProjectState } from "@shared/types";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PipelineHeader } from "@/components/PipelineHeader";
import { Board } from "@/components/Board";
import { formatLastSeen } from "@/lib/format";
import { cn } from "@/lib/utils";

interface ProjectSectionProps {
  project: ProjectState;
}

export function ProjectSection({ project }: ProjectSectionProps) {
  const [isOpen, setIsOpen] = useState(true);
  const pipelines = Array.from(project.pipelines.values());

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      {/* Project header */}
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-expanded={isOpen}
          className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-accent/50"
        >
          {/* Expand/collapse chevron */}
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              isOpen && "rotate-90",
            )}
          />

          {/* Project name */}
          <h2 className="text-base font-semibold text-foreground">
            {project.projectName}
          </h2>

          {/* Directory path */}
          <span className="truncate text-xs text-muted-foreground">
            {project.projectPath}
          </span>

          {/* Spacer */}
          <span className="flex-1" />

          {/* Connection status badge */}
          <ConnectionBadge
            connected={project.connected}
            lastHeartbeat={project.lastHeartbeat}
          />
        </button>
      </CollapsibleTrigger>

      {/* Pipelines */}
      <CollapsibleContent>
        <div className="pl-7 pr-4 pb-4">
          {pipelines.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No active pipelines
            </p>
          ) : (
            pipelines.map((pipeline, index) => (
              <div key={pipeline.id}>
                {index > 0 && <Separator className="my-3" />}
                <PipelineHeader pipeline={pipeline} />
                <Board pipeline={pipeline} />
              </div>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Connection status badge with dot indicator */
function ConnectionBadge({
  connected,
  lastHeartbeat,
}: {
  connected: boolean;
  lastHeartbeat: number;
}) {
  // Tick every 10s to keep "last seen" time fresh when disconnected
  const [, setTick] = useState(0);
  useEffect(() => {
    if (connected) return;
    const timer = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(timer);
  }, [connected]);

  if (connected) {
    return (
      <Badge
        variant="outline"
        className="shrink-0 gap-1.5 border-green-500/50 bg-green-500/10 text-green-400"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
        Connected
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="shrink-0 gap-1.5 border-red-500/50 bg-red-500/10 text-red-400"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
      Disconnected · {formatLastSeen(lastHeartbeat)}
    </Badge>
  );
}
