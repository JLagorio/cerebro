// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import type { ComponentProps, ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import type {
  TestCase,
  TestFailure,
  TestReport,
  TestSuite as TestSuiteData,
  TestTotals,
} from '@/engine/ai/testReport';
import { Badge } from './Badge';
import { CodeBlock, CodeBlockContent } from './CodeBlock';
import type { CollapsibleOpenProps } from './Collapsible';
import {
  StepHead,
  formatDuration,
  plural,
  useStepOpen,
  vaultPathOf,
  type VaultPathProps,
} from './StepLine';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './Trace';
import './trace-steps.css';

/**
 * A test run, as its runner reported it (M91.9, shadcn's Test Results): a
 * line that counts what passed and failed, opening onto the totals, the
 * failures first, and each suite's cases. It draws only what
 * engine/ai/testReport.ts read from the runner's own summary (Q11): output
 * with no summary is no report, so this draws nothing and the caller shows
 * the command's output instead — a run nobody counted never reads "0
 * failed" (CV-05). The cases are those the output still shows, never a
 * total, so a suite carries no count of its own.
 */

/** "Ran 7 tests, 2 failed, 2 skipped": the counts that are not zero. */
export function testRunTitle(totals: TestTotals): string {
  const errors = totals.errors ?? 0;
  return [
    `Ran ${plural(totals.total, 'test', 'tests')}`,
    totals.failed > 0 && `${totals.failed} failed`,
    totals.skipped > 0 && `${totals.skipped} skipped`,
    errors > 0 && plural(errors, 'error', 'errors'),
  ]
    .filter(Boolean)
    .join(', ');
}

/** The run's totals, each in words: "Passed: 3", "Failed: 2". Every count
 *  is the runner's own; what it reported as none of something is shown only
 *  where none is the news (no failures). */
export function TestResultsSummary({
  totals,
  className,
  ...props
}: ComponentProps<'div'> & { totals: TestTotals }) {
  const errors = totals.errors ?? 0;
  const files = totals.files?.failed ?? 0;
  return (
    <div
      data-slot="test-results-summary"
      {...props}
      className={['cb-ai-test-totals', className].filter(Boolean).join(' ')}
    >
      <Badge variant="secondary">Passed: {totals.passed}</Badge>
      <Badge variant={totals.failed > 0 ? 'destructive' : 'secondary'}>
        Failed: {totals.failed}
      </Badge>
      {totals.skipped > 0 && <Badge variant="secondary">Skipped: {totals.skipped}</Badge>}
      {errors > 0 && <Badge variant="destructive">Errors: {errors}</Badge>}
      {files > 0 && <Badge variant="destructive">Failed files: {files}</Badge>}
    </div>
  );
}

/** A location as printed: "src/cart.test.ts:6:19". */
function where(location: NonNullable<TestFailure['location']>): string {
  return [location.file, location.line, location.column]
    .filter((part) => part !== undefined)
    .join(':');
}

/** Where a failure was raised: a button that opens the page when it is one
 *  in this vault, else the location as text. */
function FailureLocation({
  location,
  onOpenPath,
  isVaultPath,
}: VaultPathProps & { location: NonNullable<TestFailure['location']> }) {
  const path = onOpenPath === undefined ? null : vaultPathOf(location.file, isVaultPath);
  const line = (
    <TraceLine>
      <TraceIcon>
        <Icon name="file-code" />
      </TraceIcon>
      <TraceTitle>
        {path !== null && <span className="sr-only">Open </span>}
        {where(location)}
      </TraceTitle>
    </TraceLine>
  );
  if (path === null || onOpenPath === undefined) return line;
  return (
    <button
      type="button"
      data-slot="test-failure-location"
      className="cb-ai-step-link"
      onClick={() => onOpenPath(path, location.line, location.column)}
    >
      {line}
    </button>
  );
}

/** One failure: its test, opening onto its error and where it was raised. */
export function TestError({
  failure,
  onOpenPath,
  isVaultPath,
}: VaultPathProps & { failure: TestFailure }) {
  const line = (
    <TraceLine status="error">
      <TraceIcon>
        <Icon name="x" />
      </TraceIcon>
      <TraceTitle>{failure.name}</TraceTitle>
    </TraceLine>
  );
  if (failure.message === undefined && failure.location === undefined) return line;
  return (
    <TraceCollapsible data-slot="test-failure" defaultOpen>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="cb-ai-step-detail">
        {failure.message !== undefined && (
          <CodeBlock size="sm" variant="destructive">
            <CodeBlockContent wrap className="cb-ai-step-code">
              {failure.message}
            </CodeBlockContent>
          </CodeBlock>
        )}
        {failure.location !== undefined && (
          <Trace>
            <FailureLocation
              location={failure.location}
              onOpenPath={onOpenPath}
              isVaultPath={isVaultPath}
            />
          </Trace>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** One case, its status in words: "Passed: …", "Failed: …", "Skipped …". */
export function Test({ test }: { test: TestCase }) {
  const failed = test.status === 'failed';
  const skipped = test.status === 'skipped';
  const line = (
    <TraceLine
      data-result={test.status}
      status={failed ? 'error' : undefined}
      statusText={failed ? 'Failed' : skipped ? null : 'Passed'}
    >
      <TraceIcon>
        <Icon name={failed ? 'x' : skipped ? 'circle-dashed' : 'check'} />
      </TraceIcon>
      <TraceTitle>{skipped ? `Skipped ${test.name}` : test.name}</TraceTitle>
      {test.durationMs !== undefined && (
        <TraceDescription>{formatDuration(test.durationMs)}</TraceDescription>
      )}
    </TraceLine>
  );
  if (!failed || test.message === undefined) return line;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm" variant="destructive">
          <CodeBlockContent wrap className="cb-ai-step-code">
            {test.message}
          </CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** What a cut failure list says: how many it shows of how many the runner
 *  counted. The fold keeps the end of the output, so the ones still shown
 *  are the last printed, not the first. */
export function cutWords(shown: number, counted: number): string {
  return shown === 0
    ? `The output no longer shows its ${plural(counted, 'failure', 'failures')}.`
    : `Showing ${shown} of ${plural(counted, 'failure', 'failures')}; the output no longer shows the rest.`;
}

/** Failed cases first, the rest in the order the runner printed them. */
function failedFirst<T>(items: readonly T[], failed: (item: T) => boolean): T[] {
  return [...items.filter(failed), ...items.filter((item) => !failed(item))];
}

/** A suite — a test file, a package — opening onto the cases the output
 *  still shows, failed ones first. */
export function TestSuite({ suite }: { suite: TestSuiteData }) {
  const failed = suite.cases.some((test) => test.status === 'failed');
  const skipped = suite.cases.length > 0 && suite.cases.every((test) => test.status === 'skipped');
  return (
    <TraceCollapsible data-slot="test-suite">
      <TraceCollapsibleTrigger>
        <TraceLine
          status={failed ? 'error' : undefined}
          statusText={
            failed ? 'Failed' : skipped ? 'Skipped' : suite.cases.length > 0 ? 'Passed' : null
          }
        >
          <TraceIcon>
            <Icon name="file-code" />
          </TraceIcon>
          <TraceTitle>{suite.name}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted>
        <Trace>
          {failedFirst(suite.cases, (test) => test.status === 'failed').map((test, index) => (
            // Cases are named by their runner, which may print a name twice.
            <Test key={`${index}:${test.name}`} test={test} />
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

export type TestResultsProps = Omit<ComponentProps<'div'>, 'title' | 'children'> &
  CollapsibleOpenProps &
  VaultPathProps & {
    /** testReport.ts's reading of the command's output; null draws nothing. */
    report: TestReport | null;
    /** The line's sentence; left out, the counts: "Ran 7 tests, 2 failed". */
    title?: ReactNode;
  };

/**
 * The run. It opens by itself when anything failed, and the reader's choice
 * wins from then on. When the runner counted more failures than the output
 * still shows, it says how many it shows of how many.
 */
export function TestResults({
  report,
  title,
  onOpenPath,
  isVaultPath,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: TestResultsProps) {
  // A file that failed to load counts in no test, and fails the run all the same.
  const failing =
    report !== null &&
    (report.totals.failed > 0 ||
      (report.totals.errors ?? 0) > 0 ||
      (report.totals.files?.failed ?? 0) > 0);
  const opened = useStepOpen({ open, defaultOpen, onOpenChange }, failing);
  if (report === null) return null;
  const { totals, failures } = report;
  // The counts say "failed" when a test did; a run that failed only outside
  // its tests, or in a file that never loaded, says so first, and one that
  // passed says that.
  const words =
    title !== undefined
      ? undefined
      : totals.failed > 0
        ? null
        : failing
          ? 'Failed'
          : totals.total > 0
            ? 'Passed'
            : null;
  return (
    <TraceCollapsible
      data-slot="test-results"
      data-status={failing ? 'failed' : 'done'}
      data-runner={report.runner}
      {...props}
      className={className}
      open={opened.open}
      onOpenChange={opened.onOpenChange}
    >
      <TraceCollapsibleTrigger>
        <StepHead
          status={failing ? 'failed' : 'done'}
          statusText={words}
          icon="flask-conical"
          title={title ?? testRunTitle(totals)}
          description={
            totals.durationMs === undefined ? undefined : formatDuration(totals.durationMs)
          }
        />
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted className="cb-ai-step-detail">
        <TestResultsSummary totals={totals} />
        {failures.length > 0 && (
          <Trace data-slot="test-failures">
            {failures.map((failure, index) => (
              <TestError
                key={`${index}:${failure.name}`}
                failure={failure}
                onOpenPath={onOpenPath}
                isVaultPath={isVaultPath}
              />
            ))}
          </Trace>
        )}
        {report.cut && (
          <p data-slot="test-results-cut" className="cb-ai-test-cut">
            {cutWords(failures.length, totals.failed)}
          </p>
        )}
        {report.suites !== undefined && report.suites.length > 0 && (
          <Trace data-slot="test-suites">
            {failedFirst(report.suites, (suite) =>
              suite.cases.some((test) => test.status === 'failed'),
            ).map((suite, index) => (
              <TestSuite key={`${index}:${suite.name}`} suite={suite} />
            ))}
          </Trace>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
