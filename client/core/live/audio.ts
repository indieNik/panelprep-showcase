// Excerpted from the PanelPrep production codebase for hackathon judging.

/**
 * Browser audio I/O for the Gemini Live session.
 *
 * - {@link AudioRecorder}: captures the mic at 16 kHz mono and emits base64 PCM
 *   frames ready for `sendRealtimeInput`.
 * - {@link AudioPlayer}: schedules incoming 24 kHz PCM chunks for gapless playback,
 *   and can be cleared instantly for barge-in (interruption).
 */

const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;

function base64FromArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function int16FromBase64(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export class AudioRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

  /** Start capturing. `onChunk` receives base64-encoded 16-bit PCM @ 16 kHz. */
  async start(onChunk: (base64Pcm: string) => void): Promise<void> {
    this.ctx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    await this.ctx.audioWorklet.addModule('worklets/pcm-recorder-processor.js');

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-recorder-processor');
    this.node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      onChunk(base64FromArrayBuffer(event.data));
    };
    source.connect(this.node);
    // Keep the worklet pulling without routing mic to speakers.
    this.node.connect(this.ctx.destination);
  }

  /** Mute/unmute by toggling the mic track — silences capture at the source. */
  setMuted(muted: boolean): void {
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private nextStartTime = 0;
  private readonly active = new Set<AudioBufferSourceNode>();

  private ensureCtx(): AudioContext {
    this.ctx ??= new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    return this.ctx;
  }

  /** Create + resume the context within a user gesture so playback isn't blocked. */
  async prime(): Promise<void> {
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  }

  /** Schedule a base64 PCM (16-bit, 24 kHz) chunk for gapless playback. */
  enqueue(base64Pcm: string): void {
    const ctx = this.ensureCtx();
    const pcm = int16FromBase64(base64Pcm);
    if (!pcm.length) return;

    const buffer = ctx.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      channel[i] = pcm[i] / 0x8000;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    this.nextStartTime = Math.max(this.nextStartTime, now);
    src.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;

    this.active.add(src);
    src.onended = () => this.active.delete(src);
  }

  /** Barge-in: stop everything currently scheduled. */
  clear(): void {
    for (const src of this.active) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.active.clear();
    this.nextStartTime = 0;
  }

  async stop(): Promise<void> {
    this.clear();
    await this.ctx?.close();
    this.ctx = null;
  }
}
