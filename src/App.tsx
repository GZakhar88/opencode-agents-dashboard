export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">
          OpenCode Dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Real-time multi-agent pipeline visualization
        </p>
      </header>
      <main>
        <p className="text-muted-foreground">
          Connecting to server...
        </p>
      </main>
    </div>
  );
}
