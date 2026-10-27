import { expect, test } from '@playwright/test';
import { boot, openAssistantPanel } from './boot';

const ANSWER =
  '## A practical plan\n\nKeep the original source and review the next step.\n\n<script>neverRun()</script>\n';

for (const theme of ['light', 'dark'] as const) {
  test(`save an answer previews exact text, preserves the draft and supplies Undo in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.addInitScript((answer) => {
      localStorage.setItem(
        'cerebro.conversations',
        JSON.stringify([
          {
            id: 'save-browser',
            title: 'A practical plan',
            usesDefaultTitle: false,
            sessionId: null,
            messages: [
              { id: 'question', role: 'user', text: 'Help me plan the next step.', tools: [] },
              { id: 'answer', role: 'assistant', text: answer, tools: [] },
            ],
            createdAt: '2026-07-20T12:00:00.000Z',
            archived: false,
            vault: '/demo-vault',
          },
        ]),
      );
      localStorage.setItem('cerebro.activeConversation', 'save-browser');
    }, ANSWER);
    await boot(page);
    if (theme === 'dark')
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    await openAssistantPanel(page);
    const panel = page.getByTestId('ai-panel');
    const composer = panel.getByLabel('Message the assistant');
    await composer.fill('Keep my next question.');
    const writes = await page.evaluate(() => window.__cerebroMockWrites.length);
    const action = panel.getByRole('button', { name: 'Save answer', exact: true });
    await action.focus();
    await page.keyboard.press('Enter');
    let dialog = page.getByRole('dialog', { name: 'Save answer as page' });
    await expect(dialog.getByLabel('Page title')).toBeFocused();
    expect(await dialog.getByTestId('answer-save-preview').textContent()).toBe(ANSWER);
    await expect(dialog.locator('script')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(action).toBeFocused();
    expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(writes);
    await expect(composer).toHaveValue('Keep my next question.');
    await page.keyboard.press('Enter');
    dialog = page.getByRole('dialog', { name: 'Save answer as page' });
    await dialog.getByLabel('Page title').fill('My reviewed answer');
    await page.screenshot({ path: info.outputPath(`message-save-preview-${theme}.png`) });
    await dialog.getByRole('button', { name: 'Save page', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Saved to my-reviewed-answer.md');
    expect(await page.evaluate(() => window.__cerebroMockFs.get('my-reviewed-answer.md'))).toBe(
      `# My reviewed answer\n\n${ANSWER}`,
    );
    await page.screenshot({ path: info.outputPath(`message-save-success-${theme}.png`) });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(composer).toHaveValue('Keep my next question.');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.__cerebroMockFs.has('my-reviewed-answer.md')))
      .toBe(false);
    await expect(composer).toHaveValue('Keep my next question.');
  });
}
