import { createLink } from '@tanstack/react-router';
import { dndSetText, quietHoursText, toggleDay, WEEKDAY_LABELS } from '@whombat/client';
import { COMMUNITY_TEXT } from '@whombat/client/managed';
import { useBootstrap, useTheAgent } from '@whombat/client/react';
import {
  ClockTime,
  DND_PRESET_LABELS,
  type DndPreset,
  dndUntilFor,
  type NotificationPreferences,
  WEEKDAY_KEYS,
} from '@whombat/core';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { useCommunity, useManaged } from '../../app/providers';
import { Button, ButtonLink } from '../../components/Button';
import { cx } from '../../components/cx';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { BOX_PAGE_TEXT } from '../../managed/pageText';
import { useWebPush, type WebPushStatus } from '../../push/useWebPush';
import { useNow } from '../messaging/useRoom';
import own from './NotificationsTab.module.css';
import { useNotificationPreferences, useSaveNotificationPreferences } from './notificationPreferences';
import {
  customDndUntil,
  dndStateText,
  EMAIL_OPTIONS,
  localInputValue,
  type NotificationsWords,
  notificationsWords,
} from './notificationsModel';
import styles from './SettingsScreen.module.css';

const PRESETS: DndPreset[] = ['30m', '1h', 'tomorrow'];
const RouterButtonLink = createLink(ButtonLink);
const SAVE_FAILED = 'That didn’t save. Try again in a moment.';

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
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const prefs = useNotificationPreferences(burrow);
  const save = useSaveNotificationPreferences(burrow);
  const toast = useToast();
  const timeZone = bootstrap?.preferences.timeZone ?? bootstrap?.burrow.timeZone ?? 'Europe/Amsterdam';
  const capabilities = bootstrap?.capabilities;
  const { words: agent } = useTheAgent(burrow);
  const words = notificationsWords(bootstrap?.burrow.name ?? 'this Whombat', agent.name);

  const apply = useCallback<Apply>(
    (change, done) =>
      save(change).then(
        () => {
          if (done) toast.show(done);
          return true;
        },
        () => {
          toast.show(SAVE_FAILED);
          return false;
        },
      ),
    [save, toast],
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
  const ids = useId();
  const now = useNow(15_000);
  const [custom, setCustom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = dndStateText(prefs, now, timeZone);

  const setUntil = (until: string) =>
    apply((p) => ({ ...p, dndUntil: until }), dndSetText(until, Date.now(), timeZone));

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
        DO NOT DISTURB
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <StatusDot tone={state ? 'warn' : 'mut'} size={8} label={null} />
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} role="status">
              {state ?? 'Off'}
            </span>
            <span className={styles.rowMeta}>{state ? meta.on : meta.off}</span>
          </span>
          {state && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void apply((p) => ({ ...p, dndUntil: null }), 'Do not disturb is off.')}
            >
              Turn off
            </Button>
          )}
        </div>
        <div className={cx(styles.row, own.wrapRow)}>
          <span className={own.rowLabel} id={`${ids}-for`}>
            {state ? 'Change to' : 'Pause for'}
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
                {DND_PRESET_LABELS[preset]}
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
              Custom…
            </Button>
          </div>
        </div>
        {custom !== null && (
          <form id={`${ids}-custom`} className={cx(styles.row, own.wrapRow)} onSubmit={onCustom} noValidate>
            <label className={own.rowLabel} htmlFor={`${ids}-until`}>
              Until
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
              Pause
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCustom(null)}>
              Cancel
            </Button>
            <span id={`${ids}-zone`} className={own.fullHint}>
              In your time zone, {timeZone}.
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
        QUIET HOURS
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${ids}-on`}>
              Quiet hours
            </label>
            <span className={styles.rowMeta} id={`${ids}-summary`}>
              {quietHoursText(schedule)}
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
                From
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
                to
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
                In your time zone, {timeZone}. A night that starts on Friday ends on Saturday morning; the
                same time twice is the whole day.
              </span>
            </div>
            <div className={cx(styles.row, own.wrapRow)}>
              <span className={own.rowLabel} id={`${ids}-days`}>
                On
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
  const ids = useId();
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        EMAIL
      </SectionLabel>
      <div className={styles.card}>
        <div className={cx(styles.row, own.wrapRow)}>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>Email about what’s unread</span>
            <span className={styles.rowMeta}>{hints[prefs.email]}</span>
          </span>
          <SegmentedControl
            label="Email about what’s unread"
            options={EMAIL_OPTIONS}
            value={prefs.email}
            onChange={(email) => void apply((p) => ({ ...p, email }))}
          />
        </div>
      </div>
    </section>
  );
}

/** THREADS: replies in your threads notify you even where you only get mentions. */
function ThreadsSection({ prefs, apply }: { prefs: NotificationPreferences; apply: Apply }) {
  const ids = useId();
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        THREADS
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${ids}-replies`}>
              Replies in your threads
            </label>
            <span className={styles.rowMeta}>
              Threads you started, replied to or were mentioned in notify you of new replies, also where you
              only get mentions.
            </span>
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
  const ids = useId();
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        PREVIEWS
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${ids}-previews`}>
              Show message text in notifications
            </label>
            <span className={styles.rowMeta} id={`${ids}-meta`}>
              {PREVIEWS_HINT}
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

const PREVIEWS_HINT =
  'Notifications show who wrote and the start of the message. Off: they only say what kind of notification it is.';

/** What THIS BROWSER says; `off` and `unsupported` say it in the shell's words (`NotificationsWords`). */
const PUSH_TEXT: Record<WebPushStatus, { title: string; meta: string }> = {
  on: { title: 'On in this browser', meta: 'Notifications show here even when Whombat isn’t open.' },
  off: { title: 'Off in this browser', meta: '' },
  denied: {
    title: 'Blocked by this browser',
    meta: 'Allow notifications for this site in the browser’s settings, then come back here.',
  },
  unsupported: { title: 'Not available in this browser', meta: '' },
  busy: { title: 'One moment…', meta: 'Asking the browser.' },
  unknown: { title: 'Checking this browser…', meta: 'Asking the browser whether notifications are on.' },
};

/** THIS BROWSER: the push subscription of this browser, turned on only from a click (the browser asks then). */
function BrowserSection({ words }: { words: NotificationsWords }) {
  const ids = useId();
  const push = useWebPush();
  const managed = useManaged();
  const community = useCommunity();
  // The box's own page without notifications here: not a secure page (a community box's insecure local-network page),
  // or a commercial box, whose notifications come through control (AP-5325, AP-5428). A secure box page has the box's
  // own Web Push (`managed.push`).
  const boxPage = managed?.page !== undefined && !managed.push;
  const base = PUSH_TEXT[push.status];
  const text = boxPage
    ? community
      ? { title: COMMUNITY_TEXT.push.insecureTitle, meta: COMMUNITY_TEXT.push.insecureMeta }
      : { title: BOX_PAGE_TEXT.notificationsTitle, meta: BOX_PAGE_TEXT.notifications }
    : push.status === 'off'
      ? { ...base, meta: words.pushOff }
      : push.status === 'unsupported'
        ? { ...base, meta: words.pushUnsupported }
        : base;
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        THIS BROWSER
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <StatusDot
            tone={push.status === 'on' ? 'ok' : push.status === 'denied' ? 'bad' : 'mut'}
            size={8}
            label={null}
          />
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} role="status">
              {text.title}
            </span>
            <span className={styles.rowMeta}>{text.meta}</span>
          </span>
          {boxPage ? null : push.status === 'on' ? (
            <Button variant="secondary" size="sm" onClick={() => void push.disable()}>
              Turn off
            </Button>
          ) : push.status === 'unsupported' ? (
            // A dead end otherwise: the phone app is how this person hears from Whombat.
            <RouterButtonLink variant="secondary" size="sm" to="/settings" search={{ tab: 'phone' } as never}>
              {words.getApp}
            </RouterButtonLink>
          ) : push.status === 'off' || push.status === 'busy' ? (
            <Button
              variant="primary"
              size="sm"
              disabled={push.status === 'busy'}
              onClick={() => void push.enable()}
            >
              Turn on
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
