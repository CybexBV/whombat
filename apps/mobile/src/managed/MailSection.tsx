/**
 * EMAIL on This Whombat (Whombat hermes-engine.md HE-61; contracts CT-1308; hermes-engine-app.md AP-5477), after
 * TAILSCALE, on a community box: the box sends email through your own mail server, optional. One row
 * in NETWORK's look — Off with **Set up**, or the server (from address · host:port · security) with the last test
 * beneath and **Send a test**, **Change**, **Remove** (asked once). Set up and Change open a sheet: server, port,
 * security, user name, password (never shown again: “Saved. Leave it empty to keep it.”), from address and name, with
 * Send a test (of what is typed, without saving) and Save. A server set in the box's configuration is read-only. Every
 * word is the client's `MAIL_TEXT`; `mailView` decides the row and `mailDraft` checks the form. Every target 44dp.
 */
import {
  type HostMailOutput,
  MAIL_TEXT,
  type MailAction,
  type MailApi,
  type MailForm,
  mailApi,
  mailDraft,
  mailErrorText,
  mailForm,
  mailPortFor,
  mailTestText,
  mailView,
} from '@whombat/client';
import { useMe } from '@whombat/client/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { Sheet } from '../ui/sheet';
import { useManaged } from './context';
import { Card, ErrorLine, Field, Note, Row } from './ui';

const T = MAIL_TEXT;

/** The mail server's ops on a community box's session; null anywhere else. */
export function useMailHere(): { api: MailApi; email: string } | null {
  const managed = useManaged();
  const session = managed?.session ?? null;
  const community = managed?.community === true;
  // Your own email on this Whombat (no cloud account here): the from address a new form starts with.
  const me = useMe({});
  const email = me.data?.account.email ?? managed?.email ?? '';
  return useMemo(
    () => (session && community ? { api: mailApi(session), email } : null),
    [session, community, email],
  );
}

function label(action: MailAction): string {
  switch (action) {
    case 'set_up':
      return T.setUp;
    case 'test':
      return T.test;
    case 'change':
      return T.change;
    case 'remove':
      return T.remove;
  }
}

export function MailSection({ here }: { here: { api: MailApi; email: string } | null }) {
  const theme = useTheme();
  const [answer, setAnswer] = useState<HostMailOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const api = here?.api ?? null;
  const read = useCallback(() => {
    api?.get().then(setAnswer, () => setAnswer(null));
  }, [api]);
  useEffect(read, [read]);
  const v = mailView(answer);
  if (!here || !api || !v || !answer) return null;
  const mail = api;

  const test = async () => {
    setBusy(true);
    setNote(null);
    try {
      await mail.test();
      // The row's last test says how it went (a test of the stored settings is kept as theirs).
      read();
    } catch (error) {
      setNote({ text: mailErrorText(error), bad: true });
    } finally {
      setBusy(false);
    }
  };
  const act = (action: MailAction) => {
    if (action === 'set_up' || action === 'change') setEditing(true);
    else if (action === 'test') void test();
    else
      Alert.alert(T.removeTitle, T.removeLead, [
        { text: T.cancel, style: 'cancel' },
        {
          text: T.remove,
          style: 'destructive',
          onPress: () =>
            void mail.remove().then(
              (r) => {
                setAnswer(r);
                setNote({ text: T.removed, bad: false });
              },
              (error) => setNote({ text: mailErrorText(error), bad: true }),
            ),
        },
      ]);
  };

  const [main, ...rest] = v.actions;
  return (
    <Card label={T.section}>
      <Row
        first
        dot={v.dot}
        title={v.title}
        meta={[v.meta, v.test].filter(Boolean).join('\n')}
        action={
          main ? (
            <Button
              label={label(main)}
              variant={main === 'set_up' ? 'primary' : 'secondary'}
              disabled={busy}
              busy={busy && main === 'test'}
              onPress={() => act(main)}
              style={{ paddingHorizontal: 14 }}
            />
          ) : null
        }
      />
      {note ? (
        <Text
          size={12}
          mono
          lh={1.45}
          color={note.bad ? theme.colors.bad : theme.colors.ink2}
          accessibilityLiveRegion="polite"
          style={{ paddingHorizontal: 16, paddingBottom: 12 }}
        >
          {note.text}
        </Text>
      ) : null}
      {rest.length > 0 ? (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'flex-end',
            gap: 8,
            padding: 12,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          {rest.map((action) => (
            <Button
              key={action}
              label={label(action)}
              variant="secondary"
              disabled={busy}
              onPress={() => act(action)}
              style={{ paddingHorizontal: 14 }}
            />
          ))}
        </View>
      ) : null}
      <MailSheet
        visible={editing}
        api={mail}
        answer={answer}
        email={here.email}
        onClose={() => setEditing(false)}
        onSaved={(r) => {
          setAnswer(r);
          setNote({ text: T.saved, bad: false });
          setEditing(false);
        }}
      />
    </Card>
  );
}

const SECURITY = ['starttls', 'tls', 'none'] as const;

function MailSheet({
  visible,
  api,
  answer,
  email,
  onClose,
  onSaved,
}: {
  visible: boolean;
  api: MailApi;
  answer: HostMailOutput;
  email: string;
  onClose: () => void;
  onSaved: (r: HostMailOutput) => void;
}) {
  const theme = useTheme();
  const [form, setForm] = useState<MailForm>(() => mailForm(answer.mail, email));
  const [problem, setProblem] = useState<string | null>(null);
  const [tested, setTested] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  // Every opening starts from what is stored; closing forgets what was typed, the password above all.
  useEffect(() => {
    if (!visible) return;
    setForm(mailForm(answer.mail, email));
    setProblem(null);
    setTested(null);
  }, [visible, answer.mail, email]);
  const hasPassword = answer.mail?.hasPassword === true;
  const set = (patch: Partial<MailForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setProblem(null);
  };
  const draft = () => {
    const d = mailDraft(form, hasPassword);
    if (!d.ok) setProblem(T.problems[d.problem]);
    return d.ok ? d.input : null;
  };
  const save = async () => {
    const input = draft();
    if (!input) return;
    setBusy('save');
    try {
      onSaved(await api.set(input));
    } catch (error) {
      setProblem(mailErrorText(error));
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    const input = draft();
    if (!input) return;
    setBusy('test');
    setTested(null);
    try {
      const r = await api.test(input);
      setTested({ text: mailTestText(r.test), bad: r.test.state !== 'sent' });
    } catch (error) {
      setTested({ text: mailErrorText(error), bad: true });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet visible={visible} onClose={onClose} label={T.formTitle} closeLabel={T.cancel} maxHeight="92%">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}
      >
        <View style={{ gap: 4 }}>
          <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
            {T.formTitle}
          </Text>
          <Text size={13.5} lh={1.45} color={theme.colors.mut}>
            {T.formLead}
          </Text>
        </View>
        <Field
          label={T.host}
          value={form.host}
          onChangeText={(host) => set({ host })}
          placeholder={T.hostPlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <View style={{ gap: 2 }}>
          <Segmented
            label={T.securityLabel}
            options={SECURITY.map((s) => ({ value: s, label: T.security[s] }))}
            value={form.security}
            onChange={(security) => set({ security, port: mailPortFor(security, form.port) })}
          />
        </View>
        <Field
          label={T.port}
          value={form.port}
          onChangeText={(port) => set({ port: port.replace(/\D/g, '') })}
          keyboardType="number-pad"
          mono
        />
        <Field
          label={T.username}
          hint={T.usernameHint}
          value={form.username}
          onChangeText={(username) => set({ username })}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
        />
        <Field
          label={T.password}
          hint={hasPassword ? T.passwordKept : T.passwordHint}
          value={form.password}
          onChangeText={(password) => set({ password })}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
        />
        <Field
          label={T.from}
          value={form.from}
          onChangeText={(from) => set({ from })}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field
          label={T.fromName}
          value={form.fromName}
          onChangeText={(fromName) => set({ fromName })}
          placeholder={T.fromNamePlaceholder}
          autoCapitalize="words"
        />
        <ErrorLine text={problem} />
        {tested ? tested.bad ? <ErrorLine text={tested.text} /> : <Note text={tested.text} /> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={busy === 'test' ? T.testing : T.test}
            variant="secondary"
            busy={busy === 'test'}
            disabled={busy !== null}
            onPress={() => void test()}
            style={{ flex: 1 }}
          />
          <Button
            label={busy === 'save' ? T.saving : T.save}
            busy={busy === 'save'}
            disabled={busy !== null}
            onPress={() => void save()}
            style={{ flex: 1 }}
          />
        </View>
      </ScrollView>
    </Sheet>
  );
}
