/**
 * “Ask before updating” on the phone (Whombat ask-before-updating.md ABU-01): the web's switch, in This Whombat → About's
 * UPDATES card, only where the box's manager says it keeps it. Saved at once, with a note; shows the choice until the
 * box's next status agrees.
 */
import { askFirstView, UPDATE_TEXT } from '@whombat/client/managed';
import { type ApplianceStatus, OperationError, sessionOps } from '@whombat/client/session';
import { useEffect, useState } from 'react';
import { Alert, Switch, View } from 'react-native';
import { showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { switchColors } from '../ui/switchColors';
import { useManagedOrThrow } from './context';

export function AskFirstRow({ status, onChanged }: { status: ApplianceStatus; onChanged: () => void }) {
  const theme = useTheme();
  const { session } = useManagedOrThrow();
  const view = askFirstView(status);
  const [wanted, setWanted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = view?.on;
  useEffect(() => {
    if (shown !== undefined && shown === wanted) setWanted(null);
  }, [shown, wanted]);
  if (!view) return null;
  const on = wanted ?? view.on;
  const meta = on ? UPDATE_TEXT.askOn : UPDATE_TEXT.askOff;
  const save = (next: boolean) => {
    setBusy(true);
    setWanted(next);
    sessionOps
      .applianceUpdateAsk(session, next)
      .then(
        (r) => {
          setWanted(r.askFirst);
          if (r.askFirst === next) showNotice(UPDATE_TEXT.askSwitched(r.askFirst));
          else Alert.alert('That didn’t go through', UPDATE_TEXT.failed);
          onChanged();
        },
        (e) => {
          setWanted(null);
          Alert.alert('That didn’t go through', e instanceof OperationError ? e.message : UPDATE_TEXT.failed);
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
