import { expect, it } from 'vitest';
import { IMAGE_PLACEHOLDER, neutralizeRemoteImages, stripRemoteImages } from './remoteImages';
it.each([
  '"https://images.example/a.png"',
  "'http://images.example/a.png'",
  '"h\\u0074tps://images.example/a.png"',
  '//images.example/a.png',
])('neutralizes image layout source %s before Mermaid sees it', (value) => {
  expect(neutralizeRemoteImages(`flowchart TD\n A@{ img: ${value}, label: "Hello" }`)).toContain(
    IMAGE_PLACEHOLDER,
  );
});
it('strips HTML image labels and external CSS fetches before layout', () => {
  const result = neutralizeRemoteImages(
    'A["<img src="https://images.example/a.png">Hi"]\nclassDef x fill:url(https://images.example/bg.png)',
  );
  expect(result).not.toContain('https://');
  expect(result).toContain('Hi');
});
it('removes remote SVG and foreignObject resource references while retaining local fragments', () => {
  const out = stripRemoteImages(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image href="https://images.example/a.png"/><image xlink:href="//images.example/b.png"/><use href="#local"/><foreignObject><img src="https://images.example/c.png"/></foreignObject><path style="fill:url(https://images.example/d.png)"/></svg>',
  );
  expect(out).not.toContain('images.example');
  expect(out).toContain('href="#local"');
});

it('accepts Mermaid links without an xlink declaration while still stripping remote resources', () => {
  const out = stripRemoteImages(
    '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="people/ana.md"><g id="node"/></a><image xlink:href="https://images.example/picture.png"/></svg>',
  );
  expect(out).toContain('people/ana.md');
  expect(out).toContain('id="node"');
  expect(out).not.toContain('images.example');
});

it.each(['"img"', '"\\u0069mg"', "'img'"])(
  'YAML quoted image key %s cannot bypass the pre-layout gate',
  (key) => {
    const out = neutralizeRemoteImages(
      `flowchart TD\n A@{ ${key}: "https://images.example/quoted.png" }`,
    );
    expect(out).toContain(IMAGE_PLACEHOLDER);
    expect(out).not.toContain('images.example');
  },
);
it('removes CSS escape-bearing style commands before layout', () => {
  const out = neutralizeRemoteImages(String.raw`flowchart TD
 A[Hello]
 classDef hot fill:u\72l(https://images.example/escaped.png)
 class A hot
 style A fill:u\72l(https://images.example/other.png)`);
  expect(out).not.toContain('images.example');
  expect(out).toContain('A[Hello]');
});
it.each([
  String.raw`.x {background:u\72l(https://images.example/escaped.png)}`,
  String.raw`@im\70ort 'https://images.example/style.css';`,
])('removes escaped returned SVG stylesheet resources: %s', (css) => {
  expect(
    stripRemoteImages(`<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style></svg>`),
  ).not.toContain('images.example');
});

it('removes string-bearing CSS image functions before layout', () => {
  expect(
    neutralizeRemoteImages(
      'flowchart TD\n A[Hello]\n classDef hot background-image:image-set("https://images.example/set.png" 1x)',
    ),
  ).not.toContain('images.example');
  expect(
    stripRemoteImages(
      '<svg xmlns="http://www.w3.org/2000/svg"><path style=\'background-image:image-set("https://images.example/set.png" 1x)\'/></svg>',
    ),
  ).not.toContain('images.example');
  expect(
    stripRemoteImages(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.a {background-image:image-set("https://images.example/style.png" 1x)}</style></svg>',
    ),
  ).not.toContain('images.example');
});
