import { type OwnedAudioBuffer, ownAudioBuffer } from 'audio-buffer'
import AudioIn from 'audio-in'

const CHANNELS = 1

export type RecordSilenceOptions = {
  /** Stop recording after this much continuous silence (only once speech was heard). */
  silenceMs?: number
  /** Mean absolute PCM level treated as speech. Tune with the `[mic] level=` trace. */
  threshold?: number
  /** Give up when no speech at all was heard within this time from the start. */
  noSpeechMs?: number
}

export default class Microphone {
  recording: boolean
  #audioIn: AudioIn | null
  #abortRecording: (() => void) | null
  onReadable?: (this: AudioIn, byteLength: number, sampleCount?: number) => void

  constructor() {
    this.recording = false
    this.#audioIn = null
    this.#abortRecording = null
  }

  start() {
    if (this.recording) {
      throw new Error('already recording')
    }
    const self = this
    this.#audioIn = new AudioIn({
      channels: CHANNELS,
      onReadable(size, sampleCount) {
        if (self.onReadable) {
          self.onReadable.call(this, size, sampleCount)
        }
      },
    })
    this.#audioIn.start()
    this.recording = true
  }

  stop() {
    this.#audioIn?.close()
    this.#audioIn = null
    this.#abortRecording?.()
    this.recording = false
  }

  async record(durationMilliSec = 3000, silence?: RecordSilenceOptions): Promise<OwnedAudioBuffer> {
    if (this.recording) {
      throw new Error('already recording')
    }
    this.recording = true
    const HEADER_SIZE = 44
    const silenceMs = silence?.silenceMs ?? 2000
    const threshold = silence?.threshold ?? 600
    const noSpeechMs = silence?.noSpeechMs ?? 0
    const startedAt = Date.now()

    return new Promise((resolve, reject) => {
      let writeOffset = 0
      let audioin: AudioIn | undefined
      let wavBuffer: ArrayBuffer
      let dataView: Uint8Array
      let finished = false
      let speechDetected = false
      let lastLoudAt = 0
      let lastLevelLogAt = 0
      const finish = () => {
        if (finished) return
        finished = true
        this.#abortRecording = null
        audioin?.close()
        this.recording = false
        let out = wavBuffer
        if (writeOffset < dataView.byteLength) {
          // Ended early on silence: shrink the WAV and fix the header sizes.
          out = wavBuffer.slice(0, HEADER_SIZE + writeOffset)
          const view = new DataView(out)
          view.setUint32(4, 36 + writeOffset, true)
          view.setUint32(40, writeOffset, true)
        }
        const owned = ownAudioBuffer(out) as OwnedAudioBuffer & { speechDetected?: boolean }
        if (silence) {
          owned.speechDetected = speechDetected
        }
        resolve(owned)
      }
      const fail = (error: unknown) => {
        if (finished) return
        finished = true
        this.#abortRecording = null
        audioin?.close()
        this.recording = false
        reject(error)
      }
      // Lets stop() abort a finite recording so close() never leaves the microphone held.
      this.#abortRecording = () => fail(new Error('recording aborted'))

      try {
        audioin = new AudioIn({
          channels: CHANNELS,
          onReadable(size) {
            const remaining = dataView.byteLength - writeOffset
            const chunkSize = Math.min(size, remaining)
            const chunk = this.read(chunkSize)

            if (!chunk) {
              finish()
              return
            }
            dataView.set(new Uint8Array(chunk), writeOffset)
            writeOffset += chunkSize

            if (silence && chunk.byteLength >= 2) {
              const samples = new Int16Array(chunk as ArrayBuffer, 0, chunk.byteLength >> 1)
              let sum = 0
              let count = 0
              for (let i = 0; i < samples.length; i += 4) {
                sum += Math.abs(samples[i])
                count += 1
              }
              const level = count > 0 ? sum / count : 0
              const now = Date.now()
              if (level >= threshold) {
                speechDetected = true
                lastLoudAt = now
              }
              if (now - lastLevelLogAt >= 1000) {
                lastLevelLogAt = now
                trace(`[mic] level=${Math.round(level)} speech=${speechDetected}\n`)
              }
              if (speechDetected && now - lastLoudAt >= silenceMs) {
                finish()
                return
              }
              if (!speechDetected && noSpeechMs > 0 && now - startedAt >= noSpeechMs) {
                finish()
                return
              }
            }

            if (writeOffset >= dataView.byteLength) {
              finish()
            }
          },
        })
      } catch (error) {
        this.#abortRecording = null
        this.recording = false
        reject(error)
        return
      }

      // generate header
      const { sampleRate, channels, bitsPerSample } = audioin
      const byteRate = sampleRate * channels * (bitsPerSample >> 3)
      const contentLength = (durationMilliSec / 1000) * byteRate
      wavBuffer = new ArrayBuffer(HEADER_SIZE + contentLength)
      const headerView = new DataView(wavBuffer)
      dataView = new Uint8Array(wavBuffer, HEADER_SIZE)

      headerView.setUint8(0, 'R'.charCodeAt(0))
      headerView.setUint8(1, 'I'.charCodeAt(0))
      headerView.setUint8(2, 'F'.charCodeAt(0))
      headerView.setUint8(3, 'F'.charCodeAt(0))
      headerView.setUint32(4, 36 + contentLength, true)
      headerView.setUint8(8, 'W'.charCodeAt(0))
      headerView.setUint8(9, 'A'.charCodeAt(0))
      headerView.setUint8(10, 'V'.charCodeAt(0))
      headerView.setUint8(11, 'E'.charCodeAt(0))
      headerView.setUint8(12, 'f'.charCodeAt(0))
      headerView.setUint8(13, 'm'.charCodeAt(0))
      headerView.setUint8(14, 't'.charCodeAt(0))
      headerView.setUint8(15, ' '.charCodeAt(0))
      headerView.setUint32(16, 16, true)
      headerView.setUint16(20, 1, true) // AudioFormat = 1 (PCM)
      headerView.setUint16(22, channels, true)
      headerView.setUint32(24, sampleRate, true)
      headerView.setUint32(28, byteRate, true)
      headerView.setUint16(32, (channels * bitsPerSample) >> 3, true)
      headerView.setUint16(34, bitsPerSample, true)
      headerView.setUint8(36, 'd'.charCodeAt(0))
      headerView.setUint8(37, 'a'.charCodeAt(0))
      headerView.setUint8(38, 't'.charCodeAt(0))
      headerView.setUint8(39, 'a'.charCodeAt(0))
      headerView.setUint32(40, contentLength, true)

      // start recording
      try {
        audioin.start()
      } catch (error) {
        fail(error)
      }
    })
  }
}
