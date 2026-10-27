import type { ReactNode } from 'react';
import { SectionBoundary } from '@/components/ui/SectionBoundary';
import { flushOpenPages, prepareOpenPages } from '@/editor/openPages';
import { useQuitHost } from './quit';

/** A fault keeps what was typed (M93.12): the open pages flush, as a leave
 * does, before anything else can be asked of them. */
export function keepOpenPages(): void {
  prepareOpenPages();
  void flushOpenPages().catch(() => undefined);
}

/** One section whose render fault stays its own; see SectionBoundary. */
export function Contained({
  label,
  resetKey,
  onBack,
  compact,
  children,
}: {
  label: string;
  resetKey?: unknown;
  onBack?: () => void;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <SectionBoundary
      label={label}
      resetKey={resetKey}
      onBack={onBack}
      compact={compact}
      onCatch={keepOpenPages}
    >
      {children}
    </SectionBoundary>
  );
}

/** While the whole window is down, ⌘Q, the close button and ⌘W still save
 * and quit: App's own quit host went with it. */
function QuitHostWhileDown() {
  useQuitHost();
  return null;
}

/** The last boundary, around App. Its fallback never reloads: a reload would
 * drop every memory-only owner, draft and open log (BL-01). */
export function RootBoundary({ children }: { children: ReactNode }) {
  return (
    <SectionBoundary
      label="Cerebro"
      onCatch={keepOpenPages}
      fallbackClassName="flex h-screen items-center justify-center bg-n-0 p-6"
      whileFailed={<QuitHostWhileDown />}
    >
      {children}
    </SectionBoundary>
  );
}
