# Live dictation for OpenTodo (Ramble-style)

A working prototype of live, hands-free dictation in [OpenTodo](https://github.com/OpenTodoApp/OpenTodo)'s quick add, built on **OpenTodo v1.5.0** for our own instance and shared here in case the maintainers find it useful.

Tap the microphone once and talk:
- Every phrase becomes a draft task when you pause, and the microphone keeps listening.
- A spoken correction changes the draft it is about. "No, at half past three and with my friend Marcos" updates the meeting instead of adding a task.
- **Add**, or saying "that's all", saves the drafts as one batch with one Undo. Nothing is saved while you talk.

It complements the assistant's *Ramble into tasks* ([OpenTodoApp/OpenTodo#608](https://github.com/OpenTodoApp/OpenTodo/issues/608), `voice-ramble`). That one takes a finished brain dump and proposes a batch. This one works phrase by phrase while you talk, inside quick add, with corrections by voice.

It is a reference, not a finished contribution: it is based on v1.5.0 rather than `main`, it has no OpenSpec change, and it needs OpenAI's API as the server's speech service. See [Status](#status).

## What it does

| You say (it was tested in Spanish) | What happens |
| --- | --- |
| "Mañana tenemos una reunión a las tres" | Draft `Reunión`, tomorrow at 15:00 |
| "Ah, no, esa reunión es a las tres y media y es con mi amigo Marcos" | Changes that draft: `Reunión con mi amigo Marcos`, 15:30 |
| "Y el viernes tengo que comprar pan" | Draft `Comprar pan`, on Friday |
| "No, espera, lo del dentista mejor el martes por la mañana" | Moves the dentist to Tuesday |
| "Olvida lo de las bombillas" | Takes that draft out |
| "Vale, a ver…", "gracias" | Nothing |
| "Yo creo que eso es todo", "nada más", "that's all" | Adds the drafts |

A panel under the field shows the state, the last phrase heard and the drafts, each with a ✕. **Add N tasks** and **Discard** sit at the bottom of the panel; the list scrolls inside it, so Add stays on screen on a phone's add sheet. Saving goes through the view's own quick add (`onAddMany`), so the view's defaults apply, with one Undo toast. The full behaviour is in [`files/docs/voice-live.md`](files/docs/voice-live.md).

## How it works

```
browser ──SDP──► POST /api/v1/voice/live ──► OpenAI /v1/realtime/calls (the server's key)
browser ◄═══════ WebRTC (microphone audio → OpenAI; events ← data channel) ═══════► OpenAI
   │ each transcribed phrase
   └──► POST /api/v1/voice/interpret ──► OpenAI /v1/chat/completions (strict JSON output)
            {text, local time, the drafts so far, projects, labels}
         ◄── {actions: [create | update ref | delete ref | finish]}  → change the drafts
Add / finish ──► the view's quick add (one batch, one Undo)
```

- **Audio** goes from the browser to OpenAI's Realtime API over WebRTC. The server only exchanges the SDP offer, adding its key.
  - The session never answers (`create_response: false`): it only detects the end of each phrase (`semantic_vad`) and transcribes it.
  - There is no volume threshold on the phone and no gap between phrases.
- **The first 1–2 s, while connecting,** are recorded in the browser and transcribed through the existing `POST /api/v1/voice/transcribe`. That text is joined to the first phrase.
- **The interpreter** is a small model with strict structured output. It reads each phrase with the drafts so far and the next 15 days spelled out, and returns `create`, `update ref`, `delete ref` or `finish`. The server then cleans the answer:
  - refs must exist, and dates and times must be valid;
  - repetition rules are made canonical;
  - only the person's own projects and labels are used;
  - a time without a day becomes today or tomorrow;
  - a value is cleared only when the phrase asks for it.
- **When the interpreter does not answer**, the phrase falls back to a local parser.
- **Privacy.** The server neither stores nor logs audio, text or tasks of these routes. Under end-to-end encryption, project and label names are not sent.

Live dictation is on only when the speech service is OpenAI's API with a key (`/api/v1/me` → `speech.live: true`); otherwise quick add dictates into the field as in v1.5.0. Six optional variables, `OPENTODO_VOICE_*`, pick the models and the end-of-phrase eagerness. The defaults are `gpt-realtime-2.1-mini`, `gpt-transcribe` and `gpt-5.4-mini` with low reasoning.

## Try it

```sh
git clone https://github.com/OpenTodoApp/OpenTodo.git && cd OpenTodo
git checkout v1.5.0
cp -R ../opentodo-live-dictation/files/. .
git apply ../opentodo-live-dictation/modified-files.patch
```

Then:
1. Add the 14 strings of `strings.json` to `web/src/locales/{es,de,fr,it,pt,nl,zh}.json`, and regenerate `web/src/locales/messages.json` with the extractor. The patch leaves the catalogs out; `strings.json` lists each string, the files that use it and a draft translation.
2. Raise `initialGzipKB` in `web/bundle-budget.json` from 712 to 714. The first load measures 713.2 KB; the panel and the engine are lazy.
3. Build, and connect the speech service to `https://api.openai.com` with a key. Use Settings → Server → Speech to text, or `OPENTODO_STT_URL`, `OPENTODO_STT_MODEL` and `OPENTODO_STT_KEY_FILE`.
4. Turn on voice capture in Settings → Capture.

## What changes

- **Server.**
  - New package `internal/voice`: the Realtime session, the SDP exchange, the interpreter (`prompt.txt`, the strict schema, `Clean`) and tests. `openai_test.go` runs 15 dictation scenarios against OpenAI with `OPENTODO_VOICE_TEST_KEY_FILE`.
  - Two routes in `internal/httpapi/speech`, `POST /api/v1/voice/live` and `POST /api/v1/voice/interpret`.
  - `speech.live` in `/me`, `stt.Live()`, and the variables in `internal/config/stt.go`.
  - `docs/api.md`, `docs/self-hosting/configuration.md` and the v1 surface snapshot are updated.
- **Web.**
  - `lib/voice/live.ts`: WebRTC, phrase order and the pre-roll.
  - `lib/voice/voiceSession.ts`: drafts, the interpreter queue, Add and Discard, timers.
  - `app/quickadd/LivePanel.tsx`: the panel, lazy.
  - The wiring in `useDictation.ts`, `QuickAdd.tsx` and `QuickAddSheet.tsx`.
- **Earlier work in the same fork.** Phrase-by-phrase dictation for the server recogniser, with an energy-based end of phrase (`serverRecognition.ts`, `audioPrime.ts`), and spoken corrections read locally (`correction.ts`). The latter is now the fallback when the interpreter does not answer.
- **Strings.** Fourteen new strings, in `strings.json`.

## Tested

- **Interpreter against OpenAI.** 45 of 45 scenario runs right (15 scenarios, 3 times), about 1 s per phrase. The scenarios include corrections, new tasks after a correction, deletes, repetition, projects and labels, filler, and endings with "that's all" or its look-alikes.
- **End to end, locally.** Headless Chrome with a fake microphone played Spanish speech (OpenAI TTS) through the real app.
  - On a desktop and on emulated phones (390×844 and 360×640): adding with the button and by voice, closing the sheet with drafts, pausing, the app going to the background, and a failed connection.
  - Before Add, the server held no new tasks.
- **Test suites.** Go: `internal/voice`, `internal/config`, the routes, the v1 surface and the API docs. Web: the voice, quick add and i18n tests, `eslint src`, the typecheck and the bundle budget.
- **Not tested:**
  - a real phone, iOS Safari in particular;
  - Linux CI: it was built on Windows, where some unrelated suites fail for locale and path reasons.

## Status

These are open questions for the maintainers:

- **Base version.** It is based on v1.5.0. `main` (1.6.0) has changed voice capture since, and this is not ported.
- **No OpenSpec change.** The behaviour is described in `docs/voice-live.md` only.
- **OpenAI only.** The interpreter reuses the speech service's key for a chat model. It may belong with the assistant's provider instead.
- **Default recogniser.** `web/src/lib/voice/settings.ts` makes the server's speech service the default recogniser, so live dictation works out of the box. Upstream would probably keep the browser's.
- **Translations.** The new strings in de, fr, it, pt, nl and zh are machine drafts and need a speaker's review; es is used daily by the fork's owner.
- **AI disclosure.** It was written with AI coding agents (Claude, through Claude Code), as the contributing guide asks to disclose.

## License

AGPL-3.0-only, like OpenTodo (see [LICENSE](LICENSE)). This repository holds changes to OpenTodo; OpenTodo itself is © its authors.
