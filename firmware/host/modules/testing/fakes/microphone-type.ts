import type { OwnedAudioBuffer } from 'audio-buffer'

// Mirror of the real microphone module's public surface (type-only, for tests).
export type RecordSilenceOptions = {
  silenceMs?: number
  threshold?: number
  noSpeechMs?: number
}

export default class Microphone {
  recording = false

  start(): void {
    throw new Error('microphone fake is type-only')
  }

  stop(): void {
    throw new Error('microphone fake is type-only')
  }

  record(_durationMilliSec?: number, _silence?: RecordSilenceOptions): Promise<OwnedAudioBuffer> {
    throw new Error('microphone fake is type-only')
  }
}
