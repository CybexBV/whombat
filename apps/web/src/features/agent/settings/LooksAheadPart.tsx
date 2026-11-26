/**
 * Settings → the assistant → **Looks ahead** (Whombat looks-ahead.md; `looksAhead.get`, `looksAhead.update`,
 * `looksAhead.checkNow`): checks upcoming plans (up to a week ahead and again before they start) and incoming mail
 * against connected files, docs and the web, and tells the person only when something needs attention. “Keeping an
 * eye on” lists what it follows over days (a refund, an answer from the notary), each removable.
 */
import { Link } from '@tanstack/react-router';
import {
  hasLooksAheadMatters,
  hasLooksAheadV2,
  looksAheadCalendarMeta,
  looksAheadCheckMeta,
  looksAheadSavedText,
  matterLine,
  LOOKS_AHEAD_TEXT as T,
} from '@whombat/client';
import { commitOutcomeText, hostErrorInfo } from '@whombat/client/hosts';
import {
  useCheckLooksAheadNow,
  useLooksAhead,
  useSessionProtocol,
  useTheAgent,
  useUpdateLooksAhead,
} from '@whombat/client/react';
import { AHEAD_KIND_WORDS, AHEAD_RULE_MAX, AHEAD_RULES_MAX, type LooksAheadUpdate } from '@whombat/core';
import { useId, useState } from 'react';
import { LoadErrorNote } from '../../../app/runtime';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { SkeletonRows } from '../../../components/ListState';
import { SectionLabel } from '../../../components/SectionLabel';
import { useToast } from '../../../components/Toast';
import { Toggle } from '../../../components/Toggle';
import { useBurrowViewer } from '../../runs/useBurrowViewer';
import styles from '../../settings/SettingsScreen.module.css';
import own from './LooksAhead.module.css';

export function LooksAheadPart({ burrow }: { burrow: string }) {
  const ids = useId();
  const toast = useToast();
  const protocol = useSessionProtocol();
  const v2 = hasLooksAheadV2(protocol);
  const hasMatters = hasLooksAheadMatters(protocol);
  const { timeZone } = useBurrowViewer(burrow);
  const { words } = useTheAgent(burrow);
  const query = useLooksAhead({ params: { burrow } }, { retry: false });
  const update = useUpdateLooksAhead(burrow);
  const checkNow = useCheckLooksAheadNow(burrow);
  const [draftRule, setDraftRule] = useState('');
  const view = query.data;

  if (!view) {
    return query.error ? (
      <LoadErrorNote error={query.error} message={T.failed} onRetry={() => void query.refetch()} />
    ) : (
      <SkeletonRows count={3} lines={1} />
    );
  }

  const busy = update.isPending;
  const save = (change: LooksAheadUpdate, onDone?: () => void) => {
    const said = looksAheadSavedText(view, change);
    update.mutateAsync(change).then(
      (result) => {
        if (result.status === 'ok') {
          toast.show(said);
          onDone?.();
        } else toast.show(commitOutcomeText(result) ?? T.notSaved);
      },
      (error) => toast.show(hostErrorInfo(error).message || T.notSaved),
    );
  };
  const runCheckNow = () => {
    checkNow.mutateAsync().then(
      (result) => {
        if (result.status === 'ok') toast.show(result.data.started ? T.checkStarted : T.nothingDue);
        else toast.show(commitOutcomeText(result) ?? T.notSaved);
      },
      (error) => toast.show(hostErrorInfo(error).message || T.notSaved),
    );
  };
  const week = T.week(view.week.checked, view.week.told);
  const rules = view.rules ?? [];
  const recent = view.recent ?? [];
  const matters = view.matters ?? [];
  const trimmedRule = draftRule.trim();
  const canAddRule = trimmedRule.length >= 2 && rules.length < AHEAD_RULES_MAX && !busy;

  return (
    <>
      <p className={own.intro}>{T.explainFor(words.Name)}</p>

      <div className={styles.card}>
        <div className={cx(styles.row, styles.lastRow)} data-row="looks-ahead">
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${ids}-on`}>
              {T.title}
            </label>
            <span className={styles.rowMeta} id={`${ids}-week`}>
              {week}
            </span>
          </span>
          <span className={own.mainActions}>
            {v2 ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={!view.on || checkNow.isPending}
                onClick={runCheckNow}
              >
                {checkNow.isPending ? T.checkingNow : T.checkNow}
              </Button>
            ) : null}
            <Toggle
              id={`${ids}-on`}
              checked={view.on}
              disabled={busy}
              aria-describedby={`${ids}-week`}
              onCheckedChange={(on) => save({ on })}
            />
          </span>
        </div>
      </div>

      <section className={styles.section} aria-labelledby={`${ids}-calendars`} data-ahead="calendars">
        <SectionLabel as="h2" id={`${ids}-calendars`}>
          {T.calendars}
        </SectionLabel>
        {!view.hasCalendar ? (
          <p className={own.note}>{T.noCalendar}</p>
        ) : !view.calendarsRead ? (
          <p className={own.note}>{T.calendarsUnread}</p>
        ) : view.calendars.length ? (
          <div className={styles.card}>
            {view.calendars.map((c, i) => (
              <div
                key={c.key}
                className={cx(styles.row, i === view.calendars.length - 1 && styles.lastRow)}
                data-calendar={c.key}
              >
                <span className={cx(styles.rowMain, !view.on && own.resting)}>
                  <label className={styles.rowTitle} htmlFor={`${ids}-cal-${i}`}>
                    {c.name}
                  </label>
                  <span className={styles.rowMeta} id={`${ids}-cal-${i}-meta`}>
                    {looksAheadCalendarMeta(c)}
                  </span>
                </span>
                <Toggle
                  id={`${ids}-cal-${i}`}
                  checked={c.on}
                  disabled={busy || !view.on}
                  aria-describedby={`${ids}-cal-${i}-meta`}
                  onCheckedChange={(on) => save({ calendar: c.key, on })}
                />
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {v2 ? (
        <section className={styles.section} aria-labelledby={`${ids}-mail`} data-ahead="mail">
          <SectionLabel as="h2" id={`${ids}-mail`}>
            {T.mail}
          </SectionLabel>
          {view.hasMail === false ? (
            <p className={own.note}>{T.noMail}</p>
          ) : (
            <div className={styles.card}>
              <div className={cx(styles.row, styles.lastRow)} data-row="looks-ahead-mail">
                <span className={cx(styles.rowMain, !view.on && own.resting)}>
                  <label className={styles.rowTitle} htmlFor={`${ids}-mail-on`}>
                    {T.mail}
                  </label>
                  <span className={styles.rowMeta} id={`${ids}-mail-meta`}>
                    {T.mailLine}
                  </span>
                </span>
                <Toggle
                  id={`${ids}-mail-on`}
                  checked={view.mailOn ?? true}
                  disabled={busy || !view.on}
                  aria-describedby={`${ids}-mail-meta`}
                  onCheckedChange={(mailOn) => save({ mailOn })}
                />
              </div>
            </div>
          )}
        </section>
      ) : null}

      {hasMatters && (view.hasMail || matters.length > 0) ? (
        <section className={styles.section} aria-labelledby={`${ids}-matters`} data-ahead="matters">
          <SectionLabel as="h2" id={`${ids}-matters`}>
            {T.matters}
          </SectionLabel>
          {matters.length ? (
            <ul className={cx(styles.card, own.list)}>
              {matters.map((matter, i) => (
                <li
                  key={matter.id}
                  className={cx(styles.row, i === matters.length - 1 && styles.lastRow)}
                  data-matter={matter.id}
                >
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>{matter.title}</span>
                    <span className={styles.rowMeta}>{matterLine(matter, timeZone)}</span>
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    aria-label={T.removeMatterLabel(matter.title)}
                    onClick={() => save({ removeMatter: matter.id })}
                  >
                    {T.removeMatter}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={own.note}>{T.mattersEmpty(words.Name)}</p>
          )}
        </section>
      ) : null}

      {v2 ? (
        <section className={styles.section} aria-labelledby={`${ids}-rules`} data-ahead="rules">
          <SectionLabel as="h2" id={`${ids}-rules`}>
            {T.rules}
          </SectionLabel>
          <p className={own.note}>{T.rulesHint}</p>
          <div className={styles.card}>
            {rules.length ? (
              <ul className={own.list}>
                {rules.map((rule) => (
                  <li key={rule} className={styles.row} data-rule={rule}>
                    <span className={cx(styles.rowMain, own.ruleText)}>{rule}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      aria-label={T.removeRuleLabel(rule)}
                      onClick={() => save({ removeRule: rule })}
                    >
                      {T.removeRule}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <form
              className={own.ruleForm}
              onSubmit={(e) => {
                e.preventDefault();
                if (!canAddRule) return;
                save({ addRule: trimmedRule }, () => setDraftRule(''));
              }}
            >
              <input
                type="text"
                className={own.ruleInput}
                value={draftRule}
                maxLength={AHEAD_RULE_MAX}
                placeholder={T.rulesPlaceholder}
                aria-label={T.rules}
                onChange={(e) => setDraftRule(e.target.value)}
              />
              <Button type="submit" variant="secondary" size="sm" disabled={!canAddRule}>
                {T.addRule}
              </Button>
            </form>
          </div>
        </section>
      ) : null}

      {view.stopped.length ? (
        <section className={styles.section} aria-labelledby={`${ids}-stopped`} data-ahead="stopped">
          <SectionLabel as="h2" id={`${ids}-stopped`}>
            {T.stopped}
          </SectionLabel>
          <ul className={cx(styles.card, own.list)}>
            {view.stopped.map((kind, i) => (
              <li
                key={kind}
                className={cx(styles.row, i === view.stopped.length - 1 && styles.lastRow)}
                data-kind={kind}
              >
                <span className={cx(styles.rowMain, styles.rowTitle)}>{AHEAD_KIND_WORDS[kind]}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  aria-label={T.turnBackOnLabel(kind)}
                  onClick={() => save({ kind, on: true })}
                >
                  {T.turnBackOn}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {v2 && recent.length ? (
        <section className={styles.section} aria-labelledby={`${ids}-recent`} data-ahead="recent">
          <SectionLabel as="h2" id={`${ids}-recent`}>
            {T.recent}
          </SectionLabel>
          <ul className={cx(styles.card, own.list)}>
            {recent.map((item, i) => (
              <li
                key={item.id}
                className={cx(styles.row, i === recent.length - 1 && styles.lastRow)}
                data-check={item.id}
              >
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{item.title}</span>
                  <span className={styles.rowMeta}>{looksAheadCheckMeta(item)}</span>
                </span>
                {item.threadRootId && item.of !== 'triage' ? (
                  <Link to="/chat" search={{ thread: item.threadRootId }} className={own.threadLink}>
                    {T.openThread}
                  </Link>
                ) : item.inboxItemId && item.of !== 'triage' ? (
                  <Link to="/inbox" search={{ item: item.inboxItemId }} className={own.threadLink}>
                    {T.openInInbox}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
