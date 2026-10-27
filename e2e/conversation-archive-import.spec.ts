import { expect, test } from '@playwright/test';
import { openStateLab } from './boot';

// Native durable readback/ownership has its own SQLite tests. This browser
// journey checks the real Settings/import/cache path against isolated lab data.
for (const theme of ['light', 'dark'] as const) {
  test(`explicit archive import clears checked pairs and keeps refused history (${theme})`, async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 820 });
    const kept = [
      { id: 'lab-kept-user', role: 'user', text: 'Kept question', tools: [], hiddenFutureField: { keep: true } },
      { id: 'lab-kept-answer', role: 'assistant', text: 'Kept answer', tools: [{ id: 'kept-tool', name: 'Read', input: 'KEPT_RAW_INPUT', output: 'KEPT_RAW_OUTPUT', done: true, failed: false }], parts: [{ kind: 'reasoning', id: 'kept-thinking', text: 'KEPT_PRIVATE_REASONING' }] },
    ];
    const unknown = { id: 'unknown-vault-thread', title: 'Unassigned history', usesDefaultTitle: false, sessionId: null, createdAt: '2026-07-20T12:00:00Z', archived: false, messages: [{ id: 'unknown-user', role: 'user', text: 'Unknown vault question', tools: [] }, { id: 'unknown-answer', role: 'assistant', text: 'Unknown vault answer', tools: [] }] };
    const source = { id: 'lab-import-thread', title: 'Recent fixture history', usesDefaultTitle: false, sessionId: null, vault: '/demo-vault', createdAt: '2026-07-20T12:00:00Z', archived: false, unknownThreadField: { keep: 'opaque' }, messages: [
      { id: 'lab-import-user', role: 'user', text: 'Imported visible question', tools: [], prompt: 'EXCLUDED_ASSEMBLED_PROMPT' },
      { id: 'lab-import-answer', role: 'assistant', text: 'Imported visible answer', tools: [], parts: [{ kind: 'reasoning', id: 'private-thinking', text: 'EXCLUDED_REASONING' }, { kind: 'text', id: 'final', text: 'Imported visible answer' }] },
      ...kept,
    ] };
    await page.addInitScript((records) => window.localStorage.setItem('cerebro.conversations', JSON.stringify(records)), [source, unknown]);
    const errors: string[] = [];page.on('pageerror', (error) => errors.push(error.message));
    await openStateLab(page, 'conversation-archive', 'ready');
    if (theme === 'dark') await page.getByTestId('lab-theme').click();
    const archive = page.getByTestId('conversation-archive');
    await expect(archive).toContainText('2 cached turns available');
    const importButton = archive.getByRole('button', { name: 'Import this vault’s recent conversations' });
    await expect(importButton).toBeDisabled();
    expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem('cerebro.conversations')!))).toEqual([source, unknown]);
    await archive.getByRole('button', { name: 'Conversation retention' }).click();
    await page.getByRole('option', { name: 'Forever', exact: true }).click();
    await expect(archive).toContainText('Retention choice saved for new completed content. Existing messages keep their recorded expiry.');
    await expect(importButton).toBeEnabled();
    expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem('cerebro.conversations')!))).toEqual([source, unknown]);
    await importButton.click();
    await expect(archive).toContainText('Imported 1 cached turn; cleared 1 checked copy. 1 kept.');
    await expect(archive).toContainText('1 cached turn available');
    const after = await page.evaluate(() => JSON.parse(window.localStorage.getItem('cerebro.conversations')!));
    expect(after[1]).toEqual(unknown);expect(after[0].messages.slice(2)).toEqual(kept);expect(after[0].unknownThreadField).toEqual(source.unknownThreadField);
    for (const message of after[0].messages.slice(0, 2)) {
      expect(message.text).toBe('');expect(message.tools).toEqual([]);expect(message.archiveRecord.origin).toBe('browser_cache');expect(message.archiveRecord.importedAt).toBe('2026-07-28T12:00:00Z');
      expect(message.prompt).toBeUndefined();expect(message.parts).toBeUndefined();
    }
    await archive.getByRole('button', { name: /Imported fixture discussion/ }).click();
    await expect(archive).toContainText('Imported visible question');await expect(archive).toContainText('Imported visible answer');
    await expect(archive).toContainText('Completion time not recorded');
    await expect(archive).not.toContainText('EXCLUDED_ASSEMBLED_PROMPT');await expect(archive).not.toContainText('EXCLUDED_REASONING');await expect(archive).not.toContainText('KEPT_RAW_INPUT');
    await expect(archive).not.toContainText('Succeeded');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`archive-import-${theme}.png`), animations: 'disabled', fullPage: true });
    expect(errors).toEqual([]);
  });
}
