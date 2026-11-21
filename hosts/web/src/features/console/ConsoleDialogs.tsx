// Confirmation for power actions (REMOTE-CONSOLE 7) and the paste dialog
// (REMOTE-CONSOLE 6.6 / 6.7).

import { useEffect, useId, useState } from 'react';
import { Modal } from '../../components/Modal';
import { t, tx, tn } from '../../lib/i18n';
import type { ActionSpec } from './labels';
import { analyzePaste, formatBytes, PASTE_LIMIT_BYTES, type PasteAnalysis } from './paste';

interface PowerConfirmProps {
  spec: ActionSpec | null;
  guestName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Names the guest and the action; the primary button carries the action
 * ("Shut down web-01"). Hard power-offs (Force stop, Stop) use the serious
 * color and need the guest name typed as an extra step. Esc cancels.
 */
export function PowerConfirmDialog({ spec, guestName, onCancel, onConfirm }: PowerConfirmProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  useEffect(() => setTyped(''), [spec]);
  if (!spec) return null;
  const ready = !spec.serious || typed.trim() === guestName;
  const verb = spec.confirmButton(guestName);
  return (
    <Modal
      open
      onClose={onCancel}
      tone={spec.serious ? 'serious' : 'default'}
      title={spec.confirmTitle(guestName)}
      description={spec.explain(guestName)}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onCancel} autoFocus={!spec.serious}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className={`btn-primary btn-sm${spec.serious ? ' is-serious' : ''}`}
            aria-disabled={!ready || undefined}
            onClick={() => ready && onConfirm()}
          >
            {verb}
          </button>
        </>
      }
    >
      {spec.serious && (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) onConfirm();
          }}
        >
          <label className="field-label" htmlFor={inputId}>
            {tx('Type {name} to confirm', { name: <span className="mono">{guestName}</span> })}
          </label>
          <input
            id={inputId}
            className="input mono"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </form>
      )}
    </Modal>
  );
}

export type PasteDialogState =
  | { mode: 'input' }
  /** The text contains control characters: paste without them, raw, or cancel. */
  | { mode: 'control'; analysis: PasteAnalysis };

interface PasteDialogProps {
  state: PasteDialogState | null;
  guestName: string;
  onCancel: () => void;
  /** Send this text; raw = keep control characters. */
  onSend: (text: string, raw: boolean) => void;
}

export function PasteDialog({ state, guestName, onCancel, onSend }: PasteDialogProps) {
  const [text, setText] = useState('');
  const [analysis, setAnalysis] = useState<PasteAnalysis | null>(null);
  const areaId = useId();
  const infoId = useId();
  useEffect(() => {
    setText('');
    setAnalysis(state?.mode === 'control' ? state.analysis : null);
  }, [state]);
  if (!state) return null;

  // After typing / pasting into the box, a text with control characters switches to the choice view.
  const a = analysis;
  if (a && a.controlCount > 0) {
    const names = a.controlNames.join(', ');
    return (
      <Modal
        open
        onClose={onCancel}
        title={t('The text contains control characters')}
        description={
          a.controlCount === 1
            ? tx('{n} control character ({names}) can trigger actions in {name}, for example escape sequences or Ctrl+C. Pasting without them sends only text, newlines and tabs.', {
                n: a.controlCount,
                names: `${names}${a.controlCount > a.controlNames.length ? ', …' : ''}`,
                name: <span className="mono">{guestName}</span>,
              })
            : tx('{n} control characters ({names}) can trigger actions in {name}, for example escape sequences or Ctrl+C. Pasting without them sends only text, newlines and tabs.', {
                n: a.controlCount,
                names: `${names}${a.controlCount > a.controlNames.length ? ', …' : ''}`,
                name: <span className="mono">{guestName}</span>,
              })
        }
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={onCancel}>
              {t('Cancel')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => onSend(a.normalized, true)}>
              {t('Paste raw')}
            </button>
            <button type="button" className="btn-primary btn-sm" autoFocus onClick={() => onSend(a.sanitized, false)}>
              {t('Paste without them')}
            </button>
          </>
        }
      />
    );
  }

  const cur = text ? analyzePaste(text) : null;
  const tooLarge = cur?.tooLarge ?? false;
  const submit = () => {
    if (!cur || !cur.normalized || tooLarge) return;
    if (cur.controlCount > 0) setAnalysis(cur);
    else onSend(cur.sanitized, false);
  };
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('Paste into {name}', { name: guestName })}
      description={t('The browser did not give access to the clipboard. Paste the text here (Ctrl+V or ⌘V), then send it to the guest.')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn-primary btn-sm" aria-disabled={!cur?.normalized || tooLarge || undefined} onClick={submit}>
            {t('Send to {name}', { name: guestName })}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label" htmlFor={areaId}>
          {t('Text to paste')}
        </label>
        <textarea
          id={areaId}
          className="input mono"
          autoFocus
          spellCheck={false}
          value={text}
          aria-describedby={infoId}
          aria-invalid={tooLarge || undefined}
          onChange={(e) => setText(e.target.value)}
        />
        <div id={infoId} className={tooLarge ? 'field-error' : 'field-hint'} aria-live="polite">
          {tooLarge
            ? t('The text is {size}; the limit is {limit}.', { size: formatBytes(cur!.bytes), limit: formatBytes(PASTE_LIMIT_BYTES) })
            : cur
              ? `${t('{size} of {limit}', { size: formatBytes(cur.bytes), limit: formatBytes(PASTE_LIMIT_BYTES) })}${cur.controlCount ? ` · ${tn(cur.controlCount, '{n} control character', '{n} control characters')}` : ''}`
              : t('Up to {limit} of text.', { limit: formatBytes(PASTE_LIMIT_BYTES) })}
        </div>
      </div>
    </Modal>
  );
}
