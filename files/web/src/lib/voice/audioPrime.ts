// The AudioContext has to be created inside the user's gesture (the click on the
// microphone). Created after `getUserMedia`, the browser leaves it suspended, the
// analyser returns zeros and the phrase never closes.
//
// A module of its own, without dependencies, so the dictation's start (the hot
// path) can import it without pulling in the recognition engine.
import { resettable } from '../moduleState'

let primed: AudioContext | null = null

type Ctx = { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext }

/** Creates or resumes the context; call it from the click handler. */
export function primeAudio(win: unknown = globalThis): void {
  const w = win as Ctx
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) return
  try {
    if (!primed) primed = new Ctor()
    if (primed.state === 'suspended') void primed.resume().catch(() => {})
  } catch {
    primed = null
  }
}

/** The context made ready, or null if it could not be created. */
export function primedContext(): AudioContext | null {
  return primed
}

/** For tests. */
export function resetPrimedAudio(): void {
  primed = null
}
resettable('audioPrime', resetPrimedAudio)
