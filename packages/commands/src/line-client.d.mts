export declare function socketTarget(path: string): { path: string };
export interface LineFailures<T> {
  refused(err: NodeJS.ErrnoException): T;
  broken(err: NodeJS.ErrnoException): T;
  unreadable(): T;
  closed(connected: boolean): T;
  timeout?(): T;
}
export declare function askLine<T>(
  target: { path: string },
  request: unknown,
  on: LineFailures<T>,
  timeoutMs?: number,
): Promise<{ reply: unknown } | T>;
