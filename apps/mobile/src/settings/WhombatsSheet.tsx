/**
 * Switch Whombat's sheet (whombat-switcher.md AP-3084): the web's burrow-name menu on the phone. YOUR WHOMBATS, the open
 * one first and checked, the others with the list's words or “Set up this device”, edge to edge between hairlines as a
 * sheet's rows are (44dp minimum); then All Whombats (the list) and Claim a Whombat. A tap opens
 * one as the list's Open does (AP-64). While the directory loads or can't be read, the rows wait and All Whombats stays.
 */
import { type ManagedWhombats, type SwitcherRow, switcherCopy, switcherRows } from '@whombat/client/managed';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Check, LayoutGrid, Plus } from '../ui/icons';
import { Sheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';

export function WhombatsSheet({
  visible,
  current,
  whombats,
  onAll,
  onClose,
}: {
  visible: boolean;
  /** The Whombat this phone has open. */
  current: string;
  whombats: ManagedWhombats;
  /** All Whombats: the list. */
  onAll: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const copy = switcherCopy(rawLocale);
  const [rows, setRows] = useState<SwitcherRow[] | null>(null);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    whombats.list().then(
      (list) =>
        live &&
        setRows(
          switcherRows(list, {
            current,
            known: (d) => whombats.known(d),
            ...(whombats.local && { local: true }),
            locale: rawLocale,
          }),
        ),
      () => live && setRows((r) => r ?? []),
    );
    return () => {
      live = false;
    };
  }, [visible, current, whombats, rawLocale]);

  const go = (then: () => void) => {
    onClose();
    then();
  };
  const row = {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderTopWidth: 1,
    borderTopColor: theme.colors.line,
  } as const;
  return (
    <Sheet visible={visible} onClose={onClose} title={copy.kicker} label={copy.kicker} maxHeight="80%">
      <ScrollView>
        {rows === null ? (
          <View style={{ ...row, justifyContent: 'center' }}>
            <ActivityIndicator color={theme.colors.mut} />
          </View>
        ) : (
          rows.map((r) => (
            <Touchable
              key={r.device}
              onPress={() => go(() => !r.here && whombats.open(r.appliance))}
              feedback="wash"
              accessibilityRole="button"
              accessibilityState={{ selected: r.here }}
              accessibilityLabel={`${r.name}. ${r.meta}`}
              testID={`whombat-${r.device}`}
              style={row}
            >
              <View
                style={
                  r.setUp
                    ? {
                        width: 9,
                        height: 9,
                        borderRadius: 5,
                        borderWidth: 1.5,
                        borderStyle: 'dashed',
                        borderColor: theme.colors.brand,
                      }
                    : {
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: r.online ? theme.colors.ok : theme.colors.mut,
                      }
                }
              />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text size={15.5} weight={r.here ? 600 : 500} numberOfLines={1}>
                  {r.name}
                </Text>
                <Text size={13} lh={1.4} color={theme.colors.mut} numberOfLines={1}>
                  {r.meta}
                </Text>
              </View>
              {r.here ? <Check size={20} color={theme.colors.brand} strokeWidth={2.25} /> : null}
            </Touchable>
          ))
        )}
        <Touchable onPress={() => go(onAll)} feedback="wash" accessibilityRole="button" style={row}>
          <LayoutGrid size={18} color={theme.colors.mut} />
          <Text size={15.5} color={theme.colors.ink2}>
            {copy.all}
          </Text>
        </Touchable>
        <Touchable onPress={() => go(whombats.claim)} feedback="wash" accessibilityRole="button" style={row}>
          <Plus size={18} color={theme.colors.mut} />
          <Text size={15.5} color={theme.colors.ink2}>
            {copy.claim}
          </Text>
        </Touchable>
        <View style={{ height: 1, backgroundColor: theme.colors.line }} />
      </ScrollView>
    </Sheet>
  );
}
