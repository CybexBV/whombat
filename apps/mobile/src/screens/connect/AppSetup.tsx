/**
 * An `app_oauth` entry's app on the phone (Dropbox; phone-connect.md PC-07, AP-2912): the web's AppOAuthSetup in Connect
 * {Name}, above the form: whether it is set up, and the four steps — create the app (the console's link), its
 * permissions, the redirect address to copy, then the app key and secret (masked, no autofill) — and once saved Replace
 * and Remove (with the web's confirm). An app set in the Whombat's config is only shown. The words are the web's (`APP_SETUP_TEXT`).
 */

import {
  type AppMethod,
  appSavedLine,
  appSaveProblem,
  appSetupText,
  appSummary,
  appWords,
  connectProblem,
} from '@whombat/client/connections';
import { useConnectorAppWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import type { CatalogAppStatus, CatalogEntry } from '@whombat/core/domain';
import { type ReactNode, useState } from 'react';
import { Alert, View } from 'react-native';
import { useI18n, useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { copyToClipboard } from '../../ui/clipboard';
import { FormField, FormMessage } from '../../ui/formField';
import { Button, StatusDot } from '../../ui/primitives';
import { showNotice } from '../feedback';
import { Note, openOutside, PLAIN_INPUT, TextLink } from './parts';

export function AppSetup({
  entry,
  method,
  app,
}: {
  entry: CatalogEntry;
  method: AppMethod;
  app: CatalogAppStatus;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const appSetupTextHere = appSetupText(rawLocale);
  const theme = useTheme();
  const words = appWords(entry, rawLocale);
  const done = app.configured;
  const [showSteps, setShowSteps] = useState(!done);
  const steps = app.source !== 'config' && (showSteps || !done);
  return (
    <View style={{ gap: 8 }}>
      <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut} accessibilityRole="header">
        {appSetupTextHere.section(entry.name)}
      </Text>
      <View
        style={{
          gap: 14,
          padding: 14,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ paddingTop: 6 }}>
            <StatusDot
              color={done ? theme.colors.ok : theme.colors.mut}
              label={done ? appSetupTextHere.setUp : appSetupTextHere.notSetUp}
            />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text size={15} weight={600}>
              {appSetupTextHere.forThisWhombat}
            </Text>
            <Text size={13} lh={1.4} color={theme.colors.mut}>
              {appSummary(entry, app, rawLocale)}
            </Text>
          </View>
        </View>
        {done && app.source !== 'config' ? (
          <TextLink
            label={showSteps ? appSetupTextHere.hideSteps : appSetupTextHere.showSteps}
            onPress={() => setShowSteps((v) => !v)}
          />
        ) : null}
        {steps ? (
          <View style={{ gap: 16 }}>
            <Step n={1} title={appSetupTextHere.stepCreate} done={done}>
              <Note>
                {entry.id === 'dropbox'
                  ? appSetupTextHere.createDropbox(words.console)
                  : appSetupTextHere.createOther(words.console)}
              </Note>
              <TextLink
                label={appSetupTextHere.openConsole(words.console)}
                external
                onPress={() => openOutside(method.consoleUrl)}
              />
            </Step>
            <Step n={2} title={appSetupTextHere.stepPermissions} done={done}>
              <Note>{appSetupTextHere.permissions}</Note>
              <Text size={12.5} lh={1.6} mono selectable>
                {method.scopes.join('  ')}
              </Text>
            </Step>
            <Step n={3} title={appSetupTextHere.stepRedirect} done={done}>
              <Note>{appSetupTextHere.redirect}</Note>
              <Text size={12.5} lh={1.5} mono selectable>
                {app.redirectUri}
              </Text>
              <Button
                label={tMobile('screens2.guide.copy', {
                  label: appSetupTextHere.redirectLabel.toLowerCase(),
                })}
                variant="secondary"
                onPress={() =>
                  void copyToClipboard(app.redirectUri, appSetupTextHere.redirectCopied, rawLocale)
                }
              />
              {/* What Dropbox's first sign-in needs on the same tab (SG-22, AP-3910): PKCE, and people other than its owner. */}
              {entry.id === 'dropbox' ? (
                <>
                  <Note>{appSetupTextHere.dropboxPublicClients}</Note>
                  <Note>{appSetupTextHere.dropboxMoreUsers}</Note>
                </>
              ) : null}
            </Step>
            <Step n={4} title={appSetupTextHere.stepPaste(words.id)} done={done}>
              <AppForm entry={entry} method={method} app={app} />
            </Step>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: ReactNode;
}) {
  const { tClient } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={tMobile(done ? 'screens2.connect.stepDone' : 'screens2.connect.stepToDo', {
          n,
          title,
        })}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
      >
        <Text size={13.5} weight={600} mono color={theme.colors.mut}>
          {`${n}.`}
        </Text>
        <Text size={15} weight={600} style={{ flex: 1 }}>
          {title}
        </Text>
        <StatusDot
          color={done ? theme.colors.ok : theme.colors.mut}
          label={done ? tClient('schedules.end.done') : tMobile('screens.to-do')}
          size={7}
        />
      </View>
      {children}
    </View>
  );
}

function AppForm({ entry, method, app }: { entry: CatalogEntry; method: AppMethod; app: CatalogAppStatus }) {
  const { rawLocale } = useI18n();
  const appSetupTextHere = appSetupText(rawLocale);
  const words = appWords(entry, rawLocale);
  const save = useConnectorAppWrite(api.connectors.setApp);
  const remove = useConnectorAppWrite(api.connectors.removeApp);
  const [editing, setEditing] = useState(!app.configured);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSave() {
    const refused = appSaveProblem(entry, method, app, { clientId, secret }, rawLocale);
    if (refused === 'unchanged') return setEditing(false);
    if (refused) return setError(refused);
    setError(null);
    const id = clientId.trim();
    const key = secret.trim();
    try {
      const result = await save.mutateAsync({
        params: { catalogId: entry.id },
        body: { ...(id ? { clientId: id } : {}), ...(key ? { clientSecret: key } : {}) },
      });
      if (result.status === 'ok') {
        setClientId('');
        setSecret('');
        setEditing(false);
        showNotice(appSetupTextHere.saved(entry.name));
      }
    } catch (err) {
      const p = connectProblem(err, undefined, undefined, rawLocale);
      setError(p.fields.clientId ?? p.fields.clientSecret ?? p.message);
    } finally {
      // The secret goes with the request: the mutation forgets its input too.
      save.reset();
    }
  }

  function onRemove() {
    Alert.alert(appSetupTextHere.removeApp, appSetupTextHere.confirmRemove(entry.name), [
      { text: appSetupTextHere.cancel, style: 'cancel' },
      {
        text: appSetupTextHere.removeApp,
        style: 'destructive',
        onPress: () =>
          void remove.mutateAsync({ params: { catalogId: entry.id } }).then(
            (result) => {
              if (result.status === 'ok') showNotice(appSetupTextHere.removed(entry.name));
            },
            (err) => setError(connectProblem(err, undefined, undefined, rawLocale).message),
          ),
      },
    ]);
  }

  if (!editing)
    return (
      <View style={{ gap: 10 }}>
        <Note>{appSavedLine(entry, app, rawLocale)}</Note>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={appSetupTextHere.replace}
            variant="secondary"
            onPress={() => setEditing(true)}
            style={{ flex: 1 }}
          />
          <Button
            label={appSetupTextHere.remove}
            variant="secondary"
            disabled={remove.isPending}
            onPress={onRemove}
            style={{ flex: 1 }}
          />
        </View>
        <FormMessage text={error} />
      </View>
    );

  return (
    <View style={{ gap: 12 }}>
      <Note>{`${appSetupTextHere.copyThem}${method.clientSecretOptional ? appSetupTextHere.optionalSecret(words.secret) : ''}`}</Note>
      <FormField
        label={words.id}
        value={clientId}
        onChangeText={(v) => {
          setClientId(v);
          setError(null);
        }}
        placeholder={app.configured ? appSetupTextHere.keepId : 'a1b2c3d4e5f6g7h'}
        mono
        {...PLAIN_INPUT}
      />
      <FormField
        label={`${words.secret}${method.clientSecretOptional ? ' (optional)' : ''}`}
        value={secret}
        onChangeText={(v) => {
          setSecret(v);
          setError(null);
        }}
        placeholder={app.secretSet ? appSetupTextHere.keepSecret : ''}
        secret
      />
      <FormMessage text={error} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          label={appSetupTextHere.save}
          busy={save.isPending}
          onPress={() => void onSave()}
          style={{ flex: 1 }}
        />
        {app.configured ? (
          <Button
            label={appSetupTextHere.cancel}
            variant="quiet"
            onPress={() => {
              setEditing(false);
              setError(null);
            }}
            style={{ flex: 1 }}
          />
        ) : null}
      </View>
    </View>
  );
}
