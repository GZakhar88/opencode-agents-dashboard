/**
 * App — Main dashboard layout.
 *
 * Wires up useEventSource + useBoardState to provide real-time
 * Kanban board visualization of all connected projects.
 *
 * Wraps everything in:
 * - ErrorBoundary: catches React rendering errors, prevents white screen
 * - MotionConfig: respects OS-level prefers-reduced-motion setting
 * - ReconnectBanner: visible reconnection/disconnection notification
 */

import { useState, useEffect } from "react";
import type { ProjectState } from "@shared/types";
import { useEventSource } from "@/hooks/useEventSource";
import { useBoardState } from "@/hooks/useBoardState";
import { MotionConfig } from "framer-motion";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { StatusIndicator } from "@/components/StatusIndicator";
import { ProjectSection } from "@/components/ProjectSection";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Link2Off, ServerOff, ChevronDown, ChevronUp } from "lucide-react";
import { FOCUS_RING } from "@/lib/styles";
import { cn } from "@/lib/utils";

export default function App() {
  return (
    <ErrorBoundary>
      <DashboardApp />
    </ErrorBoundary>
  );
}

/**
 * Check if a project is completed (has zero non-done beads).
 * A completed project is one where all beads are in "done" stage,
 * or has no beads at all.
 */
function isProjectCompleted(project: ProjectState): boolean {
  for (const pipeline of project.pipelines.values()) {
    for (const bead of pipeline.beads.values()) {
      if (bead.stage !== "done") {
        return false;
      }
    }
  }
  return true;
}

/**
 * Inner dashboard component — separated from App so that the ErrorBoundary
 * wraps all hook-level and rendering errors.
 */
function DashboardApp() {
  const { state, dispatch } = useBoardState();

  const { status, reconnect } = useEventSource({
    onEvent: dispatch,
  });

  // Toggle state for showing/hiding completed projects (persisted to localStorage)
  const [showCompleted, setShowCompleted] = useState(() => {
    const stored = localStorage.getItem("dashboard:showCompleted");
    return stored === "true";
  });

  // Persist toggle state to localStorage
  useEffect(() => {
    localStorage.setItem("dashboard:showCompleted", String(showCompleted));
  }, [showCompleted]);

  const projects = Array.from(state.projects.values());
  
  // Split projects into active and completed
  const activeProjects = projects.filter((p) => !isProjectCompleted(p));
  const completedProjects = projects.filter((p) => isProjectCompleted(p));
  
  // Projects to display based on toggle state, sorted by visual weight:
  // active (connected with active pipelines) > idle (connected) > disconnected
  const unsorted = showCompleted ? projects : activeProjects;
  const displayedProjects = [...unsorted].sort((a, b) => {
    const weight = (p: ProjectState) => {
      if (!p.connected) return 0;
      for (const pipeline of p.pipelines.values()) {
        if (pipeline.status === "active") return 2;
      }
      return 1;
    };
    return weight(b) - weight(a);
  });
  
  const isInitialLoad = status === "connecting" && projects.length === 0;

  // Detect permanent failure: disconnected with no data
  const isPermanentlyDisconnected =
    status === "disconnected" && projects.length === 0;

  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delayDuration={300}>
        <div className="min-h-screen bg-background">
          {/* Global header */}
          <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="flex items-center justify-between px-6 py-4">
              <div>
                <h1 className="text-xl font-bold text-foreground">
                  OpenCode Dashboard
                </h1>
                <p className="text-xs text-muted-foreground">
                  Real-time agent activity dashboard
                </p>
              </div>
              <StatusIndicator status={status} />
            </div>
            
            {/* Completed projects toggle — shown when there are completed projects */}
            {completedProjects.length > 0 && (
              <div className="border-t px-6 py-2">
                <button
                  type="button"
                  onClick={() => setShowCompleted(!showCompleted)}
                  className={cn(
                    "inline-flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground",
                    FOCUS_RING,
                  )}
                >
                  {showCompleted ? (
                    <>
                      <ChevronUp className="h-3 w-3" />
                      <span>
                        Showing {completedProjects.length} completed project
                        {completedProjects.length !== 1 ? "s" : ""}
                      </span>
                      <span className="text-muted-foreground/70">(Hide)</span>
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3 w-3" />
                      <span>
                        {completedProjects.length} completed project
                        {completedProjects.length !== 1 ? "s" : ""} hidden
                      </span>
                      <span className="text-muted-foreground/70">(Show)</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </header>

          {/* Reconnection banner — slides in below header when connection is lost */}
          <ReconnectBanner status={status} onReconnect={reconnect} />

          {/* Main content */}
          <main className="px-6 py-6">
            {isInitialLoad && <LoadingSkeleton />}

            {isPermanentlyDisconnected && (
              <DisconnectedState onReconnect={reconnect} />
            )}

            {!isInitialLoad &&
              !isPermanentlyDisconnected &&
              projects.length === 0 && <EmptyState />}

            {displayedProjects.length > 0 && (
              <div className="project-grid">
                {displayedProjects.map((project) => (
                  <ProjectSection key={project.projectPath} project={project} />
                ))}
              </div>
            )}
          </main>
        </div>
      </TooltipProvider>
    </MotionConfig>
  );
}

/** Empty state shown when no projects are connected */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24">
      <div className="mb-4 rounded-full bg-muted p-4">
        <Link2Off className="h-8 w-8 text-muted-foreground" />
      </div>
      <h2 className="mb-1 text-lg font-semibold text-foreground">
        No projects connected
      </h2>
      <p className="text-sm text-muted-foreground">
        Start an OpenCode session with the dashboard plugin to see agent
        activity here.
      </p>
    </div>
  );
}

/** Disconnected state — server unreachable, helpful recovery message */
function DisconnectedState({ onReconnect }: { onReconnect: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center py-24"
    >
      <div className="mb-4 rounded-full bg-red-500/10 p-4">
        <ServerOff className="h-8 w-8 text-red-400" />
      </div>
      <h2 className="mb-1 text-lg font-semibold text-foreground">
        Unable to connect to server
      </h2>
      <p className="mb-2 text-sm text-muted-foreground">
        The dashboard server appears to be offline. Please check that:
      </p>
      <ul className="mb-6 list-inside list-disc text-sm text-muted-foreground">
        <li>
          The server is running (
          <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">
            bun run server
          </code>
          )
        </li>
        <li>It&apos;s accessible on the expected port</li>
        <li>No firewall is blocking the connection</li>
      </ul>
      <button
        type="button"
        onClick={onReconnect}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent",
          FOCUS_RING,
        )}
      >
        Try Reconnecting
      </button>
    </div>
  );
}
