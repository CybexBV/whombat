import { describe, expect, it } from 'vitest';
import { api } from '../contracts/index.js';
import { MCP_TOOLS } from '../contracts/mcp.js';
import { SetAgentNotesBody, WriteMemoryBody } from '../contracts/memory.js';
import { DispatchContext, DispatchSession } from '../contracts/runner.js';
import { KEY_CATALOG } from '../keys/catalog.js';
import {
  AGENT_NOTES_MAX,
  AgentNotes,
  AgentNotesText,
  emptyMemoryFile,
  MEMORY_ENTRY_SEPARATOR,
  MEMORY_FILE_LIMITS,
  memoryChars,
  memoryCopy,
  memoryEntries,
  memoryFileProblem,
  memoryFileText,
  memoryUsageText,
  normalizeMemoryFile,
  notesCopy,
  PersonMemory,
} from './memory.js';
import { conversationKeyFor, TaskKey, taskKeyFor } from './session.js';

describe('Hermes memory files (CT-1200, CT-1201)', () => {
  it('uses Hermes’s separator and limits', () => {
    expect(MEMORY_ENTRY_SEPARATOR).toBe('\n§\n');
    expect(MEMORY_FILE_LIMITS).toEqual({ memory: 2200, user: 1375 });
  });

  it('splits on the whole separator, trims, drops empty and repeated entries', () => {
    const text = ['  a  ', '', 'b § still b', 'a'].join(MEMORY_ENTRY_SEPARATOR);
    expect(memoryEntries(text)).toEqual(['a', 'b § still b']);
    expect(memoryEntries('one\r\n§\r\ntwo')).toEqual(['one', 'two']);
    expect(memoryFileText(['a', 'b'])).toBe('a\n§\nb');
    expect(normalizeMemoryFile(' a \n§\n\n§\nb ')).toBe('a\n§\nb');
  });

  it('counts code points of the joined entries', () => {
    expect(memoryChars('ab\n§\ncd')).toBe(7);
    expect(memoryChars('😀')).toBe(1);
    expect(memoryChars('')).toBe(0);
  });

  it('refuses a file over its limit, and only then', () => {
    expect(memoryFileProblem('user', 'x'.repeat(1375))).toBeNull();
    expect(memoryFileProblem('user', 'x'.repeat(1376))).toMatch(/1,375/);
    expect(memoryFileProblem('memory', 'x'.repeat(2200))).toBeNull();
    expect(memoryFileProblem('memory', 'x'.repeat(2201))).toMatch(/2,200/);
  });

  it('an empty file has its own limit and no version', () => {
    expect(emptyMemoryFile('user')).toEqual({ text: '', used: 0, limit: 1375, version: '', updatedAt: null });
    expect(
      PersonMemory.safeParse({ memory: emptyMemoryFile('memory'), user: emptyMemoryFile('user') }).success,
    ).toBe(true);
  });
});

describe('the agent’s notes (CT-1205, CT-1581)', () => {
  it('trims and caps the text in code points', () => {
    expect(AgentNotesText.parse('  hi\r\nthere  ')).toBe('hi\nthere');
    expect(AgentNotesText.safeParse('x'.repeat(AGENT_NOTES_MAX)).success).toBe(true);
    expect(AgentNotesText.safeParse('x'.repeat(AGENT_NOTES_MAX + 1)).success).toBe(false);
    expect(AGENT_NOTES_MAX).toBeLessThan(4000);
    expect(SetAgentNotesBody.parse({ text: '' }).text).toBe('');
  });

  it('are the person’s: no editor or edit right to show (CT-1581)', () => {
    expect(Object.keys(AgentNotes.shape).sort()).toEqual(['limit', 'text', 'updatedAt', 'used']);
  });

  it('turns go with the notes as text, not entries', () => {
    expect(DispatchContext.shape.notes.parse(undefined)).toBeNull();
    expect('profile' in DispatchContext.shape).toBe(false);
    expect('memory' in DispatchContext.shape).toBe(false);
  });
});

describe('memory endpoints (CT-1202…CT-1204)', () => {
  it('are the person’s memory and the notes', () => {
    expect(Object.keys(api.memory).sort()).toEqual(['clear', 'mine', 'notes', 'setNotes', 'write']);
    expect(api.memory.mine.id).toBe('memory.mine');
    expect(api.memory.write.method).toBe('PUT');
    expect(api.memory.write.path).toBe('/burrows/:burrow/memory/:file');
    expect(api.memory.clear.method).toBe('DELETE');
    expect(api.memory.setNotes.path).toBe('/burrows/:burrow/agent/notes');
  });

  it('a write takes a text and the version it started from', () => {
    expect(WriteMemoryBody.parse({ text: 'a', ifVersion: 'abc' })).toEqual({ text: 'a', ifVersion: 'abc' });
    expect(api.memory.write.params.safeParse({ burrow: 'b', file: 'notes' }).success).toBe(false);
    expect(api.memory.clear.query.parse({ file: 'user' })).toEqual({ file: 'user' });
  });

  it('no memory tools or proposal key remain', () => {
    for (const name of ['remember', 'recall', 'save_checkpoint', 'memory', 'propose_instruction'])
      expect(name in MCP_TOOLS).toBe(false);
    expect('memory.propose' in KEY_CATALOG).toBe(false);
  });
});

describe('memory words', () => {
  it('fill in the agent’s name and never name a file', () => {
    const copy = memoryCopy('Dusty');
    expect(copy.memory).toContain('Dusty');
    expect(copy.user).toBe('About you');
    expect(Object.values(copy).join(' ')).not.toMatch(/MEMORY\.md|USER\.md/);
    expect(notesCopy('Dusty').intro).toContain('Dusty');
    expect(Object.keys(notesCopy('Dusty'))).not.toContain('readOnly');
    expect(memoryUsageText(1240, 2200)).toBe('1,240 of 2,200 characters');
  });
});

describe('session keys (CT-1207)', () => {
  it('keys a turn by run, thread or conversation', () => {
    expect(taskKeyFor({ conversationId: 'cnv_a', threadRootId: 'msg_b', runId: 'run_c' })).toBe('run:run_c');
    expect(taskKeyFor({ conversationId: 'cnv_a', threadRootId: 'msg_b', runId: null })).toBe('thread:msg_b');
    expect(conversationKeyFor({ conversationId: 'cnv_a', threadRootId: null })).toBe('conv:cnv_a');
    expect(TaskKey.safeParse('automation:aut_1:step_2').success).toBe(true);
    expect(TaskKey.safeParse('elsewhere:x').success).toBe(false);
  });

  it('a turn says whether it resumes its Hermes session', () => {
    const session = { key: 'thread:msg_b', resumed: true, since: null, reason: null, scratchKey: 'sess_1' };
    expect(DispatchSession.parse(session)).toEqual(session);
    expect(DispatchSession.safeParse({ ...session, scratchKey: 'a/b' }).success).toBe(false);
    expect(DispatchContext.shape.session.parse(undefined)).toBeNull();
  });
});
