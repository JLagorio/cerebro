import { PageHeader } from '@/components/PageHeader';
import '@/history/historyPage.css';
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
      <div className="history-page-scroll">
        <div className="history-page-column">
          <PageHeader
            title="History"
            icon={<Icon name="activity" size={18} />}
            description="Changes, sessions and checkpoints across your vault."
            className="history-page-header"
          />
          <div className="history-page-sections">
            <HistoryHeatmapSection />
            <HistoryFeedSection />
          </div>
        </div>
      </div>
    </div>
  );
}
