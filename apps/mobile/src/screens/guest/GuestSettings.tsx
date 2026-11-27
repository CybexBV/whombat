/**
 * A guest's Settings on the phone (proxmox-mobile.md AP-1493, AP-1494): its Proxmox configuration read as it is in five
 * groups (processors, memory, disks, network, options), the everyday edits — name, memory, cores, start with the
 * server, protection, notes, tags — and Grow on a disk. Each edit is a sheet with its field, then the review
 * (“Memory  4 GiB → 8 GiB”) and Apply with the digest of what was reviewed; a change made meanwhile comes back as
 * “Changed meanwhile — review again.” over the review of what is there now. Adding hardware, the firewall rules, HA
 * and replication stay on the web (AP-1367, PX-06), and the screen says so with a link.
 */

import { formatBytesBinary, isEmptyDraft } from '@whombat/client/hosts';
import {
  editDraft,
  editSpec,
  editStart,
  type GuestEditKind,
  growDisk,
  guestSettingGroups,
  reviewLines,
  reviewRestartNote,
} from '@whombat/client/hosts/mobile';
import type { HostGuestConfig, HostGuestDetail } from '@whombat/core';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { mobileTranslator, useI18n, useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard } from '../../ui/assistant';
import { FormField, FormMessage } from '../../ui/formField';
import { OneSheet } from '../../ui/oneSheet';
import { Touchable } from '../../ui/Touchable';
import { ReviewList, RowAction, SettingLine, SwitchLine } from './parts';
import { useManageChange } from './useServerChange';

export function GuestSettings({
  config,
  guest,
  canChange,
  webUrl,
  onEdit,
  onGrow,
}: {
  config: HostGuestConfig;
  guest: HostGuestDetail;
  canChange: boolean;
  /** The guest's page on the web (its Hardware), or null where there is no web (the demo world). */
  webUrl: string | null;
  onEdit: (kind: GuestEditKind) => void;
  onGrow: (disk: string) => void;
}) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const groups = guestSettingGroups(config, guest.name, rawLocale);
  return (
    <>
      {groups.map((group) => (
        <OneCard key={group.id} label={group.title}>
          {group.rows.map((r, i) => {
            const edit = r.edit;
            const grow = r.grow;
            return (
              <SettingLine
                key={r.id}
                first={i === 0}
                label={r.label}
                value={r.value}
                sub={r.locked ? tMobile('screens2.guest.changeInProxmox') : r.sub}
                mono={r.mono}
                action={
                  canChange && edit ? (
                    <RowAction
                      label={tMobile('screens.change')}
                      spoken={tMobile('screens2.guest.changeX', { what: r.label.toLowerCase() })}
                      onPress={() => onEdit(edit)}
                    />
                  ) : canChange && grow ? (
                    <RowAction
                      label={tMobile('screens.grow')}
                      spoken={tMobile('screens2.guest.growX', { what: r.label })}
                      onPress={() => onGrow(grow)}
                    />
                  ) : null
                }
              />
            );
          })}
        </OneCard>
      ))}
      {webUrl ? (
        <Touchable
          onPress={() => void Linking.openURL(webUrl)}
          feedback="fade"
          accessibilityRole="link"
          accessibilityLabel={tMobile('screens2.guest.webOnly')}
          accessibilityHint={tMobile('screens.opens-whombat-on-the-web')}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text size={13.5} lh={1.45} color={theme.colors.brand}>
            {tMobile('screens2.guest.webOnly')}
          </Text>
        </Touchable>
      ) : (
        <Text size={13.5} lh={1.45} color={theme.colors.mut}>
          {tMobile('screens2.guest.webOnly')}
        </Text>
      )}
    </>
  );
}

/** One everyday edit: its field, then the review, then Apply with the digest. */
export function EditSheet({
  serverId,
  guest,
  config,
  kind,
  onClose,
}: {
  serverId: string;
  guest: HostGuestDetail;
  config: HostGuestConfig;
  kind: GuestEditKind;
  onClose: () => void;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const spec = editSpec(kind, guest.name, rawLocale);
  const [input, setInput] = useState(() => editStart(config, kind));
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  // Against the configuration as it is now: after “Changed meanwhile” the review shows the new old values.
  const { draft, error: checkError } = editDraft(config, kind, input, rawLocale);
  const empty = !draft || isEmptyDraft(draft);
  const lines = draft ? reviewLines(config, draft, rawLocale) : [];

  const apply = async () => {
    if (!draft || empty) return;
    setError(null);
    setNotice(null);
    const out = await send({
      op: 'config.set',
      guestId: guest.id,
      params: draft as Record<string, unknown>,
      digest: config.digest,
      name: guest.name,
    });
    if (out.ok || out.waiting) return onClose();
    if (out.conflict) setNotice(mobileTranslator(rawLocale).t('screens2.guest.changedMeanwhile'));
    else if (Object.keys(out.fields).length) {
      setFieldError(Object.values(out.fields).join(' '));
      setStep('edit');
    } else setError(out.message);
  };

  if (step === 'review')
    return (
      <OneSheet
        visible
        onClose={() => !busy && onClose()}
        title={spec.title}
        busy={busy ? 'apply' : null}
        buttons={[
          {
            id: 'apply',
            label: tMobile('screens2.common.apply'),
            variant: 'primary',
            disabled: empty,
            onPress: () => void apply(),
          },
          {
            id: 'back',
            label: tMobile('screens2.common.back'),
            variant: 'quiet',
            onPress: () => setStep('edit'),
          },
        ]}
        note={error}
      >
        {notice ? (
          <View style={{ marginTop: 12 }}>
            <FormMessage text={notice} />
          </View>
        ) : null}
        <ReviewList lines={lines} note={reviewRestartNote(config, rawLocale)} />
      </OneSheet>
    );

  return (
    <OneSheet
      visible
      onClose={onClose}
      title={spec.title}
      buttons={[
        {
          id: 'review',
          label: tMobile('screens2.common.review'),
          variant: 'primary',
          disabled: empty,
          onPress: () => {
            setFieldError(null);
            setStep('review');
          },
        },
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
      note={draft && empty ? tMobile('screens2.guest.nothingChanged') : null}
    >
      <View style={{ marginTop: 16 }}>
        {spec.kind === 'switch' ? (
          <SwitchLine label={spec.field} value={input.on} onChange={(on) => setInput({ ...input, on })} />
        ) : (
          <FormField
            label={spec.field}
            value={input.text}
            onChangeText={(text) => setInput({ ...input, text })}
            error={fieldError ?? (input.text.trim() || kind === 'name' ? checkError : null)}
            hint={spec.hint}
            multiline={spec.kind === 'multiline'}
            mono={kind === 'name' || kind === 'tags'}
            keyboardType={spec.kind === 'number' ? 'number-pad' : 'default'}
            autoCapitalize={kind === 'description' ? 'sentences' : 'none'}
            autoCorrect={kind === 'description'}
            autoFocus
          />
        )}
      </View>
    </OneSheet>
  );
}

/** Grow a disk: by how many GB, then the review of its size now and after; disks only grow. */
export function GrowSheet({
  serverId,
  guest,
  config,
  disk,
  onClose,
}: {
  serverId: string;
  guest: HostGuestDetail;
  config: HostGuestConfig;
  disk: string;
  onClose: () => void;
}) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const [add, setAdd] = useState('8');
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const grow = growDisk(config, disk, add, rawLocale);
  const title = tMobile('screens2.guest.growDisk', { disk, name: guest.name });

  const apply = async () => {
    if (!grow.params) return;
    setError(null);
    setNotice(null);
    const out = await send({ op: 'disk.resize', guestId: guest.id, params: grow.params, name: guest.name });
    if (out.ok || out.waiting) return onClose();
    if (out.conflict) setNotice(mobileTranslator(rawLocale).t('screens2.guest.changedMeanwhile'));
    else setError(out.message);
  };

  if (step === 'review')
    return (
      <OneSheet
        visible
        onClose={() => !busy && onClose()}
        title={title}
        busy={busy ? 'apply' : null}
        buttons={[
          {
            id: 'apply',
            label: tMobile('screens2.common.grow'),
            variant: 'primary',
            disabled: !grow.params,
            onPress: () => void apply(),
          },
          {
            id: 'back',
            label: tMobile('screens2.common.back'),
            variant: 'quiet',
            onPress: () => setStep('edit'),
          },
        ]}
        note={error}
      >
        {notice ? (
          <View style={{ marginTop: 12 }}>
            <FormMessage text={notice} />
          </View>
        ) : null}
        <ReviewList lines={grow.line ? [grow.line] : []} note={tMobile('screens2.guest.growNote')} />
      </OneSheet>
    );

  return (
    <OneSheet
      visible
      onClose={onClose}
      title={title}
      body={
        grow.now != null
          ? tMobile('screens2.guest.disksOnlyGrowNow', { size: formatBytesBinary(grow.now) })
          : tMobile('screens2.guest.disksOnlyGrow')
      }
      buttons={[
        {
          id: 'review',
          label: tMobile('screens2.common.review'),
          variant: 'primary',
          disabled: !grow.params,
          onPress: () => setStep('review'),
        },
        { id: 'cancel', label: tMobile('screens2.common.cancel'), variant: 'quiet', onPress: onClose },
      ]}
    >
      <View style={{ marginTop: 16 }}>
        <FormField
          label={tMobile('screens.add-gb')}
          value={add}
          onChangeText={setAdd}
          error={add.trim() ? grow.error : null}
          hint={
            grow.after != null
              ? tMobile('screens2.guest.then', { size: formatBytesBinary(grow.after) })
              : null
          }
          keyboardType="number-pad"
          autoFocus
        />
      </View>
    </OneSheet>
  );
}
