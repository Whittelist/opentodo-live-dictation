---
title: Live dictation
summary: Talk to quick add and every phrase becomes a draft task; a spoken correction changes the draft it is about, and Add (or "that's all") saves them. Needs the server's speech service on OpenAI's API.
audience: user
section: Guides
specs: [voice-capture]
screens: []
order: 79
---
# Live dictation

When the server's [speech service](self-hosting/speech-to-text.md) is OpenAI's API, the microphone in quick add starts a live dictation, like Todoist's Ramble. Tap it once and talk. Each phrase becomes a draft task when you pause, and the microphone keeps listening. A spoken correction changes the draft it is about instead of adding another. When you are done, **Add** (or saying "that's all") saves the drafts at once.

| You say | What happens |
| --- | --- |
| "Mañana tenemos una reunión a las tres" | Draft `Reunión`, tomorrow at **15:00** |
| "Ah, no, esa reunión es a las tres y media y es con mi amigo Marcos" | **Changes** that draft: `Reunión con mi amigo Marcos`, 15:30 |
| "Y el viernes tengo que comprar pan" | Draft `Comprar pan`, on Friday |
| "El lunes llamar al dentista y enviar la factura a Pedro antes del jueves, eso es urgente" | Two drafts; the invoice with a deadline and priority 1 |
| "No, espera, lo del dentista mejor el martes por la mañana" | Moves the dentist to Tuesday |
| "Sacar la basura todos los martes" | A repeating task (`every tuesday`) |
| "Olvida lo de las bombillas" | Takes that draft out |
| "Vale, a ver…", "gracias" | Nothing |
| "Yo creo que eso es todo", "nada más", "that's all" | **Adds** the drafts, like the button |

The examples are in Spanish, the language this was tested in; the interpreter works in the dictation language.

## The panel

Under the field, a panel shows what is going on: Connecting, Listening, Hearing you, Thinking, Paused or Saving. Below that it shows the last phrase heard, and the drafts with their date, time, project, labels and priority. A draft a correction changed is marked **Changed**, and each draft has a ✕ to take it out. Nothing is saved while you talk.

- **Add N tasks** stops the microphone and waits for a phrase in progress. Then it saves the drafts as one batch with one Undo, through the view's own quick add: Today's date in Today, the project in a project. On a phone the add sheet closes.
- **Discard** drops the drafts.

A long dictation scrolls inside the panel (up to 40% of the screen), so Add stays in view on a phone's sheet and in the pinned quick-add row. On touch screens the ✕ and the buttons are 44 px.

The microphone button pauses and resumes the dictation. Leaving the app, 30 seconds without speech or 10 minutes of dictation also pause it, and the drafts stay. Closing the sheet or leaving the screen with drafts saves them, with Undo, so nothing said is lost; drafts are never saved after a sign-out.

## How it works

```
browser ──SDP──► POST /api/v1/voice/live ──► OpenAI /v1/realtime/calls (the server's key)
browser ◄═══════ WebRTC (microphone audio → OpenAI; events ← data channel) ═══════► OpenAI
   │ each transcribed phrase
   └──► POST /api/v1/voice/interpret ──► OpenAI /v1/chat/completions (strict JSON output)
            {text, local time, this dictation's drafts, projects, labels}
         ◄── {actions: [create | update ref | delete ref | finish]}  → change the drafts
Add / finish ──► the view's quick add (onAddMany: one batch, one Undo)
```

- **Audio.** It goes over WebRTC straight from the browser to OpenAI; the server only exchanges the SDP offer, adding its key.
  - The Realtime session (`type: realtime`, `create_response: false`) never answers. It only detects the end of each phrase with `semantic_vad` and transcribes it with `gpt-transcribe`.
  - There is no AudioContext and no volume threshold on the phone, and no gap between phrases.
- **What is said while connecting** (1–2 s) is recorded in the browser and transcribed through `POST /api/v1/voice/transcribe`.
  - If you were still talking, it goes in front of the first phrase. Words both recordings heard at the seam are kept once, including a word the first one cut short.
  - Otherwise it is a phrase of its own.
- **Interpretation.** `internal/voice` builds the message, with the next 15 days spelled out so the model never counts weekdays. It calls the model with strict structured output and cleans the answer:
  - refs must exist, and dates and times must be valid;
  - a repetition rule is made canonical (`internal/recurrence`);
  - only your own projects and labels are used;
  - a time without a day is today or tomorrow;
  - a one-weekday rule is aligned with the day;
  - a value is cleared only when the phrase asks for it;
  - `finish` comes once, last.
- **When the interpreter does not answer**, the phrase goes through the local parser (`correction.ts`), as a draft or as a correction of the last one, with a notice.
- **Privacy.** The server neither stores nor logs the audio, text or tasks of these routes. Under end-to-end encryption, project and label names are not sent to the interpreter.

Live dictation is on only when the speech service is OpenAI's API with a key (`/api/v1/me` → `speech.live: true`). Otherwise the microphone dictates into the field as before.

## Configuration (optional)

| Variable | Default |
| --- | --- |
| `OPENTODO_VOICE_LIVE` | `on` (`off` goes back to dictation into the field) |
| `OPENTODO_VOICE_LIVE_MODEL` | `gpt-realtime-2.1-mini` |
| `OPENTODO_VOICE_TRANSCRIBE_MODEL` | `gpt-transcribe` |
| `OPENTODO_VOICE_EAGERNESS` | `medium` (`low` waits longer for the end of a thought) |
| `OPENTODO_VOICE_INTERPRET_MODEL` | `gpt-5.4-mini` |
| `OPENTODO_VOICE_INTERPRET_REASONING` | `low` for GPT-5 models |

## Limits

- **Speed.** A draft appears about 1.5 s after a phrase ends.
- **Accuracy.** The interpreter got 45 of 45 scenario runs right against OpenAI, endings with "that's all" included. When it slips, a spoken correction or the ✕ fixes it before Add.
- **Proper names.** Speech recognition can mishear a name now and then.
- **Drafts live in memory until Add.** Closing the browser tab loses them.
- **Connection.** It needs one: OpenAI hears and reads every phrase.
