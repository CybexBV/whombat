import { describe, expect, it } from 'vitest';
import { AcpEventMapper } from './events';

const chunk = (text: string, messageId = 'm1') =>
  ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId }) as const;

describe('AcpEventMapper', () => {
  const reply = 'lumio.example.net is ready on the Hetzner server, and nothing public has changed yet.';

  it('keeps only what is new when the whole message comes again with more after it', () => {
    const mapper = new AcpEventMapper({ notices: 'without-message-id' });
    mapper.map(chunk(reply));
    const resent = mapper.map(chunk(`\n\n${reply}\n\nOne more line.`));
    expect(resent).toEqual([{ type: 'text_delta', text: '\n\nOne more line.' }]);
    expect(mapper.text).toBe(`${reply}\n\nOne more line.`);
  });

  it('drops the whole message sent again as it was', () => {
    const mapper = new AcpEventMapper();
    mapper.map(chunk(reply));
    expect(mapper.map(chunk(`\n\n${reply}`))).toEqual([]);
    expect(mapper.text).toBe(reply);
  });

  it('keeps a short message said twice and text that only begins the same', () => {
    const mapper = new AcpEventMapper();
    mapper.map(chunk('Yes.'));
    mapper.map(chunk(' Yes.'));
    expect(mapper.text).toBe('Yes. Yes.');
    const other = new AcpEventMapper();
    other.map(chunk('lumio.example.net is ready'));
    other.map(chunk(' on the Hetzner server.'));
    expect(other.text).toBe('lumio.example.net is ready on the Hetzner server.');
  });
});
