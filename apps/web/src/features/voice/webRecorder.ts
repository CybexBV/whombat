/**
 * The browser's microphone for voice typing (docs/decisions/dictation.md DT-01, DT-07): `getUserMedia`, an AudioWorklet
 * that hands the samples on (a ScriptProcessor where a browser has no AudioWorklet), and `VoiceCapture`, which brings
 * them to a 16 kHz mono 16-bit WAV of at most five minutes. The browser asks for the microphone when recording first
 * starts; a refusal, or no microphone, is `MicrophoneError`. The level of each chunk feeds the waveform. A page that
 * can't record at all (the box's page over plain HTTP has no `getUserMedia`) offers no mic.
 */
import { encodeWav, levelOf, MicrophoneError, VoiceCapture, type VoiceRecorder } from '@whombat/client/voice';

/** Whether this page can record: a secure page with a microphone API and Web Audio. */
export function webRecorderSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window.AudioContext === 'function'
  );
}

/** What `getUserMedia` refused with when the person said no, or there is no microphone to use. */
const REFUSED = new Set([
  'NotAllowedError',
  'SecurityError',
  'NotFoundError',
  'NotReadableError',
  'OverconstrainedError',
]);

const WORKLET_URL = new URL('./captureWorklet.js', import.meta.url);

interface Live {
  stream: MediaStream;
  context: AudioContext;
  nodes: AudioNode[];
  capture: VoiceCapture;
}

/** One recorder for the page: one recording at a time anyway. */
export function createWebRecorder(): VoiceRecorder {
  let live: Live | null = null;

  const teardown = async () => {
    const was = live;
    live = null;
    if (!was) return;
    for (const track of was.stream.getTracks()) track.stop();
    for (const node of was.nodes) node.disconnect();
    await was.context.close().catch(() => {});
  };

  return {
    async start({ maxSeconds, onLevel, onEnd }) {
      await teardown();
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (error) {
        if (REFUSED.has((error as { name?: string } | null)?.name ?? '')) throw new MicrophoneError();
        throw error;
      }
      // The microphone's own rate: a context at 16 kHz would refuse its stream in some browsers.
      const context = new AudioContext();
      const capture = new VoiceCapture({ rate: context.sampleRate, maxSeconds });
      const mine: Live = { stream, context, nodes: [], capture };
      live = mine;
      const take = (chunk: Float32Array) => {
        if (live !== mine) return;
        onLevel?.(levelOf(chunk));
        if (!capture.push(chunk)) {
          // Five minutes: the nodes stop, the WAV stays for `stop`.
          for (const node of mine.nodes) node.disconnect();
          onEnd?.('limit');
        }
      };
      try {
        if (context.state === 'suspended') await context.resume();
        const source = context.createMediaStreamSource(stream);
        mine.nodes.push(source);
        if (context.audioWorklet) {
          await context.audioWorklet.addModule(WORKLET_URL.href);
          const node = new AudioWorkletNode(context, 'whombat-capture');
          node.port.onmessage = (event: MessageEvent<Float32Array>) => take(event.data);
          source.connect(node);
          // Connected to the output (silent) so every browser keeps pulling it.
          node.connect(context.destination);
          mine.nodes.push(node);
        } else {
          const node = context.createScriptProcessor(4096, 1, 1);
          node.onaudioprocess = (event) => {
            take(event.inputBuffer.getChannelData(0).slice());
            event.outputBuffer.getChannelData(0).fill(0);
          };
          source.connect(node);
          node.connect(context.destination);
          mine.nodes.push(node);
        }
      } catch (error) {
        await teardown();
        throw error;
      }
      for (const track of stream.getAudioTracks())
        track.addEventListener('ended', () => {
          if (live === mine) onEnd?.('error');
        });
    },
    async stop() {
      const wav = live ? live.capture.wav() : encodeWav(new Int16Array(0));
      await teardown();
      return wav;
    },
    cancel: teardown,
  };
}
