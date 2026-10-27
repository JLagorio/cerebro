import { useId, useLayoutEffect, useRef, useState } from 'react';
import { MessageText } from '@/agent/MessageMarkdown';
import { Button } from '@/components/ui/Button';
import { helpTopic, helpTopics } from './productHelpCatalog';

/** Read-only local guides. Opening help never reads or writes a vault page. */
export function ProductHelp() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const choices = useRef<HTMLDivElement>(null);
  const previous = useRef<string | null>(null);
  const headingId = useId();
  const topic = selected === null ? null : helpTopic(selected);
  useLayoutEffect(() => {
    if (selected !== null) heading.current?.focus();
    else if (previous.current !== null) {
      const index = helpTopics.findIndex(({ id }) => id === previous.current);
      choices.current?.querySelectorAll('button')[index]?.focus();
    } else if (open) choices.current?.querySelector('button')?.focus();
    previous.current = selected;
  }, [open, selected]);

  return (
    <div className="mt-6 border-t border-n-200 pt-5">
      <h2 className="mb-2 text-md font-semibold text-n-900">Product help</h2>
      {!open ? (
        <Button icon="book-open" onClick={() => setOpen(true)}>
          Browse guides
        </Button>
      ) : topic === null ? (
        <div ref={choices} className="flex flex-wrap gap-2" aria-label="Help topics">
          {helpTopics.map(({ id, title }) => (
            <Button key={id} onClick={() => setSelected(id)}>
              {title}
            </Button>
          ))}
        </div>
      ) : (
        <article aria-labelledby={headingId} className="max-w-[68ch] text-ui text-n-800">
          <Button size="sm" variant="ghost" icon="arrow-left" onClick={() => setSelected(null)}>
            All guides
          </Button>
          <h3
            ref={heading}
            id={headingId}
            tabIndex={-1}
            className="my-3 text-lg font-semibold text-n-900 outline-none"
          >
            {topic.title}
          </h3>
          <MessageText text={topic.body} onOpen={() => undefined} />
          <p className="mt-4 text-meta text-(--text-meta)">Guide for Cerebro {topic.appVersion}</p>
        </article>
      )}
    </div>
  );
}
