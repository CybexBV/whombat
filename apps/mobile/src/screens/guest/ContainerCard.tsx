/**
 * A Docker container of an Unraid server or a libvirt VM on its Summary (Whombat incus-unraid.md IU-05, IU-09;
 * incus-unraid-mobile.md AP-1630, AP-1631): whether an update is ready with Update (asked: it restarts on the new
 * version; Docker on Unraid with a dockerMan template), the autostart switch (done at once), and the link to its web
 * page. The switch and Update need the server's Manage switch; this Whombat itself never shows them.
 */

import { unraidChangeWords } from '@whombat/client/hosts';
import { containerView, selfAllowsOp } from '@whombat/client/hosts/mobile';
import type { HostGuestDetail } from '@whombat/core';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { useI18n, useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard } from '../../ui/assistant';
import { OneSheet } from '../../ui/oneSheet';
import { Touchable } from '../../ui/Touchable';
import { RowAction, SettingLine, SwitchLine } from './parts';
import { useManageChange } from './useServerChange';

export function ContainerCard({
  serverId,
  serverName,
  guest: g,
  onUnraid,
  canChange,
}: {
  serverId: string;
  serverName: string;
  guest: HostGuestDetail;
  onUnraid: boolean;
  /** The Manage switch on and this Whombat's runtime can (`hosts.unraid` / `hosts.libvirt`). */
  canChange: boolean;
}) {
  const { tClient } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const v = containerView(g, onUnraid);
  const { send, busy } = useManageChange(serverId);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!v) return null;
  const autostartOk = canChange && selfAllowsOp(g, 'guest.autostart');
  const toggle = (on: boolean) =>
    void send({
      op: 'guest.autostart',
      guestId: g.id,
      params: { on },
      name: g.name,
      done: unraidChangeWords('guest.autostart', serverName, { target: g.name, on }).finished,
    }).then((o) => setError(o.ok || o.waiting ? null : o.message));
  return (
    <OneCard
      label={g.platform === 'docker' ? tMobile('screens.container') : tMobile('screens.virtual-machine')}
    >
      {v.updateText ? (
        <SettingLine
          first
          label={tClient('hosts.agentUpdates.title')}
          value={v.updateText}
          sub={
            g.updateAvailable && !v.canUpdate
              ? 'Update it in Unraid: it has no template Whombat can use.'
              : null
          }
          action={
            canChange && v.canUpdate ? (
              <RowAction
                label={tMobile('screens.update')}
                spoken={`Update ${g.name}`}
                onPress={() => setAsking(true)}
              />
            ) : null
          }
        />
      ) : null}
      {v.autostart !== null ? (
        autostartOk ? (
          <View
            style={{
              paddingHorizontal: 14,
              borderTopWidth: v.updateText ? 1 : 0,
              borderTopColor: theme.colors.line,
            }}
          >
            <SwitchLine label={v.autostartLabel} value={v.autostart} onChange={toggle} disabled={busy} />
          </View>
        ) : (
          <SettingLine first={!v.updateText} label={v.autostartLabel} value={v.autostart ? 'Yes' : 'No'} />
        )
      ) : null}
      {v.webUi ? (
        <Touchable
          onPress={() => void Linking.openURL(v.webUi ?? '')}
          feedback="wash"
          accessibilityRole="link"
          accessibilityLabel={`Open ${g.name}’s web page`}
          accessibilityHint={v.webUi}
          style={{
            minHeight: 52,
            justifyContent: 'center',
            paddingHorizontal: 14,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Text size={15} weight={500} color={theme.colors.brand}>
            {tMobile('screens.open-its-web-page')}
          </Text>
          <Text size={12.5} mono color={theme.colors.mut} numberOfLines={1}>
            {v.webUi}
          </Text>
        </Touchable>
      ) : null}
      {error ? (
        <Text size={13} color={theme.colors.bad} style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
          {error}
        </Text>
      ) : null}
      {asking ? (
        <UpdateSheet serverId={serverId} serverName={serverName} guest={g} onClose={() => setAsking(false)} />
      ) : null}
    </OneCard>
  );
}

/** Update a container: asked, then dockerMan's update runs as a task that says when it ends. */
function UpdateSheet({
  serverId,
  serverName,
  guest,
  onClose,
}: {
  serverId: string;
  serverName: string;
  guest: HostGuestDetail;
  onClose: () => void;
}) {
  const { t: tMobile } = useMobileT();
  const { send, busy } = useManageChange(serverId);
  const [error, setError] = useState<string | null>(null);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={guest.name}
      tone="warn"
      title={`Update ${guest.name}?`}
      body={tMobile('screens.it-stops-gets-the-new-version-and-starts')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: 'Update',
          variant: 'primary',
          onPress: () =>
            void send({
              op: 'container.update',
              guestId: guest.id,
              confirm: true,
              name: serverName,
              follow: { kind: 'container.update', extra: guest.name },
            }).then((o) => {
              if (o.ok || o.waiting) onClose();
              else setError(o.message);
            }),
        },
        { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    />
  );
}
