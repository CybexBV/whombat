/**
 * Pieces of the phone's connect screens (phone-connect.md PC-03, PC-05, PC-11; AP-2903…AP-2915): the scrolling page and
 * its sticky footer (Add a server's), a step's header, a text link, what an address turned out to be, a certificate
 * to compare and trust, the guided token (its steps with values to copy, Open {Name}, paste from the clipboard or a
 * file), More options' fold and the wait for a sign-in in the browser (Nextcloud's login, the service's own page: Plex's,
 * with a code to type where the service gives one; connection-signin-android.md AP-3951). The words are the web's
 * (`@whombat/client/connections`).
 */
import {
  CONNECT_FORM_TEXT,
  filledText,
  guidedLink,
  guidedSteps,
  guideLabel,
  type IdentifyNote,
  minutesLeftText,
  readPaste,
  SERVICE_LOGIN_WAIT_TEXT,
  takesPaste,
  trustText,
} from '@whombat/client/connections';
import type { CatalogEntry, CatalogSignIn, ConnectionAccessLevel } from '@whombat/core/domain';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { type ReactNode, type RefObject, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { type PendingLogin, underLabel, waitEnds, waitWords } from '../../data/connectForm';
import { TAB_WORDS } from '../../data/shell';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { copyToClipboard } from '../../ui/clipboard';
import { ChevronDown, ChevronUp } from '../../ui/icons';
import { bottomPadding } from '../../ui/insets';
import { useKeyboardPadding } from '../../ui/keyboard';
import { Button, StatusDot, toneColor } from '../../ui/primitives';
import { Touchable } from '../../ui/Touchable';

export type GuidedMethod = Extract<CatalogSignIn, { kind: 'token' | 'client_credentials' }>;

/** “‹ …” for a screen a link opened: what lies under it (`underLabel`). */
export function backUnder(
  state: { routes: readonly { key: string; name: string; params?: unknown; state?: unknown }[] },
  key: string,
): string {
  const at = state.routes.findIndex((r) => r.key === key);
  return underLabel(state.routes[(at < 0 ? state.routes.length : at) - 1], TAB_WORDS);
}

/** No autofill, autocorrect or suggestions on an address, an account or a name (and no “save password?”). */
export const PLAIN_INPUT = {
  autoCapitalize: 'none',
  autoCorrect: false,
  autoComplete: 'off',
  importantForAutofill: 'no',
  spellCheck: false,
  textContentType: 'none',
} as const;

/** The page: what scrolls, and its buttons in a footer the keyboard pushes up (Add a server's, AP-1697). */
export function Panel({
  children,
  footer,
  scrollRef,
}: {
  children: ReactNode;
  footer: ReactNode;
  /** To bring a field into sight that appeared below (the code sign in once asks for). */
  scrollRef?: RefObject<ScrollView | null>;
}) {
  return (
    <>
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 4, paddingBottom: 24, gap: 18 }}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
      {footer}
    </>
  );
}

export function Footer({ bottomInset, children }: { bottomInset: number; children: ReactNode }) {
  const theme = useTheme();
  // With the keyboard up the gesture area is under it: the footer sits on the keyboard and moves with it (the
  // composer's rule).
  const padding = useKeyboardPadding(bottomPadding(36, bottomInset, 12), 12);
  return (
    <Reanimated.View
      style={[
        {
          gap: 10,
          paddingTop: 10,
          paddingHorizontal: 16,
          borderTopWidth: 1,
          borderTopColor: theme.colors.line,
          backgroundColor: theme.colors.bg,
        },
        padding,
      ]}
    >
      {children}
    </Reanimated.View>
  );
}

export function Title({ children }: { children: string }) {
  return (
    <Text
      size={28}
      weight={700}
      lh={1.15}
      tracking={-0.02}
      accessibilityRole="header"
      style={{ flexShrink: 1 }}
    >
      {children}
    </Text>
  );
}

/** A 44dp text button in `brand` (“Documentation”, “Open Proxmox VE”); `external` adds ↗ and says it opens elsewhere. */
export function TextLink({
  label,
  onPress,
  external = false,
}: {
  label: string;
  onPress: () => void;
  external?: boolean;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="fade"
      ringRadius={8}
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={label}
      accessibilityHint={external ? 'Opens in your browser' : undefined}
      style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
    >
      <Text size={14} weight={500} color={theme.colors.brand}>
        {external ? `${label} ↗` : label}
      </Text>
    </Touchable>
  );
}

/** Opens a page outside the app (a service's own site), never one of this Whombat's. */
export function openOutside(url: string | null | undefined) {
  if (url) void Linking.openURL(url).catch(() => {});
}

/** A step's header (PC-11: step titles as section headers): its number in a ring (filled once done) and its title. */
export function StepHeader({ number, title, done }: { number: number; title: string; done: boolean }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={`Step ${number}: ${title}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          borderWidth: done ? 0 : 1.5,
          borderColor: theme.colors.line2,
          backgroundColor: done ? theme.colors.ok : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text size={12.5} weight={600} mono color={done ? theme.colors.bg : theme.colors.ink2}>
          {String(number)}
        </Text>
      </View>
      <Text size={17} weight={600} style={{ flex: 1 }}>
        {title}
      </Text>
    </View>
  );
}

/** A quiet line (13.5 `mut`). */
export function Note({ children, tone }: { children: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const theme = useTheme();
  return (
    <Text size={13.5} lh={1.45} color={tone ? toneColor(theme, tone) : theme.colors.mut}>
      {children}
    </Text>
  );
}

/** “Looking at the address…” with a spinner, read out. */
export function Busy({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={text}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
    >
      <ActivityIndicator size="small" color={theme.colors.brand} />
      <Text size={13.5} color={theme.colors.mut}>
        {text}
      </Text>
    </View>
  );
}

/** What answers at the address (CS-13): a dot in its tone, the service and version, and a line. */
export function FoundNote({ note }: { note: IdentifyNote }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${note.title}. ${note.text}`}
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}
    >
      <View style={{ paddingTop: 6 }}>
        <StatusDot color={toneColor(theme, note.tone)} label={note.title} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text size={15} weight={600}>
          {note.title}
        </Text>
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {note.text}
        </Text>
      </View>
    </View>
  );
}

/**
 * A certificate of the server's own (CS-05): its fingerprint to compare with what the service shows, and Trust this
 * certificate, which fills the entry's fingerprint field. Entries that can't pin one only say it can't be verified.
 */
export function CertificateNote({
  entry,
  sha256,
  canPin,
  pinned,
  onTrust,
  onUndo,
}: {
  entry: CatalogEntry;
  sha256: string;
  canPin: boolean;
  pinned: boolean;
  onTrust: () => void;
  onUndo: () => void;
}) {
  const theme = useTheme();
  if (pinned)
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StatusDot color={theme.colors.ok} label={CONNECT_FORM_TEXT.trusted} size={7} />
        <Text size={13.5} lh={1.45} style={{ flex: 1 }}>
          {CONNECT_FORM_TEXT.trusted}
        </Text>
        <Button label={CONNECT_FORM_TEXT.undo} variant="quiet" onPress={onUndo} />
      </View>
    );
  return (
    <View
      style={{
        gap: 8,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
        {canPin ? CONNECT_FORM_TEXT.ownCertificate : CONNECT_FORM_TEXT.unverifiable}
      </Text>
      <Text size={12} lh={1.5} mono selectable>
        {sha256}
      </Text>
      {canPin ? (
        <>
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {trustText(entry)}
          </Text>
          <Button label={CONNECT_FORM_TEXT.trust} variant="secondary" onPress={onTrust} />
        </>
      ) : null}
    </View>
  );
}

/** Numbered steps with values to copy (CS-15): a token's made by hand, a pairing code's. Nothing without steps. */
export function GuideSteps({
  label,
  steps,
}: {
  /** The steps' name for a screen reader: “Making the token”. */
  label: string;
  steps: readonly { text: string; values: readonly { label: string; value: string }[] }[];
}) {
  const theme = useTheme();
  if (!steps.length) return null;
  return (
    <View accessibilityLabel={label} style={{ gap: 12 }}>
      {steps.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the steps are fixed for the entry; their number is their key
        <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
          <Text size={13.5} weight={600} mono color={theme.colors.mut} style={{ width: 18 }}>
            {`${i + 1}.`}
          </Text>
          <View style={{ flex: 1, gap: 8 }}>
            <Text size={14} lh={1.45}>
              {s.text}
            </Text>
            {s.values.map((v) => (
              <CopyRow key={v.label} label={v.label} value={v.value} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/** What the paste button and the file say: what it filled, or that it found nothing. */
interface PasteNote {
  text: string;
  ok: boolean;
}

/**
 * Making the token by hand, guided (CS-15): the numbered steps with values to copy, “Open {Name}” where the key is made
 * (the level's link fills the service's form), and the paste button — the clipboard as it is when pressed, which fills
 * what it finds the way a dropped file does on the web — and Choose a file (at most 64 kB, deleted from the cache at
 * once). Nothing it read stays anywhere but in the form.
 */
export function GuidedToken({
  entry,
  method,
  fields,
  access,
  pasteLabel,
  openLabel,
  onPaste,
}: {
  entry: CatalogEntry;
  method: GuidedMethod;
  fields: Readonly<Record<string, string>>;
  access: ConnectionAccessLevel;
  pasteLabel: string;
  openLabel: string;
  /** Fills the form from a text; what it filled in words, or null when it found nothing. */
  onPaste: (text: string) => string | null;
}) {
  const theme = useTheme();
  const [note, setNote] = useState<PasteNote | null>(null);
  const steps = guidedSteps(entry, method, fields);
  const link = guidedLink(entry, method, access, fields);

  function take(text: string) {
    if (!text.trim()) return setNote({ text: CONNECT_FORM_TEXT.pasteNothing, ok: false });
    const filled = onPaste(text);
    setNote(filled ? { text: filled, ok: true } : { text: CONNECT_FORM_TEXT.pasteNothing, ok: false });
  }

  async function fromClipboard() {
    try {
      take(await Clipboard.getStringAsync());
    } catch {
      setNote({ text: CONNECT_FORM_TEXT.pasteNothing, ok: false });
    }
  }

  async function fromFile() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['text/plain', 'application/json', '*/*'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return;
    const file = new File(asset.uri);
    try {
      if ((asset.size ?? 0) > 64_000) return setNote({ text: CONNECT_FORM_TEXT.fileTooBig, ok: false });
      take(await file.text());
    } catch {
      setNote({ text: CONNECT_FORM_TEXT.pasteNothing, ok: false });
    } finally {
      // The picker's copy goes at once: a key never stays on the phone.
      try {
        file.delete();
      } catch {
        // already gone
      }
    }
  }

  if (!steps.length && !method.paste.length) return null;
  return (
    <View style={{ gap: 14 }}>
      <GuideSteps label={guideLabel(method)} steps={steps} />
      {link ? (
        <Button label={`${openLabel} ↗`} variant="secondary" onPress={() => openOutside(link)} />
      ) : null}
      {/* Stacked, full width: a long name (Nginx Proxy Manager) never cuts the paste button's words off. A session's
          password is the person's own: nothing to paste (AP-3807). */}
      {takesPaste(method) ? (
        <View style={{ gap: 8 }}>
          <Button label={pasteLabel} variant="secondary" onPress={() => void fromClipboard()} />
          <Button label={CONNECT_FORM_TEXT.chooseFile} variant="secondary" onPress={() => void fromFile()} />
          {note ? (
            <Text
              size={13}
              lh={1.4}
              color={note.ok ? theme.colors.ok : theme.colors.bad}
              accessibilityLiveRegion="polite"
            >
              {note.text}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A value to copy in a guided step: its label, the value in mono, Copy. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, paddingVertical: 6 }}>
        <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
          {label.toUpperCase()}
        </Text>
        <Text size={12.5} mono selectable numberOfLines={3}>
          {value}
        </Text>
      </View>
      <Touchable
        onPress={() => void copyToClipboard(value, CONNECT_FORM_TEXT.copied(label))}
        feedback="wash"
        ringRadius={10}
        accessibilityLabel={`${CONNECT_FORM_TEXT.copy} ${label.toLowerCase()}`}
        style={{
          minHeight: 44,
          minWidth: 64,
          paddingHorizontal: 12,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text size={14} weight={500} color={theme.colors.brand}>
          {CONNECT_FORM_TEXT.copy}
        </Text>
      </Touchable>
    </View>
  );
}

/** More options' toggle (CS-50): the chevron, its words, and the summary while it's closed. */
export function MoreToggle({
  open,
  summary,
  onPress,
}: {
  open: boolean;
  summary: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <Touchable
      onPress={onPress}
      feedback="fade"
      ringRadius={8}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={
        open ? CONNECT_FORM_TEXT.moreOptions : `${CONNECT_FORM_TEXT.moreOptions}. ${summary}`
      }
      style={{ minHeight: 44, justifyContent: 'center', gap: 2 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Text size={14} weight={600} color={theme.colors.brand}>
          {CONNECT_FORM_TEXT.moreOptions}
        </Text>
        <Chevron size={15} color={theme.colors.brand} strokeWidth={2} />
      </View>
      {open ? null : (
        <Text size={13} lh={1.4} color={theme.colors.mut} numberOfLines={2}>
          {summary}
        </Text>
      )}
    </Touchable>
  );
}

/**
 * Waiting for a sign-in in the browser (CX-11; SG-01, SG-05: “as Nextcloud's”): Nextcloud's login or the service's own
 * page is open there; Whombat asks every `pollEveryMs` (the screen's poll) until it connects, the flow expires (at most
 * 10 minutes) or fails. A device-code service's code shows large with Copy, above the button that opens the page again
 * (AP-3951). The words are the web's, with the browser.
 */
export function LoginWaitView({ login, onCancel }: { login: PendingLogin; onCancel: () => void }) {
  const theme = useTheme();
  const [now, setNow] = useState(() => Date.now());
  const [ends] = useState(() => waitEnds(login, Date.now()));
  const words = waitWords(login);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={{ gap: 14 }} accessibilityLiveRegion="polite">
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <ActivityIndicator color={theme.colors.brand} style={{ marginTop: 2 }} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text size={16} weight={600}>
            {words.title}
          </Text>
          <Text size={13.5} lh={1.45} color={theme.colors.mut}>
            {`${words.line} · ${minutesLeftText(ends, now)}`}
          </Text>
        </View>
      </View>
      {words.code ? <UserCode text={words.code.text} value={words.code.value} /> : null}
      <Button
        label={`${words.open} ↗`}
        variant="secondary"
        accessibilityHint="Opens in your browser"
        onPress={() => openOutside(login.flow.loginUrl)}
      />
      <Button label={words.cancel} variant="quiet" onPress={onCancel} />
    </View>
  );
}

/** A code to type on the service's page (`userCode`, CT-738): what to do with it, the code large in mono, Copy. */
function UserCode({ text, value }: { text: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: 10,
        padding: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
        {text}
      </Text>
      <Text
        size={26}
        weight={600}
        mono
        tracking={0.08}
        selectable
        // “Code: K 7 Q F …”, read a character at a time, as it is typed.
        accessibilityLabel={`${SERVICE_LOGIN_WAIT_TEXT.codeLabel}: ${value.split('').join(' ')}`}
      >
        {value}
      </Text>
      <Button
        label={CONNECT_FORM_TEXT.copy}
        variant="secondary"
        accessibilityLabel={`${CONNECT_FORM_TEXT.copy} ${value}`}
        onPress={() => void copyToClipboard(value, SERVICE_LOGIN_WAIT_TEXT.codeCopied)}
      />
    </View>
  );
}

/** Reads a paste with the method's patterns and says what it filled (CS-15). */
export function pasteFill(entry: CatalogEntry, method: GuidedMethod, text: string) {
  const found = readPaste(entry, method, text);
  return found ? { ...found, text: filledText(found.filled) } : null;
}
