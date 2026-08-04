import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import type { TemplateDraft } from '@/engine/libraryDraft';
import { BodyField, EditorSection, Field } from './chrome';

/**
 * The template editor (M18).
 *
 * Templates were already ordinary files, and they still are — this screen only
 * puts them where the other two live and names the two properties that decide
 * what a template does. `fill:` earns its own section for one reason worth
 * being blunt about: **a template with a fill prompt starts an agent run the
 * moment a page is created from it.** That is the only place in the app where
 * making a file also spends a turn, and it should not be discoverable only by
 * watching the assistant start talking.
 */
export function TemplateEditor({
  draft,
  types,
  onChange,
}: {
  draft: TemplateDraft;
  /** Type names the vault declares, so the stamp is picked rather than typed. */
  types: string[];
  onChange: (next: TemplateDraft) => void;
}) {
  const set = <K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]) =>
    onChange({ ...draft, [key]: value });

  return (
    <>
      <EditorSection title="What it makes">
        <Field
          label="Type"
          hint="Pages made from this template carry this type, and land on its screens. Leave it as a doc for prose that is not a record of anything."
        >
          <Select
            size="sm"
            width={240}
            value={draft.type}
            ariaLabel="Type"
            onChange={(e) => set('type', e.target.value)}
            options={[
              { value: '', label: 'A document' },
              ...types.map((t) => ({ value: t, label: t })),
            ]}
          />
        </Field>
      </EditorSection>

      <EditorSection
        title="The page"
        hint="Copied to every page made from this template. {{title}} and {{date}} are substituted; frontmatter on this file becomes the new page's frontmatter."
      >
        <BodyField
          testId="template-body"
          ariaLabel="Template body"
          value={draft.body}
          onChange={(v) => set('body', v)}
          placeholder={'# {{title}}\n\n## Problem\n\n## Proposal\n\n## Risks\n'}
        />
      </EditorSection>

      <EditorSection
        title="Fill it in"
        hint="An instruction for the assistant, run against the page this template just made. Sections it has nothing to say about are left blank rather than invented — a template full of plausible fiction is worse than one left empty, because the empty one is obviously unfinished."
      >
        <Field label="Fill prompt" htmlFor="template-fill">
          <BodyField
            id="template-fill"
            testId="template-fill"
            rows={4}
            ariaLabel="Fill prompt"
            value={draft.fill}
            onChange={(v) => set('fill', v)}
            placeholder="Draft the problem and the risks from what the vault already knows about this project. Leave anything you cannot source blank."
          />
        </Field>
        {draft.fill.trim() !== '' && (
          <p
            className="m-0 flex items-start gap-1.5 rounded-md border border-warn-300 bg-warn-50 px-2.5 py-2 text-2xs leading-[16px] text-warn-700"
            role="note"
          >
            <Icon name="sparkles" size={12} color="var(--warn-700)" />
            Creating a page from this template will start an assistant run straight away.
          </p>
        )}
      </EditorSection>
    </>
  );
}
