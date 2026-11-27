import type { ReactNode } from 'react';
import { useWebI18n } from '../../i18n/provider';
import { useToast } from '../Toast';

/** Copies `text`: the Clipboard API, else a selected textarea (plain-http origins). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Not a secure context, or permission denied: the older way.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export interface CopyButtonProps {
  text: string;
  /** Toast after copying (“Invite link copied.”). */
  copied: string;
  className?: string;
  /** Its name for a screen reader when the words on it don't say what it does (an address: “Copy the address …”). */
  label?: string;
  children: ReactNode;
}

/**
 * A quiet text button that copies `text` and confirms with a toast, e.g. “Copy invite link” on a pending
 * invite (docs/decisions/auth-selfhost.md). Styled by the row it sits in, like its “Remove” neighbour.
 */
export function CopyButton({ text, copied, className, label, children }: CopyButtonProps) {
  const { t } = useWebI18n();
  const toast = useToast();
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label ? t('common.copy') : undefined}
      onClick={() => {
        void copyText(text).then((ok) => toast.show(ok ? copied : t('common.copyDenied')));
      }}
    >
      {children}
    </button>
  );
}
