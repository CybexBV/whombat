/**
 * Small pieces of the catalog pages (AP-756, AP-757): a form field in the Google page's language, a field's choices as
 * radio cards, an outside link, and numbered steps with values to copy.
 */
import { CONNECT_FORM_TEXT } from '@whombat/client/connections';
import type { ReactNode } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import k from './Catalog.module.css';
import c from './Connectors.module.css';

/**
 * A field's choices as radio cards (a `select`'s own options, Find My's Read in the background; or a `fromService`
 * field's, Find My's Mac): the mono label as the group's name, a card per choice, the help and the problem under them.
 */
export function OptionCards({
  name,
  label,
  help,
  problem,
  options,
  value,
  disabled = false,
  onChange,
}: {
  /** The radio group's name, unique on the page. */
  name: string;
  label: string;
  help?: string | null;
  problem?: string | null;
  options: readonly { value: string; label: string; line?: string | null }[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className={k.fieldset} data-options={name}>
      <legend className={c.fieldLabel}>{label.toUpperCase()}</legend>
      <div className={k.scopes}>
        {options.map((o) => (
          <label key={o.value} className={k.scope}>
            <input
              type="radio"
              name={name}
              className={k.radio}
              value={o.value}
              checked={value === o.value}
              disabled={disabled}
              onChange={() => onChange(o.value)}
            />
            <span className={k.scopeText}>
              <span className={k.scopeTitle}>{o.label}</span>
              {o.line ? <span className={c.meta}>{o.line}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {problem ? (
        <p className={c.error} role="alert">
          {problem}
        </p>
      ) : null}
      {help ? <p className={`${c.hint} ${k.narrow}`}>{help}</p> : null}
    </fieldset>
  );
}

/** One form field: the mono label, the input (and a button beside it), the help, a deep link, the problem. */
export function Field({
  id,
  label,
  help,
  problem,
  link,
  after,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  problem?: string;
  link?: ReactNode;
  after?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={k.field}>
      <label className={c.fieldLabel} htmlFor={id}>
        {label.toUpperCase()}
      </label>
      {after ? (
        <div className={k.inputRow}>
          {children}
          {after}
        </div>
      ) : (
        children
      )}
      {problem ? (
        <p className={c.error} role="alert">
          {problem}
        </p>
      ) : null}
      {help || link ? (
        <p className={c.hint}>
          {help}
          {help && link ? ' ' : null}
          {link}
        </p>
      ) : null}
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className={c.externalLink} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Icon name="external" size={13} />
      <span className={c.srOnly}> (opens in a new tab)</span>
    </a>
  );
}

/** Numbered steps with values to copy (CS-15): a token's made by hand, a pairing code's. Nothing without steps. */
export function GuideSteps({
  label,
  steps,
}: {
  /** The list's name for a screen reader: “Making the token”. */
  label: string;
  steps: readonly { text: string; values: readonly { label: string; value: string }[] }[];
}) {
  if (!steps.length) return null;
  return (
    <ol className={k.guide} aria-label={label}>
      {steps.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the steps are fixed for the entry; their number is their key
        <li key={i} className={k.guideStep}>
          <span className={k.guideNumber} aria-hidden="true">
            {i + 1}
          </span>
          <div className={k.guideMain}>
            <p className={k.guideText}>{s.text}</p>
            {s.values.length > 0 && (
              <dl className={c.copyList}>
                {s.values.map((v) => (
                  <CopyRow key={v.label} label={v.label} value={v.value} />
                ))}
              </dl>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <CopyButton text={value} copied={CONNECT_FORM_TEXT.copied(label)} className={c.copyButton}>
        {CONNECT_FORM_TEXT.copy}
        <span className={c.srOnly}> {label.toLowerCase()}</span>
      </CopyButton>
    </>
  );
}
