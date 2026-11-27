/**
 * Backup options on the phone (Whombat backup-options.md BKO-01…05; backup-options-android.md AP-6853): Cancel · Backup
 * options · Save over the summary of what the choice costs (`policySummary`), HOW OFTEN (a segmented control and what
 * each loses at most), HOW LONG TO KEEP THEM (Up to a year, recommended, with its timeline; Everything for 90 days;
 * Choose… with four numbers), SPACE (a limit in GB, off at first) and CHECKING (the weekly check). Save sends every
 * option at once (`backup.setPolicy`) and goes back.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BACKUP_OPTIONS_TEXT, keepTicks, policySummary } from '@whombat/client/managed';
import { useBackupCheckpoints, useBackupPolicy, useSetBackupPolicy } from '@whombat/client/react';
import { formatBytes } from '@whombat/core/text';
import type { BackupFrequency } from '@whombat/protocol/session';
import { type ReactNode, useEffect, useState } from 'react';
import { ScrollView, Switch, TextInput, View } from 'react-native';
import { useI18n } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { tint } from '../ui/glanceColors';
import { Screen } from '../ui/headers';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { ErrorState, Loading, SectionLabel } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { useBottomRoom } from '../ui/screenBottom';
import { switchColors } from '../ui/switchColors';
import { Touchable } from '../ui/Touchable';
import { backupErrorText } from './BackupDestination';
import { Tag } from './BackupsOverview';
import { draftInput, draftKeep, type KeepChoice, type PolicyDraft, policyDraft } from './backupOptions';
import { managedText } from './copy';
import { ErrorLine } from './ui';
import { useBackupPlaceName, useBackupSession } from './useBackups';

type Props = NativeStackScreenProps<RootStackParamList, 'BackupOptions'>;

const D = BACKUP_OPTIONS_TEXT.dialog;
const FREQUENCIES: BackupFrequency[] = ['nightly', '6h', 'hourly'];

export function BackupOptionsScreen({ navigation }: Props) {
  const { rawLocale } = useI18n();
  const managedTextHere = managedText(rawLocale);

  const theme = useTheme();
  const bottomRoom = useBottomRoom();
  const session = useBackupSession();
  const policy = useBackupPolicy(session);
  const list = useBackupCheckpoints(session);
  const placeName = useBackupPlaceName(session);
  const save = useSetBackupPolicy(session);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (policy.data && !draft) setDraft(policyDraft(policy.data.policy));
  }, [policy.data, draft]);
  const close = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('WhombatBackups'));

  const onSave = () => {
    if (!draft) return;
    const r = draftInput(draft);
    if ('error' in r) {
      setError(r.error);
      return;
    }
    setError(null);
    save.mutate(r.input, { onSuccess: close, onError: (e) => setError(backupErrorText(e)) });
  };

  const header = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 8,
        minHeight: 52,
      }}
    >
      <HeaderButton label={D.cancel} onPress={close} />
      <Text size={16} weight={600} accessibilityRole="header">
        {D.title}
      </Text>
      <HeaderButton
        label={save.isPending ? D.saving : D.save}
        strong
        disabled={!draft || save.isPending}
        onPress={onSave}
      />
    </View>
  );

  if (!session || policy.isError)
    return (
      <Screen>
        {header}
        <ErrorState text={managedTextHere.loadError} onRetry={() => void policy.refetch()} />
      </Screen>
    );
  if (!draft || !policy.data)
    return (
      <Screen>
        {header}
        <Loading />
      </Screen>
    );

  const set = (patch: Partial<PolicyDraft>) => setDraft({ ...draft, ...patch });
  const keep = draftKeep(draft);
  const ticks = keep ? keepTicks(keep) : [];
  const limitGb = Number(draft.limitGb.replace(',', '.'));
  const lastDrill = list.data?.checkpoints.find((c) => c.check)?.check ?? null;
  const keepOptions: { value: KeepChoice; title: string; meta?: string; tag?: string }[] = [
    { value: 'year', title: D.keepYear, meta: D.keepYearMeta, tag: D.recommended },
    { value: 'days90', title: D.keep90, meta: D.keep90Meta },
    { value: 'custom', title: D.keepChoose },
  ];

  return (
    <Screen>
      {header}
      <KeyboardAvoidingView style={{ flex: 1 }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 + bottomRoom, gap: 6 }}
        >
          {keep ? (
            <View
              style={{
                borderRadius: 14,
                padding: 14,
                backgroundColor: tint(theme.colors.ok, 0.12),
                marginBottom: 8,
              }}
            >
              <Text size={15} lh={1.45} color={theme.colors.ink}>
                {policySummary(keep, list.data ?? null, placeName)}
              </Text>
            </View>
          ) : null}

          <SectionLabel>{D.howOften.toUpperCase()}</SectionLabel>
          <Segmented
            label={D.howOften}
            options={FREQUENCIES.map((f) => ({ value: f, label: D.frequency[f] }))}
            value={draft.frequency}
            onChange={(frequency) => set({ frequency })}
          />
          <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6, paddingTop: 4 }}>
            {D.frequencyHint[draft.frequency]}
          </Text>

          <View style={{ height: 8 }} />
          <SectionLabel>{D.howLong.toUpperCase()}</SectionLabel>
          <Group>
            <View accessibilityRole="radiogroup" accessibilityLabel={D.howLong}>
              {keepOptions.map((o, i) => {
                const selected = draft.keep === o.value;
                return (
                  <View key={o.value}>
                    <Touchable
                      feedback="wash"
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected, selected }}
                      accessibilityLabel={[o.title, o.tag, o.meta].filter(Boolean).join('. ')}
                      onPress={() => set({ keep: o.value })}
                      style={{
                        flexDirection: 'row',
                        gap: 12,
                        minHeight: 52,
                        paddingVertical: 13,
                        paddingHorizontal: 14,
                        borderTopWidth: i === 0 ? 0 : 1,
                        borderTopColor: theme.colors.line,
                      }}
                    >
                      <Radio on={selected} />
                      <View style={{ flex: 1, gap: 3 }}>
                        <View
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                        >
                          <Text size={15.5} weight={600}>
                            {o.title}
                          </Text>
                          {o.tag ? <Tag text={o.tag} /> : null}
                        </View>
                        {o.meta ? (
                          <Text size={13} lh={1.45} color={theme.colors.mut}>
                            {o.meta}
                          </Text>
                        ) : null}
                      </View>
                    </Touchable>
                    {o.value === 'year' && ticks.length > 0 ? <Timeline ticks={ticks} /> : null}
                  </View>
                );
              })}
            </View>
            {draft.keep === 'custom' ? (
              <View style={{ padding: 14, paddingTop: 0, gap: 10 }}>
                {(['allDays', 'dailyDays', 'weeklyWeeks', 'monthlyMonths'] as const).map((k) => (
                  <NumberField
                    key={k}
                    label={D.keepFields[k]}
                    value={draft.custom[k]}
                    onChange={(v) => set({ custom: { ...draft.custom, [k]: v } })}
                  />
                ))}
              </View>
            ) : null}
          </Group>
          {policy.data.clearedBy === 'none' ? (
            <Text
              size={13}
              lh={1.45}
              color={theme.colors.mut}
              style={{ paddingHorizontal: 6, paddingTop: 4 }}
            >
              {D.clearedByNone}
            </Text>
          ) : null}

          <View style={{ height: 8 }} />
          <SectionLabel>{D.space.toUpperCase()}</SectionLabel>
          <Group>
            <ToggleRow
              title={D.limit}
              meta={
                draft.limitOn
                  ? Number.isFinite(limitGb) && limitGb > 0
                    ? D.limitOn(formatBytes(limitGb * 1e9, rawLocale))
                    : D.limitOffPlain
                  : D.limitOff(
                      placeName,
                      list.data?.space?.freeBytes == null
                        ? null
                        : formatBytes(list.data.space.freeBytes, rawLocale),
                    )
              }
              value={draft.limitOn}
              onChange={(limitOn) =>
                set({
                  limitOn,
                  ...(limitOn && !draft.limitGb && { limitGb: suggestedGb(list.data?.space?.usedBytes) }),
                })
              }
            />
            {draft.limitOn ? (
              <View style={{ padding: 14, paddingTop: 0 }}>
                <NumberField
                  label={D.limitGb}
                  value={draft.limitGb}
                  onChange={(limitGb) => set({ limitGb })}
                  decimal
                />
              </View>
            ) : null}
          </Group>

          <View style={{ height: 8 }} />
          <SectionLabel>{D.checking.toUpperCase()}</SectionLabel>
          <Group>
            <ToggleRow
              title={D.weeklyCheck}
              meta={D.weeklyCheckMeta(
                lastDrill
                  ? lastDrill.ok
                    ? D.lastGood(weekday(lastDrill.at))
                    : D.lastBad(weekday(lastDrill.at))
                  : null,
              )}
              value={draft.weeklyCheck}
              onChange={(weeklyCheck) => set({ weeklyCheck })}
            />
          </Group>
          <View style={{ paddingTop: 8 }}>
            <ErrorLine text={error} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** Twice what the backups take now, at least 10 GB: a start for the field. */
function suggestedGb(used: number | null | undefined): string {
  return String(Math.max(10, Math.ceil(((used ?? 0) * 2) / 1e9)));
}

function weekday(iso: string): string {
  return (
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(iso).getDay()] ??
    ''
  );
}

function HeaderButton({
  label,
  onPress,
  strong = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  strong?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      feedback="wash"
      ringRadius={10}
      style={{
        minHeight: 44,
        minWidth: 64,
        justifyContent: 'center',
        paddingHorizontal: 10,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        size={16}
        weight={strong ? 600 : 400}
        color={theme.colors.brand}
        style={{ textAlign: strong ? 'right' : 'left' }}
      >
        {label}
      </Text>
    </Touchable>
  );
}

function Group({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}

function Radio({ on }: { on: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: 22,
        height: 22,
        marginTop: 1,
        borderRadius: 11,
        borderWidth: on ? 7 : 1.5,
        borderColor: on ? theme.colors.btn : theme.colors.line2,
      }}
    />
  );
}

/** The picture of what is kept: ticks denser towards now, the four labels under them. */
function Timeline({ ticks }: { ticks: { at: number; tall: boolean }[] }) {
  const theme = useTheme();
  const L = D.timeline;
  return (
    <View
      accessible
      accessibilityLabel={`${L.yearAgo}, ${L.months}, ${L.weeks}, ${L.now}`}
      style={{ paddingHorizontal: 18, paddingBottom: 14 }}
    >
      <View style={{ height: 20, borderBottomWidth: 1, borderBottomColor: theme.colors.line2 }}>
        {ticks.map((t) => (
          <View
            key={t.at}
            style={{
              position: 'absolute',
              bottom: 0,
              left: `${t.at * 100}%`,
              width: 1.5,
              height: t.tall ? 18 : 12,
              backgroundColor: t.tall ? theme.colors.ink2 : theme.colors.mut,
            }}
          />
        ))}
      </View>
      <View style={{ height: 18, marginTop: 4 }}>
        {(
          [
            [L.yearAgo, 0],
            [L.months, 38],
            [L.weeks, 62],
            [L.now, 100],
          ] as const
        ).map(([label, at]) => (
          <Text
            key={label}
            size={11}
            mono
            color={theme.colors.mut}
            style={{
              position: 'absolute',
              width: 80,
              ...(at === 0
                ? { left: 0 }
                : at === 100
                  ? { right: 0, textAlign: 'right' }
                  : { left: `${at}%`, marginLeft: -40, textAlign: 'center' }),
            }}
          >
            {label}
          </Text>
        ))}
      </View>
    </View>
  );
}

function ToggleRow({
  title,
  meta,
  value,
  onChange,
}: {
  title: string;
  meta: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, padding: 14 }}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text size={15.5} weight={500}>
          {title}
        </Text>
        <Text size={13} lh={1.45} color={theme.colors.mut}>
          {meta}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={title}
        {...switchColors(theme, value)}
      />
    </View>
  );
}

function NumberField({
  label,
  value,
  onChange,
  decimal = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  decimal?: boolean;
}) {
  const theme = useTheme();
  const metrics = textMetrics({ size: 16, family: 'mono' });
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text size={14} color={theme.colors.ink2} style={{ flex: 1 }}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        accessibilityLabel={label}
        keyboardType={decimal ? 'decimal-pad' : 'number-pad'}
        selectionColor={theme.colors.brand}
        style={{
          width: 96,
          minHeight: 44,
          paddingHorizontal: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.line2,
          backgroundColor: theme.colors.sf,
          color: theme.colors.ink,
          fontFamily: metrics.fontFamily,
          fontSize: metrics.fontSize,
          textAlign: 'right',
          includeFontPadding: false,
        }}
      />
    </View>
  );
}
