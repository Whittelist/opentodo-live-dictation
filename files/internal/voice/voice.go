// Package voice is the live dictation of quick add (fork: voice-live, the
// behaviour of Todoist's Ramble). The microphone stays open over WebRTC to
// OpenAI's realtime API, which cuts the speech into utterances where the
// person pauses and transcribes each one; the text of an utterance comes back
// to this server, and a model turns it into task operations — create a task,
// or update or delete one the same dictation made — that the app applies like
// typed edits. "No, a las tres y media y con Marcos" edits the meeting it just
// created instead of adding another task.
//
// This server relays the browser's WebRTC offer (adding the session settings
// and the key) and the text of one utterance at a time; the audio never passes
// through it. Nothing is stored or logged: no audio, no text, no task.
package voice

import (
	"strings"

	"github.com/OpenTodoApp/opentodo/internal/config"
)

// Defaults of the live dictation. The realtime model never answers; it only
// carries the session that detects the ends of phrases and transcribes them.
const (
	DefaultModel           = "gpt-realtime-2.1-mini"
	DefaultTranscribeModel = "gpt-transcribe"
	DefaultEagerness       = "medium"
	DefaultInterpretModel  = "gpt-5.4-mini"
)

// Config names the models and how eagerly a phrase ends.
type Config struct {
	Model           string
	TranscribeModel string
	// Eagerness is the semantic end-of-turn detection's: low waits longest
	// for the person to go on, high closes a phrase soonest.
	Eagerness      string
	InterpretModel string
	// Reasoning is the interpretation model's reasoning_effort, empty to
	// leave it out (and ask for temperature 0 instead).
	Reasoning string
}

// ConfigFrom fills the variables' empty fields with the defaults.
func ConfigFrom(env config.LiveEnv) Config {
	c := Config{Model: env.Model, TranscribeModel: env.TranscribeModel, Eagerness: env.Eagerness, InterpretModel: env.InterpretModel, Reasoning: env.Reasoning}
	if c.Model == "" {
		c.Model = DefaultModel
	}
	if c.TranscribeModel == "" {
		c.TranscribeModel = DefaultTranscribeModel
	}
	if c.Eagerness == "" {
		c.Eagerness = DefaultEagerness
	}
	if c.InterpretModel == "" {
		c.InterpretModel = DefaultInterpretModel
	}
	switch {
	case strings.EqualFold(c.Reasoning, "off"):
		c.Reasoning = ""
	case c.Reasoning == "" && strings.HasPrefix(c.InterpretModel, "gpt-5"):
		// A little thinking: on the owner's dictation scenarios gpt-5.4-mini
		// got 32 of 32 right with "low" (1.1 s on average) against 31 of 32
		// with "none" (0.9 s); one utterance still answers within a second or two.
		c.Reasoning = "low"
	}
	return c
}
