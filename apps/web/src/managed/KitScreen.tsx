/**
 * “Keep a way back in” (Whombat backup-options.md BKO-09; app backup-options.md AP-6820…AP-6826; mock 3-bring-back,
 * screen a): the recovery kit kept one or more ways — locked with the person's passkey (recommended; the envelope goes
 * to control, which can't open it), printed (a page with the kit's text and a QR code to scan on a new Whombat), saved
 * as a file. The print is a layout of its own that only paper shows (`@media print`), so `window.print()` prints the
 * kit and nothing else of the page.
 */
import { kitQrPayload } from '@whombat/client/managed';
import { File, Printer, UserKey } from 'lucide-react';
import { useId, useMemo } from 'react';
import { AuthLayout } from '../app/auth/AuthLayout';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { QrCode } from '../components/QrCode';
import { Tag } from '../components/Tag';
import { useWebI18n, type WebTranslator, webTranslator } from '../i18n/provider';
import styles from './bringBack.module.css';
import m from './managed.module.css';

/** The recovery kit's words in the page's language. */
function kitWords(t: WebTranslator['t']) {
  return {
    title: t('kit.title'),
    lead: (name: string) => t('kit.lead', { name }),
    passkey: t('kit.passkey'),
    passkeyMeta: t('kit.passkeyMeta'),
    print: t('kit.print'),
    printMeta: t('kit.printMeta'),
    file: t('kit.file'),
    fileMeta: t('kit.fileMeta'),
    usePasskey: t('kit.usePasskey'),
    noPasskey: (name: string) => t('kit.noPasskey', { name }),
    saved: t('kit.saved'),
    kicker: t('kit.kicker'),
    tip: t('kit.tip'),
    save: t('kit.save'),
    saving: t('kit.saving'),
    printAgain: t('kit.printAgain'),
    downloadAgain: t('kit.downloadAgain'),
    done: t('kit.done'),
    recommended: t('kit.recommended'),
  };
}

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
  const { t } = useWebI18n();
  const K = useMemo(() => kitWords(t), [t]);
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
              {K.recommended}
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

/** Which printed sheet: the recovery kit's, or the backups' paper copy. */
export type PrintKind = 'kit' | 'paper';

const PRINT_KEYS = {
  kit: { title: 'kit.printTitle', lead: 'kit.printLead', scan: 'kit.printScan' },
  paper: { title: 'paper.printTitle', lead: 'paper.printLead', scan: 'paper.printScan' },
} as const;

/**
 * The printed kit or paper copy: only paper shows it (`@media print`). In another language than English the sheet
 * also carries its English title, so whoever helps with a restore later can read what it is; the kit's own text stays
 * as it is, so it scans and checks the same in every language.
 */
export function KitPrintSheet({
  name,
  kitText,
  kind = 'kit',
}: {
  name: string;
  kitText: string;
  kind?: PrintKind;
}) {
  const { t, language } = useWebI18n();
  const keys = PRINT_KEYS[kind];
  const english = language === 'en' ? null : webTranslator('en-GB').t(keys.title, { name });
  const qr = kitQrPayload(kitText);
  const scan = t(keys.scan);
  return (
    // Paper is light: the sheet takes the light theme's tokens whatever the page's.
    <div className={styles.printSheet} data-kit-print="" data-theme="light">
      <h1 className={styles.printTitle}>{t(keys.title, { name })}</h1>
      {english ? (
        <p className={styles.printLead} lang="en">
          {english}
        </p>
      ) : null}
      <p className={styles.printLead}>{t(keys.lead)}</p>
      {qr ? (
        <figure className={styles.printQr}>
          <QrCode value={qr} size={220} label={scan} />
          <figcaption>{scan}</figcaption>
        </figure>
      ) : null}
      <pre className={styles.printText} lang="en">
        {kitText}
      </pre>
    </div>
  );
}
