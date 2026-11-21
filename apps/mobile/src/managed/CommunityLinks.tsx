/**
 * The QR code a community box makes for one more of your devices, on the phone (Whombat hermes-engine.md HE-60;
 * hermes-engine-app.md AP-5474): a five-minute code (`enroll.link.create`) to scan, the link in mono to read, and Copy;
 * nothing goes through control. Not mocked: the rows of Devices.
 */

import { LINK_TEXT, linkErrorText, linkTimeLeft } from '@whombat/client/managed';
import { type DeviceLinkCreated, sessionOps } from '@whombat/client/session';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { copyToClipboard } from '../ui/clipboard';
import { Button } from '../ui/primitives';
import { QrCode } from '../ui/QrCode';
import { useManagedOrThrow } from './context';
import { Note } from './ui';

/** The QR code on its light plate, the link beneath in mono (selectable), then the actions. */
function LinkPanel({
  link,
  label,
  note,
  children,
}: {
  link: string;
  label: string;
  note?: string | null;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ padding: 16, gap: 12 }}>
      <View style={{ alignItems: 'center', paddingVertical: 4 }} testID="link-qr">
        <QrCode value={link} size={232} label={label} />
      </View>
      <Note text={note} />
      <Text size={12.5} mono selectable lh={1.45} color={theme.colors.ink2} testID="local-link">
        {link}
      </Text>
      {children}
    </View>
  );
}

/**
 * Add a device with a QR code (community; AP-5474): `enroll.link.create` makes a code for one more device of this
 * account, good for five minutes, counted down here; when it runs out, New code. Rendered inside ADD A DEVICE.
 */
export function DeviceLinkCard() {
  const { session } = useManagedOrThrow();
  const theme = useTheme();
  const t = LINK_TEXT.device;
  const [made, setMade] = useState<DeviceLinkCreated | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!made) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [made]);
  const make = async () => {
    setBusy(true);
    setNote(null);
    try {
      setMade(await sessionOps.linkCreate(session));
      setNow(Date.now());
    } catch (error) {
      setNote(linkErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  const left = made ? linkTimeLeft(made.expiresAt, now) : null;
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.line }}>
      {made && left ? (
        <LinkPanel link={made.link} label={t.qrLabel} note={`${t.meta} ${t.left(left)}`}>
          <Button
            label={t.copy}
            variant="secondary"
            onPress={() => void copyToClipboard(made.link, t.copied)}
          />
          <Button label={t.hide} variant="quiet" onPress={() => setMade(null)} />
        </LinkPanel>
      ) : (
        <View style={{ padding: 16, gap: 12 }}>
          <Text size={15} weight={500}>
            {t.section}
          </Text>
          <Note text={made ? t.over : t.meta} />
          <Note text={note} />
          <Button
            label={busy ? t.making : made ? t.again : t.make}
            variant="secondary"
            busy={busy}
            onPress={() => void make()}
          />
        </View>
      )}
    </View>
  );
}
