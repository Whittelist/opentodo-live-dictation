package httpapi

import (
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// Live dictation (fork: voice-live) against an in-process fake of OpenAI's
// realtime calls and chat completions routes.

type fakeOpenAI struct {
	srv  *httptest.Server
	mu   sync.Mutex
	got  []map[string]string
	chat string
}

func newFakeOpenAI(t *testing.T) *fakeOpenAI {
	f := &fakeOpenAI{chat: `{"actions":[{"type":"create","ref":null,"title":"reunión","date":"2026-11-22","time":"15:00","deadline":null,"recurrence":null,"project":"casa","labels":null,"priority":null,"clear":[]},` +
		`{"type":"update","ref":7,"title":"x","date":null,"time":null,"deadline":null,"recurrence":null,"project":null,"labels":null,"priority":null,"clear":[]}]}`}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := map[string]string{"path": r.URL.Path, "auth": r.Header.Get("Authorization")}
		switch r.URL.Path {
		case "/v1/realtime/calls":
			_, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
			mr := multipart.NewReader(r.Body, params["boundary"])
			for {
				p, err := mr.NextPart()
				if err != nil {
					break
				}
				b, _ := io.ReadAll(p)
				got[p.FormName()] = string(b)
			}
			w.Header().Set("Content-Type", "application/sdp")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte("v=0\r\no=openai answer\r\n"))
		case "/v1/chat/completions":
			b, _ := io.ReadAll(r.Body)
			got["body"] = string(b)
			f.mu.Lock()
			content := f.chat
			f.mu.Unlock()
			out, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
			_, _ = w.Write(out)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
		f.mu.Lock()
		f.got = append(f.got, got)
		f.mu.Unlock()
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeOpenAI) last() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.got[len(f.got)-1]
}

const testOffer = "v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"

func TestVoiceLive(t *testing.T) {
	e, srv, logs := sttEnv(t)
	fake := newFakeOpenAI(t)
	e.allowPrivate(true)

	// Not offered while the service is not OpenAI's API.
	resp, out := e.do("PUT", "/api/v1/settings/stt", map[string]any{"url": fake.srv.URL + "/v1", "model": "gpt-4o-transcribe", "key": "sk-live"})
	e.mustStatus(resp, 200, out)
	resp, out = e.do("GET", "/api/v1/me", nil)
	e.mustStatus(resp, 200, out)
	if sp := out["speech"].(map[string]any); sp["live"] != nil {
		t.Fatalf("live offered by another service: %v", sp)
	}
	resp, out = e.do("POST", "/api/v1/voice/live", map[string]any{"sdp": testOffer})
	if resp.StatusCode != 409 || errCode(out) != "stt_not_configured" {
		t.Fatalf("not OpenAI = %d %v", resp.StatusCode, out)
	}

	u, _ := url.Parse(fake.srv.URL)
	srv.stt.SetLiveHosts(u.Host)
	resp, out = e.do("GET", "/api/v1/me", nil)
	e.mustStatus(resp, 200, out)
	if sp := out["speech"].(map[string]any); sp["live"] != true {
		t.Fatalf("speech = %v", sp)
	}

	// The offer goes out with the session and the key; the answer comes back.
	resp, out = e.do("POST", "/api/v1/voice/live", map[string]any{"sdp": testOffer, "language": "es"})
	e.mustStatus(resp, 200, out)
	if out["sdp"] != "v=0\r\no=openai answer\r\n" {
		t.Fatalf("answer = %v", out)
	}
	c := fake.last()
	if c["path"] != "/v1/realtime/calls" || c["auth"] != "Bearer sk-live" || c["sdp"] != testOffer {
		t.Fatalf("forwarded = %v", c)
	}
	for _, want := range []string{`"create_response":false`, `"type":"semantic_vad"`, `"language":"es"`, `"model":"gpt-transcribe"`} {
		if !strings.Contains(c["session"], want) {
			t.Errorf("session lacks %s: %s", want, c["session"])
		}
	}
	for name, body := range map[string]any{"no sdp": map[string]any{}, "not an offer": map[string]any{"sdp": "hello"}} {
		if resp, out := e.do("POST", "/api/v1/voice/live", body); resp.StatusCode != 400 || errCode(out) != "invalid_input" {
			t.Errorf("%s = %d %v", name, resp.StatusCode, out)
		}
	}

	// One utterance becomes checked operations: the unknown ref is dropped,
	// the project takes its listed spelling, the title its capital.
	resp, out = e.do("POST", "/api/v1/voice/interpret", map[string]any{
		"text": "mañana reunión a las tres en casa", "language": "es", "now": "2026-11-21T16:05", "timeZone": "Europe/Madrid",
		"tasks": []any{}, "projects": []string{"Casa"},
	})
	e.mustStatus(resp, 200, out)
	actions := out["actions"].([]any)
	if len(actions) != 1 {
		t.Fatalf("actions = %v", actions)
	}
	a := actions[0].(map[string]any)
	if a["type"] != "create" || a["title"] != "Reunión" || a["date"] != "2026-11-22" || a["time"] != "15:00" || a["project"] != "Casa" {
		t.Fatalf("action = %v", a)
	}
	c = fake.last()
	if c["path"] != "/v1/chat/completions" || !strings.Contains(c["body"], "Sunday 2026-11-22 (tomorrow)") || !strings.Contains(c["body"], `"strict":true`) {
		t.Fatalf("chat request = %v", c)
	}
	for name, body := range map[string]any{
		"no text":  map[string]any{"now": "2026-11-21T16:05"},
		"no clock": map[string]any{"text": "comprar pan"},
	} {
		if resp, out := e.do("POST", "/api/v1/voice/interpret", body); resp.StatusCode != 400 || errCode(out) != "invalid_input" {
			t.Errorf("%s = %d %v", name, resp.StatusCode, out)
		}
	}
	// A model answer that is not the operations is the service failing.
	fake.mu.Lock()
	fake.chat = "not json"
	fake.mu.Unlock()
	if resp, out := e.do("POST", "/api/v1/voice/interpret", map[string]any{"text": "pan", "now": "2026-11-21T16:05"}); resp.StatusCode != 502 || errCode(out) != "stt_unavailable" {
		t.Fatalf("bad answer = %d %v", resp.StatusCode, out)
	}
	// Nothing said reaches the log.
	if strings.Contains(logs.String(), "reunión") || strings.Contains(logs.String(), "casa") {
		t.Fatalf("the log carries the utterance: %s", logs.String())
	}
	anon := newClientFor(e)
	if resp, out := anon.do("POST", "/api/v1/voice/interpret", map[string]any{"text": "pan", "now": "2026-11-21T16:05"}); resp.StatusCode != 401 {
		t.Fatalf("anonymous = %d %v", resp.StatusCode, out)
	}
}
