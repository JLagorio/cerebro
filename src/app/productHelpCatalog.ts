import catalog from '../../shared/help/generated.v1.json';

export interface HelpTopic {
  id: string;
  title: string;
  appVersion: string;
  contentHash: string;
  body: string;
}

export const helpTopics = catalog.topics.map(({ id, title }) => ({ id, title }));
/** Exact catalog lookup only; caller input never becomes a file path. */
export function helpTopic(id: string): HelpTopic | null {
  return catalog.topics.find((topic) => topic.id === id) ?? null;
}
