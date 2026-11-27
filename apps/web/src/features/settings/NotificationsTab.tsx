import { useQueryClient } from '@tanstack/react-query';
import { createLink } from '@tanstack/react-router';
import { dndSetText, quietHoursText, toggleDay, weekdayLabels } from '@whombat/client';
import { COMMUNITY_TEXT } from '@whombat/client/managed';
import { queryKeys } from '@whombat/client/query';
import { useBootstrap, useTheAgent } from '@whombat/client/react';
import {
  ClockTime,
  type DndPreset,
  dndUntilFor,
  type NotificationPreferences,
  WEEKDAY_KEYS,
} from '@whombat/core';
import type { LinkSummary } from '@whombat/protocol/session';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { useAppServices, useCommunity, useManaged } from '../../app/providers';
import { Button, ButtonLink } from '../../components/Button';
import { cx } from '../../components/cx';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { currentLocale, useWebI18n } from '../../i18n/provider';
import { useLocaleWords } from '../../i18n/words';
import { BOX_PAGE_TEXT } from '../../managed/pageText';
import { useWebPush } from '../../push/useWebPush';
import { useReach } from '../machine/useReach';
import { useNow } from '../messaging/useRoom';
import own from './NotificationsTab.module.css';
import { useNotificationPreferences, useSaveNotificationPreferences } from './notificationPreferences';
import {
  customDndUntil,
  dndStateText,
  emailOptions,
  localInputValue,
  type NotificationsWords,
  notificationsWords,
} from './notificationsModel';
import styles from './SettingsScreen.module.css';

const PRESETS: DndPreset[] = ['30m', '1h', 'tomorrow'];
const PRESET_KEYS = {
  '30m': 'settings.notifications.preset30m',
  '1h': 'settings.notifications.preset1h',
  tomorrow: 'settings.notifications.presetTomorrow',
} as const satisfies Record<DndPreset, string>;
const RouterButtonLink = createLink(ButtonLink);

/**
 * Settings → Notifications (Whombat essentials item 12; contracts CT-175; AP-490…): your own Do not disturb (quick
 * durations or a time you pick, and “Turn off”), quiet hours (days and times in your zone), email about what stayed
 * unread (only on a Whombat that can send mail), replies in your threads and whether notifications show message text
 * (AP-809), under this browser's notifications, which come first. Each
 * change saves at once. Per-conversation levels live on each conversation's bell. Not in the mocks: Settings → Profile's
 * rows (a title, a muted line, the control on the right).
 *
 * One sentence over the page (docs/decisions/less-is-more.md AP-1790, AP-1791), the agent by its name, nothing about
 * the bell, mentions or the inbox (chats have none), and no THREADS — a chat with the agent notifies every message, so
 * “Replies in your threads” changes nothing (the setting stays as it is).
 */
export function NotificationsTab({ burrow }: { burrow: string }) {
  const i18n = useWebI18n();
  const { t } = i18n;
  const saveFailed = t('settings.notifications.saveFailed');
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const prefs = useNotificationPreferences(burrow);
  const save = useSaveNotificationPreferences(burrow);
  const toast = useToast();
  const timeZone = bootstrap?.preferences.timeZone ?? bootstrap?.burrow.timeZone ?? 'Europe/Amsterdam';
  const capabilities = bootstrap?.capabilities;
  const { words: agent } = useTheAgent(burrow);
  const words = notificationsWords(
    bootstrap?.burrow.name ?? t('settings.notifications.thisWhombat'),
    agent.name,
    i18n,
  );
  const { session } = useAppServices();
  const { reach, setMail } = useReach(session);
  const qc = useQueryClient();
  const link = reach?.link;

  const apply = useCallback<Apply>(
    (change, done) =>
      save(change).then(
        () => {
          if (done) toast.show(done);
          return true;
        },
        () => {
          toast.show(saveFailed);
          return false;
        },
      ),
    [save, toast, saveFailed],
  );

  return (
    <>
      <p className={own.intro}>{words.intro}</p>
      {/* Whether this browser can tell you anything comes first: every setting under it shapes those notifications. */}
      {capabilities?.webPush === false ? null : <BrowserSection words={words} />}
      <DndSection prefs={prefs} timeZone={timeZone} apply={apply} meta={words.dndMeta} />
      <QuietHoursSection prefs={prefs} timeZone={timeZone} apply={apply} />
      {capabilities?.emailNotifications ? (
        <EmailSection prefs={prefs} apply={apply} hints={words.email} />
      ) : null}
      {/* Email through Whombat Link: only where Link knows this Whombat, and the box keeps the choices. */}
      {link?.mail && link.state !== 'off' ? (
        <LinkEmailSection
          link={link}
          mail={link.mail}
          save={async (change) => {
            const ok = await setMail(change);
            if (!ok) toast.show(saveFailed);
            // Whether this Whombat emails notifications now (the EMAIL section above) follows the second choice.
            else
              void qc.invalidateQueries({
                queryKey: queryKeys.conversations.bootstrap({ params: { burrow } }),
              });
          }}
        />
      ) : null}
      {words.threads ? <ThreadsSection prefs={prefs} apply={apply} /> : null}
      <PreviewsSection prefs={prefs} apply={apply} />
    </>
  );
}

type Apply = (
  change: (current: NotificationPreferences) => NotificationPreferences,
  done?: string,
) => Promise<boolean>;

/** DO NOT DISTURB: what's on now with “Turn off”, the quick durations, and a time to pick. */
function DndSection({
  prefs,
  timeZone,
  apply,
  meta,
}: {
  prefs: NotificationPreferences;
  timeZone: string;
  apply: Apply;
  meta: { on: string; off: string };
}) {
  const { t } = useWebI18n();
  const ids = useId();
  const now = useNow(15_000);
  const [custom, setCustom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = dndStateText(prefs, now, timeZone);

  const setUntil = (until: string) =>
    apply((p) => ({ ...p, dndUntil: until }), dndSetText(until, Date.now(), timeZone, currentLocale()));

  const onCustom = async (event: FormEvent) => {
    event.preventDefault();
    const r = customDndUntil(custom ?? '', Date.now(), timeZone);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    if (await setUntil(r.until)) setCustom(null);
  };

  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        {t('settings.notifications.dndLabel')}
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <StatusDot tone={state ? 'warn' : 'mut'} size={8} label={null} />
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} role="status">
              {state ?? t('settings.notifications.off')}
            </span>
            <span className={styles.rowMeta}>{state ? meta.on : meta.off}</span>
          </span>
          {state && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void apply((p) => ({ ...p, dndUntil: null }), t('settings.notifications.dndOff'))
              }
            >
              {t('settings.notifications.turnOff')}
            </Button>
          )}
        </div>
        <div className={cx(styles.row, own.wrapRow)}>
          <span className={own.rowLabel} id={`${ids}-for`}>
            {state ? t('settings.notifications.changeTo') : t('settings.notifications.pauseFor')}
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: a group of buttons, not form fields (no fieldset) */}
          <div className={own.choices} role="group" aria-labelledby={`${ids}-for`}>
            {PRESETS.map((preset) => (
              <Button
                key={preset}
                variant="secondary"
                size="sm"
                onClick={() => {
                  setCustom(null);
                  void setUntil(dndUntilFor(preset, Date.now(), timeZone));
                }}
              >
                {t(PRESET_KEYS[preset])}
              </Button>
            ))}
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={custom !== null}
              aria-controls={custom !== null ? `${ids}-custom` : undefined}
              onClick={() => {
                setError(null);
                // Two hours from now, on the hour.
                setCustom((v) =>
                  v === null
                    ? `${localInputValue(Date.now() + 2 * 60 * 60_000, timeZone).slice(0, 14)}00`
                    : null,
                );
              }}
            >
              {t('settings.notifications.custom')}
            </Button>
          </div>
        </div>
        {custom !== null && (
          <form id={`${ids}-custom`} className={cx(styles.row, own.wrapRow)} onSubmit={onCustom} noValidate>
            <label className={own.rowLabel} htmlFor={`${ids}-until`}>
              {t('settings.notifications.until')}
            </label>
            <Input
              id={`${ids}-until`}
              type="datetime-local"
              className={own.timeInput}
              value={custom}
              min={localInputValue(Date.now(), timeZone)}
              invalid={error !== null}
              aria-describedby={`${ids}-zone${error ? ` ${ids}-error` : ''}`}
              onChange={(e) => {
                setCustom(e.target.value);
                if (error) setError(null);
              }}
            />
            <Button type="submit" variant="primary" size="sm">
              {t('settings.notifications.pause')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCustom(null)}>
              {t('common.cancel')}
            </Button>
            <span id={`${ids}-zone`} className={own.fullHint}>
              {t('settings.notifications.inYourZone', { zone: timeZone })}
            </span>
            {error && (
              <span id={`${ids}-error`} className={styles.fieldError} role="alert">
                {error}
              </span>
            )}
          </form>
        )}
      </div>
    </section>
  );
}

/** QUIET HOURS: on or off, from and to, which days; saved once a time rests. */
function QuietHoursSection({
  prefs,
  timeZone,
  apply,
}: {
  prefs: NotificationPreferences;
  timeZone: string;
  apply: Apply;
}) {
  const WEEKDAY_LABELS = useLocaleWords(weekdayLabels);
  const { t } = useWebI18n();
  const ids = useId();
  const schedule = prefs.schedule;
  const [start, setStart] = useState(schedule.start);
  const [end, setEnd] = useState(schedule.end);
  useEffect(() => setStart(schedule.start), [schedule.start]);
  useEffect(() => setEnd(schedule.end), [schedule.end]);

  // A time is saved once it's a whole time and rests for a moment (the field changes per digit).
  useEffect(() => {
    if (start === schedule.start && end === schedule.end) return;
    if (!ClockTime.safeParse(start).success || !ClockTime.safeParse(end).success) return;
    const timer = setTimeout(() => {
      void apply((p) => ({ ...p, schedule: { ...p.schedule, start, end } }));
    }, 500);
    return () => clearTimeout(timer);
  }, [start, end, schedule.start, schedule.end, apply]);

  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        {t('settings.notifications.quietLabel')}
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${ids}-on`}>
              {t('settings.notifications.quietTitle')}
            </label>
            <span className={styles.rowMeta} id={`${ids}-summary`}>
              {quietHoursText(schedule, currentLocale())}
            </span>
          </span>
          <Toggle
            id={`${ids}-on`}
            checked={schedule.enabled}
            aria-describedby={`${ids}-summary`}
            onCheckedChange={(enabled) =>
              void apply((p) => ({
                ...p,
                schedule: {
                  ...p.schedule,
                  enabled,
                  // Switching on with no day picked means every day.
                  days: enabled && p.schedule.days.length === 0 ? [...WEEKDAY_KEYS] : p.schedule.days,
                },
              }))
            }
          />
        </div>
        {schedule.enabled && (
          <>
            <div className={cx(styles.row, own.wrapRow)}>
              <label className={own.rowLabel} htmlFor={`${ids}-start`}>
                {t('settings.notifications.from')}
              </label>
              <Input
                id={`${ids}-start`}
                type="time"
                className={own.clockInput}
                value={start}
                required
                onChange={(e) => setStart(e.target.value)}
              />
              <label className={own.rowLabel} htmlFor={`${ids}-end`}>
                {t('settings.notifications.to')}
              </label>
              <Input
                id={`${ids}-end`}
                type="time"
                className={own.clockInput}
                value={end}
                required
                onChange={(e) => setEnd(e.target.value)}
              />
              <span className={own.fullHint}>
                {t('settings.notifications.quietHint', { zone: timeZone })}
              </span>
            </div>
            <div className={cx(styles.row, own.wrapRow)}>
              <span className={own.rowLabel} id={`${ids}-days`}>
                {t('settings.notifications.on')}
              </span>
              {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not form fields */}
              <div className={own.days} role="group" aria-labelledby={`${ids}-days`}>
                {WEEKDAY_KEYS.map((day) => {
                  const on = schedule.days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      className={own.day}
                      aria-pressed={on}
                      aria-label={WEEKDAY_LABELS[day].long}
                      onClick={() =>
                        void apply((p) => ({
                          ...p,
                          schedule: { ...p.schedule, days: toggleDay(p.schedule.days, day) },
                        }))
                      }
                    >
                      {WEEKDAY_LABELS[day].short}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** EMAIL: only on a Whombat that can send mail (`Bootstrap.capabilities.emailNotifications`). */
function EmailSection({
  prefs,
  apply,
  hints,
}: {
  prefs: NotificationPreferences;
  apply: Apply;
  hints: NotificationsWords['email'];
}) {
  const i18n = useWebI18n();
  const { t } = i18n;
  const ids = useId();
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        {t('settings.notifications.emailLabel')}
      </SectionLabel>
      <div className={styles.card}>
        <div className={cx(styles.row, own.wrapRow)}>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{t('settings.notifications.emailTitle')}</span>
            <span className={styles.rowMeta}>{hints[prefs.email]}</span>
          </span>
          <SegmentedControl
            label={t('settings.notifications.emailTitle')}
            options={emailOptions(i18n)}
            value={prefs.email}
            onChange={(email) => void apply((p) => ({ ...p, email }))}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * WHOMBAT LINK (docs/decisions/link-email.md): the owner's two choices for email through Link. Told when this Whombat
 * goes offline (on unless turned off), and the notification emails and notices sent through Whombat Link (off unless
 * turned on), with an example of what such an email says. Not in the mocks: Settings → Profile's rows.
 */
function LinkEmailSection({
  link,
  mail,
  save,
}: {
  link: LinkSummary;
  mail: NonNullable<LinkSummary['mail']>;
  save: (change: { offline?: boolean; notifications?: boolean }) => Promise<void>;
}) {
  const { t } = useWebI18n();
  const ids = useId();
  const to = link.email ?? t('settings.notifications.you');
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        {t('settings.notifications.linkLabel')}
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${ids}-offline`}>
              {t('settings.notifications.linkOfflineTitle')}
            </label>
            <span className={styles.rowMeta} id={`${ids}-offline-meta`}>
              {t('settings.notifications.linkOfflineMeta', { to })}
            </span>
          </span>
          <Toggle
            id={`${ids}-offline`}
            checked={mail.offline}
            aria-describedby={`${ids}-offline-meta`}
            onCheckedChange={(offline) => void save({ offline })}
          />
        </div>
        <div className={cx(styles.row, own.wrapRow)}>
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${ids}-mail`}>
              {t('settings.notifications.linkMailTitle')}
            </label>
            <span className={styles.rowMeta} id={`${ids}-mail-meta`}>
              {t('settings.notifications.linkMailMeta')}
            </span>
          </span>
          <Toggle
            id={`${ids}-mail`}
            checked={mail.notifications}
            aria-describedby={`${ids}-mail-meta`}
            onCheckedChange={(notifications) => void save({ notifications })}
          />
          <details className={own.example}>
            <summary>{t('settings.notifications.linkExampleLabel')}</summary>
            <div className={own.exampleMail}>
              <p className={own.exampleSubject}>{t('settings.notifications.linkExampleSubject')}</p>
              <p>{t('settings.notifications.linkExampleBody')}</p>
              <p className={own.exampleButton}>{t('settings.notifications.linkExampleButton')}</p>
              <p className={own.exampleFoot}>{t('settings.notifications.linkExampleFoot')}</p>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}

/** THREADS: replies in your threads notify you even where you only get mentions. */
function ThreadsSection({ prefs, apply }: { prefs: NotificationPreferences; apply: Apply }) {
  const { t } = useWebI18n();
  const ids = useId();
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        {t('settings.notifications.threadsLabel')}
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${ids}-replies`}>
              {t('settings.notifications.threadsTitle')}
            </label>
            <span className={styles.rowMeta}>{t('settings.notifications.threadsMeta')}</span>
          </span>
          <Toggle
            id={`${ids}-replies`}
            checked={prefs.threadReplies}
            onCheckedChange={(threadReplies) => void apply((p) => ({ ...p, threadReplies }))}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * PREVIEWS (CT-286, AP-809): whether this person's notifications show who wrote and how the message starts, or only
 * what kind of notification it is.
 */
function PreviewsSection({ prefs, apply }: { prefs: NotificationPreferences; apply: Apply }) {
  const { t } = useWebI18n();
  const ids = useId();
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        {t('settings.notifications.previewsLabel')}
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${ids}-previews`}>
              {t('settings.notifications.previewsTitle')}
            </label>
            <span className={styles.rowMeta} id={`${ids}-meta`}>
              {t('settings.notifications.previewsMeta')}
            </span>
          </span>
          <Toggle
            id={`${ids}-previews`}
            checked={prefs.previews}
            aria-describedby={`${ids}-meta`}
            onCheckedChange={(previews) => void apply((p) => ({ ...p, previews }))}
          />
        </div>
      </div>
    </section>
  );
}

/** THIS BROWSER's line in each state; `off` and `unsupported` in the shell's words. */
const BROWSER_PUSH_META = {
  on: 'settings.notifications.browserOn',
  denied: 'settings.notifications.browserDenied',
  busy: 'settings.notifications.browserBusy',
  unknown: 'settings.notifications.browserUnknown',
} as const;

/**
 * THIS BROWSER: one switch for this browser's notifications. On asks the browser (from the click); Off unsubscribes and
 * is remembered here, so they don't come back by themselves. Blocked in the browser's site settings, the switch rests
 * and the line says where to allow them; where this browser can't show any, the phone app is the way.
 */
function BrowserSection({ words }: { words: NotificationsWords }) {
  const { t } = useWebI18n();
  const ids = useId();
  const push = useWebPush();
  const managed = useManaged();
  const community = useCommunity();
  // The box's own page without notifications here: not a secure page (a community box's insecure local-network page),
  // or a commercial box, whose notifications come through control (AP-5325, AP-5428). A secure box page has the box's
  // own Web Push (`managed.push`).
  const boxPage = managed?.page !== undefined && !managed.push;
  const text = boxPage
    ? community
      ? { title: COMMUNITY_TEXT.push.insecureTitle, meta: COMMUNITY_TEXT.push.insecureMeta }
      : { title: BOX_PAGE_TEXT.notificationsTitle, meta: BOX_PAGE_TEXT.notifications }
    : {
        title: t('settings.notifications.browserTitle'),
        meta:
          push.status === 'off'
            ? words.pushOff
            : push.status === 'unsupported'
              ? words.pushUnsupported
              : t(BROWSER_PUSH_META[push.status]),
      };
  const toggles = !boxPage && push.status !== 'unsupported';
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        {t('settings.notifications.browserLabel')}
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row} data-browser-push={boxPage ? 'box-page' : push.status}>
          <span className={styles.rowMain}>
            {toggles ? (
              <label className={styles.rowTitle} htmlFor={`${ids}-push`}>
                {text.title}
              </label>
            ) : (
              <span className={styles.rowTitle}>{text.title}</span>
            )}
            <span className={styles.rowMeta} id={`${ids}-meta`} role="status">
              {text.meta}
            </span>
          </span>
          {boxPage ? null : push.status === 'unsupported' ? (
            // A dead end otherwise: the phone app is how this person hears from Whombat.
            <RouterButtonLink variant="secondary" size="sm" to="/settings" search={{ tab: 'phone' } as never}>
              {words.getApp}
            </RouterButtonLink>
          ) : (
            <Toggle
              id={`${ids}-push`}
              checked={push.status === 'on'}
              disabled={push.status !== 'on' && push.status !== 'off'}
              aria-describedby={`${ids}-meta`}
              onCheckedChange={(on) => void (on ? push.enable() : push.disable())}
            />
          )}
        </div>
      </div>
    </section>
  );
}
