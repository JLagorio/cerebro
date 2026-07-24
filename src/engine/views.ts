// PLACEHOLDER — created in Task 11 so vaultStore can parse saved views. Task
// 15 REPLACES this file with the full tolerant parser plus serializeView.
import type { ViewFile } from './types';

export function parseViewYaml(id: string, _yaml: string): ViewFile {
  return {
    id,
    definition: {
      name: id,
      icon: null,
      color: null,
      order: null,
      filters: null,
      presentation: {
        type: 'list',
        groupBy: 'status',
        orderBy: { field: 'modifiedAt', dir: 'desc' },
        visibleFields: ['key', 'status', 'priority', 'assignee', 'due', 'estimate'],
      },
    },
  };
}
