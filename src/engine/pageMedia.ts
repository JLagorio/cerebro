/**
 * Page media as markdown image lines (M55.4).
 *
 * An image, a video, an audio clip or a file on a page is written as one line
 * of its own:
 *
 * ```markdown
 * ![Plan|300](attachments/plan.png "The plan, as drawn")
 * ```
 *
 * The text is the block's name, the title its caption, and a text ending in
 * `|N` is the width it was resized to (Obsidian's spelling, read for images
 * and videos only). The kind is not written: it comes back from the path's
 * extension (`mediaKindOf`). A file uses the embed form too, on purpose: a
 * link line, `[x](y.pdf)`, is never read as a block, so a working link in a
 * hand-written file stays a link.
 *
 * Pure string code with no imports: the engine typechecks with no DOM, so
 * there is no `URL` class here, and a relative path is the common case anyway.
 * The block-tree passes that use it live in `src/editor/markdown.ts`.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

/** What a media line says. `''` is "not set", the prop default. */
export interface PageMedia {
  /** The text in the brackets, less any `|N` width. */
  name: string;
  url: string;
  /** The title, which the block shows as its caption. */
  caption: string;
  /** The `|N` width, for an image or a video only. */
  width?: number;
}

/** BlockNote's own video list (`isVideoUrl`), so a video it parses is one here too. */
const VIDEO = ['mp4', 'webm', 'ogg', 'mov', 'mkv', 'flv', 'avi', 'wmv', 'm4v'];
const AUDIO = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'oga', 'opus', 'weba'];
const FILE = [
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'csv',
  'tsv',
  'txt',
  'json',
  'xml',
  'zip',
  'gz',
  'tgz',
  'tar',
  '7z',
  'rar',
  'epub',
  'key',
  'numbers',
  'pages',
];

/**
 * The kind of block a url is, read from its path's extension: the query and
 * fragment dropped, case folded. Anything unknown, or no extension, is an
 * image, which is what `![…](…)` means everywhere else.
 */
export function mediaKindOf(url: string): MediaKind {
  const path = url.split('#')[0].split('?')[0];
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  const ext = dot <= 0 ? '' : last.slice(dot + 1).toLowerCase();
  if (VIDEO.includes(ext)) return 'video';
  if (AUDIO.includes(ext)) return 'audio';
  if (FILE.includes(ext)) return 'file';
  return 'image';
}

/** Kinds whose block carries a width (BlockNote's `previewWidth`). */
const hasWidth = (kind: MediaKind): boolean => kind === 'image' || kind === 'video';

/** A control character: no destination may hold one. */
const hasControl = (text: string): boolean =>
  [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** Undo CommonMark's backslash escapes: a backslash before ASCII punctuation. */
const unescape = (raw: string): string =>
  raw.replace(/\\([!-/:-@[-`{-~])/g, (_m, char: string) => char);

/** `|N` at the end of the RAW text, its pipe not escaped. */
const WIDTH = /(?<!\\)((?:\\\\)*)\|(\d+)$/;

/**
 * Read one media embed starting at `at`: `![text](dest "title")`. Returns what
 * it says and the index just past its `)`, or null if there is not one there.
 * The title may be quoted `"…"`, `'…'` or `(…)`.
 */
export function readMediaAt(line: string, at: number): { media: PageMedia; end: number } | null {
  if (!line.startsWith('![', at)) return null;
  let i = at + 2;
  // The text: up to the first unescaped `]`. An unescaped `[` is a nested
  // bracket this grammar does not take.
  let rawText = '';
  for (;;) {
    const c = line[i];
    if (c === undefined || c === '\n' || c === '[') return null;
    if (c === '\\' && i + 1 < line.length) {
      rawText += c + line[i + 1];
      i += 2;
      continue;
    }
    if (c === ']') break;
    rawText += c;
    i += 1;
  }
  i += 1;
  if (line[i] !== '(') return null;
  i += 1;

  // The destination: `<…>`, or bare with balanced parentheses.
  let url: string;
  if (line[i] === '<') {
    i += 1;
    let raw = '';
    for (;;) {
      const c = line[i];
      if (c === undefined || c === '\n' || c === '<') return null;
      if (c === '\\' && i + 1 < line.length) {
        raw += c + line[i + 1];
        i += 2;
        continue;
      }
      if (c === '>') break;
      raw += c;
      i += 1;
    }
    i += 1;
    url = unescape(raw);
  } else {
    let raw = '';
    let depth = 0;
    for (;;) {
      const c = line[i];
      if (c === undefined) return null;
      if (c === ' ' || c === '\t') break;
      if (hasControl(c)) return null;
      if (c === '\\' && i + 1 < line.length) {
        raw += c + line[i + 1];
        i += 2;
        continue;
      }
      if (c === '(') depth += 1;
      if (c === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      raw += c;
      i += 1;
    }
    if (depth !== 0) return null;
    url = unescape(raw);
  }
  if (url === '') return null;

  // The title, after at least one space.
  let caption = '';
  const spaceAt = i;
  while (line[i] === ' ' || line[i] === '\t') i += 1;
  const open = line[i];
  if (i > spaceAt && (open === '"' || open === "'" || open === '(')) {
    const close = open === '(' ? ')' : open;
    i += 1;
    let raw = '';
    for (;;) {
      const c = line[i];
      if (c === undefined || c === '\n') return null;
      if (open === '(' && c === '(') return null;
      if (c === '\\' && i + 1 < line.length) {
        raw += c + line[i + 1];
        i += 2;
        continue;
      }
      if (c === close) break;
      raw += c;
      i += 1;
    }
    i += 1;
    caption = unescape(raw);
    while (line[i] === ' ' || line[i] === '\t') i += 1;
  }
  if (line[i] !== ')') return null;

  const width = hasWidth(mediaKindOf(url)) ? WIDTH.exec(rawText) : null;
  const media: PageMedia =
    width === null
      ? { name: unescape(rawText), url, caption }
      : {
          name: unescape(rawText.slice(0, width.index + width[1].length)),
          url,
          caption,
          width: Number(width[2]),
        };
  return { media, end: i + 1 };
}

/**
 * Read one whole line as a media line, or null. Strict, like the container
 * markers: a leading space, anything trailing, two embeds or a link (`[x](y)`)
 * is not one, and the line stays the text it is.
 */
export function parseMediaLine(line: string): PageMedia | null {
  const read = readMediaAt(line, 0);
  return read !== null && read.end === line.length ? read.media : null;
}

/** Does a bare destination read back as itself? */
const bareSafe = (url: string): boolean => {
  if (/[\s<>\\]/.test(url) || hasControl(url)) return false;
  let depth = 0;
  for (const c of url) {
    if (c === '(') depth += 1;
    if (c === ')') {
      if (depth === 0) return false;
      depth -= 1;
    }
  }
  return depth === 0;
};

/** One line on its own: newlines in a name or caption become spaces. */
const oneLine = (text: string): string => text.replace(/\r?\n|\r/g, ' ');

/**
 * The line a media block is written as. The width is written only for an
 * image or a video, rounded to a whole pixel; a name that already ends in
 * `|digits` has that pipe escaped, so it never reads back as a width.
 */
export function formatMediaLine(media: PageMedia): string {
  let text = oneLine(media.name).replace(/[\\[\]]/g, (c) => `\\${c}`);
  const kind = mediaKindOf(media.url);
  if (hasWidth(kind) && /\|\d+$/.test(text)) {
    text = text.replace(/\|(\d+)$/, '\\|$1');
  }
  if (hasWidth(kind) && media.width !== undefined && media.width > 0) {
    text += `|${Math.round(media.width)}`;
  }
  const url = oneLine(media.url);
  const dest = bareSafe(url) ? url : `<${url.replace(/[\\<>]/g, (c) => `\\${c}`)}>`;
  const caption = oneLine(media.caption);
  const title = caption === '' ? '' : ` "${caption.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return `![${text}](${dest}${title})`;
}
