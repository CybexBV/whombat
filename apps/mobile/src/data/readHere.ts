/**
 * What an open conversation or thread reads as its newest message changes: the thread's own marker (Chat and Feedback,
 * with something new in it), the thread's inbox rows, the conversation's marker, or nothing. Nothing while the app
 * isn't in front: the connection can stay up in the background (work under way, messages waiting to go), and a message
 * arriving then wasn't seen — read, it would leave the badge and its notification the shade. Coming back reads it.
 */
export type ReadHere = 'thread' | 'inbox' | 'conversation' | null;

export function readHere(facts: {
  /** The app is in front. */
  shows: boolean;
  /** A new chat: it reads nothing. */
  fresh: boolean;
  /** Only the room's copy of a thread's root shows yet. */
  rootOnly: boolean;
  hasConversation: boolean;
  /** The newest message from the server. */
  hasLast: boolean;
  thread: boolean;
  /** What is new in the thread (Chat and Feedback). */
  newInThread: number;
  /** The thread's messages on screen are its fresh copy (`threadReadable`). */
  threadReadable: boolean;
  /** Where the viewer had read the conversation is known (MX-05). */
  readKnown: boolean;
  /** The demo world, which keeps no read markers. */
  demo: boolean;
}): ReadHere {
  const f = facts;
  if (!f.shows || f.fresh || f.rootOnly || !f.hasConversation || !f.hasLast) return null;
  if (f.thread) {
    if (f.newInThread > 0) return f.threadReadable ? 'thread' : null;
    return f.demo ? null : 'inbox';
  }
  return f.readKnown && !f.demo ? 'conversation' : null;
}
