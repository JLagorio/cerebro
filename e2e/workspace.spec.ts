import { expect, test, type Page } from '@playwright/test';

/** What the mock roots backend exposes for seeding (see src/lib/mockRoots.ts). */
interface MockRootsWindow {
  __cerebroMockRoots: {
    resetMockRoots(): void;
    seedRoot(s: { path: string; label: string; knowledge?: boolean }): { id: string };
    seedFile(rootPath: string, rel: string, content: string): void;
    seedKnowledgeDir(path: string): void;
  };
}

async function boot(page: Page): Promise<void> {
  // The background distiller (M8.6) is off for tests that are not about it:
  // a reader that fires four seconds in would rescan the vault mid-assertion.
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.autoLearn', 'false');
    // Pin the theme (M16.39). These specs assert on rendered UI, and an unset
    // themeMode resolves 'system' — so a dark display would flip every colour
    // out from under them. The app has two palettes now; the specs assume one.
    window.localStorage.setItem('cerebro.themeMode', 'light');
  });
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });
}

/** Seed two mounted repositories with a small documentation tree. */
async function seedRepos(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as MockRootsWindow;
    w.__cerebroMockRoots.resetMockRoots();
    w.__cerebroMockRoots.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    w.__cerebroMockRoots.seedRoot({ path: '/repos/beta', label: 'beta' });
    w.__cerebroMockRoots.seedFile(
      '/repos/alpha',
      'README.md',
      '# Alpha\n\nSee [the guide](./docs/guide.md).',
    );
    w.__cerebroMockRoots.seedFile('/repos/alpha', 'docs/guide.md', '# Guide\n\nInstall it.');
    w.__cerebroMockRoots.seedFile('/repos/alpha', 'src/main.rs', 'fn main() {}');
    w.__cerebroMockRoots.seedFile('/repos/beta', 'README.md', '# Beta');
  });
}

async function openWorkspace(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await expect(page.getByTestId('workspace-page')).toBeVisible();
}

test.describe('workspace', () => {
  test('browses a mounted repo and reads a doc', async ({ page }) => {
    await boot(page);
    await seedRepos(page);
    await openWorkspace(page);

    await expect(page.getByTestId('root-tree')).toBeVisible();
    await expect(page.getByTestId('root-tree').getByTestId('tree-row')).toHaveCount(2);

    // Expanding a root lists exactly one level.
    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'alpha' })
      .click();
    await expect(
      page.getByTestId('root-tree').getByTestId('tree-row').filter({ hasText: 'README.md' }),
    ).toHaveCount(1);

    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'README.md' })
      .click();
    await expect(page.getByTestId('doc-viewer')).toContainText('Alpha');
  });

  test('a relative link navigates in-app', async ({ page }) => {
    await boot(page);
    await seedRepos(page);
    await openWorkspace(page);

    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'alpha' })
      .click();
    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'README.md' })
      .click();
    await page.getByTestId('doc-internal-link').click();

    await expect(page.getByTestId('doc-viewer')).toHaveAttribute('data-path', 'docs/guide.md');
    await expect(page.getByTestId('doc-viewer')).toContainText('Install it');
  });

  test('a code file opens read-only in the code viewer', async ({ page }) => {
    await boot(page);
    await seedRepos(page);
    await openWorkspace(page);

    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'alpha' })
      .click();
    await page.getByTestId('root-tree').getByTestId('tree-row').filter({ hasText: 'src' }).click();
    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'main.rs' })
      .click();

    const viewer = page.getByTestId('code-viewer');
    await expect(viewer).toBeVisible();
    await expect(viewer).toHaveAttribute('data-lang', 'rust');
  });

  test('opening files stacks tabs, and closing one falls back left', async ({ page }) => {
    await boot(page);
    await seedRepos(page);
    await openWorkspace(page);

    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'alpha' })
      .click();
    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'README.md' })
      .click();
    await expect(page.getByTestId('tab')).toHaveCount(1);

    await page.getByTestId('root-tree').getByTestId('tree-row').filter({ hasText: 'src' }).click();
    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'main.rs' })
      .click();
    await expect(page.getByTestId('tab')).toHaveCount(2);

    // Re-opening a file focuses its tab rather than adding a duplicate.
    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'README.md' })
      .click();
    await expect(page.getByTestId('tab')).toHaveCount(2);
    await expect(page.getByTestId('doc-viewer')).toHaveAttribute('data-path', 'README.md');

    await page.getByLabel('Close README.md').click();
    await expect(page.getByTestId('tab')).toHaveCount(1);
    await expect(page.getByTestId('code-viewer')).toBeVisible();
  });

  test('the editor splits into two panes and each keeps its own file', async ({ page }) => {
    await boot(page);
    await seedRepos(page);
    await openWorkspace(page);

    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'alpha' })
      .click();
    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'README.md' })
      .click();
    await expect(page.getByTestId('editor-pane')).toHaveCount(1);

    await page.getByTestId('split-editor').click();
    await expect(page.getByTestId('editor-pane')).toHaveCount(2);
    await expect(page.getByTestId('pane-splitter')).toHaveCount(1);

    // The new pane has focus, so the next file opens there and the left pane
    // keeps what it was showing.
    await page.getByTestId('root-tree').getByTestId('tree-row').filter({ hasText: 'src' }).click();
    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'main.rs' })
      .click();

    const panes = page.getByTestId('editor-pane');
    await expect(panes.nth(0).getByTestId('doc-viewer')).toHaveAttribute('data-path', 'README.md');
    await expect(panes.nth(1).getByTestId('code-viewer')).toHaveAttribute('data-lang', 'rust');
  });

  test('Cmd+\\ splits, and closing a pane’s last tab removes the pane', async ({ page }) => {
    await boot(page);
    await seedRepos(page);
    await openWorkspace(page);

    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'alpha' })
      .click();
    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'README.md' })
      .click();

    await page.keyboard.press('ControlOrMeta+\\');
    await expect(page.getByTestId('editor-pane')).toHaveCount(2);

    // Both panes hold README.md, so its close button appears twice; the one in
    // the focused (second) pane is the one under test.
    await page.getByTestId('editor-pane').nth(1).getByLabel('Close README.md').click();
    await expect(page.getByTestId('editor-pane')).toHaveCount(1);
    await expect(page.getByTestId('doc-viewer')).toHaveAttribute('data-path', 'README.md');
  });

  test('a code file shows numbered lines and a breadcrumb', async ({ page }) => {
    await boot(page);
    await seedRepos(page);
    await openWorkspace(page);

    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'alpha' })
      .click();
    await page.getByTestId('root-tree').getByTestId('tree-row').filter({ hasText: 'src' }).click();
    await page
      .getByTestId('root-tree')
      .getByTestId('tree-row')
      .filter({ hasText: 'main.rs' })
      .click();

    await expect(page.getByTestId('code-viewer')).toHaveAttribute('data-line-numbers', 'true');
    await expect(page.getByTestId('breadcrumb')).toHaveAttribute('data-path', 'src/main.rs');
    await expect(page.getByTestId('breadcrumb')).toContainText('alpha');
    await expect(page.getByTestId('breadcrumb')).toContainText('src');
  });

  test('the explorer is a keyboard-operable tree', async ({ page }) => {
    await boot(page);
    await seedRepos(page);
    await openWorkspace(page);

    const tree = page.getByRole('tree');
    await expect(tree).toBeVisible();

    const first = page.getByRole('treeitem').first();
    await first.focus();
    // Right expands the root rather than moving off it.
    await page.keyboard.press('ArrowRight');
    await expect(
      page.getByTestId('root-tree').getByTestId('tree-row').filter({ hasText: 'README.md' }),
    ).toHaveCount(1);

    // alpha's children, directories first: docs, src, README.md.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const readme = page.locator('[data-testid="tree-row"][data-path="README.md"]');
    await expect(readme).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('doc-viewer')).toHaveAttribute('data-path', 'README.md');
  });

  test('file icons can be turned off from the explorer settings', async ({ page }) => {
    await boot(page);
    await seedRepos(page);
    await openWorkspace(page);

    await page.getByTestId('workspace-settings').click();
    const toggle = page.getByTestId('toggle-file-icons');
    await expect(toggle).toHaveAttribute('data-checked', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('data-checked', 'false');

    // The tree still renders; only the glyphs changed.
    await expect(page.getByTestId('root-tree').getByTestId('tree-row')).toHaveCount(2);
  });

  test('the mount dialog opens and closes without mounting anything', async ({ page }) => {
    await boot(page);
    await seedRepos(page);
    await openWorkspace(page);

    await page.getByTestId('mount-root').click();
    await expect(page.getByTestId('mount-dialog')).toBeVisible();

    await page.getByTestId('mount-cancel').click();
    await expect(page.getByTestId('mount-dialog')).toBeHidden();
    await expect(page.getByTestId('root-tree').getByTestId('tree-row')).toHaveCount(2);
  });

  // The refusal PATH is not driven from here: the dialog's folder picker is the
  // Tauri plugin, which does not exist in a browser, and reaching past it would
  // assert against a seam rather than the app. It is covered where it can be
  // driven honestly — RootMountDialog.test.tsx renders the card for both
  // refusal codes, rootsStore.test.ts proves mount() resolves rather than
  // throws, and mockRoots.test.ts holds the guard parity with roots/read.rs.

  test('an empty workspace says how to fill it', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      (window as unknown as MockRootsWindow).__cerebroMockRoots.resetMockRoots();
    });
    await openWorkspace(page);

    await expect(page.getByTestId('workspace-empty')).toBeVisible();
    await expect(page.getByTestId('root-tree')).toBeHidden();
  });
});
