import { snapshotLegacyCache, importLegacyCache } from './legacyCacheImport';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ArchiveContext, ArchiveMessage, ArchiveSetting, ArchiveThread, ExportFormat, RetentionChoice } from '@/lib/generated/conversations';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { forgetArchivedConversation } from './conversations';
import { Message } from './ChatTurn';
import { archiveService, currentArchiveRecord, projectArchiveThread, projectArchiveMessage, sameArchiveContext, type ArchiveService } from './conversationArchive';
import { getVaultOpening, useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useOpenPath } from '@/app/useOpenPath';
import { resolveTarget } from '@/engine/wikilink';
import './conversation-archive.css';

const choices: readonly { value: RetentionChoice; label: string }[] = [
  { value: 'off', label: 'Off' }, { value: 'days30', label: '30 days' },
  { value: 'days90', label: '90 days (recommended)' }, { value: 'forever', label: 'Forever' },
];
const errorWords = (value: unknown) => typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string' ? value.message : 'Conversation archive is unavailable.';
const subscribeVault = (changed: () => void) => useVaultStore.subscribe(changed);

export function ConversationRetention({ active, service = archiveService }: { active: boolean; service?: ArchiveService }) {
  const vault = useVaultStore((state) => state.vaultPath);
  const opening = useSyncExternalStore(subscribeVault, getVaultOpening, getVaultOpening);
  const entries = useVaultStore((state) => state.entries);
  const openPath = useOpenPath();
  const epoch = useRef(0);
  const messagesEpoch = useRef(0);
  const [reload, setReload] = useState(0);
  const [cacheEpoch,setCacheEpoch]=useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- opening, reload and cacheEpoch are re-read triggers: the legacy cache lives outside any store
  const cache=useMemo(()=>vault===null?null:snapshotLegacyCache(vault),[vault,opening,reload,cacheEpoch]);
  const [context, setContext] = useState<ArchiveContext | null>(null);
  const [setting, setSetting] = useState<ArchiveSetting | null>(null);
  const [threads, setThreads] = useState<ArchiveThread[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<ArchiveThread | null>(null);
  const [messages, setMessages] = useState<ArchiveMessage[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [messageStatus, setMessageStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');

  useEffect(() => {
    const current = ++epoch.current;
    messagesEpoch.current += 1;
    if (!active || vault === null) return;
    setBusy(false); setMessageStatus('idle'); setStatus('loading'); setContext(null); setSelected(null); setMessages([]); setNotice('');
    void (async () => {
      try {
        const found = await service.context();
        const [choice, page] = await Promise.all([service.setting(found), service.threads(found, search)]);
        if (epoch.current !== current || getVaultOpening() !== opening) return;
        if (!sameArchiveContext(found, choice.context) || !sameArchiveContext(found, page.context)) throw new Error('The archive opening changed. Refresh this read.');
        setContext(found); setSetting(choice); setThreads(page.items.map(projectArchiveThread)); setAfter(page.nextCursor); setStatus('ready');
      } catch (error) {
        if (epoch.current === current && getVaultOpening() === opening) { setFailure(errorWords(error)); setStatus('unavailable'); }
      }
    })();
    return () => { epoch.current += 1; messagesEpoch.current += 1; };
  }, [active, vault, opening, reload, search, service]);

  useEffect(() => {
    const now=Date.now();
    const next = messages.flatMap((message) => message.persistence !== 'retained' || message.expiresAt === null ? [] : [Date.parse(message.expiresAt)]).filter(Number.isFinite).map((at)=>Math.max(now,at)).sort((a,b) => a-b)[0];
    if (next === undefined) return;
    const timer = window.setTimeout(() => setMessages((items)=>items.map(currentArchiveRecord)), Math.min(2_147_483_647, Math.max(1, next-Date.now())));
    return () => window.clearTimeout(timer);
  }, [messages]);

  useEffect(()=>{
    const now=Date.now();const expiries=threads.flatMap((thread)=>{const expiry='titleExpiresAt' in thread?thread.titleExpiresAt:null;const at=typeof expiry==='string'?Date.parse(expiry):NaN;return thread.title!==null && Number.isFinite(at)?[Math.max(now,at)]:[];});
    if(expiries.length===0)return;
    const timer=window.setTimeout(()=>{setThreads((items)=>items.map(projectArchiveThread));setSelected((thread)=>thread===null?null:projectArchiveThread(thread));},Math.min(2_147_483_647,Math.max(1,Math.min(...expiries)-now)));
    return()=>window.clearTimeout(timer);
  },[threads]);

  const readThread = async (thread: ArchiveThread, older = false) => {
    if (context === null) return;
    const current = epoch.current; const request = ++messagesEpoch.current;
    setSelected(thread); setMessageStatus('loading');
    if (!older) { setMessages([]); setBefore(null); }
    try {
      const page = await service.messages(context, thread.id, older ? before : null);
      if (current !== epoch.current || request !== messagesEpoch.current || getVaultOpening() !== opening) return;
      if (!sameArchiveContext(context, page.context) || page.threadId !== thread.id) throw new Error('The archive thread changed. Refresh this read.');
      setMessages((previous) => (older ? [...previous, ...page.items] : page.items).map(currentArchiveRecord)); setBefore(page.nextCursor); setMessageStatus('ready');
    } catch (error) {
      if (current === epoch.current && request === messagesEpoch.current) { setFailure(errorWords(error)); setMessageStatus('unavailable'); }
    }
  };
  const moreThreads = async () => {
    if (context === null || after === null) return;
    const current = epoch.current; setBusy(true);
    try {
      const page = await service.threads(context, search, after);
      if (current !== epoch.current || !sameArchiveContext(context, page.context)) return;
      setThreads((previous) => [...previous, ...page.items.map(projectArchiveThread).filter((thread) => !previous.some((existing) => existing.id === thread.id))]); setAfter(page.nextCursor);
    } catch (error) { if (current === epoch.current) { setFailure(errorWords(error)); setStatus('unavailable'); } }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const choose = async (value: string) => {
    const choice = choices.find((choice) => choice.value === value)?.value;
    if (context === null || setting === null || choice === undefined) return;
    const current = epoch.current; setBusy(true); setNotice('');
    try {
      const saved = await service.choose(context, choice, setting.revision);
      if (current !== epoch.current || !sameArchiveContext(context, saved.context)) return;
      setSetting(saved); setNotice(choice === 'off' ? 'New completed content will not be archived. Existing content keeps its recorded expiry.' : 'Retention choice saved for new completed content. Existing messages keep their recorded expiry.');
    } catch (error) { if (current === epoch.current) setNotice(errorWords(error)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const remove = async () => {
    if (context === null || selected === null) return;
    const current = epoch.current; const thread = selected.id; setBusy(true);
    try {
      const result = await service.remove(context, thread);
      if (current !== epoch.current || getVaultOpening() !== opening) return;
      if (result.state === 'blocked_active') { setNotice('This conversation still has work or an approval. Open it to Stop or resolve that work, then retry Delete.'); return; }
      if (vault !== null) forgetArchivedConversation(vault, thread);
      setThreads((previous) => previous.filter((item) => item.id !== thread)); setSelected(null); setMessages([]);
      setNotice(result.state === 'deleted' && result.cleanup !== 'completed' ? `Archived content deleted. Storage cleanup is ${result.cleanup}.` : 'Archived content deleted.');
    } catch (error) { if (current === epoch.current) setNotice(errorWords(error)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const prune = async () => {
    if (context === null) return;
    const current = epoch.current; setBusy(true);
    try {
      const result = await service.prune(context);
      if (current !== epoch.current || !sameArchiveContext(context, result.context)) return;
      setNotice(`Removed ${result.removedMessages} expired messages. ${result.cleanup==='completed'?'Storage cleanup finished.':result.cleanup==='deferred'?'Storage cleanup will finish later.':'Storage cleanup could not finish; you can retry.'}`);
      const [saved, page] = await Promise.all([service.setting(context), service.threads(context, search)]);
      if (current !== epoch.current) return;
      setSetting(saved); setThreads(page.items.map(projectArchiveThread)); setAfter(page.nextCursor); setSelected(null); setMessages([]);
    } catch (error) { if (current === epoch.current) setNotice(errorWords(error)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const exportThread = async (format: ExportFormat) => {
    if (context === null || selected === null) return;
    const current = epoch.current; setBusy(true);
    try {
      const result = await service.export(context, selected.id, format);
      if (current !== epoch.current) return;
      setNotice(result.state === 'cancelled' ? 'Export cancelled.' : `Export saved${result.partial ? ' with partial or unavailable portions labeled' : ''}.`);
    } catch (error) { if (current === epoch.current) setNotice(errorWords(error)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const importCache=async()=>{
    if(context===null||vault===null||setting===null||setting.choice==='off')return;
    const current=epoch.current;const snapshot=snapshotLegacyCache(vault);setBusy(true);
    try {
      const result=await importLegacyCache(service,context,vault,snapshot,()=>current===epoch.current&&getVaultOpening()===opening,(saved,kept)=>{if(current===epoch.current)setNotice(`Imported ${saved} cached turns. ${kept} kept in recent history.`);});
      if(current!==epoch.current||getVaultOpening()!==opening)return;
      const details=[result.unknownCompletion>0?'Turns without a recorded completion time stay in recent history with timed retention. Choose Forever to import them.':'',result.blocked>0?'Some conversations still have work or an approval. Resolve that work before retrying.':'',result.saved>result.cleared?'Some saved turns changed locally or their cached copies could not be cleared. Those copies were kept.':'',result.kept>result.unknownCompletion+result.blocked?'Some cached turns could not be saved or checked. Their copies stay in recent history.':''].filter(Boolean).join(' ');
      setNotice(`Imported ${result.saved} cached ${result.saved===1?'turn':'turns'}; cleared ${result.cleared} checked ${result.cleared===1?'copy':'copies'}. ${result.kept} kept. ${details}`);setCacheEpoch((value)=>value+1);
      const [saved,page]=await Promise.all([service.setting(context),service.threads(context,search)]);if(current!==epoch.current||getVaultOpening()!==opening)return;if(!sameArchiveContext(context,saved.context)||!sameArchiveContext(context,page.context))throw new Error('The archive changed. Refresh this view.');setSetting(saved);setThreads(page.items.map(projectArchiveThread));setAfter(page.nextCursor);
    }catch(error){if(current===epoch.current)setNotice(errorWords(error));}finally{if(current===epoch.current)setBusy(false);}
  };
  const projected = useMemo(() => [...messages].reverse().flatMap(projectArchiveMessage), [messages]);
  const openTarget = (target: string) => { const entry = resolveTarget(target, entries); if (entry !== null) openPath(entry.path); };
  const partial = projected.some((message)=>message.archiveRecord?.persistence==='expired') || messages.some((message) => message.content === null || message.content.answer.availability !== 'complete');

  return <section className="cb-conversation-archive" data-testid="conversation-archive">
    <h3 className="m-0 text-sm font-semibold">Conversation archive</h3>
    <p className="cb-conversation-archive-hint">Keep completed questions, answers and display references locally, outside the vault. They may contain sensitive text. Reasoning and raw tool payloads are excluded.</p>
    {status === 'loading' ? <p role="status">Reading archive…</p> : status === 'unavailable' ? <div data-testid="section-unavailable" role="status"><p>{failure}</p><Button variant="secondary" size="sm" onClick={() => setReload((value) => value + 1)}>Retry archive read</Button></div> : setting !== null && <>
      <div className="cb-conversation-archive-actions"><Select ariaLabel="Conversation retention" options={choices} value={setting.choice} disabled={busy} onChange={(value) => void choose(value)} /><span className="text-xs text-(--text-meta)">{(setting.logicalBytes / 1024 / 1024).toFixed(1)} MiB of {setting.budgetBytes / 1024 / 1024} MiB</span><Button variant="secondary" size="sm" disabled={busy} onClick={() => void prune()}>Remove expired content</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setReload((value) => value + 1)}>Refresh</Button></div>
      <p className="cb-conversation-archive-hint">{setting.revision === 0 ? 'Off until you choose a duration. ' : ''}Off stops saving new completed messages. Existing content keeps the duration recorded at completion; continuing a thread does not renew older messages. When storage is full, new completed messages are not saved; existing saved content stays.</p>
      <div className="cb-conversation-archive-actions"><Button variant="secondary" size="sm" disabled={busy||setting.choice==='off'||cache===null||cache.turns===0} onClick={()=>void importCache()}>Import this vault’s recent conversations</Button><span className="text-xs text-(--text-meta)">{cache===null?'Recent history has not been read.':cache.unreadable>0?'Some recent history could not be read.':`${cache.turns} cached ${cache.turns===1?'turn':'turns'} available`}</span></div>
      <p className="cb-conversation-archive-hint">Import is optional. It copies only saved questions, answer parts and display references from this vault’s recent history, then checks the saved copy before clearing cached text. It does not copy whole Claude Code sessions. If no completion time is recorded, choose Forever to import that turn; timed choices leave it in recent history.</p>
      {cache!==null&&(cache.unknown>0||cache.unreadable>0)&&<p role="status" className="text-xs text-(--text-meta)">Conversations without a recorded vault, or records we could not read, stay in recent history. They are not assigned to this vault.</p>}
      <form className="cb-conversation-archive-actions" onSubmit={(event) => { event.preventDefault(); setSearch(query); }}><Input ariaLabel="Search retained conversations" placeholder="Search retained content" value={query} onChange={(event) => setQuery(event.target.value)} /><Button variant="secondary" size="sm" type="submit">Search</Button></form>
      {threads.length === 0 ? <p className="text-sm text-(--text-meta)">{search ? 'No retained content matches this search.' : 'No conversations are recorded in this archive.'}</p> : <ul className="cb-conversation-archive-list">{threads.map((thread) => <li key={thread.id}><button type="button" onClick={() => void readThread(thread)} aria-pressed={selected?.id === thread.id}><span>{projectArchiveThread(thread).title ?? 'Conversation'}</span><span className="text-xs text-(--text-meta)">{thread.contentState === 'retained' ? 'Retained content' : thread.contentState === 'expired' ? 'Content expired' : 'Metadata only'}</span></button></li>)}</ul>}
      {after !== null && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void moreThreads()}>More conversations</Button>}
      {selected !== null && <div className="cb-conversation-archive-preview" aria-label="Archived conversation"><div className="cb-conversation-archive-actions"><h4 className="m-0 flex-1 text-sm font-semibold">{projectArchiveThread(selected).title ?? 'Conversation'}</h4><Button variant="secondary" size="sm" onClick={() => useUiStore.getState().showConversation(selected.id)}>Open in assistant</Button><Button variant="secondary" size="sm" disabled={busy} onClick={() => void exportThread('json')}>Export JSON</Button><Button variant="secondary" size="sm" disabled={busy} onClick={() => void exportThread('markdown')}>Export Markdown</Button><Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()}>Delete archived conversation</Button></div>
        {messageStatus === 'loading' && messages.length === 0 ? <p role="status">Reading messages…</p> : messageStatus === 'unavailable' ? <p data-testid="section-unavailable" role="status">{failure}</p> : <>{partial && <p role="status" className="text-sm text-(--text-meta)">Some archived content is expired, unretained or unavailable.</p>}{before !== null && <Button variant="secondary" size="sm" disabled={messageStatus === 'loading'} onClick={() => void readThread(selected, true)}>Older messages</Button>}{projected.length === 0 ? <p>No completed messages were retained.</p> : projected.map((message) => <Message key={message.id} message={message} onOpen={openTarget} onOpenPath={(path) => { openPath(path); }} />)}{messages.flatMap((message) => currentArchiveRecord(message).content?.answer.references ?? []).filter((reference) => reference.kind !== 'source').map((reference, index) => <p key={index} className="text-xs text-(--text-meta)">{reference.kind === 'artifact' ? <button type="button" onClick={() => openPath(reference.path)}>Artifact: {reference.path}</button> : reference.kind === 'effect' ? `Effect reference: ${reference.invocationId}` : null}</p>)}</>}
      </div>}
    </>}
    {notice !== '' && <p role="status" className="text-sm">{notice}</p>}
    <p className="cb-conversation-archive-hint">Custom names stay in this app’s recent history; the archive keeps its original title. Finish or stop work and resolve approvals before deleting. Delete does not stop work or undo actions. Deleting archived content does not remove exports, backups, saved files or Claude Code history. Storage cleanup is separate.</p>
  </section>;
}
