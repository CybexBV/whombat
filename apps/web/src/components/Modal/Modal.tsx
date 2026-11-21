import * as Dialog from '@radix-ui/react-dialog';
import { type ReactNode, useRef } from 'react';
import { cx } from '../cx';
import styles from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /**
   * Accessible title. Rendered visually hidden; if the modal shows its own heading, wrap that in
   * `<ModalTitle>` instead and omit this.
   */
  title?: string;
  /** `md` 560px (approval), `lg` 760px, `console` 1080px (a server's console). */
  width?: 'md' | 'lg' | 'console';
  /**
   * Default layout: 28px padding, column with 22px gap (approval modal). Pass `false` to lay out
   * the content yourself (a two-column grid with no padding).
   */
  padded?: boolean;
  className?: string;
  /** Portal container; defaults to `document.body`. */
  container?: HTMLElement | null;
  /** Esc was pressed; `preventDefault()` keeps the modal open (a server console whose screen has the keyboard). */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}

/**
 * Modal dialog (Radix Dialog). Overlay var(--ov); closes on overlay click and Esc; 22px radius,
 * bg background, modal shadow; `width: min(100%, 560|760|1080px)`. On close, focus returns to whatever had
 * it when the modal opened (Radix only returns it to a `Dialog.Trigger`, which our modals don't use).
 */
export function Modal({
  open,
  onOpenChange,
  children,
  title,
  width = 'md',
  padded = true,
  className,
  container,
  onEscapeKeyDown,
}: ModalProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className={styles.overlay} data-testid="modal-overlay">
          <Dialog.Content
            className={cx(styles.content, styles[width], padded && styles.padded, className)}
            aria-describedby={undefined}
            onEscapeKeyDown={onEscapeKeyDown}
            // Focus the dialog itself (not its first control) so no focus ring appears on open,
            // matching the mock; Tab then moves into the content.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              returnFocus.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
              (event.currentTarget as HTMLElement | null)?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (returnFocus.current?.isConnected) returnFocus.current.focus();
              returnFocus.current = null;
            }}
          >
            {title && <Dialog.Title className={styles.srOnly}>{title}</Dialog.Title>}
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The modal's visible heading; also becomes its accessible name. */
export const ModalTitle = Dialog.Title;
/** Optional description, linked with `aria-describedby`. */
export const ModalDescription = Dialog.Description;
/** Wrap a button to close the modal (`<ModalClose asChild><Button>Cancel</Button></ModalClose>`). */
export const ModalClose = Dialog.Close;
