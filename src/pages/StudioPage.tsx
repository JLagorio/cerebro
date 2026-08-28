import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { rowClass, SECTION_LABEL } from '@/app/sidebarChrome';
import { STUDIO_DIR, studioProjects, type StudioProject } from '@/engine/studio';
import type { Selection } from '@/engine/types';
import { ConceptBody } from '@/knowledge/ConceptBody';
import { createFolder, readNote } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

export type StudioSelection = Extract<Selection, { kind: 'studio' }>;

/** Frontmatter stripped for PREVIEW only — the file keeps it; a prototype
 * page an agent stamped is still that page, and the reader came for prose. */
const stripFrontmatter = (body: string) => body.replace(/^---\n[\s\S]*?\n---\n?/, '');

/**
 * The live preview: the page's rendered body, re-read whenever the scanner
 * sees a write. That re-read is the whole "live" — the assistant edits the
 * file, the watcher rescans, `modifiedAt` moves, and this refetches.
 */
function StudioPreview({ path, modifiedAt }: { path: string; modifiedAt: string }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  // null = not loaded yet; a failed read is its own state — "could not read"
  // and "empty page" are opposite sentences (the M33 rule).
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (vaultPath === null) return;
    let cancelled = false;
    setFailed(false);
    readNote(vaultPath, path)
      .then((text) => {
        if (!cancelled) setBody(stripFrontmatter(text));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, path, modifiedAt]);

  if (failed) {
    return (
      <p data-testid="studio-preview-unavailable" className="m-0 text-sm text-n-500">
        Couldn't read this page — the preview can't say what it holds.
      </p>
    );
  }
  if (body === null) return null;
  return <ConceptBody markdown={body} sources={[]} fromPath={path} />;
}

function NewPrototypeDialog({ onClose }: { onClose: () => void }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const createItem = useVaultStore((s) => s.createItem);
  const navigate = useNavStore((s) => s.navigate);
  const toast = useUiStore((s) => s.toast);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  const create = async () => {
    if (trimmed === '' || vaultPath === null || busy) return;
    setBusy(true);
    const slug = slugify(trimmed) || 'prototype';
    try {
      await createFolder(vaultPath, `${STUDIO_DIR}/${slug}`);
      await createItem({
        folder: `${STUDIO_DIR}/${slug}`,
        slug: 'index',
        frontmatter: {},
        body: `# ${trimmed}\n`,
      });
      onClose();
      navigate({ kind: 'studio', project: slug });
    } catch {
      toast("Couldn't create the prototype");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New prototype"
      width={420}
      primaryAction={{
        label: 'Create',
        onClick: () => void create(),
        disabled: trimmed === '' || busy,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <p className="m-0 mb-2 text-sm text-n-500">
        A folder under {STUDIO_DIR}/ with an index page — yours and the assistant's to build in.
      </p>
      <Input
        autoFocus
        ariaLabel="Prototype name"
        placeholder="Prototype name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create();
        }}
        width="100%"
      />
    </Dialog>
  );
}

function ProjectView({ project }: { project: StudioProject }) {
  const navigate = useNavStore((s) => s.navigate);
  const askAgent = useUiStore((s) => s.askAgent);
  // The previewed page is a LENS — local state, not selection — per the
  // place doctrine: switching pages is looking at the same prototype
  // differently.
  const [pagePath, setPagePath] = useState<string | null>(null);
  const shown =
    project.pages.find((p) => p.path === pagePath) ?? project.main ?? project.pages[0] ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex w-56 flex-none flex-col border-r border-n-200 px-2 pb-4">
        <div className={SECTION_LABEL}>Pages</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {project.pages.map((page) => (
            <button
              key={page.path}
              type="button"
              data-testid="studio-page-row"
              onClick={() => setPagePath(page.path)}
              className={rowClass(shown?.path === page.path)}
            >
              <Icon name="file-text" size={15} />
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{page.title}</span>
            </button>
          ))}
        </div>
        {/* The chat rail IS the assistant panel — a second transcript surface
            in here would be the two-chromes defect. Seeded with the folder so
            the build lands where the preview looks. */}
        <Button
          variant="primary"
          testId="studio-build"
          onClick={() =>
            askAgent(
              `Build on the "${project.title}" prototype. Work only inside ${project.folder}/ — its index.md is the main page; edit it and add pages beside it as the prototype needs.`,
              shown?.path ?? project.folder,
            )
          }
        >
          Build with the assistant
        </Button>
        {shown !== null && (
          <Button
            variant="secondary"
            testId="studio-edit-page"
            onClick={() => navigate({ kind: 'doc', path: shown.path })}
          >
            Edit this page
          </Button>
        )}
      </div>
      <div
        className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5"
        data-testid="studio-preview"
      >
        {shown === null ? (
          // Absent, not empty: the folder exists with no main page yet.
          <p className="m-0 text-sm text-n-500">
            No pages yet — the prototype's index.md has not been written.
          </p>
        ) : (
          <StudioPreview path={shown.path} modifiedAt={shown.modifiedAt} />
        )}
      </div>
    </div>
  );
}

/**
 * Studio (M40): the prototype-building surface, the third locked name.
 *
 * A prototype is a FOLDER of pages under studio/ — the artifact Studio
 * builds is the artifact the vault can hold (files-first; the write path
 * creates markdown, so the previewable thing is a rendered page, not an
 * iframe). The chat rail is the standing Assistant panel, seeded at the
 * prototype's folder; the preview is live because a write rescans and the
 * body refetches.
 */
export function StudioPage({ selection }: { selection: StudioSelection }) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const [creating, setCreating] = useState(false);

  const projects = useMemo(() => studioProjects(entries), [entries]);
  const open =
    selection.project === undefined
      ? null
      : (projects.find((p) => p.slug === selection.project) ?? null);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="studio-page">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-n-200 px-4">
        {open !== null && (
          <button
            type="button"
            aria-label="All prototypes"
            data-testid="studio-back"
            onClick={() => navigate({ kind: 'studio' })}
            className="flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent text-n-400 hover:bg-n-100 hover:text-n-800"
          >
            <Icon name="arrow-left" size={15} />
          </button>
        )}
        <Icon name="pencil-ruler" size={16} color="var(--n-600)" />
        <h1 className="m-0 text-lg font-semibold leading-6 tracking-[-0.005em]">
          {open === null ? 'Studio' : open.title}
        </h1>
        <span className="flex-1" />
        {open === null && (
          <Button variant="primary" testId="studio-new" onClick={() => setCreating(true)}>
            New prototype
          </Button>
        )}
      </div>
      {open !== null ? (
        <ProjectView project={open} />
      ) : selection.project !== undefined ? (
        // A deep link to a prototype the vault no longer holds. Absent, said
        // plainly — never a blank preview of nothing.
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <EmptyState
            icon="file-x"
            title="This prototype no longer exists"
            description="Its folder may have been renamed or moved to the Trash."
            action={
              <Button variant="secondary" onClick={() => navigate({ kind: 'studio' })}>
                All prototypes
              </Button>
            }
          />
        </div>
      ) : projects.length === 0 ? (
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <EmptyState
            icon="pencil-ruler"
            title="Nothing on the bench"
            description="A prototype is a folder of pages you and the assistant build together — its preview updates as the files change."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                New prototype
              </Button>
            }
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-3">
          <ul className="m-0 flex max-w-[720px] flex-col gap-0.5 p-0">
            {projects.map((project) => (
              <li key={project.slug} className="list-none">
                <button
                  type="button"
                  data-testid="studio-project"
                  data-slug={project.slug}
                  onClick={() => navigate({ kind: 'studio', project: project.slug })}
                  className="flex w-full min-w-0 items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1.5 text-left hover:bg-n-50"
                >
                  <Icon name="pencil-ruler" size={14} color="var(--n-500)" />
                  <span className="min-w-0 flex-1 truncate text-sm text-n-800">
                    {project.title}
                  </span>
                  <span className="flex-none text-2xs text-n-400 [font-family:var(--font-mono)]">
                    {project.pages.length} {project.pages.length === 1 ? 'page' : 'pages'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {creating && <NewPrototypeDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
