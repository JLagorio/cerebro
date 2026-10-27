import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_HELP_BYTES = 16 * 1024;
interface TopicSource {
  id: string;
  title: string;
  file: string;
  tools: string[];
}
interface HelpInput {
  version: string;
  topics: TopicSource[];
  readSource: (file: string) => string;
  toolNames: string[];
  retiredTerms: string[];
}

/** Compile only the declared, shipped human guides. No vault is an input. */
export function compileHelp(input: HelpInput) {
  if (!input.version.trim()) throw new Error('Help requires an app version.');
  const ids = new Set<string>();
  const topics = input.topics.map((source) => {
    if (!/^[a-z][a-z0-9-]*$/.test(source.id) || ids.has(source.id))
      throw new Error(`Invalid or duplicate help ID: ${source.id}`);
    ids.add(source.id);
    if (source.file !== `${source.id}.md` || !source.title.trim())
      throw new Error(`Invalid help source: ${source.id}`);
    for (const tool of source.tools)
      if (!input.toolNames.includes(tool)) throw new Error(`Unknown help tool: ${tool}`);
    const body = input.readSource(source.file);
    if (!body.trim()) throw new Error(`Empty help source: ${source.id}`);
    const prose = `${source.title}\n${body}`.toLowerCase();
    for (const term of input.retiredTerms)
      if (prose.includes(term.toLowerCase())) throw new Error(`Retired help term: ${term}`);
    // Named tool references must also be declared and checked against the manifest.
    for (const match of body.matchAll(/\btool:([a-z][a-z0-9_]*)\b/g))
      if (!source.tools.includes(match[1])) throw new Error(`Undeclared help tool: ${match[1]}`);
    const topic = {
      id: source.id,
      title: source.title,
      appVersion: input.version,
      contentHash: createHash('sha256').update(body).digest('hex'),
      body,
    };
    if (Buffer.byteLength(JSON.stringify(topic), 'utf8') > MAX_HELP_BYTES)
      throw new Error(`Help topic exceeds ${MAX_HELP_BYTES} bytes: ${source.id}`);
    return topic;
  });
  return { format: 1, topics };
}

export function buildHelpCatalog(root: string) {
  const json = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const source = json('shared/help/catalog.v1.json') as { format: number; topics: TopicSource[] };
  if (source.format !== 1 || !Array.isArray(source.topics))
    throw new Error('Unknown help catalog.');
  return compileHelp({
    version: (json('package.json') as { version: string }).version,
    topics: source.topics,
    readSource: (file) => readFileSync(resolve(root, 'shared/help', file), 'utf8'),
    toolNames: (json('shared/policy/tools.v1.json') as { tools: { name: string }[] }).tools.map(
      (tool) => tool.name,
    ),
    retiredTerms: (json('shared/prompt/retired-terms.json') as { terms: string[] }).terms,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check'))
    throw new Error('Usage: pnpm exec node --import tsx scripts/build-help.ts [--check]');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const output = resolve(root, 'shared/help/generated.v1.json');
  const content = JSON.stringify(buildHelpCatalog(root), null, 2) + '\n';
  if (args[0] === '--check') {
    if (readFileSync(output, 'utf8') !== content)
      throw new Error('Help catalog drift: run pnpm exec tsx scripts/build-help.ts');
  } else writeFileSync(output, content);
}
