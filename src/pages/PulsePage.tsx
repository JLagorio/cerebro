import { Icon } from '@/components/ui/Icon';
import { HistoryHeatmapSection } from '@/history/ActivityHeatmap';
import { HistoryFeedSection } from '@/history/ActivityFeed';

/**
 * History (M64.2): who changed what in this vault, and when.
 *
 * The year as a heatmap of editing sessions, then the feed: sessions, agent
 * runs and checkpoints, day by day. Edits between commits, the runs that
 * wrote them and the days Cerebro was closed all show, and "nothing
 * happened" never reads like "not recorded" (CV-05). Activity (runtime.db's
 * write rows, runs and app sessions) and checkpoints (git) are separate
 * reads, and each fails alone: a vault with no history kept, or a log that
 * could not be read, is a line in the feed, never a blank page.
 *
 * The background distiller and scheduled agents write whether or not the
 * panel is open; this is where that work is legible.
 */
export function PulsePage() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="pulse-page">
      <PulseHeader />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 pt-1">
          <HistoryHeatmapSection />
          <HistoryFeedSection />
        </div>
      </div>
    </div>
  );
}

/** The header shares the content column's left edge (M15). In `px-5` against
 * a centred 720px list it floated ~220px to the left of every card it labels,
 * reading as two unrelated fragments. It is also titled "History", because
 * that is what the nav and the status bar call this destination — a button
 * labelled History that opens a page called Pulse is two names for one place. */
function PulseHeader() {
  return (
    <div className="flex-none px-5 pb-2 pt-3.5">
      <div className="mx-auto flex w-full min-w-0 max-w-[720px] items-center gap-2">
        <Icon name="activity" size={16} color="var(--n-600)" />
        <h1 className="m-0 text-lg font-semibold leading-6 tracking-[-0.005em]">History</h1>
      </div>
    </div>
  );
}
