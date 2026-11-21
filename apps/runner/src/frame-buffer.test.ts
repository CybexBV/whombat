import { describe, expect, it } from 'vitest';
import { FrameBuffer } from './frame-buffer';

describe('fragmented frame bytes', () => {
  it('keeps the unread suffix in order without modifying source chunks', () => {
    const buffer = new FrameBuffer();
    const first = Buffer.from('header and part');
    const second = Buffer.from(' of a message');
    buffer.append(first);
    buffer.consume(7);
    buffer.append(second);
    expect(buffer.bytes.toString()).toBe('and part of a message');
    buffer.consume(4);
    buffer.append(Buffer.from('!'));
    expect(buffer.bytes.toString()).toBe('part of a message!');
    expect(first.toString()).toBe('header and part');
    expect(second.toString()).toBe(' of a message');
    buffer.consume(buffer.bytes.length);
    buffer.append(Buffer.alloc(0));
    expect(buffer.bytes.length).toBe(0);
    buffer.append(Buffer.from('next'));
    expect(buffer.bytes.toString()).toBe('next');
  });

  it('handles repeated growth and partial consumption of a long stream', () => {
    const buffer = new FrameBuffer();
    let expected = Buffer.alloc(0);
    for (let i = 1; i <= 500; i++) {
      const chunk = Buffer.alloc((i * 17) % 211, i % 256);
      buffer.append(chunk);
      expected = Buffer.concat([expected, chunk]);
      expect(buffer.bytes.equals(expected)).toBe(true);
      const consumed = Math.min(expected.length, (i * 31) % 157);
      buffer.consume(consumed);
      expected = expected.subarray(consumed);
      expect(buffer.bytes.equals(expected)).toBe(true);
    }
  });
});
