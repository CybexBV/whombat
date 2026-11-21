import { type WebSocketByteStreamOptions, type WebSocketLike, webSocketByteStream } from '../websocket.js';

/**
 * `webSocketByteStream` for a Node `ws` WebSocket. Identical to the generic adapter; `ws` also has
 * `pause()`/`resume()`, which the adapter uses for receive backpressure (TCP-level). Construct the `ws`
 * server/client with `maxPayload` equal to `maxMessageBytes` so oversized frames are refused before allocation.
 */
export function nodeWebSocketByteStream(socket: WebSocketLike, options: WebSocketByteStreamOptions = {}) {
  return webSocketByteStream(socket, options);
}
