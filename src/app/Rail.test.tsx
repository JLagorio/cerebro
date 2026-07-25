// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useNavStore } from '@/stores/navStore';
import { Rail } from './Rail';

describe('Rail', () => {
  beforeEach(() => {
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });
  afterEach(cleanup);

  it('navigates to the Docs surface', () => {
    render(<Rail />);
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'docs' });
  });

  it('keeps Docs active on a doc page, Home active on projects', () => {
    useNavStore.setState({ selection: { kind: 'doc', path: 'inbox/welcome.md' } });
    render(<Rail />);
    expect(screen.getByRole('button', { name: 'Docs' }).className).toContain('cortex');
    expect(screen.getByRole('button', { name: 'Home' }).className).not.toContain('cortex');
    cleanup();

    useNavStore.setState({ selection: { kind: 'project', path: 'projects/x/project.md' } });
    render(<Rail />);
    expect(screen.getByRole('button', { name: 'Home' }).className).toContain('cortex');
    expect(screen.getByRole('button', { name: 'Docs' }).className).not.toContain('cortex');
  });
});
