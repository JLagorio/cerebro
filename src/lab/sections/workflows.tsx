import { WorkflowLibrary, type WorkflowLibraryService } from '@/library/WorkflowLibrary';
import { copyWorkflowDraft } from '@/library/workflowEditorSession';
import type { WorkflowDocument, WorkflowDraft, WorkflowPublication } from '@/lib/generated/workflows';
import { faulted } from '@/lib/mockFaults';
import type { LabSection, LabState } from '../presets';

const context = { vaultId: 'workflow-display-vault', storeUuid: 'workflow-display-store' };
const initial: WorkflowDraft = {
  workflowId: 'weekly-review',
  entryStepId: 'summary',
  inputSchemaJson: '{"type":"object"}',
  triggerJson: '{"kind":"manual"}',
  steps: [{ stepId: 'summary', label: 'Review summary', operation: { kind: 'result', outputJson: '{"kind":"input","path":[]}' } }],
};
/** In-memory display replies only. No IPC, native worker, filesystem or provider. */
function preview(state: LabState): WorkflowLibraryService {
  let revision = 1;
  const drafts = new Map([[initial.workflowId, { draft: copyWorkflowDraft(initial), etag: 'a'.repeat(64) }]]);
  const publication: WorkflowPublication = { revision: 1, version: { workflowId: initial.workflowId, definitionHash: 'b'.repeat(64) } };
  const publications = new Map<string, WorkflowPublication>(state === 'not-recorded' ? [] : [[initial.workflowId, publication]]);
  const versions = new Map([[publication.version.definitionHash, copyWorkflowDraft(initial)]]);
  const document = async (_context: typeof context, id: string): Promise<WorkflowDocument> => ({
    context, workflowId: id, publicationRevision: publications.get(id)?.revision ?? 0,
    draft: drafts.has(id) ? { ...drafts.get(id)!, draft: copyWorkflowDraft(drafts.get(id)!.draft) } : null,
    publication: publications.get(id) ?? null,
    versions: [...versions].filter(([, value]) => value.workflowId === id).map(([definitionHash]) => ({ workflowId: id, definitionHash })),
    versionsTruncated: false, activation: { state: 'disabled', revision: 1 },
  });
  return {
    context: async () => context,
    catalog: async () => faulted('workflow_catalog', async () => ({
      context,
      items: state === 'empty' ? [] : [{ workflowId: initial.workflowId, readable: true, publication: publications.get(initial.workflowId) ?? null }, ...(state === 'partial' ? [{ workflowId: 'unreadable-definition', readable: false, publication: null }] : [])],
      nextCursor: null, truncated: state === 'partial',
    })),
    document,
    version: async (_context, version) => {
      const value = versions.get(version.definitionHash);
      if (!value || value.workflowId !== version.workflowId) throw new Error('Display version unavailable');
      return copyWorkflowDraft(value);
    },
    save: async (request) => {
      const value = { draft: copyWorkflowDraft(request.draft), etag: (++revision).toString(16).padStart(64, '0') };
      drafts.set(request.draft.workflowId, value);
      return { ...value, draft: copyWorkflowDraft(value.draft) };
    },
    publish: async (request) => {
      const saved = drafts.get(request.workflowId);
      if (!saved || saved.etag !== request.expectedDraftEtag) throw new Error('Display draft changed');
      const value = { revision: (publications.get(request.workflowId)?.revision ?? 0) + 1, version: { workflowId: request.workflowId, definitionHash: (++revision).toString(16).padStart(64, '0') } };
      publications.set(request.workflowId, value); versions.set(value.version.definitionHash, copyWorkflowDraft(saved.draft));
      return value;
    },
    validate: async () => ({ valid: true, diagnostics: [] }),
    actions: async () => [], accounts: async () => ({ items: [], nextCursor: null }),
    account: async () => { throw new Error('Display-only account metadata is unavailable'); },
  };
}
let service = preview('ready');
const seed = (state: LabState) => () => { service = preview(state); };
export const section: LabSection = {
  id: 'workflows', title: 'Workflow library', surface: 'Library › Workflows',
  render: () => <WorkflowLibrary vaultKey="workflow-display-only" service={service} onTab={() => {}} />,
  states: {
    ready: { note: 'A published display definition. Editing, saving and publishing stay in this preview’s memory.', seed: seed('ready'), expect: { present: ['[data-testid="workflow-library"]'], text: 'Published version 1' } },
    empty: { note: 'A successful catalog read found no definitions.', seed: seed('empty'), expect: { present: ['[data-testid="workflow-library"]'], text: 'No workflows yet' } },
    'not-recorded': { note: 'A draft exists but has never been published.', seed: seed('not-recorded'), expect: { present: ['[data-testid="workflow-library"]'], text: 'Draft' } },
    partial: { note: 'One definition cannot be read and the catalog scan is incomplete.', seed: seed('partial'), expect: { present: ['[data-testid="workflow-library"]'], text: 'Definition unavailable' } },
    unavailable: { note: 'The catalog failed. Retry reads the display service again.', seed: seed('unavailable'), failNext: ['workflow_catalog'], expect: { present: ['.section-unavailable'], text: 'Workflows could not be read.' } },
  },
};
