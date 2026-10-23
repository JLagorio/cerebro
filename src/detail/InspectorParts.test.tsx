// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InspectorAction, InspectorActions, InspectorAsk } from './InspectorParts';

/**
 * The inspector's act rows (owner, 2026-10-18). An ask among them is the
 * Suggestion element in the row's voice (M91.14): it shows its label and
 * hands back its prompt, which is what the Assistant is sent.
 */

// Read from disk: vitest hands a stylesheet import to a test as an empty
// string. jsdom lays nothing out, so the geometry itself is the e2e's
// (knowledge.spec); what jsdom can answer is which rules reach an ask.
const css = readFileSync(join(__dirname, 'inspector.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of every inspector.css rule that reaches `el` at rest. */
function reaching(el: Element): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const matches = m[1].split(',').some((selector) => {
      try {
        return el.matches(selector.trim());
      } catch {
        // jsdom parses no `:has()`; no rule an ask meets uses one.
        return false;
      }
    });
    if (matches) out.push(m[2]);
  }
  return out;
}

afterEach(cleanup);

describe('InspectorAsk (M91.14)', () => {
  it('is a Suggestion named by its label, its glyph hidden, the AI’s tone on it', () => {
    render(
      <InspectorActions label="Ask Knowledge">
        <InspectorAsk
          icon="sparkles"
          label="What’s missing?"
          prompt="the long prompt"
          onAsk={() => {}}
        />
      </InspectorActions>,
    );
    const group = screen.getByRole('group', { name: 'Ask Knowledge' });
    const ask = within(group).getByRole('button', { name: 'What’s missing?' });
    expect(ask.dataset.slot).toBe('suggestion');
    expect(ask.dataset.tone).toBe('ai');
    expect(ask.className).toContain('cb-inspector-action');
    expect(ask.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    // The row says its label; the prompt is never drawn.
    expect(ask.textContent).toBe('What’s missing?');
  });

  it('hands back its prompt when pressed, and waits when held', () => {
    const onAsk = vi.fn();
    const { rerender } = render(
      <InspectorAsk icon="brain" label="Learn from this page" prompt="Learn from…" onAsk={onAsk} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Learn from this page' }));
    expect(onAsk).toHaveBeenCalledWith('Learn from…');
    rerender(
      <InspectorAsk
        icon="brain"
        label="Learn from this page"
        prompt="Learn from…"
        onAsk={onAsk}
        disabled
        title="Knowledge has this page queued to read."
      />,
    );
    const held = screen.getByRole('button', { name: 'Learn from this page' }) as HTMLButtonElement;
    expect(held.disabled).toBe(true);
    expect(held.title).toBe('Knowledge has this page queued to read.');
    fireEvent.click(held);
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  // knowledge.spec (owner, 2026-10-18): the asks are rows — no border, no
  // fill at rest, one line each.
  it('wears the act row’s metrics, and no border or fill at rest', () => {
    render(<InspectorAsk icon="sparkles" label="Ask" prompt="Ask it." onAsk={() => {}} />);
    const rules = reaching(screen.getByRole('button', { name: 'Ask' }));
    expect(rules.length).toBeGreaterThan(1);
    const said = rules.join(';');
    expect(said).toMatch(/padding:\s*4px 8px/);
    expect(said).toMatch(/min-height:\s*28px/);
    expect(said).toMatch(/line-height:\s*var\(--lh-ui\)/);
    for (const border of said.matchAll(
      /(?:^|[;\s])border(?:-(?:top|right|bottom|left|width|style|color))*\s*:\s*([^;]+)/g,
    )) {
      expect(border[1].trim()).toBe('0');
    }
    for (const fill of said.matchAll(/(?:^|[;\s])background(?:-color)?\s*:\s*([^;]+)/g)) {
      expect(fill[1].trim()).toBe('transparent');
    }
  });

  it('sits in one group with the acts that are not asks', () => {
    render(
      <InspectorActions label="File this capture">
        <InspectorAsk icon="sparkles" label="Ask to file" prompt="File it." onAsk={() => {}} />
        <InspectorAction
          icon="circle-check"
          label="Mark organized"
          tone="primary"
          onClick={() => {}}
        />
      </InspectorActions>,
    );
    const rows = within(screen.getByRole('group', { name: 'File this capture' })).getAllByRole(
      'button',
    );
    expect(
      rows.map((row) => [row.textContent, row.dataset.slot ?? null, row.dataset.tone]),
    ).toEqual([
      ['Ask to file', 'suggestion', 'ai'],
      ['Mark organized', null, 'primary'],
    ]);
  });
});
