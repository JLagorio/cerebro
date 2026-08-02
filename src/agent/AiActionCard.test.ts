import { describe, expect, it } from 'vitest';
import { isWrite, toolIcon, toolLabel, toolPath } from '@/agent/AiActionCard';

describe('toolLabel', () => {
  it('strips the MCP namespace and humanizes', () => {
    expect(toolLabel('mcp__cerebro__write_concept')).toBe('write concept');
  });

  it('leaves native CLI tool names alone', () => {
    expect(toolLabel('Bash')).toBe('Bash');
    expect(toolLabel('WebFetch')).toBe('WebFetch');
  });
});

describe('toolIcon', () => {
  it('covers both vocabularies the CLI mixes in one transcript', () => {
    expect(toolIcon('Bash')).toBe('terminal');
    expect(toolIcon('mcp__cerebro__search_notes')).toBe('search');
  });

  it('falls back rather than rendering nothing', () => {
    expect(toolIcon('SomethingNew')).toBe('wrench');
  });
});

describe('isWrite', () => {
  // A write shown as a read is the one classification error that matters —
  // it is the card whose path stays visible and that offers a diff.
  it('names the tools that change the vault', () => {
    for (const t of ['Write', 'Edit', 'mcp__cerebro__create_note', 'mcp__cerebro__write_concept']) {
      expect(isWrite(t)).toBe(true);
    }
    for (const t of ['Read', 'Grep', 'mcp__cerebro__search_notes', 'mcp__cerebro__open_note']) {
      expect(isWrite(t)).toBe(false);
    }
  });
});

describe('toolPath', () => {
  it('finds the path a tool touched', () => {
    expect(toolPath('{"path":"knowledge/x.md"}')).toBe('knowledge/x.md');
    expect(toolPath('{"file_path":"/a/b.md"}')).toBe('/a/b.md');
    expect(toolPath('{"query":"at risk"}')).toBe('at risk');
  });

  it('is quiet on malformed or empty input', () => {
    expect(toolPath(null)).toBeNull();
    expect(toolPath('not json')).toBeNull();
    expect(toolPath('{"unrelated":1}')).toBeNull();
  });
});
