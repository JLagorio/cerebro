// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOVER_OPEN_MS, HoverCard, resetHoverCards } from '@/components/ui/HoverCard';
import { resetLayers } from '@/components/ui/layers';
import { Popover } from '@/components/ui/Popover';
import { Attachment, Attachments } from './Attachment';
import { Chat } from './Chat';
import { Context } from './Context';
import { Bubble, BubbleContent, Message, MessageContent, MessageToolbar } from './Message';
import { MessageScrollerItem } from './MessageScroller';
import { ModelSelector } from './ModelSelector';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from './PromptInput';
import { Questionnaire } from './Questionnaire';
import { Suggestion, Suggestions } from './Suggestion';

/**
 * The conversation set's rails (M91.8, plan §3.3): no element links
 * anywhere but the web (CV-16), none adds a window or document keydown
 * listener of its own (CV-47) — the DS layers it opens add theirs, and only
 * theirs — every icon it names exists, and its stylesheet spends DS tokens
 * and motion tokens only.
 */

beforeEach(() => {
  vi.useFakeTimers();
  resetHoverCards();
  resetLayers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Every element of the set, as one conversation draws them. */
function Gallery({ modelOpen = false }: { modelOpen?: boolean }) {
  const [open, setOpen] = useState(modelOpen);
  const [draft, setDraft] = useState('Plan the launch');
  return (
    <Chat
      empty={<p>Nothing yet</p>}
      composer={
        <>
          <Suggestions aria-label="Conversation starters">
            <Suggestion suggestion="What is at risk right now?" description="Open risks" />
          </Suggestions>
          <PromptInput onSubmit={() => undefined}>
            <PromptInputHeader>
              <Attachments aria-label="Attached files">
                <Attachment
                  data={{ id: 'a', label: 'report.pdf', path: 'files/report.pdf' }}
                  onRemove={() => undefined}
                />
              </Attachments>
            </PromptInputHeader>
            <PromptInputBody>
              <PromptInputTextarea value={draft} onChange={(e) => setDraft(e.target.value)} />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <ModelSelector
                  label="Opus · High"
                  models={[{ value: 'opus', label: 'Opus' }]}
                  model="opus"
                  onModelChange={() => undefined}
                  efforts={[{ value: 'high', label: 'High' }]}
                  effort="high"
                  onEffortChange={() => undefined}
                  other={{ onUse: () => undefined }}
                  open={open}
                  onOpenChange={setOpen}
                />
                <Context usage={{ state: 'recorded', used: 124_000, window: 200_000 }} />
              </PromptInputTools>
              <PromptInputSubmit />
            </PromptInputFooter>
          </PromptInput>
        </>
      }
    >
      <MessageScrollerItem messageId="u1" scrollAnchor>
        <Message from="user">
          <MessageContent>
            <Bubble>
              <BubbleContent>Plan the launch</BubbleContent>
            </Bubble>
            <MessageToolbar copy="Plan the launch" onEdit={() => undefined} />
          </MessageContent>
        </Message>
      </MessageScrollerItem>
      <MessageScrollerItem messageId="a1">
        <Message>
          <MessageContent>
            <Questionnaire
              questions={[
                {
                  question: 'Which format?',
                  header: 'Format',
                  options: [
                    { label: 'Markdown', description: '', preview: 'https://example.com' },
                    { label: 'Plain text', description: '', preview: null },
                  ],
                  multiSelect: false,
                },
              ]}
              onSubmit={() => undefined}
              onDecline={() => undefined}
            />
            <MessageToolbar
              copy="Here is a plan."
              onRetry={() => undefined}
              onBranch={() => undefined}
            />
          </MessageContent>
        </Message>
      </MessageScrollerItem>
    </Chat>
  );
}

/** The keydown listeners added to window and document while `run` runs.
 *  The spies pass every call through. */
function keydownsDuring(run: () => void): number {
  const onWindow = vi.spyOn(window, 'addEventListener');
  const onDocument = vi.spyOn(document, 'addEventListener');
  try {
    run();
    return [...onWindow.mock.calls, ...onDocument.mock.calls].filter(([type]) => type === 'keydown')
      .length;
  } finally {
    onWindow.mockRestore();
    onDocument.mockRestore();
  }
}

let at = 0;
function hover(el: Element) {
  at += 7;
  act(() => {
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, screenX: at, screenY: at }));
  });
  act(() => {
    vi.advanceTimersByTime(HOVER_OPEN_MS);
  });
}

describe('keys (CV-47)', () => {
  it('adds no window or document keydown listener, drawn and used', () => {
    const added = keydownsDuring(() => {
      render(<Gallery />);
      const field = screen.getByRole('textbox', { name: 'Message' });
      fireEvent.change(field, { target: { value: 'Plan the launch, then ship it' } });
      fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
      fireEvent.keyDown(field, { key: 'Enter' });
      fireEvent.keyDown(screen.getByRole('region', { name: 'Messages' }), { key: 'PageUp' });
      fireEvent.click(screen.getByRole('radio', { name: 'Markdown' }));
      fireEvent.click(screen.getByRole('button', { name: 'What is at risk right now?' }));
    });
    expect(added).toBe(0);
  });

  it('opening the model selector adds only what its Popover adds', () => {
    const popover = keydownsDuring(() => {
      render(
        <Popover onClose={() => undefined} trapFocus>
          <button type="button">Inside</button>
        </Popover>,
      );
    });
    cleanup();
    resetLayers();
    render(<Gallery />);
    const opened = keydownsDuring(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Model and effort: Opus · High' }));
    });
    expect(screen.getByRole('dialog', { name: 'Model and effort' })).toBeTruthy();
    // Its Escape layer and its Tab trap: the spies see them.
    expect(popover).toBeGreaterThan(0);
    expect(opened).toBe(popover);
  });

  it('opening the context card adds only what its HoverCard adds', () => {
    render(
      <HoverCard label="Bare" content={() => <p>Bare</p>}>
        {({ ref }) => (
          <button type="button" ref={ref}>
            Bare
          </button>
        )}
      </HoverCard>,
    );
    const bare = keydownsDuring(() => hover(screen.getByRole('button', { name: 'Bare' })));
    expect(screen.getByRole('group', { name: 'Bare' })).toBeTruthy();
    cleanup();
    resetHoverCards();
    resetLayers();
    render(<Gallery />);
    const opened = keydownsDuring(() =>
      hover(screen.getByRole('button', { name: '62% of context used' })),
    );
    expect(screen.getByRole('group', { name: 'Context use' })).toBeTruthy();
    expect(bare).toBeGreaterThan(0);
    expect(opened).toBe(bare);
  });
});

describe('links (CV-16)', () => {
  it('draws no link to anywhere but the web, open or closed', () => {
    render(<Gallery modelOpen />);
    hover(screen.getByRole('button', { name: '62% of context used' }));
    const links = [...document.querySelectorAll('a')];
    for (const link of links) {
      expect(link.getAttribute('href') ?? '', link.outerHTML).toMatch(/^https?:\/\//);
    }
    // The preview holds a URL as text, never as a link.
    expect(screen.getByText('https://example.com').closest('a')).toBeNull();
  });
});

describe('icons', () => {
  it('names only icons that exist', () => {
    render(<Gallery modelOpen />);
    expect(document.querySelectorAll('[data-unknown-icon]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-icon]').length).toBeGreaterThan(5);
  });
});

describe('ported files', () => {
  const FILES = [
    'MessageScroller.tsx',
    'Chat.tsx',
    'Message.tsx',
    'PromptInput.tsx',
    'Attachment.tsx',
    'Suggestion.tsx',
    'ModelSelector.tsx',
    'Context.tsx',
    'Questionnaire.tsx',
    'conversation.css',
  ];

  it.each(FILES)('%s carries the MIT notice', (name) => {
    const head = readFileSync(resolve(__dirname, name), 'utf8').split('\n')[0];
    expect(head).toMatch(/Ported from shadcn\/ui at 25af02b, MIT.*THIRD_PARTY_NOTICES\.md/);
  });
});

describe('conversation.css', () => {
  const css = readFileSync(resolve(__dirname, 'conversation.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  /** A duration written as a number rather than spent from a token. */
  const LITERAL_DURATION = /(?<![\w-])\d*\.?\d+m?s\b/;

  it('spends motion tokens, never a duration of its own', () => {
    const motion = [...css.matchAll(/(?:transition|animation)[\w-]*:([^;]+);/g)].map((m) => m[1]);
    expect(motion.length).toBeGreaterThan(10);
    for (const value of motion) {
      expect(value).toMatch(/var\(--(?:motion|dur)-/);
      expect(value).not.toMatch(LITERAL_DURATION);
      expect(value).not.toMatch(/\ball\b/);
    }
  });

  it('paints with DS tokens only', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
  });

  it('keeps the starters borderless: Cerebro’s rows, not shadcn’s pills', () => {
    const rule = css.slice(css.indexOf('.cb-ai-suggestion {'));
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/\n\s+border: 0;/);
  });
});
