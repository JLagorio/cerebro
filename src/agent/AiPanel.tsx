import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { checkAgent } from '@/agent/agentIpc';
import { AiActionCard } from '@/agent/AiActionCard';
import { ChatInput } from '@/agent/ChatInput';
import { buildSnapshot, extractReferences, renderSnapshot } from '@/agent/context';
import { ConversationSwitcher } from '@/agent/ConversationSwitcher';
import { useConversations } from '@/agent/useConversations';
import { useAgentChat } from '@/agent/useAgentChat';
import { type AgentStatus, type ChatMessage } from '@/agent/types';
import { listSkills, matchSkillInvocation, skillIndex, skillPrompt, type SkillRef } from '@/engine/skills';
import { resolveSurface } from '@/engine/surface';
import { resolveView } from '@/engine/views';
import { readNote } from '@/lib/ipc';
import { useAgentCheckpoint, useGit } from '@/git/useGit';
import { useSchema } from '@/stores/vaultStore';
import { parseIssuePrefixes, SOURCES_DIR } from '@/engine/ingest';
import { resolveTarget } from '@/engine/wikilink';
import { useOpenPath } from '@/app/useOpenPath';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The AI side panel (M6).
 *
 * A docked conversation with the local agent. Everything it can see or change
 * goes through cerebro's own MCP tools, so the panel shows the tool calls
 * inline: an agent that edits your vault should not do it invisibly.
 */

/** Renders assistant text with `[[wikilinks]]` and **bold** made real. */
export function MessageText({ text, onOpen }: { text: string; onOpen: (target: string) => void }) {
  const entries = useVaultStore((s) => s.entries);
  const parts = useMemo(() => text.split(/(\[\[[^\]]+\]\]|\*\*[^*]+\*\*)/g), [text]);
  return (
    <>
      {parts.map((part, i) => {
        const link = /^\[\[([^\]]+)\]\]$/.exec(part);
        if (link !== null) {
          const [target, alias] = link[1].split('|');
          const entry = resolveTarget(target, entries);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onOpen(target)}
              className="cursor-pointer border-0 bg-transparent p-0 text-[var(--cortex-600)] underline decoration-[var(--cortex-200)] underline-offset-2 hover:decoration-[var(--cortex-500)]"
            >
              {alias ?? entry?.title ?? target}
            </button>
          );
        }
        const bold = /^\*\*([^*]+)\*\*$/.exec(part);
        if (bold !== null) return <strong key={i}>{bold[1]}</strong>;
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function Message({
  message,
  onOpen,
  onOpenPath,
  onViewDiff,
}: {
  message: ChatMessage;
  onOpen: (t: string) => void;
  onOpenPath: (p: string) => void;
  onViewDiff?: (p: string) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end" data-testid="chat-message" data-role="user">
        <div className="max-w-[85%] rounded-[12px] rounded-br-[4px] bg-[var(--cortex-500)] px-3 py-2 text-[12.5px] leading-[18px] text-[var(--n-0)]">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid="chat-message" data-role="assistant">
      {message.tools.length > 0 && (
        <div className="flex flex-col gap-1">
          {message.tools.map((tool) => (
            <AiActionCard
              key={tool.id}
              tool={tool}
              onOpenPath={onOpenPath}
              onViewDiff={onViewDiff}
            />
          ))}
        </div>
      )}
      {message.error !== undefined ? (
        <div className="rounded-[10px] border border-[var(--danger-200)] bg-[var(--danger-50)] px-3 py-2 text-[12px] leading-[17px] text-[var(--danger-700)]">
          {message.error}
        </div>
      ) : (
        <div className="text-[12.5px] leading-[19px] text-[var(--n-800)]">
          <MessageText text={message.text} onOpen={onOpen} />
          {message.streaming === true && message.text === '' && (
            <span className="text-[var(--n-400)]">Thinking…</span>
          )}
        </div>
      )}
    </div>
  );
}

const SUGGESTIONS = [
  'What is at risk right now?',
  'Help me clear the Inbox',
  'What do you know about this vault?',
];

export function AiPanel() {
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const shell = useUiStore((s) => s.agentShellAccess);
  const connectors = useUiStore((s) => s.agentConnectors);
  const issuePrefixes = useUiStore((s) => s.issuePrefixes);
  const pendingPrompt = useUiStore((s) => s.agentPendingPrompt);
  const setPendingPrompt = useUiStore((s) => s.setAgentPendingPrompt);
  const detailPath = useUiStore((s) => s.detailPath);
  const selection = useNavStore((s) => s.selection);
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const views = useVaultStore((s) => s.views);
  const schema = useSchema();
  const openPath = useOpenPath();
  const openDiff = useUiStore((s) => s.openDiff);

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // M9.4: an agent turn that wrote files becomes its own commit, so its work
  // is revertible independently of the user's.
  const { isRepo, refresh } = useGit();
  const checkpoint = useAgentCheckpoint(refresh);

  // M9.5: the rows the current surface is showing. Asking "what is at risk"
  // from the At risk view should be answered from that view's records, not
  // from the agent re-deriving a query it will get subtly wrong.
  const collection = useMemo(
    () => resolveSurface(selection, entries, schema, views),
    [selection, entries, schema, views],
  );
  const activeView =
    selection.kind === 'list'
      ? views.find((v) => v.id === selection.id && v.project === null) ?? null
      : null;

  // M13.1: the skill catalog — names and descriptions only; a body loads when
  // one is invoked, so the vault can hold many skills at no per-turn cost.
  const skills = useMemo(() => listSkills(entries), [entries]);

  // Context is a system-prompt suffix, not a hidden first message: it must
  // travel with every turn, because a resumed session re-reads it.
  const systemPrompt = useMemo(() => {
    const base = buildSystemPrompt(selection, { connectors, issuePrefixes, skills });
    const snapshot = buildSnapshot({
      selection,
      entries,
      schema,
      activePath: detailPath,
      visible: collection.entries,
      // M11: the open TAB's filters — what the person is actually looking at.
      filters:
        activeView === null
          ? null
          : resolveView(
              activeView.definition,
              selection.kind === 'list' ? selection.view : null,
            ).filters,
      references: extractReferences(draft),
    });
    return `${base}${renderSnapshot(snapshot)}`;
    // `draft` is deliberately excluded: rebuilding the prompt on every
    // keystroke would thrash, and `send` reads the references it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectors, issuePrefixes, skills, selection, entries, schema, detailPath, collection.entries, activeView]);

  const chat = useAgentChat(
    systemPrompt,
    { shell, connectors },
    null,
    isRepo ? checkpoint : undefined,
  );
  const conversations = useConversations(chat);

  useEffect(() => {
    void checkAgent().then(setStatus).catch(() => setStatus({ installed: false, version: null, path: null }));
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat.messages]);

  // A prompt handed over from elsewhere in the app ("Ask the agent to
  // revise" on a concept) is sent once and then cleared.
  const send = chat.send;
  useEffect(() => {
    if (pendingPrompt === null) return;
    setPendingPrompt(null);
    send(pendingPrompt);
  }, [pendingPrompt, send, setPendingPrompt]);

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') return;
    // M13.1: `/name …` expands to the skill's body — the transcript shows what
    // was typed, the agent gets the instructions. The expansion is handed to
    // send() as a deferred read so the turn starts synchronously; an
    // unreadable skill file falls back to sending the message as typed.
    // A draft STARTING with a space is the opt-out: sent literally, never
    // expanded — the one way to say `/weekly-review` to the agent as text.
    const literal = draft.startsWith(' ');
    const invocation = literal ? null : matchSkillInvocation(trimmed, skills);
    setDraft('');
    if (invocation === null || vaultPath === null) {
      chat.send(trimmed);
      return;
    }
    const { skill, request } = invocation;
    chat.send(trimmed, () =>
      readNote(vaultPath, skill.path).then((raw) => skillPrompt(skill, raw, request)),
    );
  };

  // M9.7: open the note and show its diff there, rather than stacking a
  // dialog over the panel that produced it.
  const viewDiff = (path: string) => {
    openPath(path);
    openDiff(path);
  };

  const openTarget = (target: string) => {
    const entry = resolveTarget(target, entries);
    if (entry !== null) openPath(entry.path);
  };

  return (
    <aside
      aria-label="AI panel"
      data-testid="ai-panel"
      className="flex w-[380px] flex-none flex-col border-l border-[var(--n-200)] bg-[var(--n-0)]"
    >
      <header className="flex flex-none items-center gap-2 border-b border-[var(--n-200)] px-3 py-2">
        <Icon name="sparkles" size={14} color="var(--synapse-500)" />
        {/* M9.5: conversations are kept and named, so this is a switcher
            rather than a label beside a button that erased the transcript. */}
        <ConversationSwitcher state={conversations} />
        {status !== null && !status.installed && (
          <span className="text-[10.5px] text-[var(--warn-600)]">not installed</span>
        )}
        <span className="flex-1" />
        <IconButton
          icon="square-pen"
          label="New conversation"
          size="sm"
          onClick={conversations.start}
        />
        <IconButton icon="x" label="Close AI panel" size="sm" onClick={() => setAiPanelOpen(false)} />
      </header>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {chat.messages.length === 0 ? (
          <div className="flex flex-col gap-2 pt-2">
            <p className="m-0 text-[12.5px] leading-[18px] text-[var(--n-500)]">
              {status?.installed === false
                ? 'Claude Code was not found on this machine. Install it and reopen cerebro.'
                : 'I can read and write this vault through cerebro. I maintain the Knowledge bundle; you verify it.'}
            </p>
            {status?.installed !== false &&
              SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => chat.send(suggestion)}
                  className="rounded-[9px] border border-[var(--n-200)] bg-transparent px-2.5 py-1.5 text-left text-[12px] text-[var(--n-700)] hover:border-[var(--n-300)] hover:bg-[var(--n-25)]"
                >
                  {suggestion}
                </button>
              ))}
          </div>
        ) : (
          chat.messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              onOpen={openTarget}
              onOpenPath={openPath}
              onViewDiff={isRepo ? viewDiff : undefined}
            />
          ))
        )}
      </div>

      <div className="flex-none border-t border-[var(--n-200)] p-2.5">
        {/* M9.5: `[[` completes against the vault, and the note you name
            travels into the snapshot with its content rather than as a word
            the agent has to go searching for. */}
        <ChatInput value={draft} onChange={setDraft} onSubmit={submit} />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="flex-1 text-[10.5px] text-[var(--n-400)]">
            {chat.streaming ? 'Working…' : 'Enter to send · [[ to reference a note'}
          </span>
          {chat.streaming ? (
            <Button variant="secondary" size="sm" icon="square" onClick={chat.stop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" size="sm" icon="send" onClick={submit}>
              Send
            </Button>
          )}
        </div>
      </div>

    </aside>
  );
}

/** What the agent is told about where the user is standing, and what it may reach. */
export function buildSystemPrompt(
  selection: { kind: string; path?: string; id?: string; name?: string },
  options: { connectors?: boolean; issuePrefixes?: string; skills?: SkillRef[] } = {},
): string {
  const lines = [
    'You are the assistant inside cerebro, a local markdown work-management app.',
    'Notes are markdown files with YAML frontmatter. A project is a folder holding project.md; its work items live in <folder>/items/. Types are declared by `type: Type` docs in types/.',
    'Use the cerebro MCP tools: get_vault_context to orient, search_notes and get_note to read, and the write tools to change things. Call open_note so the user sees what you are referring to.',
    'When you mention a note, write it as [[note-name]] so it is clickable.',
    'You maintain the knowledge/ bundle in Open Knowledge Format. Record where every claim came from in `sources`, and anchor every concept to the entities it is about with `about` wikilinks — an unanchored concept is unreachable from the work it describes. Never write `verified` — that is the user\'s stamp, and claiming it would defeat the review model.',
    'To file an Inbox capture, use propose_organize so the user can accept or reject it. Do not edit captures directly.',
    'Never create or modify `type: Type` docs on your own — schema is the user\'s to change. When a vault clearly needs a new type or field, describe the change and why, and let them make it (the Types screen and the adoption wizard are the human path).',
    'Be concise.',
  ];

  // The connector inlet (M8.2). Said only when the servers are actually
  // reachable — telling the agent to fetch through tools it does not have
  // produces apologies, not sources.
  if (options.connectors === true) {
    lines.push(
      `External material you fetch through another MCP server must be written down with cache_source, which stores it under ${SOURCES_DIR}/. Search for an existing copy before fetching: one fetch, a permanent local file, and every later question reads the file.`,
    );
    const prefixes = parseIssuePrefixes(options.issuePrefixes ?? '');
    if (prefixes.length > 0) {
      lines.push(
        `This vault's issue-tracker project keys are ${prefixes.join(', ')}. A token like ${prefixes[0]}-421 is a ticket worth fetching; nothing else that merely looks similar is.`,
      );
    }
  }

  // M13.1: the skill catalog — one line per skill; bodies load on invocation.
  const skillLine = skillIndex(options.skills ?? []);
  if (skillLine !== null) lines.push(skillLine);

  const where = describeSelection(selection);
  if (where !== null) lines.push(`The user is currently looking at ${where}.`);
  return lines.join('\n');
}

function describeSelection(selection: {
  kind: string;
  path?: string;
  id?: string;
  name?: string;
}): string | null {
  switch (selection.kind) {
    case 'doc':
    case 'project':
      return selection.path ?? null;
    case 'list':
      return selection.id !== undefined ? `the list "${selection.id}"` : null;
    case 'type':
      return selection.name !== undefined ? `the ${selection.name} type screen` : null;
    case 'inbox':
      return 'the Inbox';
    case 'knowledge':
      return 'the Knowledge bundle';
    default:
      return null;
  }
}
