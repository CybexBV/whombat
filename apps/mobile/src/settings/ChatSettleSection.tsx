/**
 * Settings → Profile → CHAT (Whombat chat-settle.md CHS-06, CHS-12, chat-inbox.md CIB-09; app chat-settle.md AP-6156,
 * chat-inbox-phone.md): “Settle threads by themselves” — Never, After 1 day, After 3 days or After a week, a menu from
 * its row — and “Settle when its code is merged”, then the note that neither touches a thread the assistant works on
 * or one waiting for the person. Each saves at once (`useSaveChatPreferences`); a failure puts it back and says why
 * under them. The same choice row is in Settled (`QuietChoiceRow`).
 */
import { inboxWords, quietChoiceOf, settleQuietChoices } from '@whombat/client';
import { useState } from 'react';
import { Switch, View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import { type NativeMenuSpec, plainMenu } from '../data/nativeMenu';
import { chatPreferencesOf, withMergedSwitch, withQuietDays } from '../data/threadSettle';
import { useAgentWords } from '../data/useAgent';
import { useSaveChatPreferences } from '../data/useThreadSettle';
import { useI18n, useMobileT } from '../i18n';
import { errorText } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ChevronRight } from '../ui/icons';
import { hasNativeMenu, MenuSheet, NativeMenu } from '../ui/nativeMenu';
import { SectionLabel } from '../ui/primitives';
import { switchColors } from '../ui/switchColors';
import { Touchable } from '../ui/Touchable';

/** The quiet days' menu: the four choices, the one in force ticked. */
function quietMenu(days: number | null, locale: string): NativeMenuSpec {
  const chosen = quietChoiceOf(days, locale);
  return plainMenu([
    settleQuietChoices(locale).map((c) => ({
      id: String(c.days),
      title: c.label,
      checked: c.days === chosen.days,
    })),
  ]);
}

/** A pick from it: the days, or null for Never; undefined for an id it never sent. */
function quietPick(id: string): number | null | undefined {
  const c = settleQuietChoices().find((x) => String(x.days) === id);
  return c ? c.days : undefined;
}

/**
 * “Settle threads by themselves” with its hint and the choice in force at the right; a tap opens the choices (iOS's own
 * menu on iPhone, a sheet elsewhere) and a pick saves at once. `onProblem` hears a failure's words (null: cleared).
 */
export function QuietChoiceRow({
  onProblem,
  disabled = false,
}: {
  onProblem: (text: string | null) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const words = inboxWords(rawLocale);
  const { bootstrap } = useBurrow();
  const save = useSaveChatPreferences();
  const days = chatPreferencesOf(bootstrap.preferences).settleQuietDays;
  const chosen = quietChoiceOf(days, rawLocale);
  const spec = quietMenu(days, rawLocale);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const pick = async (id: string) => {
    setSheet(false);
    const next = quietPick(id);
    if (next === undefined) return;
    onProblem(null);
    setBusy(true);
    try {
      await save((p) => withQuietDays(p, next));
    } catch (error) {
      onProblem(errorText(error, rawLocale));
    } finally {
      setBusy(false);
    }
  };
  const face = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={15} weight={600}>
          {words.quietChoice}
        </Text>
        <Text size={13} lh={1.45} color={theme.colors.mut}>
          {words.quietChoiceHint}
        </Text>
      </View>
      <Text size={14} color={theme.colors.ink2}>
        {chosen.label}
      </Text>
      <ChevronRight size={16} color={theme.colors.mut} strokeWidth={1.75} />
    </View>
  );
  const label = `${words.quietChoice}, ${chosen.label}`;
  return hasNativeMenu ? (
    <NativeMenu spec={spec} onPick={(id) => void pick(id)} trigger="tap" label={label}>
      {face}
    </NativeMenu>
  ) : (
    <>
      <Touchable
        onPress={() => setSheet(true)}
        disabled={disabled || busy}
        feedback="wash"
        accessibilityLabel={label}
        accessibilityHint={words.quietChoiceHint}
        style={{ minHeight: 56 }}
      >
        {face}
      </Touchable>
      <MenuSheet
        spec={spec}
        visible={sheet}
        label={words.quietChoice}
        onClose={() => setSheet(false)}
        onPick={(id) => void pick(id)}
      />
    </>
  );
}

export function ChatSettleSection() {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const words = useAgentWords();
  const { t } = useMobileT();
  const { bootstrap } = useBurrow();
  const save = useSaveChatPreferences();
  const merged = chatPreferencesOf(bootstrap.preferences).settleMerged;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const turn = async (value: boolean) => {
    setProblem(null);
    setBusy(true);
    try {
      await save((p) => withMergedSwitch(p, value));
    } catch (error) {
      setProblem(errorText(error, rawLocale));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 8 }}>
      <SectionLabel>{t('settings2.settle.chat')}</SectionLabel>
      <View
        style={{
          borderRadius: 20,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf,
          overflow: 'hidden',
        }}
      >
        <QuietChoiceRow onProblem={setProblem} disabled={busy} />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            minHeight: 56,
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text size={15} weight={600}>
              {t('settings2.settle.merged')}
            </Text>
            <Text size={13} lh={1.45} color={theme.colors.mut}>
              {t('settings2.settle.mergedHint')}
            </Text>
          </View>
          <Switch
            value={merged}
            disabled={busy}
            onValueChange={(v) => void turn(v)}
            accessibilityLabel={t('settings2.settle.merged')}
            accessibilityHint={t('settings2.settle.mergedHint')}
            accessibilityRole="switch"
            {...switchColors(theme, merged)}
            style={{ minHeight: 44 }}
          />
        </View>
      </View>
      <Text size={12.5} lh={1.5} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
        {t('settings2.settle.note', { name: words.Name })}
      </Text>
      {problem ? (
        <Text
          size={13.5}
          lh={1.45}
          color={theme.colors.bad}
          accessibilityLiveRegion="polite"
          style={{ paddingHorizontal: 6 }}
        >
          {problem}
        </Text>
      ) : null}
    </View>
  );
}
