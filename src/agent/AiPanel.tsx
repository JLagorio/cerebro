import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { checkAgent } from '@/agent/agentIpc';
import { useAgentChat } from '@/agent/useAgentChat';
import { type AgentStatus, type ChatMessage, type ToolCall } from '@/agent/types';
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

/** Tool names arrive namespaced by the CLI (`mcp__cerebro__get_note`). */
export function toolLabel(name: string): string {
  const bare = name.replace(/^mcp__cerebro__/, '');
  return bare.replace(/_/g, ' ');
}

/** A one-line summary of a tool's arguments, for the chip. */
export function toolDetail(input: string | null): string | null {
  if (input === null || input.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    for (const key of ['path', 'query', 'folder', 'to', 'slug']) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return null;
  } catch {
    return null;
  }
}

function ToolChip({ tool }: { tool: ToolCall }) {
  const detail = toolDetail(tool.input);
  return (
    <span
      data-testid="tool-chip"
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--n-200)] bg-[var(--n-25)] px-2 py-[2px] text-[11px] text-[var(--n-600)]"
    >
      <Icon
        name={tool.done ? 'check' : 'loader'}
        size={10}
        color={tool.done ? 'var(--success-600)' : 'var(--n-400)'}
      />
      <span className="font-medium">{toolLabel(tool.name)}</span>
      {detail !== null && (
        <span className="truncate text-[var(--n-400)] [font-family:var(--font-mono)]">{detail}</span>
      )}
    </span>
  );
}

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

function Message({ message, onOpen }: { message: ChatMessage; onOpen: (t: string) => void }) {
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
        <div className="flex flex-wrap gap-1">
          {message.tools.map((tool) => (
            <ToolChip key={tool.id} tool={tool} />
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
  const selection = useNavStore((s) => s.selection);
  const entries = useVaultStore((s) => s.entries);
  const openPath = useOpenPath();

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // Context is a system-prompt suffix, not a hidden first message: it must
  // travel with every turn, because a resumed session re-reads it.
  const systemPrompt = useMemo(
    () => buildSystemPrompt(selection, { connectors, issuePrefixes }),
    [connectors, issuePrefixes, selection],
  );
  const chat = useAgentChat(systemPrompt, { shell, connectors }, null);

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
    if (draft.trim() === '') return;
    chat.send(draft);
    setDraft('');
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
        <span className="text-[13px] font-semibold text-[var(--n-900)]">Assistant</span>
        {status !== null && !status.installed && (
          <span className="text-[10.5px] text-[var(--warn-600)]">not installed</span>
        )}
        <span className="flex-1" />
        <IconButton
          icon="rotate-ccw"
          label="New conversation"
          size="sm"
          onClick={chat.reset}
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
            <Message key={message.id} message={message} onOpen={openTarget} />
          ))
        )}
      </div>

      <div className="flex-none border-t border-[var(--n-200)] p-2.5">
        <textarea
          aria-label="Message the assistant"
          value={draft}
          rows={2}
          placeholder="Ask about this vault…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="w-full resize-none rounded-[9px] border border-[var(--n-200)] bg-[var(--n-0)] px-2.5 py-2 text-[12.5px] leading-[18px] text-[var(--n-900)] outline-none placeholder:text-[var(--n-400)] focus-visible:border-[var(--cortex-400)]"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="flex-1 text-[10.5px] text-[var(--n-400)]">
            {chat.streaming ? 'Working…' : 'Enter to send'}
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
  options: { connectors?: boolean; issuePrefixes?: string } = {},
): string {
  const lines = [
    'You are the assistant inside cerebro, a local markdown work-management app.',
    'Notes are markdown files with YAML frontmatter. A project is a folder holding project.md; its work items live in <folder>/items/. Types are declared by `type: Type` docs in types/.',
    'Use the cerebro MCP tools: get_vault_context to orient, search_notes and get_note to read, and the write tools to change things. Call open_note so the user sees what you are referring to.',
    'When you mention a note, write it as [[note-name]] so it is clickable.',
    'You maintain the knowledge/ bundle in Open Knowledge Format. Record where every claim came from in `sources`, and anchor every concept to the entities it is about with `about` wikilinks — an unanchored concept is unreachable from the work it describes. Never write `verified` — that is the user\'s stamp, and claiming it would defeat the review model.',
    'To file an Inbox capture, use propose_organize so the user can accept or reject it. Do not edit captures directly.',
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
    case 'view':
      return selection.id !== undefined ? `the saved view "${selection.id}"` : null;
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
