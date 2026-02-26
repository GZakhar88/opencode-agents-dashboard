/**
 * ErrorBoundary — Catches React rendering errors and shows a recovery UI.
 *
 * Prevents the "white screen of death" by catching unhandled errors
 * in the component tree and displaying a user-friendly message with
 * options to retry or reload the page.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { FOCUS_RING } from "@/lib/styles";
import { cn } from "@/lib/utils";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback component. If not provided, uses default error UI. */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    // Log error for debugging (visible in browser console)
    console.error("[ErrorBoundary] Caught error:", error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          role="alert"
          className="flex min-h-screen items-center justify-center bg-background p-6"
        >
          <div className="w-full max-w-md rounded-lg border border-status-error/30 bg-status-error/5 p-6">
            {/* Icon */}
            <div className="mb-4 flex justify-center">
              <div className="rounded-full bg-status-error/10 p-3">
                <AlertTriangle className="h-8 w-8 text-status-error" />
              </div>
            </div>

            {/* Message */}
            <h2 className="mb-2 text-center text-lg font-semibold text-foreground">
              Something went wrong
            </h2>
            <p className="mb-4 text-center text-sm text-muted-foreground">
              The dashboard encountered an unexpected error. You can try
              recovering or reload the page.
            </p>

            {/* Error details (collapsible) */}
            {this.state.error && (
              <details className="mb-4 rounded border border-border bg-muted/30 p-3">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Error details
                </summary>
                <pre className="mt-2 overflow-auto font-mono text-xs text-status-error">
                  {this.state.error.message}
                  {this.state.errorInfo?.componentStack && (
                    <>
                      {"\n\nComponent stack:"}
                      {this.state.errorInfo.componentStack}
                    </>
                  )}
                </pre>
              </details>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={this.handleRetry}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent",
                  FOCUS_RING,
                )}
              >
                <RefreshCw className="h-4 w-4" />
                Try Again
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90",
                  FOCUS_RING,
                )}
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
