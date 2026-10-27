import { createTarget } from '@/engine/createRecord';
import type { CreationDestination } from '@/engine/creationDestination';
import type { Entry, Schema } from '@/engine/types';
import { Select } from '@/components/ui/Select';
export function pageFolders(entries: Entry[], folders: string[] = []): string[] {
  const all = new Set(['', ...folders]);
  for (const entry of entries) {
    let folder = entry.folder;
    while (folder !== '') {
      all.add(folder);
      folder = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
    }
  }
  return [...all]
    .filter((folder) => !folder.split('/').some((part) => part.startsWith('.') || part === '..'))
    .sort();
}
export function CreationDestinationField({
  destination,
  entries,
  schema,
  folders = [],
  disabled = false,
  onChange,
}: {
  destination: CreationDestination;
  entries: Entry[];
  schema: Schema;
  folders?: string[];
  disabled?: boolean;
  onChange: (destination: CreationDestination) => void;
}) {
  if (destination.kind === 'record') {
    const host = entries.find((entry) => entry.path === destination.host?.path);
    return (
      <div data-testid="creation-destination" className="text-xs text-n-600">
        In {destination.typeName} · {createTarget(destination.typeName, { entries, schema }).folder}
        {destination.host !== null && (
          <> · Related to {host?.title ?? `${destination.host.path} (unavailable)`}</>
        )}
        {(!schema.types.has(destination.typeName) ||
          (destination.host !== null && host === undefined)) && (
          <p role="status">
            Choose a database or related destination: the original destination is unavailable.
          </p>
        )}
      </div>
    );
  }
  const options = pageFolders(entries, folders);
  const missing = !options.includes(destination.folder);
  return (
    <div data-testid="creation-destination" className="flex flex-col gap-1 text-xs text-n-600">
      <label htmlFor="creation-folder">In {destination.folder || 'vault root'}</label>
      <Select
        id="creation-folder"
        ariaLabel="Folder"
        value={destination.folder}
        disabled={disabled}
        options={[
          ...(missing
            ? [{ value: destination.folder, label: `${destination.folder} (unavailable)` }]
            : []),
          ...options.map((folder) => ({ value: folder, label: folder || 'Vault root' })),
        ]}
        onChange={(folder) => onChange({ ...destination, folder })}
        width="100%"
      />
      {missing && (
        <span role="status">Choose a folder: the original destination is unavailable.</span>
      )}
    </div>
  );
}
