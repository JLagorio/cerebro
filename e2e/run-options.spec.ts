import { test, expect, type Page } from '@playwright/test';
import { boot, openAgents } from './boot';

/**
 * Model and effort (M56.5): a conversation's pick reaches the run and the
 * footer names the model Claude Code reported answering, and an agent's
 * page writes `model:` and `effort:` one key per Done.
 *
 * The mock answers as `mock-<model>` (src/agent/mockAgent.ts), so the
 * footer shows the model the run was asked for, the way the real fold shows
 * the one Claude Code reported.
 */

const SCOUT = 'records/agents/release-scout.md';

async function openPanel(page: Page) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test('run options: the pick rides the turn, the footer names the model, and it survives a reload', async ({
  page,
}) => {
  await boot(page);
  let panel = await openPanel(page);
  const picker = panel.getByTestId('run-options');
  await expect(picker).toHaveText('Claude Code default');

  await picker.click();
  await page.getByTestId('run-model-opus').click();
  await page.getByTestId('run-effort-high').click();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveText('Opus · High');

  await panel.getByLabel('Message the assistant').fill('hello');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByTestId('turn-model')).toHaveText('mock-opus');
  await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible();

  // The pick is the conversation's, so it comes back with it.
  await page.reload();
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  // The panel reopens as it was left.
  panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('run-options')).toHaveText('Opus · High');
});

test("run options: Release scout's page writes model and effort one key per Done", async ({
  page,
}) => {
  await boot(page);
  await openAgents(page);
  await page.getByTestId('agent-row').filter({ hasText: 'Release scout' }).click();
  await expect(page.getByTestId('doc-title')).toContainText('Release scout');

  const file = () => page.evaluate((p) => window.__cerebroMockFs.get(p) ?? '', SCOUT);
  const model = page.getByTestId('agent-prop-model');
  const effort = page.getByTestId('agent-prop-effort');
  await expect(model).toContainText('Claude Code default');
  await expect(effort).toContainText('Claude Code default');

  await model.getByTestId('agent-prop-open').click();
  let editor = page.getByTestId('agent-editor-model');
  await editor.getByRole('radio', { name: 'Sonnet' }).check();
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect.poll(file).toContain('model: sonnet');
  expect(await file()).not.toContain('effort:');
  await expect(model).toContainText('Sonnet');

  await effort.getByTestId('agent-prop-open').click();
  editor = page.getByTestId('agent-editor-effort');
  await editor.getByRole('radio', { name: 'High', exact: true }).check();
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect.poll(file).toContain('effort: high');

  // Claude Code default removes the key.
  await model.getByTestId('agent-prop-open').click();
  editor = page.getByTestId('agent-editor-model');
  await editor.getByRole('radio', { name: 'Claude Code default' }).check();
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect.poll(file).not.toContain('model:');
  expect(await file()).toContain('effort: high');
});
