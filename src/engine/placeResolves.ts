import type { CollectionFile, Entry, KnowledgeNav, ListFile, Selection } from './types';
import { agentRef, isAgentEntry } from './agents';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const optionalText = (value: unknown): boolean => value === undefined || text(value);
function rejectedKind(_kind: never): null {
  return null;
}
function readNav(raw: unknown): KnowledgeNav | null {
  if (!object(raw)) return null;
  const tab = raw.tab as KnowledgeNav['tab'];
  switch (tab) {
    case 'all':
    case 'review':
    case 'activity':
      return { tab };
    case 'section':
      return typeof raw.folder === 'string' ? { tab, folder: raw.folder } : null;
    case 'entity':
      return text(raw.key) ? { tab, key: raw.key } : null;
    case 'runs':
      return optionalText(raw.run)
        ? { tab, ...(raw.run === undefined ? {} : { run: raw.run as string }) }
        : null;
    default:
      return rejectedKind(tab);
  }
}
/** A persisted place is data, never trusted as a cast to Selection. Unknown
 * keys are dropped; every kind's own required fields and lenses are checked. */
export function readSelection(raw: unknown): Selection | null {
  if (!object(raw)) return null;
  const kind = raw.kind as Selection['kind'];
  const pick = (key: string) => (raw[key] === undefined ? {} : { [key]: raw[key] });
  switch (kind) {
    case 'home':
    case 'pages':
    case 'inbox':
    case 'mywork':
    case 'changes':
    case 'pulse':
    case 'settings':
      return { kind };
    case 'doc':
      return text(raw.path) && optionalText(raw.tab) && optionalText(raw.thread)
        ? { kind, path: raw.path, ...pick('tab'), ...pick('thread') }
        : null;
    case 'diagram':
    case 'file':
      return text(raw.path) ? { kind, path: raw.path } : null;
    case 'collection':
      return typeof raw.folder === 'string' ? { kind, folder: raw.folder } : null;
    case 'type':
      return text(raw.name) && optionalText(raw.view)
        ? { kind, name: raw.name, ...pick('view') }
        : null;
    case 'list':
      return text(raw.id) &&
        optionalText(raw.view) &&
        (raw.collection == null || typeof raw.collection === 'string')
        ? { kind, id: raw.id, ...pick('view'), ...pick('collection') }
        : null;
    case 'knowledge': {
      if (!optionalText(raw.path)) return null;
      const nav = raw.nav === undefined ? undefined : readNav(raw.nav);
      return nav === null ? null : { kind, ...pick('path'), ...(nav === undefined ? {} : { nav }) };
    }
    case 'library':
      if (raw.tab === 'workflow')
        return optionalText(raw.workflowId)
          ? { kind, tab: 'workflow', ...pick('workflowId') }
          : null;
      return optionalText(raw.path) &&
        (raw.tab === undefined ||
          raw.tab === 'skill' ||
          raw.tab === 'agent' ||
          raw.tab === 'template')
        ? { kind, ...pick('path'), ...pick('tab') }
        : null;
    case 'workspace':
      return optionalText(raw.root) && (raw.path === undefined || typeof raw.path === 'string')
        ? { kind, ...pick('root'), ...pick('path') }
        : null;
    case 'studio':
      return optionalText(raw.project) ? { kind, ...pick('project') } : null;
    case 'agents':
      return optionalText(raw.actor) ? { kind, ...pick('actor') } : null;
    default:
      return rejectedKind(kind);
  }
}
/** Thread and run highlights belong to the visit, not the next app launch. */
export function restorablePlace(selection: Selection): Selection {
  if (selection.kind === 'doc') {
    const { thread: _thread, ...place } = selection;
    return place;
  }
  if (selection.kind === 'knowledge' && selection.nav?.tab === 'runs')
    return { ...selection, nav: { tab: 'runs' } };
  return selection;
}
export interface PlaceSnapshot {
  /** Files absent from a successful byte probe, never inferred from the scan. */
  missingFiles?: readonly string[];
  entries: readonly Entry[];
  collections: readonly CollectionFile[];
  views: readonly ListFile[];
  types: readonly string[];
  roots: readonly { id: string }[];
  rootsLoaded: boolean;
  inboxEnabled: boolean;
  folders: readonly string[];
}
export function placeResolves(selection: Selection, snapshot: PlaceSnapshot): boolean {
  const hasPath = (path: string) => snapshot.entries.some((entry) => entry.path === path);
  switch (selection.kind) {
    case 'home':
    case 'pages':
    case 'mywork':
    case 'changes':
    case 'pulse':
    case 'settings':
      return true;
    case 'inbox':
      return snapshot.inboxEnabled;
    case 'file':
      return !snapshot.missingFiles?.includes(selection.path);
    case 'doc':
    case 'diagram':
      return hasPath(selection.path);
    case 'knowledge':
    case 'library':
      return selection.path === undefined || hasPath(selection.path);
    case 'collection':
      return snapshot.collections.some((collection) => collection.folder === selection.folder);
    case 'list':
      return snapshot.views.some(
        (view) =>
          view.id === selection.id &&
          (selection.collection === undefined || view.collection === selection.collection),
      );
    case 'type':
      return snapshot.types.includes(selection.name);
    case 'workspace':
      return (
        selection.root === undefined ||
        !snapshot.rootsLoaded ||
        snapshot.roots.some((root) => root.id === selection.root)
      );
    case 'studio':
      return (
        selection.project === undefined ||
        snapshot.folders.includes(`studio/${selection.project}`) ||
        snapshot.entries.some((entry) => entry.path.startsWith(`studio/${selection.project}/`))
      );
    case 'agents':
      return (
        selection.actor === undefined ||
        !selection.actor.startsWith('process:') ||
        snapshot.entries.some(
          (entry) => isAgentEntry(entry) && agentRef(entry).actor === selection.actor,
        )
      );
    default: {
      const exhaustive: never = selection;
      return exhaustive;
    }
  }
}
