import { describe, expect, it } from 'vitest';
import { formatMediaLine, mediaKindOf, parseMediaLine, readMediaAt } from './pageMedia';

describe('parseMediaLine / formatMediaLine', () => {
  it.each([
    '![](attachments/a.png)',
    '![](../attachments/a.png)',
    '![Plan](a.png "Caption")',
    '![](<My Shot.png>)',
    '![Walkthrough|640](clips/demo.mp4 "Day one")',
    '![](https://example.com/a(1).png)',
  ])('round-trips %s byte for byte', (line) => {
    const media = parseMediaLine(line);
    expect(media).not.toBeNull();
    expect(formatMediaLine(media!)).toBe(line);
  });

  it('reads the parts of a line', () => {
    expect(parseMediaLine('![Plan](a.png "Caption")')).toEqual({
      name: 'Plan',
      url: 'a.png',
      caption: 'Caption',
    });
    expect(parseMediaLine('![](<My Shot.png>)')).toEqual({
      name: '',
      url: 'My Shot.png',
      caption: '',
    });
  });

  it('normalizes a \'…\' or (…) title to "…"', () => {
    for (const line of ["![x](a.png 'Cap')", '![x](a.png (Cap))', '![x](a.png   "Cap"  )']) {
      expect(formatMediaLine(parseMediaLine(line)!)).toBe('![x](a.png "Cap")');
    }
    expect(parseMediaLine(`![x](a.png 'say "hi"')`)!.caption).toBe('say "hi"');
    expect(formatMediaLine(parseMediaLine(`![x](a.png 'say "hi"')`)!)).toBe(
      '![x](a.png "say \\"hi\\"")',
    );
  });

  it('keeps escapes in names and titles through a round trip', () => {
    const media = { name: 'a [draft] \\ copy', url: 'a.png', caption: 'back\\slash "q"' };
    const line = formatMediaLine(media);
    expect(line).toBe('![a \\[draft\\] \\\\ copy](a.png "back\\\\slash \\"q\\"")');
    expect(parseMediaLine(line)).toEqual(media);
    expect(parseMediaLine('![a \\* b](a.png)')!.name).toBe('a * b');
  });

  it('uses <…> only where a bare destination would not read back', () => {
    expect(formatMediaLine({ name: '', url: 'a b.png', caption: '' })).toBe('![](<a b.png>)');
    expect(formatMediaLine({ name: '', url: 'a(b.png', caption: '' })).toBe('![](<a(b.png>)');
    expect(formatMediaLine({ name: '', url: 'a<b>.png', caption: '' })).toBe('![](<a\\<b\\>.png>)');
    expect(formatMediaLine({ name: '', url: 'a(b).png', caption: '' })).toBe('![](a(b).png)');
    expect(parseMediaLine('![](<a\\<b\\>.png>)')!.url).toBe('a<b>.png');
    expect(parseMediaLine('![](<a b.png>)')!.url).toBe('a b.png');
  });

  it('reads and writes name|300 as a width, for images and videos only (Q5)', () => {
    expect(parseMediaLine('![Plan|300](a.png)')).toEqual({
      name: 'Plan',
      url: 'a.png',
      caption: '',
      width: 300,
    });
    expect(parseMediaLine('![|300](a.mp4)')!.width).toBe(300);
    expect(formatMediaLine({ name: 'Plan', url: 'a.png', caption: '', width: 300 })).toBe(
      '![Plan|300](a.png)',
    );
    expect(formatMediaLine({ name: '', url: 'a.png', caption: '', width: 312.6 })).toBe(
      '![|313](a.png)',
    );
    // Audio and files carry no width: the text is the name.
    expect(parseMediaLine('![Take|300](a.mp3)')).toEqual({
      name: 'Take|300',
      url: 'a.mp3',
      caption: '',
    });
    expect(formatMediaLine({ name: 'x', url: 'a.pdf', caption: '', width: 300 })).toBe(
      '![x](a.pdf)',
    );
  });

  it('never reads a name that ends in |digits back as a width', () => {
    const media = { name: 'Version|2', url: 'a.png', caption: '' };
    const line = formatMediaLine(media);
    expect(line).toBe('![Version\\|2](a.png)');
    expect(parseMediaLine(line)).toEqual(media);
    const sized = { ...media, width: 40 };
    expect(parseMediaLine(formatMediaLine(sized))).toEqual(sized);
  });

  it('writes a name or caption on one line', () => {
    expect(formatMediaLine({ name: 'a\nb', url: 'a.png', caption: 'c\r\nd' })).toBe(
      '![a b](a.png "c d")',
    );
  });

  it.each([
    [' ![](a.png)', 'a leading space'],
    ['![](a.png) and more', 'trailing text'],
    ['![](a.png)![](b.png)', 'two images'],
    ['![](a(.png)', 'unbalanced parens'],
    ['[x](a.pdf)', 'link syntax'],
    ['![](a.png "open)', 'an unclosed title'],
    ['![x]()', 'an empty destination'],
    ['![x](<>)', 'an empty <> destination'],
    ['![a [b] c](a.png)', 'a nested bracket'],
    ['![x] (a.png)', 'a space before the destination'],
  ])('rejects %j (%s)', (line) => {
    expect(parseMediaLine(line)).toBeNull();
  });

  it('reads one embed in the middle of a line, and where it ends', () => {
    const line = '* ![Plan](a.png "Cap") after';
    expect(readMediaAt(line, 2)).toEqual({
      media: { name: 'Plan', url: 'a.png', caption: 'Cap' },
      end: 22,
    });
    expect(readMediaAt(line, 0)).toBeNull();
  });
});

describe('mediaKindOf', () => {
  it.each([
    ['attachments/a.png', 'image'],
    ['a.mp4', 'video'],
    ['a.MOV', 'video'],
    ['clips/standup.m4a', 'audio'],
    ['a.mp3?download=1', 'audio'],
    ['contract.PDF#page=2', 'file'],
    ['https://example.com/report.xlsx?x=1#y', 'file'],
    ['notes.txt', 'file'],
    ['https://example.com/image', 'image'],
    ['no-extension', 'image'],
    ['.hidden', 'image'],
    ['a.mp4/b', 'image'],
    ['a.unknownext', 'image'],
  ])('reads %s as %s', (url, kind) => {
    expect(mediaKindOf(url)).toBe(kind);
  });
});
