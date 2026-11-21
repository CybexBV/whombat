import styles from './QuickReplies.module.css';

export interface QuickRepliesProps {
  /** The agent's quick replies (`replySuggestions`). */
  suggestions: readonly string[];
  /** Sends the reply; the chips go away once it is the newest message. */
  onPick: (text: string) => void;
  disabled?: boolean;
}

/**
 * Quick replies under an agent's newest message (docs/decisions/rich-messages.md RM-05): the DM empty
 * state's suggestion chips, but a tap sends at once.
 */
export function QuickReplies({ suggestions, onPick, disabled }: QuickRepliesProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of chips, not a form section with a legend
    <div className={styles.replies} role="group" aria-label="Quick replies">
      {suggestions.map((text) => (
        <button
          key={text}
          type="button"
          className={styles.reply}
          disabled={disabled}
          onClick={() => onPick(text)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
