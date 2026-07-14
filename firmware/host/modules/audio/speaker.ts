/* global SharedArrayBuffer */

import type { BorrowedAudioBuffer } from 'audio-buffer'
import AudioOut from 'pins/audioout'

const WAV_HEADER_SIZE = 44

export type ToneProperty = {
  volume?: number
}

export default class Speaker {
  volume: number
  #pool: SharedArrayBuffer | undefined
  // The AudioOut of the currently-playing utterance (undefined when idle) and its
  // play() resolver — kept so stop() can halt playback mid-sentence for a barge-in
  // cancel instead of letting the sentence play to its end.
  #audio: AudioOut | undefined
  #resolvePlay: ((ok: boolean) => void) | undefined

  constructor(props: ToneProperty) {
    this.volume = props.volume ?? 0.5
  }

  // Immediately stop any in-progress play(): halt + close the AudioOut and resolve
  // the pending playAudio(false). No-op when idle. Used by barge-in cancel so the
  // current sentence silences at once instead of playing to completion.
  stop(): void {
    const audio = this.#audio
    const resolve = this.#resolvePlay
    this.#audio = undefined
    this.#resolvePlay = undefined
    if (audio) {
      try {
        audio.stop?.()
      } catch {}
      try {
        audio.close()
      } catch {}
    }
    resolve?.(false)
  }

  #sharedPool(size: number): SharedArrayBuffer {
    if (!this.#pool || this.#pool.byteLength < size) {
      this.#pool = new SharedArrayBuffer(size)
    }
    return this.#pool
  }
  async tone(hz: number, duration: number, volume?: number): Promise<void> {
    const audio = new AudioOut({
      streams: 1,
      sampleRate: 24000,
      bitsPerSample: 16,
    })
    return new Promise((resolve) => {
      audio.enqueue(0, AudioOut.Flush)
      audio.enqueue(0, AudioOut.Volume, Math.round((volume ?? this.volume) * 256))
      audio.enqueue(0, AudioOut.Tone, hz, (audio.sampleRate * duration) / 1000)
      audio.enqueue(0, AudioOut.Callback, 1)
      audio.start()

      audio.callback = (_id) => {
        audio.close()
        resolve()
      }
    })
  }

  async play(buffer: BorrowedAudioBuffer): Promise<boolean> {
    if (buffer.byteLength <= WAV_HEADER_SIZE) return false
    try {
      const view = new DataView(buffer)
      const numChannels = view.getUint16(22, true)
      const sampleRate = view.getUint32(24, true)
      const bitsPerSample = view.getUint16(34, true)
      if (bitsPerSample !== 16 || (numChannels !== 1 && numChannels !== 2)) return false
      if (sampleRate < 8000 || sampleRate > 48000) return false

      // AudioOut.RawSamples requires a non-relocatable buffer; a plain ArrayBuffer is
      // relocatable and rejected, so copy the PCM payload into a SharedArrayBuffer.
      // Reuse one growing pool: per-utterance allocations live in the system heap
      // (shared with I2S DMA) and repeated playback can exhaust it before GC runs.
      const pcmLength = buffer.byteLength - WAV_HEADER_SIZE
      const shared = this.#sharedPool(pcmLength)
      new Uint8Array(shared, 0, pcmLength).set(new Uint8Array(buffer, WAV_HEADER_SIZE))

      const audio = new AudioOut({ streams: 1, sampleRate, numChannels, bitsPerSample })
      return await new Promise<boolean>((resolve) => {
        // Retained so stop() can halt this in-progress utterance (barge-in cancel).
        this.#audio = audio
        this.#resolvePlay = resolve
        audio.enqueue(0, AudioOut.Flush)
        audio.enqueue(0, AudioOut.Volume, Math.round(this.volume * 256))
        // `shared` is retained by this closure until the callback fires, so it is not collected.
        // AudioOut.enqueue is typed for HostBuffer; the native layer also accepts a SharedArrayBuffer.
        // Limit playback to the copied samples: the pool may be larger than this utterance.
        audio.enqueue(0, AudioOut.RawSamples, shared as unknown as HostBuffer, 1, 0, pcmLength >> 1)
        audio.enqueue(0, AudioOut.Callback, 1)
        audio.start()
        audio.callback = () => {
          if (this.#audio !== audio) return // already stopped by stop()
          this.#audio = undefined
          this.#resolvePlay = undefined
          audio.close()
          resolve(true)
        }
      })
    } catch (error) {
      trace(`Speaker.play error ${error}\n`)
      return false
    }
  }
}
