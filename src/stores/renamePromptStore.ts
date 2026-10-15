import { create } from 'zustand';

export interface RenamePrompt {
  vault: string;
  from: string;
  to: string;
  /** Original path for board cards that keep their pointer after the move. */
  fromPath?: string;
  pages: { path: string; title: string; count: number }[];
  anchors: { path: string; title: string }[];
  refused: { path: string; title: string; count: number }[];
  sources: { path: string; title: string; resource: string; board?: true }[];
}

interface RenamePromptState {
  pending: (RenamePrompt & { id: number }) | null;
  answer(accepted: boolean, id?: number): void;
  cancel(): void;
}

let sequence = 0;
let resolvePending: ((accepted: boolean) => void) | null = null;

/** A rename waits for one answer; replacing or closing its prompt cancels it. */
export const useRenamePromptStore = create<RenamePromptState>()((set, get) => ({
  pending: null,
  answer: (accepted, id) => {
    if (id !== undefined && get().pending?.id !== id) return;
    const resolve = resolvePending;
    resolvePending = null;
    set({ pending: null });
    resolve?.(accepted);
  },
  cancel: () => get().answer(false),
}));

/** A second request settles the first as cancelled, never leaving a writer waiting. */
export function askRename(prompt: RenamePrompt): Promise<boolean> {
  useRenamePromptStore.getState().cancel();
  return new Promise((resolve) => {
    resolvePending = resolve;
    sequence += 1;
    useRenamePromptStore.setState({ pending: { ...prompt, id: sequence } });
  });
}
