/**
 * A libvirt VM's Settings on the phone (Whombat incus-unraid.md IU-13; incus-unraid-mobile.md AP-1645): its
 * configuration read in groups (processors, memory, CD/DVD, disks, network, options, firmware), the everyday edits —
 * vCPUs, memory, start with the server, notes, and the ISO in a CD/DVD drive (it changes while the VM runs) — each a
 * sheet with its field, then the review in words and Apply with the digest it was read with; “Changed meanwhile —
 * review again.” over the review of what is there now. Hardware stays on the web, and the screen says so.
 */

import { CHANGED_MEANWHILE, isEmptyDraft } from '@whombat/client/hosts';
import {
  isoChoices,
  LIBVIRT_WEB_ONLY,
  type LibvirtEditKind,
  libvirtEditDraft,
  libvirtEditSpec,
  libvirtEditStart,
  libvirtReviewLines,
  libvirtReviewNote,
  libvirtSettingGroups,
} from '@whombat/client/hosts/mobile';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostGuestConfig, HostGuestDetail } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useMobileT } from '../../i18n';
import { OneCard } from '../../ui/assistant';
import { FormField, FormMessage } from '../../ui/formField';
import { OneSheet } from '../../ui/oneSheet';
import { QuietText } from '../../ui/primitives';
import { WebLine } from './IncusSettings';
import { Choices, ReviewList, RowAction, SettingLine, SwitchLine } from './parts';
import { useManageChange } from './useServerChange';

export function LibvirtSettings({
  config,
  canChange,
  webUrl,
  onEdit,
}: {
  config: HostGuestConfig;
  canChange: boolean;
  webUrl: string | null;
  /** An edit, with the CD/DVD drive it changes. */
  onEdit: (kind: LibvirtEditKind, key?: string) => void;
}) {
  const { t: tMobile } = useMobileT();
  return (
    <>
      {libvirtSettingGroups(config).map((group) => (
        <OneCard key={group.id} label={group.title}>
          {group.rows.map((r, i) => {
            const edit = r.edit;
            return (
              <SettingLine
                key={r.id}
                first={i === 0}
                label={r.label}
                value={r.value}
                sub={r.sub}
                mono={r.mono}
                action={
                  canChange && edit ? (
                    <RowAction
                      label={tMobile('screens.change')}
                      spoken={`Change ${r.label.toLowerCase()}`}
                      onPress={() => onEdit(edit, r.key)}
                    />
                  ) : null
                }
              />
            );
          })}
        </OneCard>
      ))}
      <WebLine text={LIBVIRT_WEB_ONLY} url={webUrl} />
    </>
  );
}

/** One everyday edit of a libvirt VM: its field (an ISO from the server's list for a CD/DVD), the review, Apply. */
export function LibvirtEditSheet({
  serverId,
  guest,
  config,
  kind,
  cdrom,
  onClose,
}: {
  serverId: string;
  guest: HostGuestDetail;
  config: HostGuestConfig;
  kind: LibvirtEditKind;
  /** The CD/DVD drive (`cdrom0`) of an ISO edit. */
  cdrom?: string;
  onClose: () => void;
}) {
  const { t: tMobile } = useMobileT();
  const { slug } = useBurrowBase();
  const spec = libvirtEditSpec(kind, guest.name, config);
  const [input, setInput] = useState(() => libvirtEditStart(config, kind, cdrom));
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  const choices = useHostManageRead(
    kind === 'cdrom'
      ? { params: { burrow: slug, serverId }, query: { op: 'choices', platform: 'libvirt' } }
      : null,
    { retry: false },
  );
  const isos =
    choices.data?.op === 'choices'
      ? isoChoices(choices.data.choices.isos, libvirtEditStart(config, 'cdrom', cdrom).iso)
      : null;
  const { draft, error: checkError } = libvirtEditDraft(config, kind, input, cdrom);
  const empty = !draft || isEmptyDraft(draft);
  const lines = draft ? libvirtReviewLines(config, draft) : [];

  const apply = async () => {
    if (!draft || empty) return;
    setError(null);
    setNotice(null);
    const out = await send({
      op: 'config.set',
      guestId: guest.id,
      platform: 'libvirt',
      params: draft as Record<string, unknown>,
      digest: config.digest,
      name: guest.name,
    });
    if (out.ok || out.waiting) return onClose();
    if (out.conflict) setNotice(CHANGED_MEANWHILE);
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
          { id: 'apply', label: 'Apply', variant: 'primary', disabled: empty, onPress: () => void apply() },
          { id: 'back', label: 'Back', variant: 'quiet', onPress: () => setStep('edit') },
        ]}
        note={error}
      >
        {notice ? (
          <View style={{ marginTop: 12 }}>
            <FormMessage text={notice} />
          </View>
        ) : null}
        <ReviewList lines={lines} note={draft ? libvirtReviewNote(config, draft) : null} />
      </OneSheet>
    );

  return (
    <OneSheet
      visible
      onClose={onClose}
      title={spec.title}
      body={kind === 'cdrom' ? tMobile('screens.it-changes-at-once-also-while-it-runs') : null}
      buttons={[
        {
          id: 'review',
          label: 'Review',
          variant: 'primary',
          disabled: empty,
          onPress: () => {
            setFieldError(null);
            setStep('review');
          },
        },
        { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
      ]}
      note={draft && empty ? 'Nothing changed yet.' : null}
    >
      <View style={{ marginTop: 16 }}>
        {spec.kind === 'switch' ? (
          <SwitchLine label={spec.field} value={input.on} onChange={(on) => setInput({ ...input, on })} />
        ) : spec.kind === 'iso' ? (
          isos ? (
            <Choices
              label={spec.field}
              options={isos}
              value={input.iso}
              onChange={(iso) => setInput({ ...input, iso })}
            />
          ) : (
            <QuietText>{tMobile('screens.looking-for-iso-images')}</QuietText>
          )
        ) : (
          <FormField
            label={spec.field}
            value={input.text}
            onChangeText={(text) => setInput({ ...input, text })}
            error={fieldError ?? (input.text.trim() ? checkError : null)}
            hint={spec.hint}
            multiline={spec.kind === 'multiline'}
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
