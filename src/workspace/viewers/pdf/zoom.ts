export type PdfScale = number | 'page-width' | 'page-fit';
export const clampZoom = (scale: number): number => Math.max(0.25, Math.min(4, scale));
export const stepZoom = (scale: number, direction: 1 | -1): number =>
  clampZoom(Math.round(scale * (direction === 1 ? 1.1 : 1 / 1.1) * 100) / 100);
export function pageNumber(input: string, total: number): number | null {
  if (!/^\d+$/.test(input.trim()) || total < 1) return null;
  return Math.max(1, Math.min(total, Number(input)));
}
