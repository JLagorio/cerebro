import type { Selection } from '@/engine/types';
import type { NavSlot } from '@/stores/navStore';
/** Keep fixture histories in the same slot shape as real navigation. */
export const navSeed = (selection: Selection): NavSlot => ({ selection, byAgent: false });
