/**
 * Usage (`/usage`; the Spend report under the name Usage, docs/design-handoff/council-ui-2026-11/16-final/usage/,
 * docs/decisions/final-settings-vault-files-usage.md). It leads with the plain cost and how many times the assistant
 * worked in the chosen window (Today, Last 7 days, Last 30 days), how many of those times reported a cost, the window
 * itself and when the report was prepared; More holds that the report combines every provider, how much text was read
 * and written, the reports that are missing and what saved plans used. Read again each time the page opens; nothing
 * here is live. The window chooser and the page stay while the report loads, is empty or can't be read.
 */
import {
  USAGE_TEXT,
  USAGE_WINDOWS,
  type UsageWindow,
  type UsageWindowView,
  usageView,
} from '@whombat/client';
import { useSpendOverview, useTheAgent } from '@whombat/client/react';
import { ChartNoAxesColumn, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { errorDetail, PlacePage, PlaceState } from '../settings/Place';
import styles from './Usage.module.css';

export function UsageScreen({ burrow }: { burrow: string }) {
  const { words } = useTheAgent(burrow);
  const query = useSpendOverview({ params: { burrow } }, { staleTime: 0, refetchOnMount: 'always' });
  const [window, setWindow] = useState<UsageWindow>('today');
  const view = query.data ? usageView(query.data, words.name) : null;
  const shown = view?.windows[window];
  return (
    <PlacePage screen="usage" title={USAGE_TEXT.title} intro={USAGE_TEXT.intro(words.name)}>
      <fieldset className={styles.windows} aria-label={USAGE_TEXT.windowsLabel}>
        {USAGE_WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            className={styles.window}
            aria-pressed={w === window}
            onClick={() => setWindow(w)}
          >
            {USAGE_TEXT.windows[w]}
          </button>
        ))}
      </fieldset>
      {!view || !shown ? (
        query.error ? (
          <PlaceState
            kind="failed"
            icon={ChartNoAxesColumn}
            title={USAGE_TEXT.failedTitle}
            line={USAGE_TEXT.failedLine}
            retryLabel={USAGE_TEXT.retry}
            onRetry={() => void query.refetch()}
            detail={errorDetail(query.error)}
          />
        ) : (
          <PlaceState kind="loading" icon={ChartNoAxesColumn} title={USAGE_TEXT.loading} />
        )
      ) : (
        <>
          <p className={styles.span}>{shown.span}</p>
          {shown.empty ? (
            <PlaceState
              kind="empty"
              icon={ChartNoAxesColumn}
              title={USAGE_TEXT.emptyTitle}
              line={USAGE_TEXT.emptyLine}
            />
          ) : (
            <>
              <div className={styles.tiles} data-usage-window={window}>
                <div className={styles.tile}>
                  <span className={styles.tileLabel}>{USAGE_TEXT.cost}</span>
                  <span className={styles.value}>
                    {shown.cost ? (
                      <>
                        <span className={styles.number}>{shown.cost}</span>
                        <span className={styles.unit}>{USAGE_TEXT.unit}</span>
                      </>
                    ) : (
                      <span className={styles.none}>{USAGE_TEXT.noCost}</span>
                    )}
                  </span>
                  <span className={styles.meta}>{shown.coverage}</span>
                </div>
                <div className={styles.tile}>
                  <span className={styles.tileLabel}>{view.worked}</span>
                  <span className={styles.value}>
                    <span className={styles.number}>{shown.times}</span>
                  </span>
                </div>
              </div>
              <p className={styles.definition}>{USAGE_TEXT.definition}</p>
            </>
          )}
          <p className={styles.prepared}>{view.prepared}</p>
          <More window={shown} plans={view.plans} agent={words.name} />
        </>
      )}
    </PlacePage>
  );
}

/** More: provider coverage, the text read and written with the missing reports, and what plans used. */
function More({ window, plans, agent }: { window: UsageWindowView; plans: string[]; agent: string }) {
  const ids = useId();
  return (
    <details className={styles.more}>
      <summary className={styles.moreSummary}>
        <Icon icon={ChevronRight} size={14} className={styles.moreChevron} />
        {USAGE_TEXT.more}
      </summary>
      <div className={styles.moreBody}>
        <section aria-labelledby={`${ids}-coverage`} className={styles.moreSection}>
          <h2 id={`${ids}-coverage`} className={styles.moreTitle}>
            {USAGE_TEXT.coverageTitle}
          </h2>
          {USAGE_TEXT.coverageLines.map((line) => (
            <p key={line} className={styles.moreLine}>
              {line}
            </p>
          ))}
        </section>
        {window.empty ? null : (
          <section aria-labelledby={`${ids}-text`} className={styles.moreSection}>
            <h2 id={`${ids}-text`} className={styles.moreTitle}>
              {USAGE_TEXT.textTitle}
            </h2>
            <p className={cx(styles.moreLine, styles.moreStrong)}>{window.text}</p>
            <p className={styles.moreLine}>{USAGE_TEXT.textLine(agent)}</p>
            <p className={styles.moreLine}>{window.reports}</p>
          </section>
        )}
        {plans.length > 0 ? (
          <section aria-labelledby={`${ids}-plans`} className={styles.moreSection}>
            <h2 id={`${ids}-plans`} className={styles.moreTitle}>
              {USAGE_TEXT.plansTitle}
            </h2>
            {plans.map((plan) => (
              <p key={plan} className={styles.moreLine}>
                {plan}
              </p>
            ))}
            <p className={styles.moreLine}>{USAGE_TEXT.plansLine}</p>
          </section>
        ) : null}
      </div>
    </details>
  );
}
