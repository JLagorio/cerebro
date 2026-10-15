import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CanvasText } from './CanvasText';
afterEach(cleanup);
it('renders useful markdown with inline paint and passive link/image labels', () => {
  const { container } = render(
    <CanvasText
      text={
        '# Title\n\n- First\n- **Second**\n\n[Site](https://example.com) and [[doc#part|Alias]]\n\n![Portrait](https://example.com/photo.png)\n\n> Quote\n\n`[[literal]]`'
      }
    />,
  );
  expect(container.querySelector('h1')?.getAttribute('style')).toContain('font-size: 22px');
  expect(container.querySelectorAll('li')).toHaveLength(2);
  expect(container.querySelector('strong')?.textContent).toBe('Second');
  expect(container.textContent).toContain('Site and Alias');
  expect(container.textContent).toContain('[image: Portrait]');
  expect(container.querySelector('code')?.textContent).toBe('[[literal]]');
  expect(container.querySelector('a,img,[href],[class]')).toBeNull();
});
it('does not execute raw HTML, javascript URLs or event attributes', () => {
  const { container } = render(
    <CanvasText
      text={
        '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n<img src=x onerror="alert(1)" />'
      }
    />,
  );
  expect(container.querySelector('script,img,a,[onerror]')).toBeNull();
  expect(container.textContent).toContain('<script>');
});
