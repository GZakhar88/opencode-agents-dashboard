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
 *
 * Project filtering logic (Phase 6):
 * - Active projects: connected OR disconnected < 1 hour — shown by default
 * - Stale projects: disconnected > 1 hour — hidden by default, revealed via link
 * - Completed projects: all beads done — dimmed with checkmark overlay
 */

import { useState, useEffect, useRef, useMemo } from "react";
import type { ProjectState } from "@shared/types";
import { useEventSource } from "@/hooks/useEventSource";
import { useBoardState } from "@/hooks/useBoardState";
import { MotionConfig } from "framer-motion";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { StatusIndicator } from "@/components/StatusIndicator";
import { GlobalStats } from "@/components/GlobalStats";
import { ProjectSection } from "@/components/ProjectSection";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Link2Off, ServerOff, Eye, EyeOff, ChevronDown, Clock, ChevronRight } from "lucide-react";
import { FOCUS_RING } from "@/lib/styles";
import { cn } from "@/lib/utils";

/** Stale threshold: projects disconnected longer than this are hidden by default */
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export default function App() {
  return (
    <ErrorBoundary>
      <DashboardApp />
    </ErrorBoundary>
  );
}

/**
 * Check if a project is completed (has zero non-done beads).
 * A completed project is one where all beads are in "done" stage.
 * Projects with no beads are NOT considered completed (they're just empty).
 */
export function isProjectCompleted(project: ProjectState): boolean {
  let hasBead = false;
  for (const pipeline of project.pipelines.values()) {
    for (const bead of pipeline.beads.values()) {
      hasBead = true;
      if (bead.stage !== "done") {
        return false;
      }
    }
  }
  return hasBead;
}

/**
 * Check if a project is stale (disconnected for longer than the threshold).
 * Connected projects are never stale.
 */
export function isProjectStale(project: ProjectState, now: number): boolean {
  if (project.connected) return false;
  return (now - project.lastHeartbeat) > STALE_THRESHOLD_MS;
}

/**
 * Sort weight for visual ordering of projects.
 * Higher weight = shown first.
 *   3 = active (connected, has active pipelines)
 *   2 = idle (connected, no active pipelines)
 *   1 = recently disconnected (< 1 hour)
 *   0 = stale (disconnected > 1 hour)
 */
function projectSortWeight(project: ProjectState, now: number): number {
  if (!project.connected) {
    return isProjectStale(project, now) ? 0 : 1;
  }
  for (const pipeline of project.pipelines.values()) {
    if (pipeline.status === "active") return 3;
  }
  return 2;
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
    try {
      return localStorage.getItem("dashboard:showCompleted") === "true";
    } catch {
      return false;
    }
  });

  // Toggle state for showing/hiding stale projects (persisted to localStorage)
  const [showStale, setShowStale] = useState(() => {
    try {
      return localStorage.getItem("dashboard:showStale") === "true";
    } catch {
      return false;
    }
  });

  // Persist toggle states to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("dashboard:showCompleted", String(showCompleted));
    } catch {
      // Storage full or unavailable — silently ignore
    }
  }, [showCompleted]);

  useEffect(() => {
    try {
      localStorage.setItem("dashboard:showStale", String(showStale));
    } catch {
      // Storage full or unavailable — silently ignore
    }
  }, [showStale]);

  // Tick every 30s to re-evaluate stale detection based on elapsed time
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const projects = Array.from(state.projects.values());

  // Categorize projects into active, completed, and stale
  // Depends on state.projects (Map reference) rather than the derived array
  // to avoid re-computing on every render.
  const { activeProjects, completedProjects, staleProjects } = useMemo(() => {
    const all = Array.from(state.projects.values());
    const active: ProjectState[] = [];
    const completed: ProjectState[] = [];
    const stale: ProjectState[] = [];

    for (const p of all) {
      if (isProjectStale(p, now)) {
        // Stale projects are always in the stale bucket regardless of completion
        stale.push(p);
      } else if (isProjectCompleted(p)) {
        completed.push(p);
      } else {
        active.push(p);
      }
    }

    return { activeProjects: active, completedProjects: completed, staleProjects: stale };
  }, [state.projects, now]);

  // Build the displayed project list based on filter states
  // Active projects are always shown. Completed projects only if toggled.
  const displayedProjects = useMemo(() => {
    const result = [...activeProjects];
    if (showCompleted) {
      result.push(...completedProjects);
    }

    // Sort by visual weight (active > idle > recently disconnected)
    return result.sort((a, b) => projectSortWeight(b, now) - projectSortWeight(a, now));
  }, [activeProjects, completedProjects, showCompleted, now]);

  // Stale projects are shown separately (in a collapsed list at the bottom)
  const sortedStaleProjects = useMemo(() => {
    return [...staleProjects].sort((a, b) => b.lastHeartbeat - a.lastHeartbeat);
  }, [staleProjects]);

  const isInitialLoad = status === "connecting" && projects.length === 0;

  // Detect permanent failure: disconnected with no data
  const isPermanentlyDisconnected =
    status === "disconnected" && projects.length === 0;

  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delayDuration={300}>
        <div className="min-h-screen bg-background">
          {/* Command bar header */}
          <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="flex items-center gap-4 px-4 py-2.5 sm:px-6">
              {/* Logo + title — compact */}
              <h1 className="shrink-0 text-sm font-bold tracking-tight text-foreground">
                OpenCode<span className="hidden sm:inline font-normal text-muted-foreground/70"> Dashboard</span>
              </h1>

              {/* Vertical divider */}
              <div className="hidden h-4 w-px bg-border sm:block" />

              {/* Aggregate stats */}
              <GlobalStats projects={projects} />

              {/* Spacer */}
              <div className="flex-1" />

              {/* Completed projects filter — compact dropdown-style toggle */}
              {completedProjects.length > 0 && (
                <CompletedToggle
                  count={completedProjects.length}
                  showCompleted={showCompleted}
                  onToggle={() => setShowCompleted(!showCompleted)}
                />
              )}

              {/* Connection status */}
              <StatusIndicator status={status} />
            </div>
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
                  <ProjectSection
                    key={project.projectPath}
                    project={project}
                    isCompleted={isProjectCompleted(project)}
                  />
                ))}
              </div>
            )}

            {/* Stale projects footer — collapsed list of disconnected > 1h projects */}
            {sortedStaleProjects.length > 0 && (
              <StaleProjectsFooter
                projects={sortedStaleProjects}
                showStale={showStale}
                onToggle={() => setShowStale(!showStale)}
              />
            )}
          </main>
        </div>
      </TooltipProvider>
    </MotionConfig>
  );
}

/**
 * StaleProjectsFooter — Compact footer showing count of stale (disconnected > 1h) projects.
 *
 * When collapsed: shows "N stale projects" link.
 * When expanded: reveals the stale projects in a dimmed list.
 */
function StaleProjectsFooter({
  projects,
  showStale,
  onToggle,
}: {
  projects: ProjectState[];
  showStale: boolean;
  onToggle: () => void;
}) {
  const count = projects.length;

  return (
    <div className="mt-8">
      {/* Stale projects toggle link */}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "group mx-auto flex items-center gap-2 rounded-lg px-4 py-2 text-xs text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-muted-foreground",
          FOCUS_RING,
        )}
        aria-expanded={showStale}
        aria-label={`${showStale ? "Hide" : "Show"} ${count} stale project${count !== 1 ? "s" : ""}`}
      >
        <Clock className="h-3 w-3" />
        <span className="font-medium">
          {count} stale project{count !== 1 ? "s" : ""}
        </span>
        <ChevronRight
          className={cn(
            "h-3 w-3 transition-transform duration-200",
            showStale && "rotate-90",
          )}
        />
      </button>

      {/* Expanded stale projects list */}
      {showStale && (
        <div className="mt-3 project-grid stale-projects-grid">
          {projects.map((project) => (
            <ProjectSection
              key={project.projectPath}
              project={project}
              isCompleted={isProjectCompleted(project)}
              isStale
            />
          ))}
        </div>
      )}
    </div>
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
      <div className="mb-4 rounded-full bg-status-error/10 p-4">
        <ServerOff className="h-8 w-8 text-status-error" />
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

/**
 * CompletedToggle — Compact filter toggle for showing/hiding completed projects.
 * 
 * Renders as a small, pill-shaped button in the header command bar.
 * Uses a dropdown-style visual language (chevron + count badge).
 */
function CompletedToggle({
  count,
  showCompleted,
  onToggle,
}: {
  count: number;
  showCompleted: boolean;
  onToggle: () => void;
}) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Close dropdown on outside click or Escape key
  useEffect(() => {
    if (!isDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isDropdownOpen]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsDropdownOpen(!isDropdownOpen)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          showCompleted && "border-status-live/30 text-foreground",
          FOCUS_RING,
        )}
        aria-expanded={isDropdownOpen}
        aria-haspopup="true"
        aria-label={`${showCompleted ? "Showing" : "Hiding"} ${count} completed project${count !== 1 ? "s" : ""}`}
      >
        {showCompleted ? (
          <Eye className="h-3 w-3 text-status-live" />
        ) : (
          <EyeOff className="h-3 w-3" />
        )}
        <span className="hidden sm:inline">Completed</span>
        <span className={cn(
          "inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold tabular-nums leading-none",
          showCompleted
            ? "bg-status-live/15 text-status-live"
            : "bg-muted text-muted-foreground",
        )}>
          {count}
        </span>
        <ChevronDown className={cn(
          "h-3 w-3 transition-transform duration-150",
          isDropdownOpen && "rotate-180",
        )} />
      </button>

      {/* Dropdown panel */}
      {isDropdownOpen && (
        <div
          className="absolute right-0 top-full z-20 mt-1.5 w-48 rounded-lg border border-border bg-popover p-1 shadow-lg shadow-black/20"
          role="menu"
          aria-label="Completed projects filter"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!showCompleted}
            onClick={() => {
              if (showCompleted) onToggle();
              setIsDropdownOpen(false);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-accent",
              !showCompleted && "bg-accent/50 text-foreground",
              FOCUS_RING,
            )}
          >
            <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Hide completed</span>
            {!showCompleted && (
              <span className="ml-auto text-[10px] text-status-live">✓</span>
            )}
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={showCompleted}
            onClick={() => {
              if (!showCompleted) onToggle();
              setIsDropdownOpen(false);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-accent",
              showCompleted && "bg-accent/50 text-foreground",
              FOCUS_RING,
            )}
          >
            <Eye className="h-3.5 w-3.5 text-status-live" />
            <span>Show completed</span>
            <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {count}
            </span>
            {showCompleted && (
              <span className="text-[10px] text-status-live">✓</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
