import styles from './GitHubNotice.module.css';

export interface GitHubNoticeProps {
  text: string;
  /** A word to show as code (`redirect_uri_mismatch`): where the text names it, else after it. */
  command?: string | null;
  tone?: 'warn' | 'neutral';
}

/** A quiet notice in the run page's pattern (RunView `Notice`: a quiet box, a code span). Not in the mock (B-05). */
export function GitHubNotice({ text, command, tone = 'warn' }: GitHubNoticeProps) {
  const at = command ? text.indexOf(command) : -1;
  return (
    <p className={styles.notice} data-tone={tone} role="status">
      {command && at >= 0 ? (
        <>
          {text.slice(0, at)}
          <code className={styles.command}>{command}</code>
          {text.slice(at + command.length)}
        </>
      ) : (
        <>
          {text}
          {command && (
            <>
              {' '}
              <code className={styles.command}>{command}</code>
            </>
          )}
        </>
      )}
    </p>
  );
}
