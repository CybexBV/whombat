/**
 * “Ask before updating” on the phone (Whombat ask-before-updating.md ABU-01): the web's switch, in This Whombat → About's
 * UPDATES card, only where the box's manager says it keeps it. Saved at once, with a note; shows the choice until the
 * box's next status agrees.
 */

import { askFirstView, updateText } from '@whombat/client/managed';
import { type ApplianceStatus, OperationError, sessionOps } from '@whombat/client/session';
import { useEffect, useState } from 'react';
import { Alert, Switch, View } from 'react-native';
import { useI18n, useMobileT } from '../i18n';
import { showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { switchColors } from '../ui/switchColors';
import { useManagedOrThrow } from './context';

export function AskFirstRow({ status, onChanged }: { status: ApplianceStatus; onChanged: () => void }) {
  const { rawLocale } = useI18n();
  const updateTextHere = updateText(rawLocale);
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const { session } = useManagedOrThrow();
  const view = askFirstView(status, rawLocale);
  const [wanted, setWanted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = view?.on;
  useEffect(() => {
    if (shown !== undefined && shown === wanted) setWanted(null);
  }, [shown, wanted]);
  if (!view) return null;
  const on = wanted ?? view.on;
  const meta = on ? updateTextHere.askOn : updateTextHere.askOff;
  const save = (next: boolean) => {
    setBusy(true);
    setWanted(next);
    sessionOps
      .applianceUpdateAsk(session, next)
      .then(
        (r) => {
          setWanted(r.askFirst);
          if (r.askFirst === next) showNotice(updateTextHere.askSwitched(r.askFirst));
          else Alert.alert(tMobile('managed.that-didnt-go-through'), updateTextHere.failed);
          onChanged();
        },
        (e) => {
          setWanted(null);
          Alert.alert(
            tMobile('managed.that-didnt-go-through'),
            e instanceof OperationError ? e.message : updateTextHere.failed,
          );
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={15} weight={600}>
          {view.title}
        </Text>
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {meta}
        </Text>
      </View>
      <Switch
        value={on}
        disabled={busy}
        onValueChange={save}
        accessibilityLabel={view.title}
        accessibilityHint={meta}
        accessibilityRole="switch"
        {...switchColors(theme, on)}
        style={{ minHeight: 44 }}
      />
    </View>
  );
}
