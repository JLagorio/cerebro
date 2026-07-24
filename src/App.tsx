export default function App() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-sunken">
      <div className="rounded-xl border border-n-200 bg-surface-raised px-8 py-6 shadow-[var(--shadow-sm)]">
        <h1 className="font-sans text-2xl font-semibold tracking-[var(--track-tight)] text-n-900">
          Cerebro
        </h1>
        <p className="mt-1 text-[length:var(--text-sm)] text-[color:var(--text-secondary)]">
          Files-first work management
        </p>
        <code className="mt-3 inline-block font-mono text-xs text-cortex-600">
          vault: not opened
        </code>
      </div>
    </main>
  );
}
