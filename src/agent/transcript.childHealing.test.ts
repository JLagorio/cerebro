import { describe, expect, it } from 'vitest';
import { applyEvent, findCall, healFromTranscript } from './transcript';
import type { AgentStreamEvent, ChatMessage } from './types';

const agent = (id: string, parent?: string): AgentStreamEvent => ({
  kind: 'ToolStart',
  tool_id: id,
  tool_name: 'Agent',
  ...(parent === undefined ? {} : { parent }),
});

const started = (id: string, identity: string): AgentStreamEvent => ({
  kind: 'SubagentStarted',
  tool_id: id,
  agent_id: identity,
  subagent_type: '',
  description: '',
  background: false,
});

const report = (id: string, identity: string): AgentStreamEvent => ({
  kind: 'ToolResult',
  tool_id: id,
  data: { type: 'agent', agent_id: identity, summary: `Report from ${identity}` },
});

function reduce(events: AgentStreamEvent[], id = 'cached-reply'): ChatMessage {
  return events.reduce<ChatMessage>((message, event) => applyEvent(message, event, 'replay'), {
    id,
    role: 'assistant',
    text: 'Parent answer',
    tools: [],
  });
}

describe('partial transcript healing preserves child attribution', () => {
  it('keeps a known child identity and excludes conflicting replay steps and report', () => {
    const cached = reduce([agent('child'), started('child', 'identity-A')]);
    const replay = reduce([
      agent('child'),
      report('child', 'identity-B'),
      { kind: 'Text', parent: 'child', message_id: 'steps-B', text: 'Steps from B' },
    ]);
    const healed = healFromTranscript([cached], [replay]);
    expect(healed[0].tools).toBe(cached.tools);
    expect(healed[0].text).toBe(cached.text);
    expect(JSON.stringify(healed)).not.toContain('Steps from B');
    expect(JSON.stringify(healed)).not.toContain('Report from identity-B');
    expect(healed[0].childTraceUnavailable).toBe(true);
    expect(healFromTranscript(healed, [replay])).toBe(healed);
  });

  it('cannot finish a cached call with output from a different parent', () => {
    const roots = [agent('outer-A'), agent('outer-B')];
    const cached = reduce([
      ...roots,
      { kind: 'ToolStart', tool_id: 'read', tool_name: 'Read', parent: 'outer-A' },
    ]);
    const replay = reduce([
      ...roots,
      { kind: 'ToolStart', tool_id: 'read', tool_name: 'Read', parent: 'outer-B' },
      { kind: 'ToolDone', tool_id: 'read', parent: 'outer-B', output: 'Output from B' },
    ]);
    const [healed] = healFromTranscript([cached], [replay]);
    expect(findCall(healed.tools, 'read')).toBe(findCall(cached.tools, 'read'));
    expect(JSON.stringify(healed)).not.toContain('Output from B');
    expect(healed.childTraceUnavailable).toBe(true);
  });

  it('does not graft a differently named child tool onto a cached call', () => {
    const cached = reduce([
      agent('outer'),
      { kind: 'ToolStart', tool_id: 'same-id', tool_name: 'Read', parent: 'outer' },
    ]);
    const replay = reduce([
      agent('outer'),
      { kind: 'ToolStart', tool_id: 'same-id', tool_name: 'Bash', parent: 'outer' },
      { kind: 'ToolDone', tool_id: 'same-id', parent: 'outer', output: 'Other tool output' },
    ]);
    const [healed] = healFromTranscript([cached], [replay]);
    expect(healed.tools).toBe(cached.tools);
    expect(healed.childTraceUnavailable).toBe(true);
  });

  it('does not heal descendants through an ancestor with a conflicting child identity', () => {
    const shared = [
      agent('outer'),
      agent('inner', 'outer'),
      { kind: 'ToolStart', tool_id: 'read', tool_name: 'Read', parent: 'inner' } as const,
    ];
    const cached = reduce([...shared, started('outer', 'identity-A')]);
    const replay = reduce([
      ...shared,
      started('outer', 'identity-B'),
      { kind: 'ToolDone', tool_id: 'read', parent: 'inner', output: 'Foreign descendant' },
    ]);
    const [healed] = healFromTranscript([cached], [replay]);
    expect(healed.tools).toBe(cached.tools);
    expect(JSON.stringify(healed)).not.toContain('Foreign descendant');
    expect(healed.childTraceUnavailable).toBe(true);
  });

  it('uses the matching reply when another turn reuses a child call id', () => {
    const cached = reduce([agent('child')], 'turn-A');
    const replayA = reduce([agent('child'), report('child', 'identity-A')], 'turn-A');
    const replayB = reduce([agent('child'), report('child', 'identity-B')], 'turn-B');
    const [healed] = healFromTranscript([cached], [replayA, replayB]);
    expect(healed.tools[0].subagent?.agentId).toBe('identity-A');
    expect(JSON.stringify(healed)).not.toContain('identity-B');
    expect(healed.childTraceUnavailable).toBeUndefined();
  });

  it('keeps content partial when call-only matching has two possible replies', () => {
    const cached = reduce([agent('child')], 'cache-id');
    const replayA = reduce([agent('child'), report('child', 'identity-A')], 'replay-A');
    const replayB = reduce([agent('child'), report('child', 'identity-B')], 'replay-B');
    const [healed] = healFromTranscript([cached], [replayA, replayB]);
    expect(healed.tools).toBe(cached.tools);
    expect(healed.childTraceUnavailable).toBe(true);
  });

  it('does not combine two replay replies when cached call anchors disagree', () => {
    const cached = reduce([agent('child-A'), agent('child-B')], 'cache-id');
    const replayA = reduce([agent('child-A'), report('child-A', 'identity-A')], 'replay-A');
    const replayB = reduce([agent('child-B'), report('child-B', 'identity-B')], 'replay-B');
    const [healed] = healFromTranscript([cached], [replayA, replayB]);
    expect(healed.tools).toBe(cached.tools);
    expect(healed.childTraceUnavailable).toBe(true);
  });

  it('does not adopt a conflicting replay through its parent parts', () => {
    const cached = reduce([agent('child'), started('child', 'identity-A')]);
    delete cached.parts;
    const replay = reduce([
      agent('child'),
      report('child', 'identity-B'),
      {
        kind: 'Thinking',
        message_id: 'parent-thought',
        text: 'Reasoning from the conflicting replay',
      },
    ]);
    const [healed] = healFromTranscript([cached], [replay]);
    expect(healed.parts).toBeUndefined();
    expect(JSON.stringify(healed)).not.toContain('Reasoning from the conflicting replay');
    expect(healed.childTraceUnavailable).toBe(true);
  });

  it('keeps compatible missing-identity healing and partial payload completion', () => {
    const events = [
      agent('child'),
      { kind: 'ToolStart', tool_id: 'read', tool_name: 'Read', parent: 'child' } as const,
    ];
    const cached = reduce(events, 'cache-id');
    const replay = reduce(
      [
        ...events,
        report('child', 'identity-A'),
        { kind: 'ToolDone', tool_id: 'read', parent: 'child', output: 'Compatible output' },
        {
          kind: 'ToolPayload',
          tool_id: 'read',
          parent: 'child',
          part: 'output',
          text: 'Complete compatible output',
          bytes: 26,
          truncated: false,
        },
      ],
      'replay-id',
    );
    const healed = healFromTranscript([cached], [replay]);
    expect(healed[0].tools[0].subagent?.agentId).toBe('identity-A');
    expect(findCall(healed[0].tools, 'read')).toMatchObject({
      done: true,
      output: 'Compatible output',
      payload: { output: 'Complete compatible output' },
    });
    expect(healed[0].childTraceUnavailable).toBeUndefined();
    expect(healFromTranscript(healed, [replay])).toBe(healed);
  });
});
