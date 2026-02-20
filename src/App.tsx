/**
 * App — Main dashboard layout.
 *
 * Wires up useEventSource + useBoardState to provide real-time
 * Kanban board visualization of all connected projects.
 *
 * Wraps everything in MotionConfig with reducedMotion="user" so that
 * all Framer Motion animations respect the OS-level prefers-reduced-motion setting.
 */

import { useEventSource } from "@/hooks/useEventSource";
import { useBoardState } from "@/hooks/useBoardState";
import { MotionConfig } from "framer-motion";
import { StatusIndicator } from "@/components/StatusIndicator";
import { ProjectSection } from "@/components/ProjectSection";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Link2Off } from "lucide-react";

export default function App() {
  const { state, dispatch } = useBoardState();

  const { status } = useEventSource({
    onEvent: dispatch,
  });

  const projects = Array.from(state.projects.values());
  const isInitialLoad = status === "connecting" && projects.length === 0;

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

          {/* Main content */}
          <main className="px-6 py-6">
            {isInitialLoad && <LoadingSkeleton />}

            {!isInitialLoad && projects.length === 0 && <EmptyState />}

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
