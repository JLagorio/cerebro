import { Icon } from '@/components/ui/Icon';
import { useUiStore } from '@/stores/uiStore';

/**
 * The pin (M43). One control, three headers — doc page, record panel, agent
 * page — so "this matters, keep it near" is the same gesture everywhere.
 * Warn-500 when pinned: the design's star, and the one warm color the chrome
 * spends on a deliberate user mark.
 */
export function FavoriteStar({ path }: { path: string }) {
  const favorites = useUiStore((s) => s.favorites);
  const toggleFavorite = useUiStore((s) => s.toggleFavorite);
  const on = favorites.includes(path);
  return (
    <button
      type="button"
      data-testid="favorite-star"
      aria-pressed={on}
      aria-label={on ? 'Remove from favorites' : 'Add to favorites'}
      onClick={() => toggleFavorite(path)}
      className="flex h-6 w-6 flex-none items-center justify-center rounded-md border-0 bg-transparent hover:bg-n-100"
    >
      <Icon name="star" size={14} color={on ? 'var(--warn-500)' : 'var(--n-400)'} />
    </button>
  );
}
