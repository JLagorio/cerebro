import type { ActionDefinition } from '@/lib/generated/actions';
import type { WorkflowContext, WorkflowDraft, WorkflowVersionRef } from '@/lib/generated/workflows';
import type { WorkflowScheduleApi } from './workflowScheduleSession';
export interface WorkflowScheduleService extends WorkflowScheduleApi {
 definition: (context: WorkflowContext, version: WorkflowVersionRef) => Promise<WorkflowDraft>;
 actions: (context: WorkflowContext) => Promise<ActionDefinition[]>;
}
export interface WorkflowSchedulePanelProps { vaultKey: string; context: WorkflowContext; workflowId: string; version: WorkflowVersionRef | null; service: WorkflowScheduleService; publicationChange?: string; }

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import type { WorkflowPermissions } from '@/lib/generated/workflows';
import { retainWorkflowSchedule, type WorkflowScheduleOwner } from './workflowScheduleOwner';
import { PermissionFields, usePinned } from './WorkflowRunPanel';
import format from '../../shared/workflows/format.v1.json';
import './workflow-run.css';
const blank = (): WorkflowPermissions => ({ queryRecords: false, readPrefixes: [], accounts: [] });
/** The native implementation alone interprets schedule intervals and catch-up. */
function isSchedule(definition: WorkflowDraft): boolean { try { const trigger: unknown = JSON.parse(definition.triggerJson); return trigger !== null && typeof trigger === 'object' && 'kind' in trigger && trigger.kind === 'schedule'; } catch { return false; } }
export function WorkflowSchedulePanel(props: WorkflowSchedulePanelProps) {
 const { vaultKey, context, workflowId, service } = props; const key = JSON.stringify([vaultKey, context.vaultId, context.storeUuid, workflowId]);
 const [selection, setSelection] = useState<{ key: string; service: WorkflowScheduleService; owner: WorkflowScheduleOwner | null } | null>(null);
 useEffect(() => { const owner = retainWorkflowSchedule(vaultKey, context, workflowId, service, () => crypto.randomUUID().replaceAll('-', '')); setSelection({ key, service, owner }); return owner?.mount(); }, [vaultKey, context, workflowId, service, key]);
 if (selection === null || selection.key !== key || selection.service !== service) return <section aria-label="Automatic workflow runs"><p role="status">Loading automatic runs…</p></section>;
 if (selection.owner === null) return <section aria-label="Automatic workflow runs" className="section-unavailable"><p role="status">The automatic configuration request limit is reached. Resolve an original pending request before opening another.</p></section>;
 return <ScheduleSurface {...props} owner={selection.owner} />;
}
function ScheduleSurface({ owner, context, version, service, publicationChange }: WorkflowSchedulePanelProps & { owner: WorkflowScheduleOwner }) {
 const state = useSyncExternalStore(owner.session.subscribe, owner.session.getSnapshot); const [input, setInput] = useState('{}'); const [permissions, setPermissions] = useState(blank);
 const pinned = usePinned(service, context, version); const versionKey = version === null ? '' : JSON.stringify([version.workflowId, version.definitionHash]);
 useEffect(() => { const current = owner.session.getSnapshot(); if (current.view === null && !current.uncertain && !current.busy) void owner.session.refresh(); }, [owner]);
 const refreshedPublication = useRef<{ owner: WorkflowScheduleOwner; key: string } | null>(null);
 useEffect(() => {
  if (publicationChange === undefined || state.busy || (refreshedPublication.current?.owner === owner && refreshedPublication.current.key === publicationChange)) return;
  refreshedPublication.current = { owner, key: publicationChange };
  void owner.session.refresh();
 }, [owner, publicationChange, state.busy]);
 useEffect(() => { setPermissions(blank()); }, [versionKey]);
 const current = state.view?.configuration ?? null; const blocked = state.busy || state.uncertain || state.view === null; const expectedRevision = current?.revision ?? 0;
 const monitoring = state.view?.monitoring; const configured = current !== null && current.state !== 'removed';
 const preview = state.preview; const saved = state.ack !== null && state.ack.current.revision === current?.revision;
 return <section aria-label="Automatic workflow runs" className="cb-workflow-runtime cb-workflow-run-start">
  <div><h3>Automatic runs</h3><p>Enable a published schedule for this vault. Publishing alone does not enable it. Cerebro must remain open and ready; consequential actions still wait for their own approval.</p></div>
  <div className="cb-workflow-toolbar"><Button size="sm" disabled={state.busy} onClick={() => void owner.session.refresh()}>Refresh automatic runs</Button></div>
  {state.busy && <p role="status">Checking the original automatic configuration…</p>}
  {state.failure !== null && <p role="status" className={state.view === null ? 'section-unavailable' : undefined}>{state.failure}</p>}
  {state.uncertain && <div><p>The original request is retained. Reading configuration does not prove which request committed.</p><Button disabled={state.busy} onClick={() => void owner.session.retry(context)}>Check original configuration request</Button></div>}
  {state.view !== null && <div>
   {current === null ? <p>Automatic runs are not configured.</p> : <>
    <p className="cb-workflow-mono">Selected version {current.version.definitionHash}</p>
    {current.state === 'paused' && <p>Paused. Existing runs and approvals are unchanged.</p>}
    {current.state === 'removed' && <p>Automatic configuration removed. Existing runs and approvals are unchanged.</p>}
    {current.state === 'enabled' && <>
     {monitoring === 'watching' ? <p role="status">Monitoring is active while this vault and Cerebro are ready.</p> : monitoring === 'stopped' ? <p role="status">{saved ? 'Configuration saved. Monitoring is stopped.' : 'Automatic configuration is enabled. Monitoring is stopped.'}</p> : <p role="status">Configuration is saved. Monitoring is unavailable.</p>}
     {monitoring !== 'watching' && <Button disabled={blocked} onClick={() => void owner.session.wake()}>Resume monitoring</Button>}
    </>}
    {current.recoveryHeld && <p role="status">Recovery has held this configuration. Automatic admission is unavailable.</p>}
    {state.view.readiness === 'needs_access' && <p role="status">Saved account access is no longer ready. Review the selected accounts before explicitly enabling a new configuration.</p>}
    {state.view.readiness === 'unavailable' && <p>Current schedule readiness has not been confirmed. Refresh to read it.</p>}
    <p>Recorded observations: {current.skippedCount} skipped, {current.coalescedCount} coalesced. {current.coverageKnown ? 'The last recorded observation had continuous native coverage.' : 'Continuous native coverage was not recorded.'}</p>
    <div className="cb-workflow-toolbar">
     {current.state === 'enabled' && <Button disabled={blocked} onClick={() => void owner.session.change('pause', expectedRevision)}>Pause automatic runs</Button>}
     {configured && <><Button disabled={blocked} onClick={() => void owner.session.preview()}>Preview next observation</Button><Button disabled={blocked} onClick={() => void owner.session.change('remove', expectedRevision)}>Remove automatic configuration</Button></>}
    </div>
    {configured && <p>Pause keeps the selected input and permissions. Remove releases that configuration. Neither cancels existing runs.</p>}
   </>}
  </div>}
  {preview !== null && <div role="status"><p>If monitoring resumes now: {preview.skippedCount} skipped, {preview.coalescedCount} coalesced.</p><p>{preview.dueAtMs === null ? 'No occurrence would be admitted by that observation.' : 'One occurrence would be considered; native admission checks still apply.'}</p><p>This preview does not advance the schedule or claim continuous awake coverage.</p></div>}
  {!state.uncertain && <div>
   <h4>{configured ? 'Review a replacement configuration' : 'Enable a published schedule'}</h4>
   {version === null ? <p>Publish a schedule before enabling automatic runs.</p> : pinned.unavailable ? <p role="status">The selected published version could not be read.</p> : pinned.loaded === null ? <p role="status">Reading the published version…</p> : !isSchedule(pinned.loaded.definition) ? <p>This published version has no supported automatic schedule. Manual runs remain available; event triggers are unavailable until their native producer is ready.</p> : <>
    <p className="cb-workflow-mono">Published version {version.definitionHash}</p><details><summary>Published trigger</summary><pre>{pinned.loaded.definition.triggerJson}</pre></details>
    <label className="cb-workflow-field"><span>Automatic run input JSON</span><textarea aria-label="Automatic run input JSON" value={input} maxLength={format.stepOutputBytes} disabled={blocked} spellCheck={false} onChange={(event) => setInput(event.target.value)} /></label>
    <PermissionFields value={permissions} onChange={setPermissions} definition={pinned.loaded.definition} actions={pinned.loaded.actions} disabled={blocked} usage="schedule" />
    <p>Explicit Enable selects this version, input and permissions for future occurrences. A newer publication never changes an existing selection.</p>
    <Button variant="primary" disabled={blocked} onClick={() => void owner.session.enable({ version: { workflowId: version.workflowId, definitionHash: version.definitionHash }, expectedRevision, inputJson: input, permissions: { queryRecords: permissions.queryRecords, readPrefixes: permissions.readPrefixes.filter((prefix) => prefix.length > 0), accounts: permissions.accounts } })}>Enable automatic runs</Button>
   </>}
  </div>}
 </section>;
}
