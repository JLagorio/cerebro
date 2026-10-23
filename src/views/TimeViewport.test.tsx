import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { TimeViewport } from './TimeViewport';

afterEach(cleanup);

describe('time/table viewport', () => {
  it('scrolls columns independently while synchronizing vertical rows in both directions', () => {
    const axisRef = createRef<HTMLDivElement>();
    render(
      <TimeViewport table={<div>Records</div>} axisRef={axisRef}>
        <div>Dates</div>
      </TimeViewport>,
    );
    const table = screen.getByTestId('time-table-viewport');
    const axis = screen.getByTestId('time-axis-viewport');
    table.scrollLeft = 800;
    table.scrollTop = 120;
    fireEvent.scroll(table);
    expect(axis.scrollTop).toBe(120);
    expect(axis.scrollLeft).toBe(0);
    axis.scrollLeft = 400;
    axis.scrollTop = 240;
    fireEvent.scroll(axis);
    expect(table.scrollTop).toBe(240);
    expect(table.scrollLeft).toBe(800);
  });

  it('announces and respects the split limits for keyboard resizing', () => {
    render(
      <TimeViewport table={<div>Records</div>} axisRef={createRef()}>
        <div>Dates</div>
      </TimeViewport>,
    );
    const divider = screen.getByRole('separator', { name: 'Table and time divider' });
    expect(divider.getAttribute('aria-valuemin')).toBe('240');
    expect(divider.getAttribute('aria-valuemax')).toBe('420');
    fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true });
    expect(divider.getAttribute('aria-valuenow')).toBe('398');
    fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true });
    expect(divider.getAttribute('aria-valuenow')).toBe('420');
  });
});
