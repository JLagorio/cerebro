import { expect, test } from '@playwright/test';
import { boot, openAssistantPanel } from './boot';

for (const theme of ['light', 'dark'] as const) {
  test(`missing child details remain visible beside the parent answer (${theme})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript((theme) => {
      window.localStorage.setItem('cerebro.themeMode', theme);
      window.localStorage.setItem('cerebro.activeConversation', 'c-child-partial');
      window.localStorage.setItem(
        'cerebro.conversations',
        JSON.stringify([
          {
            id: 'c-child-partial',
            title: 'Research with missing details',
            usesDefaultTitle: false,
            sessionId: null,
            vault: '/demo-vault',
            createdAt: '2026-10-23T12:00:00.000Z',
            archived: false,
            messages: [
              { id: 'question', role: 'user', text: 'Review the launch risks.', tools: [] },
              {
                id: 'answer',
                role: 'assistant',
                text: 'The launch plan still needs a recorded mitigation.',
                tools: [],
                childTraceUnavailable: true,
              },
            ],
          },
        ]),
      );
    }, theme);
    await boot(page, { preserveTheme: true });
    await openAssistantPanel(page);
    const panel = page.getByTestId('ai-panel');
    const answer = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
    const notice = answer.getByTestId('child-trace-unavailable');
    await expect(notice).toHaveRole('status');
    await expect(notice).toHaveText(
      'Some subagent details are unavailable. The details shown may be incomplete.',
    );
    await expect(answer).toContainText('The launch plan still needs a recorded mitigation.');
    await expect(notice).toBeInViewport();
    const composer = panel.getByLabel('Message the assistant');
    await composer.fill('Keep this research follow-up');
    const input = await composer.elementHandle();
    await panel.getByRole('button', { name: 'Minimize conversation' }).click();
    await page.getByTestId('ai-panel-fab').click();
    await expect(composer).toHaveValue('Keep this research follow-up');
    await expect(notice).toBeInViewport();
    expect(await input!.evaluate((element) => element.isConnected)).toBe(true);
    await page.screenshot({ path: info.outputPath('child-details.png'), animations: 'disabled' });
  });
}
