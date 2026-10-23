import type { ReactNode } from 'react';
export function ViewerToolbar({ children }: { children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label="File actions"
      data-testid="viewer-toolbar"
      className="file-viewer-toolbar"
    >
      {children}
    </div>
  );
}
