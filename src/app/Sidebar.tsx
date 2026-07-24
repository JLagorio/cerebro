export function Sidebar() {
  return (
    <nav
      aria-label="Sidebar"
      className="flex w-[264px] flex-none flex-col overflow-hidden border-r border-[var(--n-200)] bg-[var(--surface-sunken)]"
    >
      <div className="flex items-center justify-between pb-2 pl-4 pr-3 pt-3.5">
        <h1 className="m-0 text-[15px] font-semibold text-[var(--n-900)]">Workspace</h1>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {/* Spaces tree + views section land in Task 18 */}
      </div>
    </nav>
  );
}
