import type { PaneId } from './panes';

export type PageCreationRecipe = { kind: 'blank' } | { kind: 'sheet'; sheetName: 'Sheet1' };
export type CreationDestination =
  | { kind: 'page'; folder: string; recipe: PageCreationRecipe }
  | {
      kind: 'record';
      typeName: string;
      host: { path: string; field: string } | null;
      group: { field: string; value: string } | null;
    };
export type CreationContext = { vault: string; pane: PaneId; destination: CreationDestination };

/** Pane is a focus origin, not another owner of the same unfinished draft. */
export function creationDraftKey({ vault, destination: d }: CreationContext): string {
  return JSON.stringify(
    d.kind === 'page'
      ? [
          vault,
          'page',
          d.folder,
          d.recipe.kind,
          d.recipe.kind === 'sheet' ? d.recipe.sheetName : null,
        ]
      : [
          vault,
          'record',
          d.typeName,
          d.host?.path ?? null,
          d.host?.field ?? null,
          d.group?.field ?? null,
          d.group?.value ?? null,
        ],
  );
}
