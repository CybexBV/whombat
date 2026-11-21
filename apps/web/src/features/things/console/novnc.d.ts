// Minimal typings for noVNC's RFB class (the package ships JavaScript only; ported from Rackoon's `types/novnc.d.ts`).
// https://github.com/novnc/noVNC/blob/master/docs/API.md
declare module '@novnc/novnc' {
  export interface RfbOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    wsProtocols?: string[];
  }

  export interface RfbChannel {
    readyState: number | string;
    binaryType: string;
    protocol: string;
    send(data: ArrayBuffer | ArrayBufferView): void;
    close(): void;
    onopen: ((e: Event) => void) | null;
    onmessage: ((e: MessageEvent) => void) | null;
    onclose: ((e: Event) => void) | null;
    onerror: ((e: Event) => void) | null;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | RfbChannel, options?: RfbOptions);
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
  }
}
