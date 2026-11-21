import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeControl, encodeData, encodeFrame, FRAME_CONTROL, FRAME_DATA, MAX_FRAME_PAYLOAD, parseControl } from './frames';

describe('console frame codec (wire.go EncodeWS / DecodeWS)', () => {
  it('kind | channel (uint16 BE) | payload', () => {
    const b = encodeFrame(FRAME_DATA, 0x0102, Buffer.from('hi'));
    expect([...b]).toEqual([0, 1, 2, 0x68, 0x69]);
    const f = decodeFrame(b);
    expect(f?.kind).toBe(FRAME_DATA);
    expect(f?.channel).toBe(258);
    expect(f?.payload.toString()).toBe('hi');
  });

  it('rejects short frames and bad channels', () => {
    expect(decodeFrame(Buffer.from([1, 0]))).toBeNull();
    expect(() => encodeFrame(FRAME_DATA, 70000)).toThrow(RangeError);
  });

  it('control JSON omits zero values like Go omitempty', () => {
    const f = decodeFrame(encodeControl({ type: 'status', state: 'connected', protocol: 'shell', resolution: '80x24', channel: 0, code: '' }));
    expect(f?.kind).toBe(FRAME_CONTROL);
    expect(f?.channel).toBe(0);
    expect(JSON.parse(f?.payload.toString() ?? '')).toEqual({ type: 'status', state: 'connected', protocol: 'shell', resolution: '80x24' });
    expect(parseControl(f!.payload)).toEqual({ type: 'status', state: 'connected', protocol: 'shell', resolution: '80x24' });
  });

  it('parses browser controls and ignores junk', () => {
    expect(parseControl(Buffer.from('{"type":"resize","cols":120,"rows":40}'))).toEqual({ type: 'resize', cols: 120, rows: 40 });
    expect(parseControl(Buffer.from('{"type":"ping","id":7}'))).toEqual({ type: 'ping', id: 7 });
    expect(parseControl(Buffer.from('not json'))).toBeNull();
    expect(parseControl(Buffer.from('[1]'))).toBeNull();
    expect(parseControl(Buffer.from('{"cols":1}'))).toBeNull();
  });

  it('splits data larger than 1 MiB', () => {
    const frames = encodeData(3, new Uint8Array(MAX_FRAME_PAYLOAD + 10));
    expect(frames).toHaveLength(2);
    expect(frames.map((b) => decodeFrame(b)?.payload.length)).toEqual([MAX_FRAME_PAYLOAD, 10]);
    expect(decodeFrame(frames[1]!)?.channel).toBe(3);
    expect(encodeData(0, '')).toHaveLength(1);
  });
});
