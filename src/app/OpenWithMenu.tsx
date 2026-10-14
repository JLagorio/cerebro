import { useRef, useState } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { flushOpenPages } from '@/editor/openPages';
import { splitFrontmatter } from '@/engine/frontmatter';
import { pagePrompt } from '@/engine/pagePrompt';
import type { Entry } from '@/engine/types';
import {
  canOpenOutside,
  openAgentLink,
  openInDefaultApp,
  readNote,
  revealInFinder,
  writeClipboard,
} from '@/lib/ipc';
import { refusalText } from '@/lib/refusal';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import AGENT_LINKS from '../../shared/policy/agent-links.v1.json';

/**
 * The apps a page can be handed to, in menu order. Only the ids and labels:
 * Rust builds every link and checks its length (shell::open), so no rule
 * lives in two languages.
 */
export const AGENT_TARGETS: readonly { id: string; label: string }[] = AGENT_LINKS.targets.map(
  ({ id, label }) => ({ id, label }),
);

const DESKTOP_ONLY = 'Desktop app only';

/**
 * Open with (M55.9): a page leaves the app as a prompt, a path, a Finder
 * selection, a file in the default editor, or a link into an agent app.
 *
 * Every toast waits for its await: "Prompt copied" shows once the clipboard
 * holds the prompt, never before. A prompt is built after the open pages
 * flush, so it holds what was typed a moment ago. Nothing here throws.
 */
export function OpenWithMenu({ entry, knowledgeFile }: { entry: Entry; knowledgeFile: boolean }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  if (vaultPath === null) return null;

  const desktop = canOpenOutside();
  const close = () => setOpen(false);

  /** Flush, read, build. The entry is looked up again after the flush, so
   *  its properties are the ones the flush saved. */
  const buildPrompt = async (): Promise<string> => {
    await flushOpenPages();
    const raw = await readNote(vaultPath, entry.path);
    const latest = useVaultStore.getState().entries.find((e) => e.path === entry.path) ?? entry;
    return pagePrompt({
      title: latest.title,
      path: latest.path,
      properties: latest.properties,
      relationships: latest.relationships,
      body: splitFrontmatter(raw).body,
    });
  };

  const copyPrompt = async () => {
    try {
      await writeClipboard(await buildPrompt());
    } catch {
      toast("Couldn't copy the prompt");
      return;
    }
    toast('Prompt copied');
  };

  const copyPath = async () => {
    try {
      await writeClipboard(entry.path);
    } catch {
      toast("Couldn't copy the path");
      return;
    }
    toast('Path copied');
  };

  const reveal = async () => {
    try {
      await revealInFinder(vaultPath, entry.path);
    } catch (err) {
      toast(refusalText(err));
    }
  };

  const openDefault = async () => {
    try {
      // The editor opens the file on disk, so the disk has to hold the page.
      await flushOpenPages();
      await openInDefaultApp(vaultPath, entry.path);
    } catch (err) {
      toast(refusalText(err));
    }
  };

  const handOff = async (target: { id: string; label: string }) => {
    const failed = `Couldn't open ${target.label} or copy the prompt.`;
    let prompt: string;
    try {
      prompt = await buildPrompt();
    } catch {
      toast(failed);
      return;
    }
    let outcome: Awaited<ReturnType<typeof openAgentLink>>;
    try {
      outcome = await openAgentLink(target.id, prompt);
    } catch (err) {
      toast(refusalText(err));
      return;
    }
    if (outcome === 'opened') return;
    // Too long for a link, or nothing opened it: the clipboard still can.
    try {
      await writeClipboard(prompt);
    } catch {
      toast(failed);
      return;
    }
    toast(
      outcome === 'too_long'
        ? `Too long for a link, so the prompt is copied. Paste it into ${target.label}.`
        : `${target.label} didn't open, so the prompt is copied.`,
    );
  };

  /** Close the menu, then run `action` without waiting on it. */
  const run = (action: () => Promise<void>) => () => {
    close();
    void action();
  };
  const hint = desktop ? undefined : DESKTOP_ONLY;

  return (
    <span className="relative inline-flex flex-none" data-testid="open-with">
      <IconButton
        ref={buttonRef}
        icon="square-arrow-out-up-right"
        label="Open with"
        size="sm"
        onClick={() => (open ? close() : setOpen(true))}
      />
      {open && (
        <Popover anchorRef={buttonRef} onClose={close} role="menu" ariaLabel="Open with" trapFocus>
          <MenuSurface width={264}>
            <MenuItem
              icon="clipboard-copy"
              label="Copy as prompt"
              testId="open-with-copy-prompt"
              onSelect={run(copyPrompt)}
            />
            <MenuItem
              icon="file-text"
              label="Copy path"
              testId="open-with-copy-path"
              onSelect={run(copyPath)}
            />
            <MenuSeparator />
            <MenuItem
              icon="folder-search"
              label="Reveal in Finder"
              testId="open-with-reveal"
              disabled={!desktop}
              hint={hint}
              onSelect={run(reveal)}
            />
            {/* Not on knowledge/ (Q17): the bundle is agent-written and
                human-verified, and an edit made outside the app lands as a
                reconciliation. */}
            {!knowledgeFile && (
              <MenuItem
                icon="file-pen"
                label="Open in default editor"
                testId="open-with-default-editor"
                disabled={!desktop}
                hint={hint}
                onSelect={run(openDefault)}
              />
            )}
            <MenuSeparator />
            <MenuLabel>Hand off to</MenuLabel>
            {AGENT_TARGETS.map((target) => (
              <MenuItem
                key={target.id}
                icon="bot"
                label={target.label}
                testId={`open-with-agent-${target.id}`}
                disabled={!desktop}
                hint={hint}
                onSelect={run(() => handOff(target))}
              />
            ))}
          </MenuSurface>
        </Popover>
      )}
    </span>
  );
}
