import { test, expect } from '@playwright/test';
import { boot, chooseSettingsSection, openAssistantPanel, openDestination } from './boot';
import { chooseOption } from './select';

/**
 * Who answers in the panel (M56.6): Settings binds this vault's panel to an
 * Agent record, the header names it, a turn streams a reply as that agent,
 * and choosing the plain assistant takes the label away. The binding is the
 * app's config in Tauri and an in-memory map in the browser mock.
 */

test('panel agent: binding Release scout names it in the header, and unbinding removes it', async ({
  page,
}) => {
  await boot(page);
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Assistant');
  const select = page.getByRole('button', { name: 'Panel assistant' });
  await expect(select).toHaveAttribute('data-value', '');
  await chooseOption(select, 'Release scout');
  await expect(select).toHaveAttribute('data-value', 'release-scout');

  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();
  const label = panel.getByTestId('panel-agent');
  await expect(label).toHaveText('Release scout');
  await expect(label).toHaveAttribute('data-state', 'bound');

  await panel.getByLabel('Message the assistant').fill('What is at risk right now?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'Two risks are open' }),
  ).toBeVisible({ timeout: 10_000 });
  // A bound turn draws no per-bubble label: the header already says who.
  await expect(panel.getByTestId('turn-addressed')).toHaveCount(0);

  await chooseOption(select, 'Claude Code (no agent)');
  await expect(select).toHaveAttribute('data-value', '');
  await expect(panel.getByTestId('panel-agent')).toHaveCount(0);
});
