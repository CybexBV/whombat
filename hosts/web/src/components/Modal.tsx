// Modal dialog on the native <dialog> element: showModal() makes the rest of
// the page inert (focus stays inside), Esc fires `cancel` (closes), focus
// returns to the opener when it closes. Used by the power-action
// confirmation, paste, enrollment and the admin dialogs.

import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { Icon } from './Icon';

interface ModalProps {
  open: boolean;
  /** Esc, the close button and backdrop clicks call this. */
  onClose: () => void;
  title: ReactNode;
  /** Shown under the title and used as the accessible description. */
  description?: ReactNode;
  children?: ReactNode;
  /** Footer buttons (right aligned). */
  actions?: ReactNode;
  /** Wider dialog (enrollment). */
  wide?: boolean;
  /** Prevent closing (while a request is in flight). */
  busy?: boolean;
  /** Ring color for destructive dialogs. */
  tone?: 'default' | 'serious';
  className?: string;
}

export function Modal({ open, onClose, title, description, children, actions, wide, busy, tone = 'default', className }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The content renders only once the dialog is open (showModal in a layout
  // effect), so `autoFocus` inside it works: React focuses on mount, and an
  // element in a closed <dialog> cannot take focus.
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const d = ref.current;
    const opener = document.activeElement;
    if (d && !d.open) d.showModal();
    setShown(true);
    // Closing or unmounting returns focus to the element that opened the dialog.
    return () => {
      if (d?.open) d.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={['modal', wide ? 'modal-wide' : '', tone === 'serious' ? 'is-serious' : '', className ?? ''].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCloseRef.current();
      }}
      onMouseDown={(e) => {
        // Backdrop click: the event target is the dialog itself.
        if (e.target === e.currentTarget && !busy) onCloseRef.current();
      }}
    >
      {shown && (
        <div className="modal-body">
          <div className="modal-head">
            <h2 className="modal-title" id={titleId}>
              {title}
            </h2>
            <button type="button" className="modal-x" aria-label={t('Close')} onClick={() => !busy && onClose()} disabled={busy}>
              <Icon name="close" size={16} />
            </button>
          </div>
          {description && (
            <div className="modal-desc" id={descId}>
              {description}
            </div>
          )}
          {children}
          {actions && <div className="modal-actions">{actions}</div>}
        </div>
      )}
    </dialog>
  );
}
