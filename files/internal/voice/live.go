package voice

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"time"

	"github.com/OpenTodoApp/opentodo/internal/outbound"
	"github.com/OpenTodoApp/opentodo/internal/stt"
)

// MaxOffer bounds the browser's session description.
const MaxOffer = 32 << 10

// connectTimeout bounds the exchange of session descriptions with OpenAI.
const connectTimeout = 20 * time.Second

// transcriptionPrompts steer the transcription toward dictated tasks.
var transcriptionPrompts = map[string]string{
	"es": "Dictado de tareas en español: reuniones, compras, llamadas, fechas y horas.",
	"en": "Dictating to-do tasks: meetings, errands, calls, dates and times.",
}

// ValidOffer reports whether offer looks like a WebRTC offer with audio.
func ValidOffer(offer string) bool {
	return len(offer) > 0 && len(offer) <= MaxOffer && strings.HasPrefix(offer, "v=0") && strings.Contains(offer, "m=audio")
}

// Session is the realtime session of one live dictation: the microphone's
// audio is cut into phrases by semantic turn detection and each phrase is
// transcribed; the model never answers (create_response and
// interrupt_response false), so no response is ever generated. language is an
// ISO 639-1 code or "".
func Session(c Config, language string) map[string]any {
	transcription := map[string]any{"model": c.TranscribeModel}
	if language != "" {
		transcription["language"] = language
	}
	// The streaming transcription models take no prompt.
	if p := transcriptionPrompts[language]; p != "" && c.TranscribeModel != "gpt-live-transcribe" && c.TranscribeModel != "gpt-realtime-whisper" {
		transcription["prompt"] = p
	}
	return map[string]any{
		"type":              "realtime",
		"model":             c.Model,
		"output_modalities": []string{"text"},
		"audio": map[string]any{
			"input": map[string]any{
				"noise_reduction": map[string]any{"type": "near_field"},
				"transcription":   transcription,
				"turn_detection": map[string]any{
					"type":               "semantic_vad",
					"eagerness":          c.Eagerness,
					"create_response":    false,
					"interrupt_response": false,
				},
			},
		},
	}
}

// Connect sends the browser's offer and the session to OpenAI's realtime calls
// route (the unified interface: the key stays on this server) and returns
// OpenAI's answer for the browser. root is the API root without /v1.
func Connect(ctx context.Context, client *http.Client, root, key, offer string, session map[string]any) (string, error) {
	sess, err := json.Marshal(session)
	if err != nil {
		return "", err
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for _, p := range []struct {
		name, ctype string
		data        []byte
	}{{"sdp", "application/sdp", []byte(offer)}, {"session", "application/json", sess}} {
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q`, p.name))
		h.Set("Content-Type", p.ctype)
		w, err := mw.CreatePart(h)
		if err != nil {
			return "", err
		}
		if _, err := w.Write(p.data); err != nil {
			return "", err
		}
	}
	if err := mw.Close(); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, root+"/v1/realtime/calls", &body)
	if err != nil {
		return "", fmt.Errorf("%w: %v", stt.ErrUnavailable, err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Accept", "application/sdp")
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("%w: %s", stt.ErrUnavailable, stage(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return "", fmt.Errorf("%w: reading the answer", stt.ErrUnavailable)
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("%w: the service answered %d", stt.ErrUnavailable, resp.StatusCode)
	}
	answer := string(raw)
	if !strings.HasPrefix(answer, "v=0") {
		return "", fmt.Errorf("%w: the answer is not a session description", stt.ErrUnavailable)
	}
	return answer, nil
}

// stage names where a request failed, without the address or any content.
func stage(err error) string {
	switch {
	case errors.Is(err, outbound.ErrPrivateTarget):
		return "the address is on a private network; allow private network targets in Settings → Server"
	case errors.Is(err, context.DeadlineExceeded):
		return "no answer in time"
	case strings.Contains(err.Error(), "resolve"):
		return "the host name could not be resolved"
	default:
		return "the connection failed"
	}
}
