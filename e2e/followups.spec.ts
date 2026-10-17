import { expect, test, type Page } from '@playwright/test';
import {
  chooseSettingsSection,
  boot,
  seedBeforeBoot,
  seedFileBeforeBoot,
  VAULT_TODAY,
  openAssistantPanel,
  openDestination,
  openAgents,
} from './boot';
import type { Followup } from '../src/engine/followups';
const vault = '/demo-vault';
const actor = 'process:release-scout';
const scout = 'records/agents/release-scout.md';
const now = Date.parse(VAULT_TODAY);
const rows = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __cerebroMockFollowups: () => Followup[] }).__cerebroMockFollowups(),
  );
const lobby = async (page: Page) => openDestination(page, 'Agents');

test('a due follow-up runs once as its own agent', async ({ page }) => {
  await seedBeforeBoot(page, '__cerebroSeedFleet', []);
  await seedBeforeBoot(page, '__cerebroSeedFollowups', [
    {
      vault,
      actor,
      followupId: 'due',
      note: 'check the vendor reply',
      dueAt: new Date(now - 60_000).toISOString(),
    },
  ]);
  await boot(page, { autoLearn: true });
  await expect.poll(async () => (await rows(page))[0]?.state, { timeout: 30_000 }).toBe('fired');
  const first = (await rows(page))[0].runId;
  expect(first).toBeTruthy();
  await lobby(page);
  await expect(page.getByTestId('fleet-row')).toHaveCount(1);
  await expect(page.getByTestId('run-why')).toContainText('a follow-up it asked for came due');
  await expect(page.getByTestId('fleet-row')).toContainText('Release scout');
  await expect(page.getByTestId('followup-row')).toHaveCount(0);
  expect((await rows(page))[0].runId).toBe(first);
});

test('Learn off leaves it waiting, enabling Learn runs it once', async ({ page }) => {
  await seedBeforeBoot(page, '__cerebroSeedFollowups', [
    {
      vault,
      actor,
      followupId: 'wait',
      note: 'wait for Learn',
      dueAt: new Date(now - 60_000).toISOString(),
    },
  ]);
  await boot(page);
  await lobby(page);
  await expect(page.getByTestId('followup-row')).toContainText('due now, waiting its turn');
  expect((await rows(page))[0].state).toBe('pending');
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Knowledge');
  const learn = page.getByRole('switch', { name: 'Learn on its own', exact: true });
  await page.locator('label.cb-switch').filter({ has: learn }).click();
  await expect.poll(async () => (await rows(page))[0]?.state, { timeout: 30_000 }).toBe('fired');
});

test('the lobby cancels pending rows and an addressed booking appears on its agent page', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedFileBeforeBoot(
    page,
    scout,
    '---\ntype: Agent\nslug: release-scout\ntools: [schedule_followup, get_note]\nscope: []\n---\n# Release scout\nCheck the release.\n',
  );
  await seedBeforeBoot(page, '__cerebroSeedFollowups', [
    {
      vault,
      actor,
      followupId: 'cancel',
      note: 'cancel this',
      dueAt: new Date(now + 3_600_000).toISOString(),
    },
    {
      vault,
      actor,
      followupId: 'keep',
      note: 'keep [[plain]] <b>note</b>',
      dueAt: new Date(now + 7_200_000).toISOString(),
    },
  ]);
  await boot(page);
  await lobby(page);
  await expect(page.getByTestId('followup-row')).toHaveCount(2);
  await page
    .locator('[data-followup="cancel"]')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(page.getByTestId('followup-row')).toHaveCount(1);
  expect((await rows(page)).find((row) => row.followupId === 'cancel')?.cancelReason).toBe(
    'person',
  );
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  await panel
    .getByLabel('Message the assistant')
    .fill('@release-scout follow up "check the vendor reply" in 2 hours');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByTestId('chat-message').last()).toContainText('Booked a follow-up', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('followup-row')).toHaveCount(2);
  await openAgents(page);
  await page.getByTestId('nav-agent').filter({ hasText: 'Release scout' }).click();
  await page.getByRole('tab', { name: 'Runs', exact: true }).click();
  await expect(page.getByTestId('followup-row')).toHaveCount(2);
  await expect(page.getByTestId('dossier-duty')).toContainText('while Learn on its own is on');
  await expect(page.getByTestId('followups')).toContainText('"check the vendor reply"');
  await expect(page.getByTestId('followups').locator('b,a')).toHaveCount(0);
  await page.getByTestId('followups').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('agent-followups.png'), fullPage: true });
});
