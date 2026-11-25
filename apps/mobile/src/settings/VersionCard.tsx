/**
 * VERSION (Whombat settings-simplify.md SS-06, SS-30): this app and the Whombat it talks to — first on This Whombat
 * and in the settings sheet's This Whombat group. The app's version and build number come from app.config (what
 * `phoneClient` reports in `hello`, AP-259); the Whombat's from what the screen already read (`appliance.status`),
 * (none in the demo world).
 * On Android with a Whombat's service, “This app” says whether it is up to date and has “Check for updates”; a newer
 * build gets the “Update available” row under it (update-check.md AP-2972). On This Whombat → About the Hermes Agent the
 * assistant runs on follows the Whombat (chat-settle.md AP-6159). Also at the bottom of the Settings tab. Last, Privacy
 * opens the privacy policy: App Review wants it reachable inside the app (look-around.md AP-9728). About puts the
 * Whombat's updates in the same card (`children`, before Privacy) under “VERSION & UPDATES”: one place for what runs and
 * how it is kept up to date.
 */
import { useIsFocused } from '@react-navigation/native';
import Constants from 'expo-constants';
import type { ReactNode } from 'react';
import { Linking, Platform } from 'react-native';
import { UI_ORIGINS } from '../managed/config';
import { useManaged } from '../managed/context';
import { Card, Row } from '../managed/ui';
import { useUpdateCheck } from '../managed/useAppUpdate';
import { Button } from '../ui/primitives';
import { UpdateRow } from './UpdateCard';
import { appVersionText, VERSION_TEXT, versionRows } from './version';

function ownVersion(): string | null {
  const config = Constants.expoConfig;
  const build = Platform.OS === 'ios' ? config?.ios?.buildNumber : config?.android?.versionCode;
  return appVersionText(config?.version, build);
}

/** The Whombat's version, or null while nobody says. */
function useWhombatVersion(known: string | null | undefined): string | null {
  return known || null;
}

export function VersionCard({
  runtime,
  hermes,
  label = VERSION_TEXT.label,
  children,
}: {
  runtime?: string | null;
  /** The Whombat's `ApplianceInfo.hermes` where its status was read (null: not known yet); absent: no Hermes row. */
  hermes?: { version: string } | null;
  label?: string;
  /** More rows after the versions, before Privacy (About's updates). */
  children?: ReactNode;
}) {
  // Asked again as the card shows, once the last answer is five minutes old (AP-2971).
  const check = useUpdateCheck(useManaged()?.updates, useIsFocused());
  const [app, ...rest] = versionRows(ownVersion(), useWhombatVersion(runtime), check?.status ?? null, hermes);
  return (
    <Card label={label}>
      {app ? (
        <Row
          first
          title={app.title}
          meta={app.meta}
          action={
            check && !check.update ? (
              <Button
                label={VERSION_TEXT.check}
                accessibilityLabel={VERSION_TEXT.checkLabel}
                variant="secondary"
                // Not `busy`: a spinner for the label would narrow the button and move the line beside it.
                disabled={check.status === 'checking'}
                onPress={() => void check.checkNow()}
              />
            ) : null
          }
        />
      ) : null}
      {check?.update ? <UpdateRow update={check.update} /> : null}
      {rest.map((r) => (
        <Row key={r.title} title={r.title} body={r.body ?? null} meta={r.meta} />
      ))}
      {children}
      <Row
        title={VERSION_TEXT.privacy}
        meta={VERSION_TEXT.privacyWhat}
        action={
          <Button
            label={VERSION_TEXT.privacyOpen}
            accessibilityLabel={VERSION_TEXT.privacyLabel}
            variant="secondary"
            onPress={() =>
              void Linking.openURL(`${UI_ORIGINS[0] ?? 'https://app.whombat.com'}/legal/privacy`)
            }
          />
        }
      />
    </Card>
  );
}
