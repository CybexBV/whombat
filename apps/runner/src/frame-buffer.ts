const EMPTY = Buffer.alloc(0);

/** Bytes awaiting a complete WebSocket frame. Growing geometrically keeps fragmented input linear to read. */
export class FrameBuffer {
  #buffer: Buffer = EMPTY;
  #start = 0;
  #end = 0;
  #owned = false;

  get bytes(): Buffer {
    return this.#buffer.subarray(this.#start, this.#end);
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.#start === this.#end) {
      // Complete frames need no extra copy; only an incomplete frame needs writable storage.
      this.#buffer = chunk;
      this.#start = 0;
      this.#end = chunk.length;
      this.#owned = false;
      return;
    }
    const length = this.#end - this.#start;
    const total = length + chunk.length;
    if (this.#owned && this.#end + chunk.length <= this.#buffer.length) {
      chunk.copy(this.#buffer, this.#end);
      this.#end += chunk.length;
      return;
    }
    if (this.#owned && this.#start >= this.#buffer.length / 2 && total <= this.#buffer.length) {
      // Compact only after consuming half the storage, so a small prefix cannot cause repeated large copies.
      this.#buffer.copy(this.#buffer, 0, this.#start, this.#end);
    } else {
      const next = Buffer.allocUnsafe(Math.max(total, (this.#owned ? this.#buffer.length : length) * 2));
      this.#buffer.copy(next, 0, this.#start, this.#end);
      this.#buffer = next;
      this.#owned = true;
    }
    chunk.copy(this.#buffer, length);
    this.#start = 0;
    this.#end = total;
  }

  consume(length: number): void {
    this.#start += length;
    if (this.#start === this.#end) {
      // A screenshot or a large command must not keep its storage for the connection's remaining lifetime.
      this.#buffer = EMPTY;
      this.#start = 0;
      this.#end = 0;
      this.#owned = false;
    }
  }
}
