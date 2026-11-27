/**
 * Pages by time of day on the phone (Whombat docs/decisions/desk-display.md, “Pages by time”; the web's page menu): a
 * page chip that shows a small clock and its hours, the sheet behind *Show at set times…* (From, To, the seven days, in
 * the person's zone; *Always* takes the times away) and *Ask {assistant}* beside *+ Page*. The rules and the words are
 * `@whombat/client/desk`'s, the web's too.
 */
import { toggleDay, weekdayLabels } from '@whombat/client';
import {
  type DeskPage,
  type DeskPageShow,
  deskScreensText,
  fillDeskWords,
  PAGE_TIMES_DEFAULT,
  pageHoursText,
  pageWhenText,
} from '@whombat/client/desk';
import { WEEKDAY_KEYS, type Weekday } from '@whombat/core';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { ClockField } from '../../ui/ClockField';
import { Clock, MessageCircle } from '../../ui/icons';
import { OneSheet } from '../../ui/oneSheet';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';

/** A page among the chips: its name, and for a page at set times a small clock and its hours. */
export function PageChip({
  page,
  active,
  onPress,
}: {
  page: Pick<DeskPage, 'name' | 'show'>;
  active: boolean;
  onPress: () => void;
}) {
  const { rawLocale } = useI18n();
  const E = deskScreensText(rawLocale).editor;
  const theme = useTheme();
  const fg = active ? theme.colors.btnfg : theme.colors.ink;
  const hours = page.show ? pageHoursText(page.show, rawLocale) : null;
  return (
    <Touchable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={
        page.show
          ? `${page.name}, ${fillDeskWords(E.times.label, { when: pageWhenText(page.show, rawLocale) })}`
          : page.name
      }
      feedback={active ? 'fade' : 'wash'}
      ringRadius={999}
      hitSlop={{ top: 7, bottom: 7 }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 7,
        paddingHorizontal: 13,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? theme.colors.btn : theme.colors.line2,
        backgroundColor: active ? theme.colors.btn : 'transparent',
      }}
    >
      <Text size={14} weight={500} color={fg}>
        {page.name}
      </Text>
      {hours ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, opacity: 0.75 }}>
          <Clock size={11} color={fg} />
          <Text size={12} mono color={fg}>
            {hours}
          </Text>
        </View>
      ) : null}
    </Touchable>
  );
}

/** *Ask {assistant}* beside *+ Page*, in the chips' shape: a request to make a page, in a new thread. */
export function AskPageChip({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      feedback="wash"
      ringRadius={999}
      hitSlop={{ top: 7, bottom: 7 }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 7,
        paddingHorizontal: 13,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.line2,
      }}
    >
      <MessageCircle size={14} color={theme.colors.brand} />
      <Text size={14} weight={500} color={theme.colors.brand}>
        {label}
      </Text>
    </Touchable>
  );
}

/**
 * *Show at set times…*: From and To, the seven days (all on unless chosen), in the person's zone; *Always* when the page
 * has times. Saving a window without a day says so in the sheet.
 */
export function PageTimesSheet({
  visible,
  name,
  show,
  timeZone,
  onClose,
  onSave,
}: {
  visible: boolean;
  name: string;
  show: DeskPageShow | null;
  timeZone: string;
  onClose: () => void;
  /** Saves the times (null: always); the words of a refusal, else null. */
  onSave: (show: DeskPageShow | null) => string | null;
}) {
  const { rawLocale } = useI18n();
  const E = deskScreensText(rawLocale).editor;
  const theme = useTheme();
  const start = show ?? PAGE_TIMES_DEFAULT;
  const [from, setFrom] = useState(start.from);
  const [to, setTo] = useState(start.to);
  const [days, setDays] = useState<Weekday[]>(start.days ?? [...WEEKDAY_KEYS]);
  const [note, setNote] = useState<string | null>(null);
  // Opened again (another page, or after Undo): it starts from what the page has now.
  useEffect(() => {
    if (!visible) return;
    const s = show ?? PAGE_TIMES_DEFAULT;
    setFrom(s.from);
    setTo(s.to);
    setDays(s.days ?? [...WEEKDAY_KEYS]);
    setNote(null);
  }, [visible, show]);
  return (
    <OneSheet
      visible={visible}
      onClose={onClose}
      title={E.times.title}
      body={`${name} · ${E.times.line}`}
      note={note}
      buttons={[
        {
          id: 'save',
          label: E.times.save,
          variant: 'primary',
          onPress: () => setNote(onSave({ from, to, days })),
        },
        ...(show
          ? [
              {
                id: 'always',
                label: E.times.always,
                variant: 'secondary' as const,
                onPress: () => onSave(null),
              },
            ]
          : []),
      ]}
    >
      <View style={{ gap: 14, marginTop: 16, marginBottom: 18 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
          <ClockField label={E.times.from} value={from} onChange={setFrom} />
          <ClockField label={E.times.to} value={to} onChange={setTo} />
        </View>
        <View accessibilityLabel={E.times.on} style={{ flexDirection: 'row', gap: 6 }}>
          {WEEKDAY_KEYS.map((day) => {
            const on = days.includes(day);
            return (
              <Touchable
                key={day}
                onPress={() => {
                  setNote(null);
                  setDays((d) => toggleDay(d, day));
                }}
                feedback={on ? 'fade' : 'wash'}
                ringRadius={999}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={weekdayLabels(rawLocale)[day].long}
                hitSlop={hitSlopFor(36)}
                style={{
                  flex: 1,
                  minHeight: 36,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: on ? theme.colors.btn : theme.colors.line2,
                  backgroundColor: on ? theme.colors.btn : 'transparent',
                }}
              >
                <Text size={12} weight={500} mono color={on ? theme.colors.btnfg : theme.colors.ink}>
                  {weekdayLabels(rawLocale)[day].short}
                </Text>
              </Touchable>
            );
          })}
        </View>
        <Text size={13} lh={1.45} color={theme.colors.mut}>
          {fillDeskWords(E.times.zone, { zone: timeZone })}
        </Text>
      </View>
    </OneSheet>
  );
}
