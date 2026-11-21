import { describe, expect, it } from 'vitest';
import { readHere } from './readHere';

const room = {
  shows: true,
  fresh: false,
  rootOnly: false,
  hasConversation: true,
  hasLast: true,
  thread: false,
  newInThread: 0,
  threadReadable: true,
  readKnown: true,
  demo: false,
};
const thread = { ...room, thread: true };

describe('what an open conversation reads', () => {
  it('reads the conversation, the thread or its inbox rows while the app is in front', () => {
    expect(readHere(room)).toBe('conversation');
    expect(readHere({ ...thread, newInThread: 2 })).toBe('thread');
    expect(readHere(thread)).toBe('inbox');
  });

  it('reads nothing while the app is in the background, whatever arrives', () => {
    expect(readHere({ ...room, shows: false })).toBeNull();
    expect(readHere({ ...thread, shows: false })).toBeNull();
    expect(readHere({ ...thread, shows: false, newInThread: 2 })).toBeNull();
  });

  it('waits for where the viewer had read, the thread’s fresh copy, and reads nothing in a new chat or the demo', () => {
    expect(readHere({ ...room, readKnown: false })).toBeNull();
    expect(readHere({ ...thread, newInThread: 2, threadReadable: false })).toBeNull();
    expect(readHere({ ...room, fresh: true })).toBeNull();
    expect(readHere({ ...room, demo: true })).toBeNull();
    expect(readHere({ ...thread, demo: true, newInThread: 1 })).toBe('thread');
  });
});
