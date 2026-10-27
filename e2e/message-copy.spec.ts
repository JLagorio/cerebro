import { expect, test } from '@playwright/test';
import { boot, openAssistantPanel } from './boot';

const QUESTION = 'Please turn these notes into a short plan.\nKeep the next step clear.';
const ANSWER = '## A clear next step\n\nReview the source, then save a draft for your review.\n';
type ClipboardFixture = { values: string[]; deny: boolean };
type FixtureWindow = Window & { __messageCopyFixture: ClipboardFixture };

for (const theme of ['light', 'dark'] as const) {
  test(`completed message actions copy with the keyboard and report refusal in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.addInitScript(
      ({ question, answer }) => {
        const fixture: ClipboardFixture = { values: [], deny: false };
        (window as unknown as FixtureWindow).__messageCopyFixture = fixture;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (value: string) => {
              if (fixture.deny) throw new Error('Fixture clipboard refusal');
              fixture.values.push(value);
            },
          },
        });
        window.localStorage.setItem(
          'cerebro.conversations',
          JSON.stringify([
            {
              id: 'copy-browser',
              title: 'A clear next step',
              usesDefaultTitle: false,
              sessionId: null,
              messages: [
                { id: 'question', role: 'user', text: question, tools: [] },
                { id: 'answer', role: 'assistant', text: answer, tools: [] },
              ],
              createdAt: '2026-07-20T12:00:00.000Z',
              archived: false,
              vault: '/demo-vault',
            },
          ]),
        );
        window.localStorage.setItem('cerebro.activeConversation', 'copy-browser');
      },
      { question: QUESTION, answer: ANSWER },
    );
    await boot(page);
    if (theme === 'dark')
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    await openAssistantPanel(page);
    const panel = page.getByTestId('ai-panel');
    const composer = panel.getByLabel('Message the assistant');
    await composer.fill('Keep my next question.');
    const writes = await page.evaluate(() => window.__cerebroMockWrites.length);
    const questionActions = panel.getByRole('group', { name: 'Question actions' });
    const answerActions = panel.getByRole('group', { name: 'Answer actions' });
    const questionCopy = questionActions.getByRole('button', { name: 'Copy', exact: true });
    const answerCopy = answerActions.getByRole('button', { name: 'Copy', exact: true });
    await expect(questionCopy).toBeVisible();
    await expect(answerCopy).toBeVisible();
    await questionCopy.focus();
    await page.keyboard.press('Enter');
    await expect(
      questionActions.getByRole('button', { name: 'Copied', exact: true }),
    ).toBeVisible();
    await answerCopy.focus();
    await expect(answerCopy).toBeFocused();
    await page.screenshot({ path: info.outputPath(`message-copy-keyboard-${theme}.png`) });
    await page.keyboard.press('Enter');
    await expect(answerActions.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as FixtureWindow).__messageCopyFixture.values),
    ).toEqual([QUESTION, ANSWER]);
    await page.evaluate(() => {
      (window as unknown as FixtureWindow).__messageCopyFixture.deny = true;
    });
    await answerActions.getByRole('button', { name: 'Copied', exact: true }).click();
    await expect(
      answerActions.getByRole('button', { name: "Couldn't copy", exact: true }),
    ).toBeVisible();
    await expect(answerActions.getByRole('status')).toHaveText("Couldn't copy");
    await expect(composer).toHaveValue('Keep my next question.');
    await expect(
      panel.getByRole('heading', { name: 'A clear next step', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(writes);
    expect(
      await page.evaluate(() => (window as unknown as FixtureWindow).__messageCopyFixture.values),
    ).toEqual([QUESTION, ANSWER]);
    await page.screenshot({ path: info.outputPath(`message-copy-refused-${theme}.png`) });
  });
}
