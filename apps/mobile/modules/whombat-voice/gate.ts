/**
 * Which recording the app is listening to (pure, so the tests can read it). Every start gets a new number, which the
 * Android side puts on each event it sends; an event of an earlier recording (its reader still finishing as the next
 * one starts) is dropped instead of ending or filling the new one. An event without a number (iOS) counts as the
 * current recording's.
 */
export interface RecordingGate {
  /** A new recording: its number. */
  begin(): number;
  /** Nothing is recording any more. */
  end(): void;
  /** Whether an event with this number belongs to the recording under way. */
  accepts(id: unknown): boolean;
}

export function createRecordingGate(): RecordingGate {
  let last = 0;
  let current: number | null = null;
  return {
    begin() {
      last += 1;
      current = last;
      return current;
    },
    end() {
      current = null;
    },
    accepts(id) {
      if (current === null) return false;
      return id === undefined || id === null || id === current;
    },
  };
}
