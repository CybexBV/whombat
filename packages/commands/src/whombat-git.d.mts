export { encodeFrame, FRAME, FrameDecoder as FrameReader } from './frames.mjs';
export declare const LINES: {
  readonly notGitHub: (url: string) => string;
  readonly push: string;
  readonly version: string;
  readonly archive: string;
  readonly unknown: (what: string) => string;
  readonly closed: string;
  readonly usage: string;
};
export declare function githubRepo(url: string): string | null;
export declare function probe(
  url: string,
  env?: Record<string, string | undefined>,
): Promise<
  | { via: 'whombat'; target: { path: string }; error?: undefined }
  | { via: 'direct'; note: string | null; error?: undefined }
  | { error: string; via?: undefined }
>;
export declare function main(
  argv?: readonly string[],
  env?: Record<string, string | undefined>,
  options?: {
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  },
): Promise<number>;
