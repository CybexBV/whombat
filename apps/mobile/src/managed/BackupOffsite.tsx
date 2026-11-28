/**
 * This Whombat → Backups, A COPY SOMEWHERE ELSE (Whombat docs/decisions/offsite-copy.md), the web's section on the
 * phone: without a copy, one line that says why and *Keep a copy somewhere else*, which opens the form in the card;
 * with one, where it is, when it last copied, how many backups it holds, what went wrong and when Whombat tries again,
 * *Copy now*, *Change* and *Stop keeping a copy*. The words and views are `@whombat/client`'s (`offsiteView`,
 * `offsiteInput`), so the web says the same. A box from before doesn't name a copy in its summary: nothing is shown.
 */

import {
  OFFSITE_PRESETS,
  type OffsiteForm,
  offsiteErrorText,
  offsiteFormFrom,
  offsiteInput,
  offsitePlace,
  offsiteText,
  offsiteView,
} from '@whombat/client/managed';
import { useBackupOffsiteActions, useBackupPlaces } from '@whombat/client/react';
import type { ApplianceSession } from '@whombat/client/session';
import { interpolate } from '@whombat/core/i18n';
import type { BackupOffsite } from '@whombat/protocol/session';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';
import { Card, ErrorLine, Field, Note, Row } from './ui';
import { useBackupServiceStatus } from './useBackups';

export function BackupOffsiteCard({ session }: { session: ApplianceSession }) {
  const { rawLocale } = useI18n();
  const W = offsiteText(rawLocale);
  const status = useBackupServiceStatus(session);
  const places = useBackupPlaces(session);
  const actions = useBackupOffsiteActions(session);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const offsite = status.data?.summary.offsite;
  // A box from before (or one whose backup service isn't answering now) doesn't say: nothing to show or offer.
  if (offsite === undefined) return null;
  const placeName = places.data?.places.find((p) => p.id === places.data?.currentPlaceId)?.name ?? null;

  const copyNow = async () => {
    setNote(null);
    try {
      await actions.copyNow.mutateAsync();
      setNote({ text: W.queued, error: false });
    } catch (error) {
      setNote({ text: offsiteErrorText(error, rawLocale), error: true });
    }
  };

  const askRemove = (copy: BackupOffsite) =>
    Alert.alert(
      interpolate(W.removeTitle, { place: offsitePlace(copy) }),
      interpolate(W.removeLead, { place: offsitePlace(copy) }),
      [
        { text: W.form.cancel, style: 'cancel' },
        {
          text: W.removeConfirm,
          style: 'destructive',
          onPress: () => {
            setNote(null);
            actions.remove.mutate(undefined, {
              onError: (e) => setNote({ text: offsiteErrorText(e, rawLocale), error: true }),
            });
          },
        },
      ],
    );

  const form = editing ? (
    <View style={{ padding: 16 }}>
      <OffsiteFormView
        offsite={offsite}
        onCancel={() => setEditing(false)}
        onSave={async (input) => {
          await actions.set.mutateAsync(input);
          setEditing(false);
          setNote(null);
        }}
      />
    </View>
  ) : null;

  if (!offsite)
    return (
      <Card label={W.title}>
        {form ?? (
          <View style={{ padding: 16, gap: 12 }}>
            <Note text={placeName ? interpolate(W.lead, { place: placeName }) : W.leadNoPlace} />
            {note ? note.error ? <ErrorLine text={note.text} /> : <Note text={note.text} /> : null}
            <Button label={W.setUp} variant="secondary" onPress={() => setEditing(true)} />
          </View>
        )}
      </Card>
    );

  const view = offsiteView(offsite, rawLocale);
  return (
    <Card label={W.title}>
      <Row first dot={view.line.dot} title={view.line.text} />
      {view.rows.map((row) => (
        <Row key={row.label} title={row.value} meta={row.label} />
      ))}
      {form ?? (
        <View style={{ padding: 16, gap: 12, borderTopWidth: 1, borderTopColor: 'transparent' }}>
          {view.problem ? <ErrorLine text={view.problem} /> : null}
          {note ? note.error ? <ErrorLine text={note.text} /> : <Note text={note.text} /> : null}
          <Note text={W.sameRule} />
          <Button
            label={actions.copyNow.isPending || !view.canCopy ? W.copyingNow : W.copyNow}
            variant="secondary"
            busy={actions.copyNow.isPending}
            disabled={!view.canCopy}
            onPress={() => void copyNow()}
          />
          <Button label={W.change} variant="secondary" onPress={() => setEditing(true)} />
          <Button label={W.remove} variant="quiet" onPress={() => askRemove(offsite)} />
        </View>
      )}
    </Card>
  );
}

/** The form: the storage, its address, the bucket and the key; checked by the box before it keeps anything. */
function OffsiteFormView({
  offsite,
  onCancel,
  onSave,
}: {
  offsite: BackupOffsite | null;
  onCancel: () => void;
  onSave: (input: NonNullable<ReturnType<typeof offsiteInput>>) => Promise<void>;
}) {
  const { rawLocale } = useI18n();
  const W = offsiteText(rawLocale);
  const [form, setForm] = useState<OffsiteForm>(() => offsiteFormFrom(offsite));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preset = OFFSITE_PRESETS.find((p) => p.provider === form.provider) ?? OFFSITE_PRESETS[0];

  const set = (patch: Partial<OffsiteForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
  };

  const save = async () => {
    const input = offsiteInput(form);
    if (!input) {
      setError(W.form.missing);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(input);
    } catch (err) {
      setError(offsiteErrorText(err, rawLocale));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    name: Exclude<keyof OffsiteForm, 'provider'>,
    label: string,
    options: { secret?: boolean; placeholder?: string; hint?: string; mono?: boolean } = {},
  ) => (
    <Field
      label={label}
      value={form[name]}
      onChangeText={(v) => set({ [name]: v })}
      mono={options.mono}
      {...(options.placeholder ? { placeholder: options.placeholder } : {})}
      {...(options.hint ? { hint: options.hint } : {})}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      secureTextEntry={options.secret}
    />
  );

  return (
    <View style={{ gap: 14 }}>
      <Text size={17} weight={600}>
        {offsite ? W.form.changeTitle : W.form.title}
      </Text>
      <Note text={W.form.lead} />
      <ProviderPicker value={form.provider} onPick={(provider) => set({ provider })} />
      {field('endpoint', W.form.endpoint, {
        placeholder: preset?.endpoint,
        hint: W.form.endpointHint[form.provider],
        mono: true,
      })}
      {field('bucket', W.form.bucket, { mono: true })}
      {field('folder', W.form.folder, { mono: true, hint: W.form.folderHint })}
      {field('accessKeyId', W.form.keyId, { mono: true })}
      {field('secretAccessKey', W.form.secret, { secret: true, hint: W.form.secretHint })}
      {preset?.region !== null || form.region
        ? field('region', W.form.region, {
            placeholder: preset?.region ?? '',
            hint: W.form.regionHint,
            mono: true,
          })
        : null}
      <ErrorLine text={error} />
      <Button label={busy ? W.form.saving : W.form.save} size="lg" busy={busy} onPress={() => void save()} />
      <Button label={W.form.cancel} variant="secondary" disabled={busy} onPress={onCancel} />
    </View>
  );
}

function ProviderPicker({
  value,
  onPick,
}: {
  value: OffsiteForm['provider'];
  onPick: (provider: OffsiteForm['provider']) => void;
}) {
  const { rawLocale } = useI18n();
  const W = offsiteText(rawLocale);
  const theme = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={W.form.provider} style={{ gap: 8 }}>
      {OFFSITE_PRESETS.map((p) => {
        const on = p.provider === value;
        return (
          <Touchable
            key={p.provider}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={W.form.providers[p.provider]}
            onPress={() => onPick(p.provider)}
            ringRadius={14}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              minHeight: 48,
              paddingVertical: 10,
              paddingHorizontal: 14,
              borderRadius: 14,
              borderWidth: 1.5,
              borderColor: on ? theme.colors.ink : theme.colors.line,
              backgroundColor: theme.colors.sf,
            }}
          >
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                borderWidth: on ? 5 : 1.5,
                borderColor: on ? theme.colors.btn : theme.colors.line2,
              }}
            />
            <Text size={15} weight={600}>
              {W.form.providers[p.provider]}
            </Text>
          </Touchable>
        );
      })}
    </View>
  );
}
