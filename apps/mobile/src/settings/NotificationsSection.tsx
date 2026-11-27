/**
 * Your notifications on Settings → Notifications (Whombat essentials item 12; CT-175; AP-513): Do not disturb — what's on
 * now with “Turn off”, the quick durations (30 minutes, 1 hour, Until tomorrow) and a time you type, or pick on iPhone —
 * and quiet hours (a switch, from and to, the days), in your time zone, and (AP-809, on a Whombat with
 * `notifications.previews`) whether notifications show message text. Each change replaces `Preferences.notifications`
 * whole, built from what the server has now (`useSaveNotificationPreferences`); a failure puts the old value back and
 * says so.
 */

import { dndSetText, endsText, quietHoursText, toggleDay, weekdayLabels } from '@whombat/client';
import {
  type DateInput,
  dndPresetLabels,
  dndUntilFor,
  isDndActive,
  type QuietHours,
  WEEKDAY_KEYS,
  type Weekday,
} from '@whombat/core';
import { useState } from 'react';
import { Platform, Switch, TextInput, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { dndPresets, dndUntilClock, nextWholeHour } from '../data/notify';
import { useNotificationPreferences, useSaveNotificationPreferences } from '../data/useEssentials';
import { useI18n, useMobileT } from '../i18n';
import { errorText, showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { ClockField } from '../ui/ClockField';
import { Button, SectionLabel } from '../ui/primitives';
import { switchColors } from '../ui/switchColors';
import { Touchable } from '../ui/Touchable';
import { hitSlopFor } from '../ui/touchTarget';

export function NotificationsSection() {
  const { rawLocale, tClient } = useI18n();

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const now = useNow();
  const prefs = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const apply = async (change: Parameters<typeof save>[0], notice?: string): Promise<boolean> => {
    setProblem(null);
    setBusy(true);
    try {
      await save(change);
      if (notice) showNotice(notice);
      return true;
    } catch (error) {
      setProblem(errorText(error, rawLocale));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const setDnd = (at: string, now: DateInput) =>
    apply((p) => ({ ...p, dndUntil: at }), dndSetText(at, now, timeZone, rawLocale));
  const setSchedule = (change: (s: QuietHours) => QuietHours) =>
    apply((p) => ({ ...p, schedule: change(p.schedule) }));
  const on = isDndActive(prefs, now) && !!prefs.dndUntil;
  const state =
    on && prefs.dndUntil
      ? tMobile('settings2.notify.onUntil', { until: endsText(prefs.dndUntil, now, timeZone, rawLocale) })
      : tMobile('settings2.notify.off');
  const presetLabels = dndPresetLabels(rawLocale);
  const weekdays = weekdayLabels(rawLocale);
  const schedule = prefs.schedule;
  // On iPhone “Until” is iOS's time picker, starting at the next whole hour; elsewhere a time you type.
  const picksTime = Platform.OS === 'ios';
  const untilClock = picksTime ? until || nextWholeHour(now, timeZone) : until;

  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 8 }}>
        <SectionLabel>{tMobile('settings.do-not-disturb')}</SectionLabel>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6 }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: on ? theme.colors.warn : theme.colors.mut,
            }}
          />
          <Text size={15} weight={500} style={{ flex: 1 }} accessibilityLiveRegion="polite">
            {state}
          </Text>
          {on ? (
            <Touchable
              onPress={() =>
                void apply((p) => ({ ...p, dndUntil: null }), tMobile('settings2.notify.offNotice'))
              }
              disabled={busy}
              feedback="fade"
              ringRadius={10}
              accessibilityLabel={tMobile('settings.turn-off-do-not-disturb')}
              hitSlop={hitSlopFor(32)}
              style={{ minHeight: 32, justifyContent: 'center', paddingHorizontal: 8 }}
            >
              <Text size={14} weight={500} color={theme.colors.brand}>
                {tMobile('settings.turn-off')}
              </Text>
            </Touchable>
          ) : null}
        </View>
        <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
          {tMobile('settings2.notify.dndHint')}
        </Text>
        <View
          accessibilityLabel={tMobile('settings.do-not-disturb-for')}
          style={{ flexDirection: 'row', gap: 8 }}
        >
          {dndPresets(rawLocale).map((p) => (
            <Button
              key={p.preset}
              label={presetLabels[p.preset]}
              variant="secondary"
              disabled={busy}
              onPress={() => void setDnd(dndUntilFor(p.preset, now, timeZone), now)}
              style={{ flex: 1, paddingHorizontal: 6 }}
            />
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {picksTime ? (
            <View style={{ paddingLeft: 6 }}>
              <ClockField
                label={tClient('keepQuiet.pickLabel')}
                spoken={tMobile('settings2.notify.untilSpoken')}
                value={untilClock}
                disabled={busy}
                onChange={setUntil}
              />
            </View>
          ) : (
            <>
              <Text size={13} color={theme.colors.mut} style={{ paddingLeft: 6 }}>
                {tClient('keepQuiet.pickLabel')}
              </Text>
              <TextInput
                value={until}
                onChangeText={setUntil}
                placeholder="18:30"
                placeholderTextColor={theme.colors.mut}
                accessibilityLabel={tMobile('settings.do-not-disturb-until-this-time')}
                keyboardType="numbers-and-punctuation"
                returnKeyType="done"
                maxLength={5}
                cursorColor={theme.colors.ink}
                selectionColor={theme.colors.brand}
                style={{
                  width: 84,
                  minHeight: 44,
                  paddingHorizontal: 10,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: theme.colors.line2,
                  backgroundColor: theme.colors.sf,
                  color: theme.colors.ink,
                  textAlign: 'center',
                  ...textMetrics({ size: 14, family: 'mono' }),
                  includeFontPadding: false,
                }}
              />
            </>
          )}
          <Button
            label={tMobile('settings.set')}
            variant="secondary"
            disabled={busy || !untilClock.trim()}
            onPress={() => {
              const r = dndUntilClock(untilClock, now, timeZone, rawLocale);
              if (!r.ok) {
                setProblem(tMobile('settings2.notify.typeTime'));
                return;
              }
              void setDnd(r.until, now).then((ok) => ok && setUntil(''));
            }}
            style={{ paddingHorizontal: 18 }}
          />
        </View>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel>{tMobile('settings.quiet-hours')}</SectionLabel>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 6 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text size={15} weight={500}>
              {tMobile('settings.quiet-hours-2')}
            </Text>
            <Text size={12.5} mono color={theme.colors.mut}>
              {quietHoursText(schedule, rawLocale)}
            </Text>
          </View>
          <Switch
            value={schedule.enabled}
            disabled={busy}
            onValueChange={(v) => void setSchedule((s) => ({ ...s, enabled: v }))}
            accessibilityLabel={tMobile('settings.quiet-hours-2')}
            accessibilityRole="switch"
            {...switchColors(theme, schedule.enabled)}
            style={{ minHeight: 44 }}
          />
        </View>
        <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
          {tMobile('settings2.notify.quietHint')}
        </Text>
        {schedule.enabled ? (
          <>
            <View style={{ flexDirection: 'row', gap: 16, paddingHorizontal: 6 }}>
              <ClockField
                label={tMobile('settings.from')}
                value={schedule.start}
                disabled={busy}
                onChange={(start) => void setSchedule((s) => ({ ...s, start }))}
              />
              <ClockField
                label={tMobile('settings.to')}
                value={schedule.end}
                disabled={busy}
                onChange={(end) => void setSchedule((s) => ({ ...s, end }))}
              />
            </View>
            <View
              accessibilityLabel={tMobile('settings.days')}
              style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 6 }}
            >
              {WEEKDAY_KEYS.map((day: Weekday) => {
                const active = schedule.days.includes(day);
                return (
                  <Touchable
                    key={day}
                    onPress={() => void setSchedule((s) => ({ ...s, days: toggleDay(s.days, day) }))}
                    disabled={busy}
                    feedback={active ? 'fade' : 'wash'}
                    ringRadius={999}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: active }}
                    accessibilityLabel={weekdays[day].long}
                    hitSlop={hitSlopFor(36)}
                    style={{
                      flex: 1,
                      minHeight: 36,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: active ? theme.colors.btn : theme.colors.line2,
                      backgroundColor: active ? theme.colors.btn : 'transparent',
                    }}
                  >
                    <Text size={12} weight={500} mono color={active ? theme.colors.btnfg : theme.colors.ink}>
                      {weekdays[day].short}
                    </Text>
                  </Touchable>
                );
              })}
            </View>
          </>
        ) : null}
      </View>
      <View style={{ gap: 8 }}>
        <SectionLabel>{tMobile('settings.previews')}</SectionLabel>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 6 }}>
          <Text size={15} weight={500} style={{ flex: 1 }}>
            {tMobile('settings2.notify.previewsTitle')}
          </Text>
          <Switch
            value={prefs.previews}
            disabled={busy}
            onValueChange={(v) => void apply((p) => ({ ...p, previews: v }))}
            accessibilityLabel={tMobile('settings2.notify.previewsTitle')}
            accessibilityRole="switch"
            {...switchColors(theme, prefs.previews)}
            style={{ minHeight: 44 }}
          />
        </View>
        <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
          {tMobile('settings2.notify.previewsHint')}
        </Text>
      </View>
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
