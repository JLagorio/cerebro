import { expect, test } from '@playwright/test';
import { boot, openDestination, seedBeforeBoot } from './boot';

const path = 'records/skills/library-retention-fixture.md';
const initial =
  '---\ntype: Skill\nslug: library-retention-fixture\n---\n\n# Library retention fixture\n\nOriginal instructions.\n';

test.beforeEach(async ({ page }) => {
  await seedBeforeBoot(page, '__cerebroSeedFiles', { [path]: initial });
  await boot(page);
  await openDestination(page, 'Library');
  await page.getByText('Library retention fixture', { exact: true }).click();
  await expect(page.getByLabel('Instructions', { exact: true })).toBeVisible();
});

test('explicit Library Save retains failed values, blocks Back and retries without another edit', async ({
  page,
}, info) => {
  const instructions = page.getByLabel('Instructions', { exact: true });
  await instructions.fill('The exact draft to retry.');
  await page.getByLabel('Name', { exact: true }).fill('Retained title');
  await page.getByTestId('library-back').click();
  await expect(instructions).toHaveValue('The exact draft to retry.');
  expect(await page.evaluate((key) => window.__cerebroMockFs.get(key), path)).toBe(initial);
  await page.evaluate(() => {
    (window as unknown as { __cerebroFailNext: (command: string) => void }).__cerebroFailNext(
      'apply_batch',
    );
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  expect(await page.evaluate((key) => window.__cerebroMockFs.get(key), path)).toBe(initial);
  await page.screenshot({ path: info.outputPath('library-failed-draft.png') });
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(await page.evaluate((key) => window.__cerebroMockFs.get(key), path)).toContain(
    '# Retained title\n\nThe exact draft to retry.\n',
  );
  await page.getByTestId('library-back').click();
  await expect(page.getByTestId('library-page')).toBeVisible();
  await page.getByText('Retained title', { exact: true }).click();
  await expect(instructions).toHaveValue('# Retained title\n\nThe exact draft to retry.\n');
  await instructions.fill('Discard only this unsubmitted draft.');
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(instructions).toHaveValue('# Retained title\n\nThe exact draft to retry.\n');
});

test('a deleted Library target keeps its draft and recovery actions without recreating the file', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 900, height: 800 });
  const instructions = page.getByLabel('Instructions', { exact: true });
  await instructions.fill('Keep these bytes after deletion.');
  await page.evaluate((key) => window.__cerebroMockFs.delete(key), path);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy draft', exact: true })).toBeVisible();
  await page.getByTestId('library-back').click();
  await expect(instructions).toHaveValue('Keep these bytes after deletion.');
  expect(await page.evaluate((key) => window.__cerebroMockFs.has(key), path)).toBe(false);
  await page.screenshot({ path: info.outputPath('library-deleted-draft.png') });
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.getByTestId('library-back').click();
  await expect(page.getByTestId('library-page')).toBeVisible();
  expect(await page.evaluate((key) => window.__cerebroMockFs.has(key), path)).toBe(false);
});

test('a rename survives a second Save after newer prose was typed while the first Save waited', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const modulePath = '/src/stores/vaultStore.ts';
    const { useVaultStore } = await import(/* @vite-ignore */ modulePath);
    const apply = useVaultStore.getState().applyBatch;
    let first = true;
    useVaultStore.setState({
      applyBatch: async (...args: unknown[]) => {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            (window as unknown as { releaseLibrarySave: () => void }).releaseLibrarySave = resolve;
          });
        }
        return apply(...args);
      },
    });
  });
  const instructions = page.getByLabel('Instructions', { exact: true });
  await page.getByLabel('Name', { exact: true }).fill('Renamed during save');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeVisible();
  await instructions.fill(
    '# Library retention fixture\n\nNewer prose typed while the first Save waited.\n',
  );
  await page.evaluate(() =>
    (window as unknown as { releaseLibrarySave: () => void }).releaseLibrarySave(),
  );
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(await page.evaluate((key) => window.__cerebroMockFs.get(key), path)).toContain(
    '# Renamed during save',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(await page.evaluate((key) => window.__cerebroMockFs.get(key), path)).toContain(
    '# Renamed during save\n\nNewer prose typed while the first Save waited.\n',
  );
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Renamed during save');
  await expect(instructions).toHaveValue(
    '# Renamed during save\n\nNewer prose typed while the first Save waited.\n',
  );
});

test('opening against a stale shelf scan preserves outside metadata on a body-only Save', async ({
  page,
}) => {
  await page.getByTestId('library-back').click();
  await expect(page.getByTestId('library-page')).toBeVisible();
  await page.evaluate((key) => {
    const content = window.__cerebroMockFs.get(key)!;
    window.__cerebroMockFs.set(
      key,
      content.replace(
        'type: Skill',
        'type: Skill\ndescription: Outside description after shelf scan',
      ),
    );
  }, path);
  await page.getByText('Library retention fixture', { exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
    'Outside description after shelf scan',
  );
  await page.getByLabel('Instructions', { exact: true }).fill('Only the body is edited here.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  const content = await page.evaluate((key) => window.__cerebroMockFs.get(key), path);
  expect(content).toContain('description: Outside description after shelf scan');
  expect(content).toContain('Only the body is edited here.');
});

test('an authored H1 survives newer prose and a second Save when Name was untouched', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const modulePath = '/src/stores/vaultStore.ts';
    const { useVaultStore } = await import(/* @vite-ignore */ modulePath);
    const apply = useVaultStore.getState().applyBatch;
    let first = true;
    useVaultStore.setState({
      applyBatch: async (...args: unknown[]) => {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            (window as unknown as { releaseLibrarySave: () => void }).releaseLibrarySave = resolve;
          });
        }
        return apply(...args);
      },
    });
  });
  const instructions = page.getByLabel('Instructions', { exact: true });
  const name = page.getByLabel('Name', { exact: true });
  await instructions.fill('# Authored title\n\nFirst body.\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeVisible();
  const newerBody = '# Authored title\n\nNewer prose while saving.\n';
  await instructions.fill(newerBody);
  await page.evaluate(() =>
    (window as unknown as { releaseLibrarySave: () => void }).releaseLibrarySave(),
  );
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(await page.evaluate((key) => window.__cerebroMockFs.get(key), path)).toContain(
    '# Authored title\n\nFirst body.\n',
  );
  await expect(name).toHaveValue('Authored title');
  await expect(instructions).toHaveValue(newerBody);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(await page.evaluate((key) => window.__cerebroMockFs.get(key), path)).toContain(newerBody);
  await expect(name).toHaveValue('Authored title');
  await expect(instructions).toHaveValue(newerBody);
});
