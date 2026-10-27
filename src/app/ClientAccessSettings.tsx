import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Picker } from '@/library/Picker';
import {
  clientGrant,
  clientName,
  clientSnippets,
  grantWords,
  CLIENT_CAP_WORDS,
  CLIENT_TOKEN_CAP,
  type ClientToken,
  type CreatedClientToken,
} from '@/engine/clientAccess';
import { isKnowledgePath } from '@/engine/okf';
import { clientToolsets, toolsetWrites } from '@/lib/policy/tools';
import { writeClipboard } from '@/lib/ipc';
import { useClientAccessStore } from '@/stores/clientAccessStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const CLOUD_HINT =
  "claude.ai and ChatGPT run in the cloud and can't reach an address on this Mac. Claude Desktop needs a local bridge, which Cerebro doesn't ship.";
async function copy(text: string) {
  try {
    await writeClipboard(text);
  } catch (error) {
    useUiStore.getState().toast(`Couldn't copy: ${String(error)}`);
  }
}
function Snippets({ url, secret }: { url: string | null; secret?: string }) {
  const snippets = clientSnippets({ url, secret });
  return (
    <div className="mt-3 space-y-3">
      {[
        { id: 'claude-code', label: 'Claude Code', text: snippets.claude },
        { id: 'cursor', label: 'Cursor and other apps', text: snippets.cursor },
      ].map((snippet) => (
        <div key={snippet.id} data-testid="client-snippet" data-client={snippet.id}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-n-700">{snippet.label}</span>
            <Button size="sm" variant="ghost" onClick={() => void copy(snippet.text)}>
              Copy {snippet.label}
            </Button>
          </div>
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-n-50 p-3 text-2xs text-n-700">
            {snippet.text}
          </pre>
        </div>
      ))}
      <p className="text-xs text-(--text-meta)">{CLOUD_HINT}</p>
    </div>
  );
}

/** Keyed by vault at the public boundary: no draft or shown-once secret crosses it. */
export function ClientAccessSettings() {
  const vault = useVaultStore((s) => s.vaultPath);
  return <ClientAccessBody key={vault ?? ''} vault={vault} />;
}
function ClientAccessBody({ vault }: { vault: string | null }) {
  const store = useClientAccessStore();
  const entries = useVaultStore((s) => s.entries);
  const mounted = useRef(true);
  const [making, setMaking] = useState(false);
  const [created, setCreated] = useState<CreatedClientToken | null>(null);
  const [revoking, setRevoking] = useState<ClientToken | null>(null);
  const [port, setPort] = useState('37421');
  const [name, setName] = useState('');
  const policy = clientToolsets();
  const [toolsets, setToolsets] = useState([policy.default.id]);
  const [writeScope, setWriteScope] = useState<string[]>([]);
  const [readScope, setReadScope] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setProblem(null), [name, toolsets, writeScope, readScope]);
  useEffect(() => {
    mounted.current = true;
    if (vault) void useClientAccessStore.getState().refresh(vault);
    return () => {
      mounted.current = false;
    };
  }, [vault]);
  useEffect(() => {
    if (store.access) setPort(String(store.access.port));
  }, [store.access]);
  const folders = useMemo(() => {
    const found = new Set<string>();
    for (const entry of entries) {
      const parts = entry.path.split('/');
      parts.pop();
      for (let i = 1; i <= parts.length; i++) found.add(parts.slice(0, i).join('/'));
    }
    return [...found].sort().map((value) => ({ value, label: value }));
  }, [entries]);
  const writing = toolsets.some(toolsetWrites);
  const ready = store.vault === vault && store.tokensStatus === 'ready';
  const make = async () => {
    try {
      clientName(name);
      clientGrant({ toolsets, writeScope, readScope });
    } catch (error) {
      setProblem(String(error instanceof Error ? error.message : error));
      return;
    }
    setProblem(null);
    const result = await store.make({ name, toolsets, writeScope, readScope });
    if (result && mounted.current && useVaultStore.getState().vaultPath === vault) {
      setMaking(false);
      setCreated(result);
    }
  };
  const begin = () => {
    setName('');
    setToolsets([policy.default.id]);
    setWriteScope([]);
    setReadScope(null);
    setProblem(null);
    setMaking(true);
  };
  return (
    <section data-testid="client-access" className="mb-6 rounded-xl border border-n-200 p-5">
      <h2 className="mb-1 text-md font-semibold text-n-900">Other apps</h2>
      <p className="mb-4 text-ui text-(--text-meta)">
        Let MCP clients on this Mac — Claude Code in a terminal, Cursor and others — use this vault
        through Cerebro&apos;s own tools, under the guards a run has. Each app gets its own token. A
        token reads by default; it writes only in folders you name, and never Agent pages, Type docs
        or Knowledge.
      </p>
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="text-sm font-medium text-n-800">Let other apps connect</div>
          <p className="mt-0.5 text-xs text-(--text-meta)">
            Listens on 127.0.0.1 only, while Cerebro is open with this vault. Off by default.
          </p>
        </div>
        <Switch
          ariaLabel="Let other apps connect"
          checked={store.access?.enabled ?? false}
          disabled={!vault || store.accessStatus !== 'ready' || store.busy}
          onChange={(enabled) => void store.setAccess(enabled, Number(port))}
        />
      </div>
      <div className="my-3 flex items-center gap-2">
        <label htmlFor="client-port" className="text-xs text-n-600">
          Port
        </label>
        <Input
          id="client-port"
          ariaLabel="Client port"
          value={port}
          onChange={(event) => setPort(event.target.value)}
          className="w-28"
          disabled={store.accessStatus !== 'ready' || store.busy}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={store.accessStatus !== 'ready' || store.busy}
          tabIndex={0}
          onClick={() => void store.setAccess(store.access?.enabled ?? false, Number(port))}
        >
          Save port
        </Button>
      </div>
      {store.accessStatus === 'error' ? (
        <div data-testid="section-unavailable" className="text-xs text-(--text-meta)">
          <p>Couldn&apos;t read whether other apps can connect.</p>
          {vault && (
            <Button size="sm" variant="ghost" onClick={() => void store.refresh(vault)}>
              Retry connection status
            </Button>
          )}
        </div>
      ) : (
        store.access && (
          <p data-testid="client-access-status" className="text-xs text-n-600">
            {!store.access.enabled
              ? "Off. Other apps can't connect."
              : store.access.error
                ? `Couldn't listen on port ${store.access.port}: ${store.access.error}`
                : `Listening at ${store.access.url}.`}
          </p>
        )
      )}
      <div className="my-4 border-t border-n-100 pt-3">
        {!vault ? (
          <p className="text-ui text-(--text-meta)">Open a vault to make a token.</p>
        ) : store.tokensStatus === 'error' ? (
          <div data-testid="section-unavailable">
            <p className="text-ui text-(--text-meta)">Couldn&apos;t read tokens.</p>
            <Button size="sm" variant="ghost" onClick={() => void store.refresh(vault)}>
              Try again
            </Button>
          </div>
        ) : !ready ? (
          <p className="text-ui text-(--text-meta)">Reading tokens…</p>
        ) : store.tokens.length === 0 ? (
          <p className="text-ui text-(--text-meta)">No app has a token yet.</p>
        ) : (
          <ul className="m-0 list-none divide-y divide-n-100 p-0">
            {store.tokens.map((token) => (
              <li
                key={token.tokenId}
                data-testid="client-token"
                className="flex items-start gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-n-800">{token.name}</div>
                  <div className="font-mono text-2xs text-(--text-meta)">client:{token.slug}</div>
                  {grantWords(token).map((words) => (
                    <div key={words} className="text-xs text-n-600">
                      {words}
                    </div>
                  ))}
                  <div className="mt-1 text-2xs text-(--text-meta)">
                    {token.lastUsedAt
                      ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}`
                      : 'Never used'}
                  </div>
                  {!token.currentVault && (
                    <div className="text-xs text-(--text-meta)">
                      For another vault: {token.vaultPath}
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={store.busy}
                  onClick={() => setRevoking(token)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={!ready || store.busy || store.tokens.length >= CLIENT_TOKEN_CAP}
          onClick={begin}
        >
          Make a token
        </Button>
        {ready && store.tokens.length >= CLIENT_TOKEN_CAP && (
          <p className="mt-2 text-xs text-(--text-meta)">{CLIENT_CAP_WORDS}</p>
        )}
      </div>
      <h3 className="text-sm font-medium text-n-800">Connect an app</h3>
      {store.access?.url ? (
        <Snippets url={store.access.url} />
      ) : (
        <p className="mt-1 text-xs text-(--text-meta)">Turn on Let other apps connect first.</p>
      )}
      <Dialog
        open={making}
        title="Make a token"
        onClose={store.busy ? undefined : () => setMaking(false)}
        primaryAction={{ label: 'Make token', disabled: store.busy, onClick: () => void make() }}
        secondaryAction={{ label: 'Cancel', disabled: store.busy, onClick: () => setMaking(false) }}
      >
        <fieldset disabled={store.busy} className="m-0 min-w-0 space-y-4 border-0 p-0">
          <Input
            ariaLabel="Token name"
            className="w-full"
            placeholder="App name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={store.busy}
          />
          <div className="text-xs text-(--text-meta)">
            {policy.default.label} is always included.
          </div>
          {policy.grantable.map((set) => (
            <label key={set.id} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={toolsets.includes(set.id)}
                disabled={store.busy}
                onChange={(event) =>
                  setToolsets(
                    event.target.checked
                      ? [...toolsets, set.id]
                      : toolsets.filter((id) => id !== set.id),
                  )
                }
              />
              <span>
                <span className="block text-sm font-medium">{set.label}</span>
                <span className="block text-xs text-(--text-meta)">{set.hint}</span>
              </span>
            </label>
          ))}
          {writing && (
            <div>
              <div className="mb-1 text-xs font-medium">Writes in</div>
              <Picker
                options={folders.filter((folder) => !isKnowledgePath(`${folder.value}/`))}
                selected={writeScope}
                onChange={setWriteScope}
                addLabel="Choose write folders"
                emptyLabel="Choose at least one folder"
                ariaLabel="Write folders"
              />
            </div>
          )}
          <fieldset>
            <legend className="mb-1 text-xs font-medium">Reads</legend>
            <label className="mr-4 text-sm">
              <input
                type="radio"
                name="client-reads"
                checked={readScope === null}
                onChange={() => setReadScope(null)}
              />{' '}
              The whole vault
            </label>
            <label className="text-sm">
              <input
                type="radio"
                name="client-reads"
                checked={readScope !== null}
                onChange={() => setReadScope([])}
              />{' '}
              Chosen folders
            </label>
            {readScope !== null && (
              <Picker
                options={folders}
                selected={readScope}
                onChange={setReadScope}
                addLabel="Choose read folders"
                emptyLabel="Choose at least one folder"
                ariaLabel="Read folders"
              />
            )}
          </fieldset>
          {problem && (
            <p role="alert" className="text-sm text-n-700">
              {problem}
            </p>
          )}
        </fieldset>
      </Dialog>
      <Dialog
        open={created !== null}
        title="Your token"
        onClose={() => setCreated(null)}
        primaryAction={{ label: 'Done', onClick: () => setCreated(null) }}
      >
        {created && (
          <>
            <code
              data-testid="client-token-secret"
              className="block break-all rounded-md bg-n-50 p-3 text-sm"
            >
              {created.secret}
            </code>
            <p className="my-3 text-sm text-n-600">
              Copy this token now. Cerebro keeps only its fingerprint and can&apos;t show it again.
            </p>
            <Button size="sm" variant="secondary" onClick={() => void copy(created.secret)}>
              Copy
            </Button>
            <Snippets url={store.access?.url ?? null} secret={created.secret} />
          </>
        )}
      </Dialog>
      <Dialog
        open={revoking !== null}
        title={revoking ? `Revoke ${revoking.name}?` : 'Revoke token'}
        onClose={store.busy ? undefined : () => setRevoking(null)}
        primaryAction={{
          label: 'Revoke token',
          disabled: store.busy,
          onClick: () => {
            if (revoking)
              void store.revoke(revoking.tokenId).then((ok) => {
                if (ok && mounted.current) setRevoking(null);
              });
          },
        }}
        secondaryAction={{
          label: 'Cancel',
          disabled: store.busy,
          onClick: () => setRevoking(null),
        }}
      >
        <p>Any app using it stops working at once.</p>
      </Dialog>
    </section>
  );
}
