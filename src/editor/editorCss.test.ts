// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Read from disk, as theme.test.ts reads index.css: vitest hands a stylesheet
// import to the test as an empty string, `?raw` included.
const css = readFileSync(join(__dirname, 'editor.css'), 'utf8');

/**
 * What the M52.1 rules in editor.css select, held against the DOM BlockNote
 * renders.
 *
 * jsdom lays nothing out and computes no margins, so the GEOMETRY was measured
 * in the browser (see editor.css). What jsdom can answer exactly is which
 * elements a rule reaches — and that is the claim that matters here: section
 * spacing reaches a concept's headings and never an ordinary page's, and the
 * sources style reaches a paragraph that opens with a definition and nothing
 * else. The selectors are read out of the stylesheet itself, so the test
 * cannot drift from the file.
 */

/** Every rule in editor.css that sets `property`: its selector and the value it sets. */
function rulesSetting(property: string): { selector: string; value: string }[] {
  const out: { selector: string; value: string }[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const value = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+);`).exec(m[2]);
    if (value !== null) out.push({ selector: m[1].trim(), value: value[1].trim() });
  }
  return out;
}

/** The values of `property` the rules reaching an element set, in file order. */
function reaching(el: Element, property: string): string[] {
  return rulesSetting(property)
    .filter((rule) => {
      // jsdom cannot parse an attribute selector inside `:has()`; such a rule
      // is one this file makes no claim about (the M52.1 rules avoid them).
      try {
        return el.matches(rule.selector);
      } catch {
        return false;
      }
    })
    .map((rule) => rule.value);
}

afterEach(() => {
  document.body.innerHTML = '';
});

const block = (content: string) =>
  `<div class="bn-block-outer"><div class="bn-block">${content}</div></div>`;
const heading = (level: number, text: string) =>
  block(
    `<div class="bn-block-content" data-content-type="heading"><h${level}>${text}</h${level}></div>`,
  );
const paragraph = (inline: string) =>
  block(
    `<div class="bn-block-content" data-content-type="paragraph"><p class="bn-inline-content">${inline}</p></div>`,
  );
/** A citation chip as BlockNote renders it; `wrapped` adds the browser's react-renderer span. */
const chip = (def: boolean, wrapped: boolean) => {
  const badge = def ? '<button class="cb-citation-def">1</button>' : '<sup><span>1</span></sup>';
  const inner = `<span class="bn-inline-content-section" data-inline-content-type="citation">${badge}</span>`;
  return wrapped ? `<span class="react-renderer node-citation">${inner}</span>` : inner;
};

function page(sections: boolean, blocks: string[]): Element[] {
  document.body.innerHTML = `<div class="cerebro-editor${sections ? ' cerebro-editor-sections' : ''}"><div class="bn-block-group">${blocks.join('')}</div></div>`;
  return [...document.querySelectorAll('.bn-block-content')];
}

describe('section spacing', () => {
  const body = [
    heading(1, 'Definition'),
    paragraph('Text.'),
    heading(1, 'Known distortion'),
    paragraph('Text.'),
    heading(2, 'Sub'),
    heading(3, 'Subsub'),
  ];

  it('gives a heading room above in a concept body, but not the one that opens it', () => {
    const [first, , h1, , h2, h3] = page(true, body);
    expect(reaching(first, 'margin-top')).toEqual([]);
    // More room above a bigger heading.
    expect([h1, h2, h3].map((h) => reaching(h, 'margin-top'))).toEqual([
      ['22px'],
      ['18px'],
      ['14px'],
    ]);
    expect(reaching(h1, 'margin-bottom')).toEqual(['2px']);
  });

  it('leaves the headings of an ordinary page as they were', () => {
    for (const el of page(false, body)) {
      expect(reaching(el, 'margin-top')).toEqual([]);
      expect(reaching(el, 'margin-bottom')).toEqual([]);
    }
  });
});

describe('the sources list', () => {
  it.each([true, false])(
    'quiets a paragraph that opens with a definition (react-renderer wrapper: %s)',
    (wrapped) => {
      const [body, sources] = page(false, [
        paragraph(`A claim.${chip(false, wrapped)}`),
        paragraph(`${chip(true, wrapped)} First source<br>${chip(true, wrapped)} Second`),
      ]);
      expect(reaching(sources, 'color')).toEqual(['var(--n-600)']);
      expect(reaching(sources, 'font-size')).toEqual(['var(--fs-sm)']);
      expect(reaching(body, 'color')).toEqual([]);
      expect(reaching(body, 'font-size')).toEqual([]);
    },
  );

  it('leaves a paragraph alone when a reference opens it, or a definition opens only its second line', () => {
    const [reference, secondLine] = page(false, [
      paragraph(`${chip(false, true)} cited first`),
      paragraph(`Body text<br>${chip(true, true)} a definition below it`),
    ]);
    expect(reaching(reference, 'color')).toEqual([]);
    expect(reaching(secondLine, 'color')).toEqual([]);
  });

  it('sets the list off from the body above it once, not between its own paragraphs', () => {
    const [, first, second] = page(false, [
      paragraph('Body.'),
      paragraph(`${chip(true, true)} First`),
      paragraph(`${chip(true, true)} Second, after a blank line`),
    ]);
    expect(reaching(first, 'margin-top')).toEqual(['12px']);
    // The later, more specific rule takes the margin back.
    expect(reaching(second, 'margin-top')).toEqual(['12px', '0']);
  });
});
