/**
 * “Keep a way back in” (Whombat backup-options.md BKO-09; app backup-options.md AP-6820…AP-6826; mock 3-bring-back,
 * screen a): the recovery kit kept one or more ways — locked with the person's passkey (recommended; the envelope goes
 * to control, which can't open it), printed (a page with the kit's text and a QR code to scan on a new Whombat), saved
 * as a file. The print is a layout of its own that only paper shows (`@media print`), so `window.print()` prints the
 * kit and nothing else of the page.
 */
import { BACKUP_OPTIONS_TEXT, kitQrPayload } from '@whombat/client/managed';
import { File, Printer, UserKey } from 'lucide-react';
import { useId } from 'react';
import { AuthLayout } from '../app/auth/AuthLayout';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { QrCode } from '../components/QrCode';
import { Tag } from '../components/Tag';
import styles from './bringBack.module.css';
import m from './managed.module.css';

const K = BACKUP_OPTIONS_TEXT.kit;

export interface KitChoices {
  passkey: boolean;
  print: boolean;
  file: boolean;
}

/** What starts ticked: the passkey and the print where a passkey can lock it, else the print and the file. */
export function startingKitChoices(passkeyOffered: boolean): KitChoices {
  return passkeyOffered
    ? { passkey: true, print: true, file: false }
    : { passkey: false, print: true, file: true };
}

export function KeepWayBack({
  name,
  passkeyOffered,
  noPasskeyYet,
  choices,
  onChoices,
  ready,
  busy,
  saved,
  error,
  notice,
  onSave,
  onPrint,
  onDownload,
  onDone,
}: {
  name: string;
  /** The browser offers PRF and control keeps envelopes: “Your passkey” is shown. */
  passkeyOffered: boolean;
  /** No passkey for this Whombat on this account yet: Use my passkey adds one first. */
  noPasskeyYet: boolean;
  choices: KitChoices;
  onChoices: (next: KitChoices) => void;
  /** The kit is made and registered with the box. */
  ready: boolean;
  busy: boolean;
  /** Saved: Done, and the print or file again. */
  saved: boolean;
  error: string | null;
  /** What the kit leaves out (an app that can't write the backup section whole), said above the actions. */
  notice?: string | null;
  onSave: () => void;
  onPrint: () => void;
  onDownload: () => void;
  onDone: () => void;
}) {
  const ids = useId();
  const row = (
    key: keyof KitChoices,
    icon: typeof File,
    title: string,
    meta: string,
    recommended = false,
  ) => (
    <label className={styles.choiceRow} data-kit-way={key}>
      <span className={styles.choiceIcon} aria-hidden="true">
        <Icon icon={icon} size={18} />
      </span>
      <span className={styles.choiceMain}>
        <span className={styles.choiceTitle} id={`${ids}-${key}`}>
          {title}
          {recommended ? (
            <Tag tone="ok" className={styles.recommended}>
              {BACKUP_OPTIONS_TEXT.dialog.recommended}
            </Tag>
          ) : null}
        </span>
        <span className={styles.choiceMeta}>{meta}</span>
      </span>
      <input
        type="checkbox"
        className={styles.checkbox}
        aria-labelledby={`${ids}-${key}`}
        checked={choices[key]}
        disabled={busy || saved}
        onChange={(e) => onChoices({ ...choices, [key]: e.target.checked })}
      />
    </label>
  );
  const any = choices.passkey || choices.print || choices.file;
  return (
    <AuthLayout kicker={K.kicker} title={K.title} sub={K.lead(name)} tip={K.tip}>
      <fieldset className={styles.choices}>
        <legend className={styles.srOnly}>{K.title}</legend>
        {passkeyOffered ? row('passkey', UserKey, K.passkey, K.passkeyMeta, true) : null}
        {row('print', Printer, K.print, K.printMeta)}
        {row('file', File, K.file, K.fileMeta)}
      </fieldset>
      {notice ? (
        <p className={m.status} role="status" data-testid="kit-backup-gap">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className={m.error} role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <>
          <p className={m.status} role="status" data-kit-saved="">
            {K.saved}
          </p>
          <div className={m.actions}>
            <Button variant="primary" size="xl" onClick={onDone}>
              {K.done}
            </Button>
            {choices.print ? (
              <Button variant="link" onClick={onPrint}>
                {K.printAgain}
              </Button>
            ) : null}
            {choices.file ? (
              <Button variant="link" onClick={onDownload}>
                {K.downloadAgain}
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <Button variant="primary" size="xl" block disabled={!ready || busy || !any} onClick={onSave}>
            {busy ? K.saving : choices.passkey ? K.usePasskey : K.save}
          </Button>
          {choices.passkey && noPasskeyYet ? <p className={styles.hint}>{K.noPasskey(name)}</p> : null}
        </>
      )}
    </AuthLayout>
  );
}

/** The printed sheet's words: the recovery kit's, or the paper copy's (`BACKUP_OPTIONS_TEXT.paper`). */
export interface PrintWords {
  printTitle: (name: string) => string;
  printLead: string;
  printScan: string;
}

/** The printed kit or paper copy: only paper shows it (`@media print`). */
export function KitPrintSheet({
  name,
  kitText,
  words = K,
}: {
  name: string;
  kitText: string;
  words?: PrintWords;
}) {
  const qr = kitQrPayload(kitText);
  return (
    // Paper is light: the sheet takes the light theme's tokens whatever the page's.
    <div className={styles.printSheet} data-kit-print="" data-theme="light">
      <h1 className={styles.printTitle}>{words.printTitle(name)}</h1>
      <p className={styles.printLead}>{words.printLead}</p>
      {qr ? (
        <figure className={styles.printQr}>
          <QrCode value={qr} size={220} label={words.printScan} />
          <figcaption>{words.printScan}</figcaption>
        </figure>
      ) : null}
      <pre className={styles.printText}>{kitText}</pre>
    </div>
  );
}
