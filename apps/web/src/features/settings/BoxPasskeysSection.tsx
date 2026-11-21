/**
 * Devices → PASSKEYS on a box with its own address, on its own pages (Whombat own-address.md; design §7.5): the box's
 * own passkeys, under its host. Add one on this device (at the address only: another page is another RP ID), see them
 * and remove them. The hosted app's shared passkey isn't offered here: inside the own address it can't open the box.
 */
import {
  ago,
  boxPasskeyOutcome,
  createBoxPasskey,
  OWN_ADDRESS_TEXT,
  PASSKEY_COPY,
  PasskeyCancelled,
  PRIVACY_PAGE_URL,
  passkeyErrorText,
  passkeyMeta,
} from '@whombat/client/managed';
import { type OwnAddressSummary, type PasskeysList, sessionOps } from '@whombat/client/session';
import { useCallback, useEffect, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import { browserLabel } from '../../managed/keys';
import { PASSKEYS, webAuthnExists } from '../../managed/passkeyEnv';
import styles from './SettingsScreen.module.css';

const T = OWN_ADDRESS_TEXT.settings;

export function BoxPasskeysSection({ own, onChanged }: { own: OwnAddressSummary; onChanged?: () => void }) {
  const { session, managed } = useAppServices();
  const toast = useToast();
  const [list, setList] = useState<PasskeysList | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => {
    sessionOps.passkeysList(session).then(setList, () => setList(null));
  }, [session]);
  useEffect(load, [load]);
  const atAddress = window.location.hostname === own.host;
  const mine = (list?.passkeys ?? []).filter((p) => p.rpId === own.host);
  const add = async () => {
    if (!managed) return;
    setBusy(true);
    setNote(null);
    try {
      const made = await createBoxPasskey({
        session,
        platform: PASSKEYS,
        appliance: managed.appliancePeerId,
        name: browserLabel(),
      });
      setNote(boxPasskeyOutcome(made));
      onChanged?.();
    } catch (error) {
      if (!(error instanceof PasskeyCancelled)) setNote(passkeyErrorText(error) ?? T.failed);
    } finally {
      setBusy(false);
      load();
    }
  };
  const remove = async (id: string, name: string) => {
    if (!window.confirm(PASSKEY_COPY.removeConfirm(name))) return;
    try {
      await sessionOps.passkeyRemove(session, id);
      toast.show(PASSKEY_COPY.removed);
    } catch (error) {
      setNote(passkeyErrorText(error) ?? T.failed);
    }
    load();
    onChanged?.();
  };
  const canAdd = atAddress && webAuthnExists();
  return (
    <section className={styles.section} aria-label={T.passkeys} id="passkeys" data-box-passkeys="">
      <SectionLabel as="h2">{T.passkeys}</SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.passkeySet} aria-hidden="true">
            <Icon name="key" size={18} />
          </span>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{mine.length ? T.passkeyReady : T.passkeyNone}</span>
            <span className={styles.rowMeta}>
              <span>
                {OWN_ADDRESS_TEXT.passkey.words}{' '}
                <a href={PRIVACY_PAGE_URL} target="_blank" rel="noopener noreferrer">
                  {OWN_ADDRESS_TEXT.passkey.why}
                </a>
              </span>
            </span>
            {!atAddress ? (
              <span className={styles.rowMeta}>
                <span>
                  {T.passkeyElsewhere} <a href={own.url}>{own.host}</a>
                </span>
              </span>
            ) : !webAuthnExists() ? (
              <span className={styles.rowMeta}>{T.passkeyNoWebAuthn}</span>
            ) : null}
            {note ? (
              <span className={styles.rowMeta} role="status">
                {note}
              </span>
            ) : null}
          </span>
          {canAdd ? (
            <Button variant="secondary" size="sm" disabled={busy || !list} onClick={() => void add()}>
              {busy ? T.passkeyAdding : T.passkeyAdd}
            </Button>
          ) : null}
        </div>
        {mine.map((p) => (
          <div key={p.id} className={styles.row} data-row="box-passkey">
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{p.name}</span>
              <span className={styles.rowMeta}>{passkeyMeta(p, ago)}</span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void remove(p.id, p.name)}
              aria-label={`${PASSKEY_COPY.remove} ${p.name}`}
            >
              {PASSKEY_COPY.remove}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
