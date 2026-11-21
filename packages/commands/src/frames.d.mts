export declare const FRAME: Readonly<{
  stdin: 1;
  stdout: 2;
  stderr: 3;
  exit: 4;
  signal: 5;
  resize: 6;
  eof: 7;
}>;
export type FrameType = (typeof FRAME)[keyof typeof FRAME];
export interface Frame {
  type: number;
  payload: Buffer;
}
export declare const MAX_FRAME: number;
export declare const MAX_LINE: number;
export declare function encodeFrame(type: number, payload?: Uint8Array | string): Buffer;
export declare function jsonFrame(type: number, value: unknown): Buffer;
export declare class FrameDecoder {
  push(chunk: Uint8Array): Frame[];
  get pending(): number;
}
export declare function frameJson(frame: Frame): unknown;
export declare function headerLine(value: unknown): Buffer;
export declare const SIGNALS: readonly string[];
