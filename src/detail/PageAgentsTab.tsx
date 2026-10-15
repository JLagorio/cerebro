import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { RelationPicker } from '@/detail/RelationPicker';
import { agentFieldsOf } from '@/engine/assignment';
import { isAgentEntry, isPaused } from '@/engine/agents';
import { filedTypesOf } from '@/engine/filing';
import { humanize } from '@/engine/schema';
import { parseTriggers } from '@/engine/triggers';
import type { Entry, Schema } from '@/engine/types';
import { formatWikilink, resolveTarget } from '@/engine/wikilink';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

/** A host's own assignments, not a roster inferred from work already filed.
 * Editing this list never changes its existing work. The five human filing
 * doors copy agents only when work newly joins a host. */
export function PageAgentsTab({
  entry,
  entries,
  schema,
}: {
  entry: Entry;
  entries: Entry[];
  schema: Schema;
}) {
  const fields = agentFieldsOf(entry.type, schema);
  const filed = filedTypesOf(entry.type, schema);
  const receiving = [
    ...new Set(filed.flatMap((row) => (row.receiving === null ? [] : [row.receiving]))),
  ];
  const [picking, setPicking] = useState<string | null>(null);
  const patch = useVaultStore((state) => state.patchFrontmatter);
  const navigate = useNavStore((state) => state.navigate);
  if (fields.length === 0)
    return (
      <p data-testid="page-agents-unconfigured" className="m-0 px-6 py-4 text-sm text-n-500">
        {entry.type ?? 'These'} pages have no relation to Agent, so this page lists no agents. Add a
        Relation property related to Agent to the {entry.type ?? 'page'} database.
      </p>
    );
  const save = (field: string, next: string[]) =>
    void patch(entry.path, { [field]: next.length === 0 ? null : next.map(formatWikilink) });
  return (
    <div data-testid="page-agents" className="space-y-5 px-6 py-4">
      {fields.map((field) => {
        const raw = entry.relationships[field.name] ?? [];
        return (
          <section key={field.name} data-field={field.name} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="m-0 text-xs font-semibold text-n-600">{humanize(field.name)}</h3>
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                testId="page-agents-add"
                onClick={() => setPicking(field.name)}
              >
                Add agent
              </Button>
            </div>
            {raw.length === 0 && (
              <p data-testid="page-agents-empty" className="m-0 text-sm text-n-500">
                No agents yet. Agents you add here are assigned the work filed here from now on.
              </p>
            )}
            {raw.map((target, index) => {
              const resolved = resolveTarget(target, entries);
              const agent = resolved !== null && isAgentEntry(resolved) ? resolved : null;
              const statuses =
                agent === null
                  ? [`No agent called ${target}.`]
                  : isPaused(agent)
                    ? ["Paused: work that arrives now won't wake it."]
                    : receiving.length === 0
                      ? ["Won't wake on its own: no filed work has one field that takes agents."]
                      : receiving.map((field) =>
                          parseTriggers(agent.properties.when).some(
                            (trigger) => trigger.event === 'assigned' && trigger.field === field,
                          )
                            ? `Wakes when work is assigned to it via ${field}.`
                            : `Won't wake on its own: none of its triggers is assigned to it via ${field}. Open its page to add one.`,
                        );
              return (
                <div
                  key={`${index}:${target}`}
                  data-testid="page-agent-row"
                  className="flex items-start gap-2 py-1"
                >
                  <div className="min-w-0 flex-1">
                    {agent === null ? (
                      <span className="text-sm text-n-600">{target}</span>
                    ) : (
                      <button
                        type="button"
                        data-testid="page-agent-open"
                        onClick={() => navigate({ kind: 'doc', path: agent.path })}
                        className="border-0 bg-transparent p-0 text-left text-sm text-cortex-600 hover:text-cortex-700"
                      >
                        {agent.title}
                      </button>
                    )}
                    {statuses.map((status) => (
                      <p
                        key={status}
                        data-testid="page-agent-status"
                        className="m-0 mt-0.5 text-xs text-n-500"
                      >
                        {status}
                      </p>
                    ))}
                  </div>
                  <IconButton
                    icon="x"
                    size="sm"
                    label={`Remove ${agent?.title ?? target}`}
                    onClick={() =>
                      save(
                        field.name,
                        raw.filter((_, at) => at !== index),
                      )
                    }
                  />
                </div>
              );
            })}
            {picking === field.name && (
              <RelationPicker
                fieldName={field.name}
                targetType="Agent"
                value={raw}
                limit={field.limit}
                entries={entries}
                schema={schema}
                onChange={(next) => save(field.name, next)}
                onClose={() => setPicking(null)}
              />
            )}
          </section>
        );
      })}
      <div
        data-testid="page-agents-footers"
        className="space-y-1 border-t border-n-100 pt-3 text-xs text-n-500"
      >
        {filed.map(({ tab, recordType, receiving }) => (
          <p key={tab.id} className="m-0">
            {receiving !== null
              ? `${tab.name} filed here get these agents through their ${receiving} field.`
              : agentFieldsOf(recordType, schema).length === 0
                ? `${tab.name} have no field that takes agents.`
                : `${tab.name} have more than one field that takes agents, so none is filled.`}
          </p>
        ))}
        <p className="m-0">Work already here keeps its own agents, and so does work that leaves.</p>
      </div>
    </div>
  );
}
