/**
 * A guest's Tasks on the phone (proxmox-mobile.md AP-1497): what ran for it, newest first, each with how it went. A
 * task opens its sheet with the log, read again every 2 seconds while it runs, and Stop it while it runs.
 */

import { taskPlatform, taskRows, taskSheetLine, taskStatus, taskWord } from '@whombat/client/hosts/mobile';
import { useHostManageRead, useHostTask } from '@whombat/client/hosts/react';
import type { HostGuestDetail, HostTask } from '@whombat/core';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useI18n, useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard, OneRow, toneOf } from '../../ui/assistant';
import { OneSheet } from '../../ui/oneSheet';
import { ErrorState, SkeletonRows } from '../../ui/primitives';
import { CardQuiet } from './parts';
import { useManageChange } from './useServerChange';

export function GuestTasks({
  slug,
  serverId,
  guest,
  now,
  timeZone,
  canChange,
}: {
  slug: string;
  serverId: string;
  guest: HostGuestDetail;
  now: number;
  timeZone: string;
  canChange: boolean;
}) {
  const { rawLocale, tClient } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const q = useHostManageRead(
    {
      params: { burrow: slug, serverId },
      query: {
        op: 'task.list',
        guestId: guest.id,
        platform: guest.platform === 'incus' ? 'incus' : guest.platform === 'libvirt' ? 'libvirt' : 'pve',
      },
    },
    { retry: false },
  );
  const [open, setOpen] = useState<HostTask | null>(null);
  const rows = q.data?.op === 'task.list' ? taskRows(q.data.items, now, timeZone, rawLocale) : [];
  if (q.isPending) return <SkeletonRows count={4} lines={2} label={tMobile('screens.loading-the-tasks')} />;
  if (q.isError)
    return <ErrorState text={tMobile('screens.the-tasks-didnt-load')} onRetry={() => void q.refetch()} />;
  return (
    <>
      <OneCard label={tClient('workLine.who.tasks')}>
        {rows.length ? (
          rows.map((r) => (
            <OneRow
              key={r.id}
              title={r.title}
              meta={r.line}
              trailing={
                <Text
                  size={12}
                  weight={500}
                  mono
                  color={toneOf(theme, r.status.tone === 'mut' ? null : r.status.tone)}
                >
                  {r.status.text}
                </Text>
              }
              chevron
              label={r.label}
              hint={tMobile('screens.shows-its-log')}
              onPress={() => setOpen(r.task)}
            />
          ))
        ) : (
          <CardQuiet>{tMobile('screens.no-tasks-yet')}</CardQuiet>
        )}
      </OneCard>
      {open ? (
        <TaskSheet
          slug={slug}
          serverId={serverId}
          task={open}
          canStop={canChange}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

/**
 * A task's log, followed every 2 seconds while it runs, with Stop it: a Proxmox task always, an Incus operation or a
 * server's update check when it says it can be cancelled (incus-unraid-mobile.md AP-1627; an Install never, SWU-04).
 */
export function TaskSheet({
  slug,
  serverId,
  task,
  canStop,
  onClose,
  title,
  body,
}: {
  slug: string;
  serverId: string;
  task: HostTask;
  canStop: boolean;
  onClose: () => void;
  /** Its own words instead of the task type's (a server's updates, server-updates-app.md AP-2884). */
  title?: string;
  /** What it says under the title, from the task as read (how a package task ended). */
  body?: (t: HostTask) => string | null;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const q = useHostTask(
    { params: { burrow: slug, serverId, taskId: task.id }, query: { platform: taskPlatform(task.id) } },
    { retry: false, refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false) },
  );
  const t = q.data ?? task;
  const status = taskStatus(t, rawLocale);
  const platform = taskPlatform(t.id);
  const running = t.status === 'running';
  // A Proxmox task always; an Incus operation that says so; a libvirt job (a backup or a copy) unless it says not.
  const stoppable =
    running &&
    canStop &&
    (platform === 'pve' ||
      ((platform === 'incus' || platform === 'host') && !!t.cancellable) ||
      (platform === 'libvirt' && t.cancellable !== false));
  const { send, busy } = useManageChange(serverId);
  const [error, setError] = useState<string | null>(null);
  const log =
    (t.log ?? []).join('\n') ||
    tMobile(platform === 'incus' ? 'screens2.guest.incusNoLog' : 'screens2.guest.noLog');
  return (
    <OneSheet
      visible
      onClose={onClose}
      badge={status.text}
      tone={
        status.tone === 'ok' ? 'ok' : status.tone === 'warn' ? 'warn' : status.tone === 'bad' ? 'bad' : 'mut'
      }
      title={title ?? taskWord(t.type, rawLocale)}
      body={body?.(t) ?? taskSheetLine(t, rawLocale)}
      busy={busy ? 'stop' : null}
      buttons={[
        ...(stoppable
          ? [
              {
                id: 'stop',
                label: tMobile('screens2.run.stopIt'),
                variant: 'secondary' as const,
                onPress: () =>
                  void send({
                    op: 'task.stop',
                    platform: platform === 'pve' ? undefined : platform,
                    params: { task: t.id, platform },
                    name: tMobile('screens2.guest.theTask'),
                  }).then((o) => {
                    if (!o.ok && !o.waiting) setError(o.message);
                  }),
              },
            ]
          : []),
        {
          id: 'close',
          label: tMobile('screens2.common.close'),
          variant: stoppable ? 'quiet' : 'primary',
          onPress: onClose,
        },
      ]}
      note={error}
    >
      <View
        style={{
          marginTop: 14,
          maxHeight: 280,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.bg,
        }}
      >
        <ScrollView nestedScrollEnabled contentContainerStyle={{ padding: 12 }}>
          <Text
            size={12}
            lh={1.5}
            mono
            color={theme.colors.ink2}
            selectable
            accessibilityLabel={tMobile('screens2.guest.log', { log })}
          >
            {log}
          </Text>
        </ScrollView>
      </View>
    </OneSheet>
  );
}
