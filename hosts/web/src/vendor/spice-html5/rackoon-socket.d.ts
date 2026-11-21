export function registerSocketFactory(uri: string, factory: (uri: string) => WebSocket): () => void;
export function createSocket(uri: string, protocols?: string | string[]): WebSocket;
