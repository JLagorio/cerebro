import { describe, expect, it } from 'vitest';
import { replayTranscript } from '@/agent/transcript';
import { transcriptRows } from '@/agent/transcriptRows';
import { bareToolName, toolFacts } from '@/lib/policy/tools';
import { demoFleetRuns } from './demoOperational';
import { demoRunTranscripts } from './demoTranscripts';

/** The demo's run transcripts (M56.9) go through the panel's one reducer and
 * its row rules, so what the run detail draws is what the panel would. */
describe('demo run transcripts', () => {
  const scout = demoRunTranscripts()['run-scout-1'];
  const read = scout.read;

  it('belongs to the run whose session it names', () => {
    const run = demoFleetRuns().find((r) => r.run_id === 'run-scout-1');
    expect(read.state).toBe('read');
    if (read.state !== 'read') return;
    expect(read.events[0]).toEqual({ kind: 'Init', session_id: run?.cli_session_id });
  });

  it('reduces through the reducer with nothing unclassified, and every tool known', () => {
    if (read.state !== 'read') throw new Error('expected a read');
    expect(read.unclassified).toEqual([]);
    const { messages, model } = replayTranscript(read.events, 'session');
    expect(model).toBe('claude-opus-5');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const reply = messages[1];
    expect(reply.interrupted).toBeUndefined();
    expect(reply.text).toContain('Release watch');
    for (const tool of reply.tools) {
      expect(toolFacts(tool.name), tool.name).not.toBeNull();
      expect(tool.done, tool.name).toBe(true);
    }
  });

  it('holds five consecutive get_note calls, which render as one row', () => {
    if (read.state !== 'read') throw new Error('expected a read');
    const reply = replayTranscript(read.events, 'session').messages[1];
    const names = reply.tools.map((t) => bareToolName(t.name));
    const first = names.indexOf('get_note');
    expect(names.slice(first, first + 5)).toEqual(Array(5).fill('get_note'));
    expect(names.filter((n) => n === 'get_note')).toHaveLength(5);

    const rows = transcriptRows(reply.tools, false);
    const groups = rows.filter((r) => r.kind === 'group');
    expect(groups).toHaveLength(1);
    expect(groups[0].kind === 'group' && groups[0].label).toContain('read 5 notes');
    // The refused write stands on its own row, failed.
    const refused = rows.find(
      (r) => r.kind === 'tool' && bareToolName(r.tool.name) === 'create_note',
    );
    expect(refused?.kind === 'tool' && refused.status).toBe('failed');
  });
});
