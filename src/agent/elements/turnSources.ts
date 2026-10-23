import { collectSources, type SourceInput } from '@/engine/ai/sources';
import type { SourceRef } from '@/engine/ai/types';
import { toolFacts, type TargetKind } from '@/lib/policy/tools';
import type { ChatMessage, MessagePart, ToolCall } from '@/agent/types';
import { inputField } from './turnTitles';

/**
 * What a reply drew on (M91.13), for the Sources line under its answer: in
 * the order the turn met them, the web its searches and fetches brought
 * back, the vault pages its reads opened, and the links in its own words
 * (engine/ai/sources.ts, which dedupes and keeps only http(s) and vault
 * paths, CV-16). A subagent's calls count where its Agent call stands: what
 * it found is what the reply drew on. Pure.
 */

/** The targets a read opens a vault page by (the manifest's `target`). */
const PAGE_TARGETS: ReadonlySet<TargetKind> = new Set<TargetKind>(['note', 'file', 'canvas']);

/** The vault page a finished read opened, by its manifest target, or null
 * for a call that is not one. */
function readPage(tool: ToolCall): string | null {
  if (!tool.done || tool.failed) return null;
  const facts = toolFacts(tool.name);
  if (facts === null || facts.fold === null || facts.target === null) return null;
  const { arg, kind } = facts.target;
  return arg === null || !PAGE_TARGETS.has(kind) ? null : inputField(tool, arg);
}

/** A call's sources, then its subagent's, depth first. */
function callInputs(tool: ToolCall): SourceInput[] {
  const inputs: SourceInput[] = [];
  if (tool.result !== undefined && !tool.failed) inputs.push({ from: 'result', data: tool.result });
  const page = readPage(tool);
  if (page !== null) inputs.push({ from: 'read', path: page });
  for (const inner of tool.subagent?.tools ?? []) inputs.push(...callInputs(inner));
  return inputs;
}

export function turnSources(message: ChatMessage): SourceRef[] {
  const byId = new Map(message.tools.map((tool) => [tool.id, tool]));
  const parts: readonly MessagePart[] = message.parts ?? [
    ...message.tools.map((tool): MessagePart => ({ kind: 'tool', toolId: tool.id })),
  ];
  const inputs: SourceInput[] = [];
  const named = new Set<string>();
  let words = false;
  for (const part of parts) {
    if (part.kind === 'tool') {
      const tool = byId.get(part.toolId);
      if (tool === undefined || named.has(tool.id)) continue;
      named.add(tool.id);
      inputs.push(...callInputs(tool));
    } else if (part.kind === 'text') {
      words = true;
      inputs.push({ from: 'text', text: part.text });
    }
  }
  for (const tool of message.tools) if (!named.has(tool.id)) inputs.push(...callInputs(tool));
  if (!words && message.text !== '') inputs.push({ from: 'text', text: message.text });
  return collectSources(inputs);
}
