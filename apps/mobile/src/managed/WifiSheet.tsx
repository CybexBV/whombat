/**
 * Join a Wi-Fi network, in a sheet (Whombat hardware-support.md HD-05, HD-06, HD-11; hardware-support-android.md
 * AP-3254…AP-3258), the web's dialog (hardware-support-web.md AP-3225, AP-3226) on a phone. Three steps:
 *
 * - **the list**: the networks nearby, each one 52dp row — its bars, its name over “Connected”, “Saved” or why it can't
 *   be joined (company and WEP networks, dimmed), a lock when secured — then **Other network…**; Look again and Cancel;
 * - **a network's form**: its password with Show/Hide where one is needed (a saved one joins without), or for Other
 *   network… its name and security; the guard's note; Back · Join;
 * - **following the change** NETWORK's poller reads: “Joining…”, then the shared line (“Joined Home”, how it went back)
 *   with Close while it runs and Done after. A network that refuses (a wrong password, not found) goes back to its form
 *   with why.
 *
 * The steps' logic is `machine.ts` (tested); the rows and words are the shared `wifiRows` and `NETWORK_TEXT`. Closing
 * forgets everything typed, the password above all.
 */
import {
  NETWORK_TEXT,
  type NetworkApi,
  type NetworkChange,
  networkErrorText,
  type WifiRowView,
  wifiRows,
} from '@whombat/client';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { ChevronRight, Lock } from '../ui/icons';
import { Button, SectionLabel } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { Sheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';
import { ChangeMark, SignalBars } from './MachineParts';
import {
  EMPTY_WIFI_FORM,
  type WifiForm,
  type WifiProblem,
  type WifiStep,
  wifiAfterChange,
  wifiFollowLine,
  wifiFormFields,
  wifiFormInput,
  wifiFormProblem,
  wifiSheetHead,
} from './machine';
import { ErrorLine, Field } from './ui';

const T = NETWORK_TEXT;
const D = T.dialog;

type Scan = { rows: WifiRowView[] } | { note: string } | null;

export function WifiSheet({
  visible,
  onClose,
  api,
  name,
  change,
  onStarted,
}: {
  visible: boolean;
  onClose: () => void;
  api: NetworkApi;
  /** The Whombat's name in the words. */
  name: string;
  /** The change NETWORK shows (the poller's). */
  change: NetworkChange | null;
  onStarted: (change: NetworkChange) => void;
}) {
  const theme = useTheme();
  const [step, setStep] = useState<WifiStep>({ at: 'list' });
  const [scan, setScan] = useState<Scan>(null);
  const [form, setForm] = useState<WifiForm>(EMPTY_WIFI_FORM);
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState<WifiProblem | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const looking = useRef(0);

  const look = async () => {
    const mine = ++looking.current;
    setScan(null);
    try {
      const r = await api.scan();
      if (mine !== looking.current) return;
      setScan(
        r.scan
          ? { rows: wifiRows(r.scan) }
          : { note: r.reason === 'no_wifi' ? T.errors.no_wifi(name) : D.couldNotLook },
      );
    } catch {
      if (mine === looking.current) setScan({ note: D.couldNotLook });
    }
  };

  // Opening looks for networks; closing forgets everything typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening
  useEffect(() => {
    if (visible) {
      void look();
      return;
    }
    looking.current += 1;
    setStep({ at: 'list' });
    setScan(null);
    setForm(EMPTY_WIFI_FORM);
    setShown(false);
    setProblem(null);
    setNote(null);
    setBusy(false);
  }, [visible]);

  // The change this sheet started: a network that refused goes back to its form with why.
  useEffect(() => {
    const back = wifiAfterChange(step, change, name);
    if (!back) return;
    setStep(back.step);
    setForm((f) => ({ ...f, password: '' }));
    setProblem(back.problem);
    setNote(back.note);
  }, [step, change, name]);

  const choose = (network: WifiRowView | null) => {
    setStep({ at: 'form', network });
    setForm({ ...EMPTY_WIFI_FORM, security: network?.security === 'open' ? 'open' : 'psk' });
    setShown(false);
    setProblem(null);
    setNote(null);
  };

  const join = async () => {
    if (step.at !== 'form') return;
    const p = wifiFormProblem(step, form);
    setProblem(p);
    setNote(null);
    if (p) return;
    setBusy(true);
    try {
      const started = await api.join(wifiFormInput(step, form));
      onStarted(started);
      setStep({ at: 'following', id: started.id, ssid: started.ssid, network: step.network });
    } catch (error) {
      setNote(networkErrorText(error, name));
    } finally {
      setBusy(false);
    }
  };

  const head = wifiSheetHead(step, name);
  const fields = wifiFormFields(step, form);
  const at = (field: WifiProblem['field']) => (problem?.field === field ? problem.text : null);
  const followed = step.at === 'following' && change?.id === step.id ? change : null;
  const line = step.at === 'following' ? wifiFollowLine(followed, name) : null;

  return (
    <Sheet visible={visible} onClose={onClose} label={head.title} closeLabel={D.cancel}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}
      >
        <View style={{ gap: 4 }}>
          <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
            {head.title}
          </Text>
          <Text size={13.5} lh={1.45} color={theme.colors.mut}>
            {head.lead}
          </Text>
        </View>

        {step.at === 'list' ? (
          <>
            <View
              accessibilityLabel={D.nearby}
              style={{ borderTopWidth: 1, borderTopColor: theme.colors.line }}
            >
              {scan === null ? (
                <ListNote text={D.looking} busy />
              ) : 'note' in scan ? (
                <ListNote text={scan.note} />
              ) : scan.rows.length === 0 ? (
                <ListNote text={D.none} />
              ) : (
                scan.rows.map((row) => <NetworkRow key={row.ssid} row={row} onPress={() => choose(row)} />)
              )}
              <ListRow label={D.other} onPress={() => choose(null)}>
                <View style={{ width: 18 }} />
                <Text size={15} weight={500} style={{ flex: 1 }}>
                  {D.other}
                </Text>
                <ChevronRight size={18} color={theme.colors.mut} />
              </ListRow>
            </View>
            <Buttons>
              <Button
                label={D.again}
                variant="secondary"
                disabled={scan === null}
                onPress={() => void look()}
                style={{ flex: 1 }}
              />
              <Button label={D.cancel} variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            </Buttons>
          </>
        ) : null}

        {step.at === 'form' ? (
          <>
            {fields.name ? (
              <>
                <Field
                  label={D.name}
                  value={form.ssid}
                  onChangeText={(ssid) => setForm((f) => ({ ...f, ssid }))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  importantForAutofill="no"
                  spellCheck={false}
                />
                <ErrorLine text={at('name')} />
                <View style={{ gap: 2 }}>
                  <SectionLabel>{D.security.toUpperCase()}</SectionLabel>
                  <Segmented
                    options={(['psk', 'open'] as const).map((s) => ({ value: s, label: D.securities[s] }))}
                    value={form.security}
                    onChange={(security) => setForm((f) => ({ ...f, security }))}
                    label={D.security}
                  />
                </View>
              </>
            ) : null}
            {fields.password ? (
              <>
                <PasswordField
                  label={D.password}
                  value={form.password}
                  onChange={(password) => setForm((f) => ({ ...f, password }))}
                  shown={shown}
                  onToggle={() => setShown((s) => !s)}
                  invalid={at('password') !== null}
                />
                <ErrorLine text={at('password')} />
              </>
            ) : null}
            {fields.savedNote ? (
              <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
                {D.savedNote}
              </Text>
            ) : null}
            {fields.name ? (
              <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
                {D.guard(name)}
              </Text>
            ) : null}
            <ErrorLine text={note} />
            <Buttons>
              <Button
                label={D.back}
                variant="secondary"
                disabled={busy}
                onPress={() => {
                  setStep({ at: 'list' });
                  setForm(EMPTY_WIFI_FORM);
                  setProblem(null);
                  setNote(null);
                }}
                style={{ flex: 1 }}
              />
              <Button
                label={busy ? D.joining : D.join}
                busy={busy}
                onPress={() => void join()}
                style={{ flex: 1 }}
              />
            </Buttons>
          </>
        ) : null}

        {line ? (
          <>
            <View
              accessible
              accessibilityLiveRegion="polite"
              accessibilityLabel={[line.title, line.meta].filter(Boolean).join('. ')}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 56,
                paddingVertical: 12,
                paddingHorizontal: 16,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: theme.colors.line,
                backgroundColor: theme.colors.sf,
              }}
            >
              <ChangeMark dot={line.dot} running={line.running} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text size={15} weight={500} lh={1.35}>
                  {line.title}
                </Text>
                {line.meta ? (
                  <Text size={12} mono lh={1.45} color={theme.colors.mut}>
                    {line.meta}
                  </Text>
                ) : null}
              </View>
            </View>
            <Button
              label={line.running ? D.close : D.done}
              variant={line.running ? 'secondary' : 'primary'}
              onPress={onClose}
            />
          </>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function Buttons({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', gap: 8 }}>{children}</View>;
}

/** A row of the list: 52dp, a hairline under it; dimmed when it can't be chosen. */
function ListRow({
  label,
  disabled = false,
  dimmed = false,
  onPress,
  children,
}: {
  label: string;
  disabled?: boolean;
  dimmed?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      feedback="wash"
      disabled={disabled}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 52,
        paddingVertical: 10,
        paddingHorizontal: 4,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
        opacity: dimmed ? 0.62 : 1,
      }}
    >
      {children}
    </Touchable>
  );
}

/** A network nearby: bars, name over its state or reason, a lock when secured. */
function NetworkRow({ row, onPress }: { row: WifiRowView; onPress: () => void }) {
  const theme = useTheme();
  return (
    <ListRow
      label={row.label}
      disabled={!row.joinable || row.connected}
      dimmed={!row.joinable}
      onPress={onPress}
    >
      <SignalBars signal={row.signal} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={15} weight={500} numberOfLines={1}>
          {row.ssid}
        </Text>
        {row.meta ? (
          <Text size={12.5} lh={1.4} color={row.connected ? theme.colors.ok : theme.colors.mut}>
            {row.meta}
          </Text>
        ) : null}
      </View>
      {row.secured ? <Lock size={14} color={theme.colors.mut} strokeWidth={2} /> : null}
    </ListRow>
  );
}

/** “Looking for networks…” (with a spinner), “No Wi-Fi networks nearby.” or why it couldn't look. */
function ListNote({ text, busy = false }: { text: string; busy?: boolean }) {
  const theme = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 52,
        paddingHorizontal: 4,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      {busy ? <ActivityIndicator size={16} color={theme.colors.mut} /> : null}
      <Text size={14} lh={1.45} color={theme.colors.mut} style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

/**
 * The password: the managed fields' input (48dp, 14 radius) with Show/Hide beside it; never autofilled, corrected or
 * suggested, and masked until shown. Shown, it is Android's visible-password field, which the keyboard neither suggests
 * for nor learns from (AP-3257). React Native applies `keyboardType` before `secureTextEntry`, and `secureTextEntry=
 * {false}` clears the visible-password flags, so Show and Hide make a new field (focused again, the typed text kept)
 * that gets `secureTextEntry` only while hidden.
 */
function PasswordField({
  label,
  value,
  onChange,
  shown,
  onToggle,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  shown: boolean;
  onToggle: () => void;
  invalid: boolean;
}) {
  const theme = useTheme();
  const metrics = textMetrics({ size: 16, family: 'mono' });
  const toggled = useRef(false);
  return (
    <View style={{ gap: 2 }}>
      <SectionLabel>{label.toUpperCase()}</SectionLabel>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <TextInput
          key={shown ? 'shown' : 'hidden'}
          autoFocus={toggled.current}
          value={value}
          onChangeText={onChange}
          accessibilityLabel={label}
          {...(shown ? { keyboardType: 'visible-password' as const } : { secureTextEntry: true })}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
          spellCheck={false}
          textContentType="none"
          placeholderTextColor={theme.colors.placeholder}
          selectionColor={theme.colors.brand}
          style={{
            flex: 1,
            minHeight: 48,
            paddingHorizontal: 14,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: invalid ? theme.colors.bad : theme.colors.line2,
            backgroundColor: theme.colors.sf,
            color: theme.colors.ink,
            fontFamily: metrics.fontFamily,
            fontSize: metrics.fontSize,
            includeFontPadding: false,
          }}
        />
        <Button
          label={shown ? D.hide : D.show}
          accessibilityLabel={shown ? `${D.hide} ${label.toLowerCase()}` : `${D.show} ${label.toLowerCase()}`}
          variant="secondary"
          onPress={() => {
            toggled.current = true;
            onToggle();
          }}
          style={{ minHeight: 48, paddingHorizontal: 14, minWidth: 72 }}
        />
      </View>
    </View>
  );
}
