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

import { useEventSource } from "@/hooks/useEventSource";
import { useBoardState } from "@/hooks/useBoardState";
import { MotionConfig } from "framer-motion";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { StatusIndicator } from "@/components/StatusIndicator";
import { ProjectSection } from "@/components/ProjectSection";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Link2Off, ServerOff } from "lucide-react";
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
 * Inner dashboard component — separated from App so that the ErrorBoundary
 * wraps all hook-level and rendering errors.
 */
function DashboardApp() {
  const { state, dispatch } = useBoardState();

  const { status, reconnect } = useEventSource({
    onEvent: dispatch,
  });

  const projects = Array.from(state.projects.values());
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
                  Real-time multi-agent pipeline visualization
                </p>
              </div>
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

            {projects.length > 0 && (
              <div className="space-y-2">
                {projects.map((project, index) => (
                  <div key={project.projectPath}>
                    {index > 0 && <Separator className="my-4" />}
                    <ProjectSection project={project} />
                  </div>
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
        Start an OpenCode session with the dashboard plugin to see pipelines
        here.
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
