/**
 * What needs a look on a server (its open alerts, a tab's hints) as notices: the alert's own words, then “Look into
 * it” (a chat with Whombat about it, in the Ask pane) for a problem only, and the ⋯ menu (Ignore, Remind me tomorrow,
 * Stop watching); quiet ones greyed with who quieted them until when and Undo, or End now while the server is kept quiet
 * (Whombat quiet-notices.md
 * QN-02, QN-10, QN-14, QN-23; AP-4828). On a Whombat without `things.quiet` an alert keeps “Remind me tomorrow”, the
 * hosts service's acknowledgement for a day, as before (ONE-07).
 */
import { useQueryClient } from '@tanstack/react-query';
import { type QuietLine, quietLineText } from '@whombat/client';
import type { WatchRowView } from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { queryKeys } from '@whombat/client/query';
import { type QuietActions, useApiMutation } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import { AlertTriangle, Info } from 'lucide-react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { useChangeRunner } from '../parts';
import { NoticeMenu, QuietUndo } from '../quiet/NoticeMenu';
import quietStyles from '../quiet/Quiet.module.css';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';

/** A row as the ⋯ menu and Undo read it. */
function lineOf(r: WatchRowView): QuietLine {
  return {
    title: r.title,
    tone: r.tone === 'bad' ? 'bad' : r.tone === 'warn' ? 'warn' : 'info',
    ...(r.nature ? { nature: r.nature } : {}),
    ...(r.check ? { check: r.check } : {}),
    ...(r.subject ? { subject: r.subject } : {}),
    ...(r.ignore ? { ignore: r.ignore } : {}),
    ...(r.quiet ? { quiet: r.quiet } : {}),
  };
}

export function WatchNotices({
  burrow,
  rows,
  subject,
  quiet,
  onEnd = null,
  ending = false,
}: {
  burrow: string;
  rows: readonly WatchRowView[];
  /** The server the chat is about (default: the alert's). */
  subject?: { id: string; name: string };
  /** Ignore, Remind me tomorrow, Stop watching and Undo (a Whombat with `things.quiet`); none: as before. */
  quiet?: QuietActions | null;
  /** End now on a line held because the server is kept quiet: it ends the whole window (`things.endQuiet`). */
  onEnd?: (() => void) | null;
  ending?: boolean;
}) {
  const [, set] = useThingSearch();
  const ack = useHostsChange(api.hosts.ackAlert);
  const start = useApiMutation(api.chats.start);
  const qc = useQueryClient();
  const { run, busy } = useChangeRunner();
  if (!rows.length) return null;
  const lookInto = async (r: WatchRowView) => {
    const serverId = subject?.id ?? r.alert?.serverId ?? undefined;
    const out = await run(
      () =>
        start.mutateAsync({
          params: { burrow },
          body: {
            text: `${r.title}. Can you look into it?`,
            ...(serverId
              ? { subject: { kind: 'server', id: serverId, name: subject?.name ?? serverId } }
              : {}),
          },
        }),
      null,
    );
    if (out.ok) {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.list') });
      set({ ask: undefined, chat: out.data.conversation.id }, { replace: true });
    }
  };
  return (
    <>
      {rows.map((r) => {
        const line = lineOf(r);
        const greyed = quietLineText(line);
        // Only a problem asks (QN-02): an alert as before, a hint once it says it is one.
        const ask = !greyed && (r.nature ? r.nature === 'problem' : !!r.alert);
        return (
          <div
            key={r.id}
            className={cx(
              styles.notice,
              greyed ? quietStyles.quietLine : null,
              !greyed && r.tone === 'bad' ? styles.noticeBad : null,
              !greyed && r.tone === 'warn' ? styles.noticeWarn : null,
            )}
            role={r.tone === 'bad' && !greyed ? 'alert' : undefined}
            data-quiet={greyed ? r.quiet?.state : undefined}
          >
            <span
              className={cx(
                styles.noticeIcon,
                greyed
                  ? quietStyles.quietIcon
                  : r.tone === 'bad'
                    ? styles.noticeIconBad
                    : r.tone === 'warn'
                      ? styles.noticeIconWarn
                      : styles.noticeIconMut,
              )}
              aria-hidden="true"
            >
              <Icon icon={r.tone === 'mut' || greyed ? Info : AlertTriangle} size={16} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{r.title}</b>
              <p>{greyed ?? r.detail}</p>
              {ask || (!quiet && r.alert && !r.alert.acknowledged) ? (
                <div className={styles.noticeActs}>
                  {ask ? (
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void lookInto(r)}>
                      Look into it
                    </Button>
                  ) : null}
                  {!quiet && r.alert && !r.alert.acknowledged ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            ack.mutateAsync({
                              params: { burrow, alertId: r.alert?.id ?? '' },
                              body: { minutes: 24 * 60 },
                            }),
                          'I’ll remind you tomorrow.',
                        )
                      }
                    >
                      Remind me tomorrow
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {greyed ? (
              <QuietUndo line={line} actions={quiet} onEnd={onEnd} ending={ending} />
            ) : (
              <NoticeMenu line={line} actions={quiet} />
            )}
          </div>
        );
      })}
    </>
  );
}
