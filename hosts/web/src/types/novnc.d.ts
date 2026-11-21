// Minimal typings for noVNC's RFB class (the package ships JavaScript only).
// https://github.com/novnc/noVNC/blob/master/docs/API.md

declare module '@novnc/novnc' {
  export interface RfbOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    repeaterID?: string;
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
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    readonly capabilities: { power: boolean };
    disconnect(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
    toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
  }
}
