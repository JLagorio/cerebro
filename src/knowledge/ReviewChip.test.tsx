// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_ONLY_LABEL, REVIEW_LABELS } from '@/engine/okf';
import { ReviewChip } from './ReviewChip';

afterEach(cleanup);

describe('ReviewChip', () => {
  // A one-line row in the page inspector has no room for a pill: the glyph
  // stands in, and says everything the pill said as its name and tooltip.
  it('draws a glyph whose name is the words the pill would say', () => {
    render(<ReviewChip status="current" by="human" size="glyph" />);
    const glyph = screen.getByRole('img', { name: `${REVIEW_LABELS.current} · by a person` });
    expect(glyph.title).toBe(`${REVIEW_LABELS.current} · by a person`);
    expect(glyph.dataset).toMatchObject({ review: 'current', by: 'human' });
    expect(glyph.textContent).toBe('');
  });

  it('keeps the agent-only review apart from a person’s', () => {
    render(<ReviewChip status="current" by="agent" size="glyph" />);
    expect(
      screen.getByRole('img', { name: `${AGENT_ONLY_LABEL} · confirmed by an agent` }),
    ).toBeTruthy();
  });

  it('still draws the pill elsewhere', () => {
    render(<ReviewChip status="predates_current" />);
    expect(screen.getByTestId('review-chip').textContent).toBe(REVIEW_LABELS.predates_current);
  });
});
