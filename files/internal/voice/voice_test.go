package voice

import (
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/OpenTodoApp/opentodo/internal/config"
)

var saturday = time.Date(2026, 11, 21, 16, 5, 0, 0, time.UTC)

func TestConfigFromDefaults(t *testing.T) {
	c := ConfigFrom(config.LiveEnv{})
	if c.Model != DefaultModel || c.TranscribeModel != DefaultTranscribeModel || c.Eagerness != "medium" || c.InterpretModel != DefaultInterpretModel || c.Reasoning != "low" {
		t.Fatalf("defaults = %+v", c)
	}
	if c := ConfigFrom(config.LiveEnv{InterpretModel: "gpt-4.1-mini"}); c.Reasoning != "" {
		t.Fatalf("a model without reasoning got %q", c.Reasoning)
	}
	if c := ConfigFrom(config.LiveEnv{Reasoning: "off"}); c.Reasoning != "" {
		t.Fatalf("off = %q", c.Reasoning)
	}
}

func TestSessionNeverAnswers(t *testing.T) {
	s := Session(ConfigFrom(config.LiveEnv{}), "es")
	raw, _ := json.Marshal(s)
	got := string(raw)
	for _, want := range []string{`"type":"realtime"`, `"create_response":false`, `"interrupt_response":false`, `"type":"semantic_vad"`, `"model":"gpt-transcribe"`, `"language":"es"`, `"prompt":"Dictado`} {
		if !strings.Contains(got, want) {
			t.Errorf("session lacks %s: %s", want, got)
		}
	}
	if raw, _ := json.Marshal(Session(Config{TranscribeModel: "gpt-live-transcribe"}, "es")); strings.Contains(string(raw), "prompt") {
		t.Fatalf("a streaming model got a prompt: %s", raw)
	}
}

func TestValidOffer(t *testing.T) {
	if !ValidOffer("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n") {
		t.Fatal("a real offer was refused")
	}
	for _, bad := range []string{"", "hello", "v=0\r\nm=video 9\r\n", "v=0 m=audio" + strings.Repeat("x", MaxOffer)} {
		if ValidOffer(bad) {
			t.Errorf("accepted %.30q", bad)
		}
	}
}

func TestConnect(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = map[string]string{"path": r.URL.Path, "auth": r.Header.Get("Authorization"), "accept": r.Header.Get("Accept")}
		_, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		mr := multipart.NewReader(r.Body, params["boundary"])
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			b, _ := io.ReadAll(p)
			got[p.FormName()], got[p.FormName()+"_type"] = string(b), p.Header.Get("Content-Type")
		}
		w.Header().Set("Content-Type", "application/sdp")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("v=0\r\nanswer"))
	}))
	defer srv.Close()
	answer, err := Connect(t.Context(), srv.Client(), srv.URL, "sk-test", "v=0\r\noffer m=audio", map[string]any{"type": "realtime"})
	if err != nil || answer != "v=0\r\nanswer" {
		t.Fatalf("answer = %q, %v", answer, err)
	}
	if got["path"] != "/v1/realtime/calls" || got["auth"] != "Bearer sk-test" || got["accept"] != "application/sdp" ||
		got["sdp"] != "v=0\r\noffer m=audio" || got["sdp_type"] != "application/sdp" || got["session"] != `{"type":"realtime"}` || got["session_type"] != "application/json" {
		t.Fatalf("request = %v", got)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnauthorized) }))
	defer bad.Close()
	if _, err := Connect(t.Context(), bad.Client(), bad.URL, "sk-test", "v=0 m=audio", nil); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("refused = %v", err)
	}
}

func TestValidate(t *testing.T) {
	ok := Request{Text: "comprar pan", Now: "2026-11-21T16:05", Language: "es"}
	if _, err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, r := range map[string]Request{
		"empty":    {Text: "  ", Now: ok.Now},
		"no clock": {Text: "x"},
		"language": {Text: "x", Now: ok.Now, Language: "spanish"},
		"long":     {Text: strings.Repeat("a", MaxText+1), Now: ok.Now},
		"date":     {Text: "x", Now: ok.Now, Tasks: []Task{{Title: "a", Date: "22/11/2026"}}},
		"zone":     {Text: "x", Now: ok.Now, TimeZone: "Europe/Madrid; drop"},
	} {
		if _, err := r.Validate(); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestUserMessageSpellsOutTheDays(t *testing.T) {
	m := UserMessage(Request{Text: "el viernes", Language: "es", TimeZone: "Europe/Madrid", Projects: []string{"Casa"},
		Tasks: []Task{{Title: "Reunión", Date: "2026-11-22", Time: "15:00"}, {Title: "Pan", Deleted: true}}}, saturday)
	for _, want := range []string{"Now: Saturday 2026-11-21 16:05 (Europe/Madrid). Language: es.", "Sunday 2026-11-22 (tomorrow)", "Friday 2026-11-27",
		`Projects: ["Casa"]`, "Labels: none", `1. "Reunión" · date 2026-11-22 · time 15:00`, `2. "Pan" · deleted`, `Utterance: "el viernes"`} {
		if !strings.Contains(m, want) {
			t.Errorf("message lacks %q:\n%s", want, m)
		}
	}
}

func s(v string) *string { return &v }
func n(v int) *int       { return &v }

func TestCleanAlignsAOneWeekdayRuleWithTheDay(t *testing.T) {
	r := Request{Text: "sacar la basura todos los martes", Now: "2026-11-21T16:05"}
	out := Clean(r, saturday, []Action{{Type: "create", Title: s("Sacar la basura"), Date: s("2026-11-24"), Recurrence: s("every monday")}})
	if *out[0].Recurrence != "every tuesday" {
		t.Fatalf("rule = %s", *out[0].Recurrence)
	}
	out = Clean(r, saturday, []Action{{Type: "create", Title: s("Regar"), Date: s("2026-11-24"), Recurrence: s("every 2 weeks")}})
	if *out[0].Recurrence != "every 2 weeks" {
		t.Fatalf("an interval rule changed: %s", *out[0].Recurrence)
	}
	// Without a day the rule's next day is the first one.
	out = Clean(r, saturday, []Action{{Type: "create", Title: s("Sacar la basura"), Recurrence: s("every tuesday")}})
	if *out[0].Date != "2026-11-24" || *out[0].Recurrence != "every tuesday" {
		t.Fatalf("no day = %s %s", *out[0].Date, *out[0].Recurrence)
	}
	// A rule given to a task on another weekday moves the task.
	r.Tasks = []Task{{Title: "Regar", Date: "2026-11-23"}}
	out = Clean(r, saturday, []Action{{Type: "update", Ref: n(1), Recurrence: s("every friday")}})
	if *out[0].Date != "2026-11-27" || *out[0].Recurrence != "every friday" {
		t.Fatalf("update = %v %s", out[0].Date, *out[0].Recurrence)
	}
}

func TestCleanKeepsValuesUnlessTakenAway(t *testing.T) {
	r := Request{Text: "mejor pasado mañana", Now: "2026-11-21T16:05", Tasks: []Task{{Title: "Llamar a mamá", Date: "2026-11-21", Time: "20:00"}}}
	out := Clean(r, saturday, []Action{{Type: "update", Ref: n(1), Date: s("2026-11-23"), Clear: []string{"time"}}})
	if len(out) != 1 || len(out[0].Clear) != 0 || *out[0].Date != "2026-11-23" {
		t.Fatalf("moving the day cleared the time: %+v", out)
	}
	if out := Clean(r, saturday, []Action{{Type: "update", Ref: n(1), Clear: []string{"date", "time"}}}); len(out) != 0 {
		t.Fatalf("a clear nobody asked for became an update: %+v", out)
	}
	for _, said := range []string{"quítale la hora", "Sin hora, por favor", "without a time", "ohne Uhrzeit", "borra la etiqueta"} {
		r.Text = said
		if out := Clean(r, saturday, []Action{{Type: "update", Ref: n(1), Clear: []string{"time"}}}); len(out) != 1 || len(out[0].Clear) != 1 {
			t.Errorf("%q did not take the time away: %+v", said, out)
		}
	}
}

func TestClean(t *testing.T) {
	r := Request{Text: "y quita el proyecto", Now: "2026-11-21T16:05", Projects: []string{"Trabajo"}, Labels: []string{"recados"},
		Tasks: []Task{{Title: "Reunión", Date: "2026-11-22", Time: "15:00"}, {Title: "Pan", Deleted: true}, {Title: "Llamar"}}}
	out := Clean(r, saturday, []Action{
		// A title is tidied; an unknown project and label are dropped; a time
		// already past today lands tomorrow.
		{Type: "create", Title: s("  comprar   leche. "), Project: s("Otro"), Labels: []string{"recados", "nada"}, Time: s("09:00"), Priority: n(1)},
		{Type: "create", Title: s("   ")},
		// A rule is canonical; without a day a weekday rule starts on its next day.
		{Type: "create", Title: s("basura"), Time: s("20:30"), Recurrence: s("Every  Tuesday")},
		{Type: "create", Title: s("mal"), Date: s("2026-13-40"), Time: s("25:00"), Recurrence: s("cada martes"), Priority: n(7)},
		// Updates name live tasks only.
		{Type: "update", Ref: n(1), Title: s("reunión con Marcos"), Time: s("15:30"), Clear: []string{"time", "project", "bogus"}},
		{Type: "update", Ref: n(2), Title: s("pan integral")},
		{Type: "update", Ref: n(9), Time: s("10:00")},
		{Type: "update", Ref: n(1), Title: s("Reunión")},
		// A time for a task without a day gives it one.
		{Type: "update", Ref: n(3), Time: s("17:00"), Project: s("trabajo")},
		// "Eso es todo": one finish, after everything else, whatever its place.
		{Type: "finish", Title: s("x")},
		{Type: "delete", Ref: n(2)},
		{Type: "delete", Ref: n(3)},
		{Type: "finish"},
	})
	got, _ := json.Marshal(out)
	want := `[` +
		`{"type":"create","ref":null,"title":"Comprar leche","date":"2026-11-22","time":"09:00","deadline":null,"recurrence":null,"project":null,"labels":["recados"],"priority":1,"clear":[]},` +
		`{"type":"create","ref":null,"title":"Basura","date":"2026-11-24","time":"20:30","deadline":null,"recurrence":"every tuesday","project":null,"labels":null,"priority":null,"clear":[]},` +
		`{"type":"create","ref":null,"title":"Mal","date":null,"time":null,"deadline":null,"recurrence":null,"project":null,"labels":null,"priority":null,"clear":[]},` +
		`{"type":"update","ref":1,"title":"Reunión con Marcos","date":null,"time":"15:30","deadline":null,"recurrence":null,"project":null,"labels":null,"priority":null,"clear":["project"]},` +
		`{"type":"update","ref":3,"title":null,"date":"2026-11-21","time":"17:00","deadline":null,"recurrence":null,"project":"Trabajo","labels":null,"priority":null,"clear":[]},` +
		`{"type":"delete","ref":3,"title":null,"date":null,"time":null,"deadline":null,"recurrence":null,"project":null,"labels":null,"priority":null,"clear":[]},` +
		`{"type":"finish","ref":null,"title":null,"date":null,"time":null,"deadline":null,"recurrence":null,"project":null,"labels":null,"priority":null,"clear":[]}` +
		`]`
	if string(got) != want {
		t.Fatalf("clean =\n%s\nwant\n%s", got, want)
	}
}
