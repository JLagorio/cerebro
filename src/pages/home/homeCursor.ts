import { createContext } from 'react';
import type { HomeRow } from '@/engine/homeLanes';
import type { ListCursor } from '@/hooks/useListCursor';
import type { useHomeDone } from './useHomeDone';
export const HomeCursorContext = createContext<{
  cursor: ListCursor;
  rows: Map<string, HomeRow>;
  done: ReturnType<typeof useHomeDone>;
} | null>(null);
