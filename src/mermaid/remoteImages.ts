import { parse } from 'yaml';

/** Layout happens in the live document. Neutralize resource-bearing source
 * before Mermaid sees it, then remove resource references from its SVG too. */
export const IMAGE_PLACEHOLDER =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22/%3E';
const VALUE = /\bimg\s*:\s*("(?:\\.|[^"\\])*"|'(?:''|\\.|[^'\\])*'|[^,}\r\n]+)/gi;

function shapes(source: string): string {
  let out = '',
    from = 0;
  for (;;) {
    const start = source.indexOf('@{', from);
    if (start < 0) return out + source.slice(from);
    out += source.slice(from, start);
    let end = start + 2,
      depth = 1,
      quote = '';
    for (; end < source.length && depth > 0; end++) {
      const char = source[end];
      if (quote) {
        if (char === '\\' && quote === '"') end++;
        else if (char === quote) {
          if (quote === "'" && source[end + 1] === "'") end++;
          else quote = '';
        }
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    const fallback = `@{img: "${IMAGE_PLACEHOLDER}"}`;
    try {
      if (depth || end - start > 65536) throw new Error('oversized or unfinished attributes');
      const attributes: unknown = parse(source.slice(start + 1, end), {
        maxAliasCount: 0,
        strict: true,
        logLevel: 'silent',
      });
      if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes))
        throw new Error('attributes');
      const fields = attributes as Record<string, unknown>;
      if ('img' in fields && !(typeof fields.img === 'string' && /^data:image\//i.test(fields.img)))
        fields.img = IMAGE_PLACEHOLDER;
      out += '@' + JSON.stringify(fields);
    } catch {
      out += fallback;
    }
    from = end;
  }
}

function localCssUrls(value: string): string {
  if (/[\\&]/.test(value) || /(?:image-set|cross-fade)\s*\(/i.test(value)) return '';
  return value.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
    (whole, double: string | undefined, single: string | undefined, bare: string | undefined) =>
      /^(?:#|data:)/i.test((double ?? single ?? bare ?? '').trim()) ? whole : 'none',
  );
}

export function neutralizeRemoteImages(source: string): string {
  return (
    shapes(source)
      // An image shape is never a network resource, including YAML-escaped URLs.
      .replace(VALUE, (_whole, value: string) => {
        const raw = value.trim().replace(/^['"]|['"]$/g, '');
        return `img: "${/^data:image\//i.test(raw) && !/[\\"']/u.test(raw) ? raw : IMAGE_PLACEHOLDER}"`;
      })
      // CSS escapes can spell resource functions without a literal url token.
      // Mermaid's styling commands retain the ordinary color/geometry grammar;
      // escape-bearing or structural CSS is removed before live layout.
      .replace(
        /(^|[;\n])(\s*(?:classDef|style|linkStyle)\b[^\n]*)/gi,
        (whole, separator: string, command: string) =>
          /[\\&{}<>@]/.test(command) || /https?:|\/\//i.test(command) ? separator : whole,
      )
      // HTML labels are laid out before the returned SVG can be inspected.
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
      .replace(/\bstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/<(?:img|image|iframe|object|embed|video|audio|source|link)\b[^>]*>/gi, '')
      .replace(/\b(?:src|srcset)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/url\([^)]*\)/gi, localCssUrls)
      .replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi, '')
  );
}

export function stripRemoteImages(svg: string): string {
  // Mermaid returns HTML-insertable SVG and emits xlink:href on linked nodes
  // without declaring xlink. Supply that namespace on an inert XML wrapper:
  // strict browser XML parsers otherwise reject the entire linked diagram.
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${svg}</svg>`,
    'image/svg+xml',
  );
  const root = doc.documentElement.firstElementChild;
  if (doc.querySelector('parsererror') || root?.localName !== 'svg') return '';
  let changed = false;
  for (const node of [root, ...root.querySelectorAll('*')]) {
    if (
      ['iframe', 'object', 'embed', 'video', 'audio', 'source', 'link'].includes(node.localName)
    ) {
      changed = true;
      node.remove();
      continue;
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.localName.toLowerCase();
      if ((name === 'href' && node.localName !== 'a') || name === 'src' || name === 'srcset') {
        if (!/^(?:#|data:)/i.test(attr.value.trim())) {
          changed = true;
          node.removeAttributeNode(attr);
        }
      } else if (/url\(|image-set|cross-fade|[\\&]/i.test(attr.value)) {
        const clean = localCssUrls(attr.value);
        if (clean !== attr.value) {
          changed = true;
          node.setAttribute(attr.name, clean);
        }
      }
    }
    if (node.localName === 'style') {
      const clean = localCssUrls(neutralizeRemoteImages(node.textContent ?? ''));
      if (clean !== node.textContent) {
        changed = true;
        node.textContent = clean;
      }
    }
  }
  return changed ? new XMLSerializer().serializeToString(root) : svg;
}
