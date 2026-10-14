import { describe, expect, it } from 'vitest';
import { linkLabel } from './linkLabels';

const HEX = '0123456789abcdef0123456789ABCDEF';

describe('linkLabel', () => {
  describe('Notion', () => {
    it('names a workspace page by its slug', () => {
      const label = linkLabel(`https://www.notion.so/acme/Q3-roadmap-review-${HEX}`);
      expect(label).toMatchObject({
        service: 'notion',
        serviceName: 'Notion',
        title: 'Q3 roadmap review',
        text: 'Q3 roadmap review',
        github: null,
      });
    });

    it('reads a notion.site page past its query', () => {
      expect(linkLabel(`https://acme.notion.site/launch-plan-${HEX}?pvs=4`)?.text).toBe(
        'Launch plan',
      );
    });

    it('gives the service name for a bare id', () => {
      const label = linkLabel(`https://www.notion.so/${HEX}`);
      expect(label?.title).toBeNull();
      expect(label?.text).toBe('Notion');
    });

    it('decodes a percent-encoded non-ASCII title', () => {
      // The e-acute (U+00E9) is %C3%A9 in UTF-8.
      expect(linkLabel(`https://www.notion.so/Caf%C3%A9-plan-${HEX}`)?.text).toBe('Caf\u00e9 plan');
    });

    it('gives the service name for a malformed escape', () => {
      expect(linkLabel(`https://www.notion.so/Bad%E0%A4%A-plan-${HEX}`)?.text).toBe('Notion');
    });

    it('caps a long slug at 80 code points ending in an ellipsis', () => {
      const slug = Array.from({ length: 40 }, () => 'word').join('-');
      const text = linkLabel(`https://www.notion.so/${slug}-${HEX}`)?.text ?? '';
      expect(Array.from(text)).toHaveLength(80);
      expect(text.endsWith('\u2026')).toBe(true);
      expect(text.startsWith('Word word')).toBe(true);
    });
  });

  describe('Figma', () => {
    it('names a design file by its slug, keeping its case', () => {
      expect(linkLabel('https://www.figma.com/design/AbC123xyz/AI-side-panel?node-id=1-2')).toEqual(
        {
          service: 'figma',
          serviceName: 'Figma',
          title: 'AI side panel',
          text: 'AI side panel',
          github: null,
        },
      );
    });

    it('names a board', () => {
      expect(linkLabel('https://figma.com/board/K3y/team_retro')?.text).toBe('Team retro');
    });

    it('gives the service name for a page that names no file', () => {
      expect(linkLabel('https://www.figma.com/files/recent')?.text).toBe('Figma');
    });
  });

  describe('Linear', () => {
    it('names an issue by its id and slug', () => {
      expect(linkLabel('https://linear.app/acme/issue/eng-142/fix-login')?.text).toBe(
        'ENG-142 Fix login',
      );
    });

    it('names an issue with no slug by its id', () => {
      expect(linkLabel('https://linear.app/acme/issue/ENG-142')?.text).toBe('ENG-142');
    });

    it('gives the service name for a project', () => {
      expect(linkLabel('https://linear.app/acme/project/q3-launch-1a2b3c')?.text).toBe('Linear');
    });
  });

  describe('GitHub', () => {
    it('names a pull request, its files tab included', () => {
      const label = linkLabel('https://github.com/acme/app/pull/42/files');
      expect(label?.text).toBe('acme/app#42');
      expect(label?.github).toEqual({ owner: 'acme', repo: 'app', number: 42, kind: 'pull' });
    });

    it('names an issue', () => {
      const label = linkLabel('https://github.com/acme/app/issues/7#issuecomment-1');
      expect(label?.text).toBe('acme/app#7');
      expect(label?.github?.kind).toBe('issue');
    });

    it('gives the service name for a repository root', () => {
      const label = linkLabel('https://github.com/acme/app');
      expect(label?.text).toBe('GitHub');
      expect(label?.github).toBeNull();
    });
  });

  describe('hosts', () => {
    it('matches an uppercase scheme and host, a port and a trailing dot', () => {
      expect(linkLabel('HTTPS://GITHUB.COM/acme/app/pull/42')?.text).toBe('acme/app#42');
      expect(linkLabel('  https://linear.app.:443/acme/issue/ENG-1  ')?.text).toBe('ENG-1');
    });

    it('matches by exact suffix only', () => {
      expect(linkLabel(`https://notion.so.evil.test/plan-${HEX}`)).toBeNull();
      expect(linkLabel(`https://evilnotion.so/plan-${HEX}`)).toBeNull();
      expect(linkLabel('https://linear.app.evil.test/acme/issue/ENG-1')).toBeNull();
    });

    it('gives null for an unknown host', () => {
      expect(linkLabel('https://example.com/acme/issue/ENG-1')).toBeNull();
    });

    it('refuses userinfo, IPv6, other schemes and non-URLs', () => {
      expect(linkLabel('https://user@github.com/acme/app/pull/1')).toBeNull();
      expect(linkLabel('https://[::1]/acme/app/pull/1')).toBeNull();
      expect(linkLabel('ftp://github.com/acme/app/pull/1')).toBeNull();
      expect(linkLabel('javascript:alert(1)//github.com')).toBeNull();
      expect(linkLabel('')).toBeNull();
      expect(linkLabel('fix the login page')).toBeNull();
    });
  });
});
