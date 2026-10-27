import { expect, test } from '@playwright/test';
import { boot, openAssistantPanel, seedBeforeBoot } from './boot';

const SESSION = '00000000-0000-4000-8000-000000000095';

for (const theme of ['light', 'dark'] as const) {
  test(`trimmed chat history remains disclosed through a live turn (${theme})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript(
      ({ theme, session }) => {
        window.localStorage.setItem('cerebro.themeMode', theme);
        window.localStorage.setItem('cerebro.activeConversation', 'c-cache-partial');
        window.localStorage.setItem(
          'cerebro.conversations',
          JSON.stringify([
            {
              id: 'c-cache-partial',
              title: 'Retained conversation',
              usesDefaultTitle: false,
              sessionId: session,
              vault: '/demo-vault',
              createdAt: '2026-07-20T12:00:00.000Z',
              archived: false,
              cacheTrimmed: true,
              messages: [
                { id: 'kept-question', role: 'user', text: 'Kept question', tools: [] },
                { id: 'kept-answer', role: 'assistant', text: 'Kept answer', tools: [] },
              ],
            },
          ]),
        );
      },
      { theme, session: SESSION },
    );
    await seedBeforeBoot(page, '__cerebroSeedCliTranscript', SESSION, {
      state: 'unavailable',
      reason: 'not_recorded',
      retention_days: null,
    });
    await boot(page, { preserveTheme: true });
    await openAssistantPanel(page);
    const panel = page.getByTestId('ai-panel');
    const notice = panel.getByTestId('transcript-unavailable');
    await expect(notice).toHaveAttribute('data-reason', 'cache_trimmed');
    await expect(notice).toContainText('Earlier messages unavailable');
    await expect(notice).toContainText('removed from this copy to fit browser storage');
    await expect(panel.getByTestId('chat-message')).toHaveCount(2);

    const composer = panel.getByLabel('Message the assistant');
    const input = await composer.elementHandle();
    await composer.fill('wait for me');
    await composer.press('Enter');
    await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await composer.fill('Keep this unsent draft');
    await expect(notice).toContainText('Earlier messages unavailable');
    await panel.getByRole('region', { name: 'Conversation', exact: true }).hover();
    await page.mouse.wheel(0, -5000);
    await expect(notice).toBeInViewport();
    await page.screenshot({ path: info.outputPath('partial-live.png'), animations: 'disabled' });

    await panel.getByRole('button', { name: 'Minimize conversation' }).click();
    await page.getByTestId('ai-panel-fab').click();
    await panel.getByRole('button', { name: 'Conversation options' }).click();
    await page.getByRole('menuitem', { name: 'Expand conversation' }).click();
    await expect(panel).toHaveAttribute('data-presentation', 'canvas');
    await expect(composer).toHaveValue('Keep this unsent draft');
    expect(await input!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(notice).toContainText('Earlier messages unavailable');
    await page.evaluate(() =>
      (window as unknown as { __cerebroReleaseMockRuns(): void }).__cerebroReleaseMockRuns(),
    );
    await expect(panel.locator('[data-role="assistant"]').last()).toContainText('Done waiting.');
    await expect(panel.getByTestId('chat-message')).toHaveCount(4);
    await expect(notice).toContainText('Earlier messages unavailable');
    await expect(composer).toHaveValue('Keep this unsent draft');
    expect(await input!.evaluate((element) => element.isConnected)).toBe(true);
    await panel.getByRole('region', { name: 'Conversation', exact: true }).hover();
    await page.mouse.wheel(0, -5000);
    await expect(notice).toBeInViewport();
    await page.screenshot({
      path: info.outputPath('partial-completed.png'),
      animations: 'disabled',
    });
  });
}
