import type { ReactNode } from 'react';
export function ViewerToolbar({ children }: { children: ReactNode }) {
  return (
    <div data-testid="viewer-toolbar" className="file-viewer-toolbar">
      {children}
    </div>
  );
}
