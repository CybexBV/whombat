/**
 * An Incus instance's Settings on the phone (Whombat incus-unraid.md IU-09; incus-unraid-mobile.md AP-1621, AP-1622):
 * its configuration read in six groups (Resources, Boot, Security, Snapshots, Notes, Profiles), the everyday edits —
 * memory, processors, start with the server, protection, notes and the snapshot schedule — each a sheet with its
 * field, then the review in words (“Memory  4 GiB → 8 GiB”) and Apply with the ETag it was read with; “Changed
 * meanwhile — review again.” over the review of what is there now. Devices, profiles, images, volumes, networks and
 * moving stay on the web, and the screen says so with a link.
 */
import { CHANGED_MEANWHILE, isEmptyDraft } from '@whombat/client/hosts';
import {
  expiryChoices,
  INCUS_WEB_ONLY,
  type IncusEditKind,
  incusEditDraft,
  incusEditSpec,
  incusEditStart,
  incusReviewLines,
  incusReviewNote,
  incusSettingGroups,
  scheduleChoices,
} from '@whombat/client/hosts/mobile';
import type { HostGuestConfig, HostGuestDetail } from '@whombat/core';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard } from '../../ui/assistant';
import { FormField, FormMessage } from '../../ui/formField';
import { OneSheet } from '../../ui/oneSheet';
import { Touchable } from '../../ui/Touchable';
import { Choices, ReviewList, RowAction, SettingLine, SwitchLine } from './parts';
import { useManageChange } from './useServerChange';

export function IncusSettings({
  config,
  canChange,
  webUrl,
  onEdit,
}: {
  config: HostGuestConfig;
  canChange: boolean;
  /** The guest's page on the web, or null where there is no web (the demo world). */
  webUrl: string | null;
  onEdit: (kind: IncusEditKind) => void;
}) {
  return (
    <>
      {incusSettingGroups(config).map((group) => (
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
                      label="Change"
                      spoken={`Change ${r.label.toLowerCase()}`}
                      onPress={() => onEdit(edit)}
                    />
                  ) : null
                }
              />
            );
          })}
        </OneCard>
      ))}
      <WebLine text={INCUS_WEB_ONLY} url={webUrl} />
    </>
  );
}

/** What stays on the web, as a line; a link where there is a web to open. */
export function WebLine({ text, url }: { text: string; url: string | null }) {
  const theme = useTheme();
  if (!url)
    return (
      <Text size={13.5} lh={1.45} color={theme.colors.mut}>
        {text}
      </Text>
    );
  return (
    <Touchable
      onPress={() => void Linking.openURL(url)}
      feedback="fade"
      accessibilityRole="link"
      accessibilityLabel={text}
      accessibilityHint="Opens whombat on the web"
      style={{ minHeight: 44, justifyContent: 'center' }}
    >
      <Text size={13.5} lh={1.45} color={theme.colors.brand}>
        {text}
      </Text>
    </Touchable>
  );
}

/** One everyday edit of an Incus instance: its field (or the schedule's choices), the review, then Apply. */
export function IncusEditSheet({
  serverId,
  guest,
  config,
  kind,
  onClose,
}: {
  serverId: string;
  guest: HostGuestDetail;
  config: HostGuestConfig;
  kind: IncusEditKind;
  onClose: () => void;
}) {
  const spec = incusEditSpec(kind, guest.name);
  const [input, setInput] = useState(() => incusEditStart(config, kind));
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManageChange(serverId);
  // Against the configuration as it is now: after “Changed meanwhile” the review shows the new old values.
  const { draft, error: checkError } = incusEditDraft(config, kind, input);
  const empty = !draft || isEmptyDraft(draft);
  const lines = draft ? incusReviewLines(config, draft) : [];
  const fromProfile = kind === 'schedule' && !!config.inherited?.includes('snapshots.schedule');

  const apply = async () => {
    if (!draft || empty) return;
    setError(null);
    setNotice(null);
    const out = await send({
      op: 'config.set',
      guestId: guest.id,
      platform: 'incus',
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
        <ReviewList lines={lines} note={draft ? incusReviewNote(config, draft) : null} />
      </OneSheet>
    );

  return (
    <OneSheet
      visible
      onClose={onClose}
      title={spec.title}
      body={
        fromProfile
          ? `The schedule now comes from a profile; what you pick here is for ${guest.name} alone.`
          : null
      }
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
      <View style={{ marginTop: 16, gap: 16 }}>
        {spec.kind === 'switch' ? (
          <SwitchLine label={spec.field} value={input.on} onChange={(on) => setInput({ ...input, on })} />
        ) : spec.kind === 'schedule' ? (
          <>
            <Choices
              label={spec.field}
              options={scheduleChoices(config)}
              value={input.schedule}
              onChange={(schedule) => setInput({ ...input, schedule })}
            />
            {input.schedule ? (
              <Choices
                label="Keep them"
                options={expiryChoices(config)}
                value={input.expiry}
                onChange={(expiry) => setInput({ ...input, expiry })}
              />
            ) : null}
          </>
        ) : (
          <FormField
            label={spec.field}
            value={input.text}
            onChangeText={(text) => setInput({ ...input, text })}
            error={fieldError ?? checkError}
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
