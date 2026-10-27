import { describe, expect, it } from 'vitest';
import { applyEvent, endLiveTurn, findCall, type ReduceMode } from './transcript';
import type { AgentStreamEvent, ChatMessage } from './types';

const reply = (): ChatMessage => ({
  id: 'parent-reply',
  role: 'assistant',
  text: 'The parent answer stays here.',
  tools: [],
});

const agent = (id: string, parent?: string): AgentStreamEvent => ({
  kind: 'ToolStart',
  tool_id: id,
  tool_name: 'Agent',
  input: JSON.stringify({ subagent_type: 'cerebro-researcher', description: id }),
  ...(parent === undefined ? {} : { parent }),
});

function reduce(events: AgentStreamEvent[], mode: ReduceMode): ChatMessage {
  return events.reduce((message, event) => applyEvent(message, event, mode), reply());
}

for (const mode of ['live', 'replay'] as const) {
  describe(`child evidence availability (${mode})`, () => {
    it('orphaned_child_output_is_partial_without_becoming_the_parent_answer', () => {
      const original = reduce([agent('known-child')], mode);
      const event: AgentStreamEvent = {
        kind: 'Text',
        message_id: 'orphan-message',
        parent: 'missing-call',
        text: 'Unattributed child content must not be retained.',
      };
      const partial = applyEvent(original, event, mode);
      expect(partial.text).toBe(original.text);
      expect(partial.tools).toBe(original.tools);
      expect(JSON.stringify(partial)).not.toContain(event.text);
      expect(partial).toHaveProperty('childTraceUnavailable', true);
      expect(endLiveTurn(partial)).toHaveProperty('childTraceUnavailable', true);
      expect(applyEvent(partial, event, mode)).toBe(partial);
    });

    it('an_ordinary_tool_cannot_become_a_parent_for_child_evidence', () => {
      const original = reduce(
        [{ kind: 'ToolStart', tool_id: 'ordinary-read', tool_name: 'Read' }],
        mode,
      );
      const partial = applyEvent(
        original,
        { kind: 'Text', message_id: 'wrong-parent', parent: 'ordinary-read', text: 'Stray' },
        mode,
      );
      expect(findCall(partial.tools, 'ordinary-read')?.subagent).toBeUndefined();
      expect(partial.text).toBe(original.text);
      expect(partial).toHaveProperty('childTraceUnavailable', true);
    });

    it('a_child_completion_cannot_settle_another_parents_call', () => {
      const original = reduce(
        [
          agent('child-a'),
          agent('child-b'),
          { kind: 'ToolStart', tool_id: 'read-a', tool_name: 'Read', parent: 'child-a' },
        ],
        mode,
      );
      const partial = applyEvent(
        original,
        { kind: 'ToolDone', tool_id: 'read-a', parent: 'child-b', output: 'Wrong parent result' },
        mode,
      );
      expect(findCall(partial.tools, 'read-a')).toBe(findCall(original.tools, 'read-a'));
      expect(findCall(partial.tools, 'read-a')?.done).toBe(false);
      expect(partial).toHaveProperty('childTraceUnavailable', true);
    });

    it.each([
      { kind: 'ToolStart', tool_id: 'read-a', tool_name: 'Read', parent: 'child-b' },
      {
        kind: 'ToolPayload',
        tool_id: 'read-a',
        parent: 'child-b',
        part: 'output',
        text: 'Wrong parent payload',
        bytes: 20,
        truncated: false,
      },
      {
        kind: 'ToolResult',
        tool_id: 'read-a',
        parent: 'child-b',
        data: { type: 'todos', todos: [] },
      },
      { kind: 'ToolDone', tool_id: 'read-a', output: 'Missing parent result' },
    ] satisfies AgentStreamEvent[])(
      'keeps a known child call immutable under a mismatched $kind event',
      (event) => {
        const original = reduce(
          [
            agent('child-a'),
            agent('child-b'),
            { kind: 'ToolStart', tool_id: 'read-a', tool_name: 'Read', parent: 'child-a' },
          ],
          mode,
        );
        const partial = applyEvent(original, event, mode);
        expect(partial.tools).toBe(original.tools);
        expect(partial.text).toBe(original.text);
        expect(partial).toHaveProperty('childTraceUnavailable', true);
      },
    );

    it('a structured child report cannot turn an ordinary tool into an Agent call', () => {
      const original = reduce(
        [{ kind: 'ToolStart', tool_id: 'ordinary-read', tool_name: 'Read' }],
        mode,
      );
      const partial = applyEvent(
        original,
        {
          kind: 'ToolResult',
          tool_id: 'ordinary-read',
          data: {
            type: 'agent',
            agent_id: 'stray-child',
            status: 'completed',
            summary: 'Wrong report',
          },
        },
        mode,
      );
      expect(partial.tools).toBe(original.tools);
      expect(JSON.stringify(partial)).not.toContain('Wrong report');
      expect(partial).toHaveProperty('childTraceUnavailable', true);
    });

    it('a duplicate start cannot rename the same child call into another tool', () => {
      const original = reduce([agent('child-a')], mode);
      const partial = applyEvent(
        original,
        {
          kind: 'ToolStart',
          tool_id: 'child-a',
          tool_name: 'Read',
        },
        mode,
      );
      expect(partial.tools).toBe(original.tools);
      expect(partial).toHaveProperty('childTraceUnavailable', true);
    });

    it.each([
      {
        kind: 'SubagentStarted',
        tool_id: 'child-a',
        agent_id: 'different-agent',
        subagent_type: '',
        description: '',
        background: false,
      },
      {
        kind: 'ToolResult',
        tool_id: 'child-a',
        data: { type: 'agent', agent_id: 'different-agent', summary: 'Different agent report' },
      },
    ] satisfies AgentStreamEvent[])(
      'does not replace a recorded child identity through $kind',
      (event) => {
        const original = reduce(
          [
            agent('child-a'),
            {
              kind: 'SubagentStarted',
              tool_id: 'child-a',
              agent_id: 'original-agent',
              subagent_type: '',
              description: '',
              background: false,
            },
          ],
          mode,
        );
        const partial = applyEvent(original, event, mode);
        expect(partial.tools).toBe(original.tools);
        expect(partial.tools[0].subagent?.agentId).toBe('original-agent');
        expect(JSON.stringify(partial)).not.toContain('Different agent report');
        expect(partial).toHaveProperty('childTraceUnavailable', true);
      },
    );

    it('late matching delivery keeps one child and the completed parent answer', () => {
      const start = agent('child-a');
      const text: AgentStreamEvent = {
        kind: 'Text',
        message_id: 'child-answer',
        parent: 'child-a',
        text: 'Child answer',
      };
      const completed = endLiveTurn(
        reduce(
          [
            start,
            { kind: 'ToolStart', tool_id: 'read-a', tool_name: 'Read', parent: 'child-a' },
            { kind: 'ToolDone', tool_id: 'read-a', parent: 'child-a', output: 'Read answer' },
            text,
            { kind: 'ToolDone', tool_id: 'child-a', output: 'Child answer' },
            { kind: 'Text', message_id: 'final-answer', text: 'Final parent answer' },
            { kind: 'TurnEnded' },
          ],
          mode,
        ),
      );
      const late = [
        start,
        text,
        { kind: 'ToolDone', tool_id: 'child-a', output: 'Child answer' },
      ].reduce((message, event) => applyEvent(message, event as AgentStreamEvent, mode), completed);
      expect(late.text).toBe('Final parent answer');
      expect(late.tools).toHaveLength(1);
      expect(late.tools[0].done).toBe(true);
      expect(late.tools[0].subagent?.status).toBe('done');
      expect(late.tools[0].subagent?.tools).toHaveLength(1);
      expect(late.tools[0].subagent?.parts.filter((part) => part.kind === 'text')).toHaveLength(1);
      expect(late.childTraceUnavailable).toBeUndefined();
    });

    it('nested_child_errors_stay_with_the_actual_child', () => {
      const failed = reduce(
        [
          agent('outer'),
          agent('inner', 'outer'),
          { kind: 'Error', parent: 'inner', message: 'Child failed' },
        ],
        mode,
      );
      expect(findCall(failed.tools, 'inner')?.subagent).toMatchObject({
        status: 'failed',
        error: 'Child failed',
      });
      expect(findCall(failed.tools, 'outer')?.subagent?.error).toBeUndefined();
      expect(failed.error).toBeUndefined();
      expect(failed.text).toBe(reply().text);
    });
  });
}
