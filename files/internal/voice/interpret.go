package voice

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/OpenTodoApp/opentodo/internal/recurrence"
	"github.com/OpenTodoApp/opentodo/internal/stt"
)

// systemPrompt tells the model how utterances become operations; the cases it
// names are the owner's own ("no, a las tres y media y con mi amigo Marcos").
//
//go:embed prompt.txt
var systemPrompt string

// Limits of one interpretation request.
const (
	MaxText      = 2000
	MaxTasks     = 100
	MaxPrevious  = 20
	MaxNames     = 500
	maxName      = 120
	maxTitle     = 300
	interpretTTL = 25 * time.Second
	// previousShown is how many earlier utterances the model reads.
	previousShown = 6
)

// Task is one task the dictation made, as the app knows it now. Its number
// (ref) is its position, from 1; a deleted task keeps its place so the
// numbers do not move.
type Task struct {
	Title      string   `json:"title"`
	Date       string   `json:"date,omitempty"`
	Time       string   `json:"time,omitempty"`
	Deadline   string   `json:"deadline,omitempty"`
	Recurrence string   `json:"recurrence,omitempty"`
	Project    string   `json:"project,omitempty"`
	Labels     []string `json:"labels,omitempty"`
	Priority   int      `json:"priority,omitempty"`
	Deleted    bool     `json:"deleted,omitempty"`
}

// Request is one utterance with what the model needs to place it.
type Request struct {
	Text string `json:"text"`
	// Language is the dictation's ISO 639-1 code.
	Language string `json:"language"`
	// Now is the device's wall clock, "YYYY-MM-DDTHH:MM": "mañana" is the
	// person's tomorrow, not the server's.
	Now string `json:"now"`
	// TimeZone is shown to the model only.
	TimeZone string   `json:"timeZone"`
	Tasks    []Task   `json:"tasks"`
	Previous []string `json:"previous"`
	Projects []string `json:"projects"`
	Labels   []string `json:"labels"`
}

// Action is one operation the app applies: create, update or delete a task of
// the session, or finish, the person saying the dictation is over ("eso es
// todo"), after which the app adds the session's tasks. Null fields stay as
// they are; Clear names the fields an update removes.
type Action struct {
	Type       string   `json:"type"`
	Ref        *int     `json:"ref"`
	Title      *string  `json:"title"`
	Date       *string  `json:"date"`
	Time       *string  `json:"time"`
	Deadline   *string  `json:"deadline"`
	Recurrence *string  `json:"recurrence"`
	Project    *string  `json:"project"`
	Labels     []string `json:"labels"`
	Priority   *int     `json:"priority"`
	Clear      []string `json:"clear"`
}

var (
	reDate     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	reTime     = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	reLanguage = regexp.MustCompile(`^[a-z]{2}$`)
	reZone     = regexp.MustCompile(`^[A-Za-z0-9_+/-]{1,64}$`)
)

// FieldError names what is wrong with a request.
type FieldError struct{ Field, Message string }

func (e *FieldError) Error() string { return e.Field + ": " + e.Message }

func validDate(s string) bool {
	if !reDate.MatchString(s) {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func runes(s string) int { return utf8.RuneCountInString(s) }

// Validate checks the request's shape and sizes; it returns the parsed clock.
func (r Request) Validate() (time.Time, error) {
	text := strings.TrimSpace(r.Text)
	if text == "" {
		return time.Time{}, &FieldError{"text", "say something first"}
	}
	if runes(text) > MaxText {
		return time.Time{}, &FieldError{"text", fmt.Sprintf("at most %d characters", MaxText)}
	}
	if r.Language != "" && !reLanguage.MatchString(r.Language) {
		return time.Time{}, &FieldError{"language", "an ISO 639-1 code such as es"}
	}
	now, err := time.Parse("2006-01-02T15:04", r.Now)
	if err != nil {
		return time.Time{}, &FieldError{"now", "the device's date and time as YYYY-MM-DDTHH:MM"}
	}
	if r.TimeZone != "" && !reZone.MatchString(r.TimeZone) {
		return time.Time{}, &FieldError{"timeZone", "an IANA time zone name"}
	}
	if len(r.Tasks) > MaxTasks {
		return time.Time{}, &FieldError{"tasks", fmt.Sprintf("at most %d", MaxTasks)}
	}
	for _, t := range r.Tasks {
		if runes(t.Title) > MaxText || runes(t.Recurrence) > 200 || runes(t.Project) > maxName || len(t.Labels) > 50 {
			return time.Time{}, &FieldError{"tasks", "a task is too long"}
		}
		if (t.Date != "" && !validDate(t.Date)) || (t.Deadline != "" && !validDate(t.Deadline)) || (t.Time != "" && !reTime.MatchString(t.Time)) {
			return time.Time{}, &FieldError{"tasks", "dates are YYYY-MM-DD and times HH:MM"}
		}
	}
	if len(r.Previous) > MaxPrevious {
		return time.Time{}, &FieldError{"previous", fmt.Sprintf("at most %d", MaxPrevious)}
	}
	for _, p := range r.Previous {
		if runes(p) > MaxText {
			return time.Time{}, &FieldError{"previous", "an utterance is too long"}
		}
	}
	if len(r.Projects) > MaxNames || len(r.Labels) > MaxNames {
		return time.Time{}, &FieldError{"projects", fmt.Sprintf("at most %d names", MaxNames)}
	}
	for _, n := range append(append([]string{}, r.Projects...), r.Labels...) {
		if runes(n) > maxName {
			return time.Time{}, &FieldError{"projects", "a name is too long"}
		}
	}
	return now, nil
}

// quote is s as a JSON string, without HTML escaping.
func quote(s string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimSpace(b.String())
}

func quoteAll(names []string) string {
	if len(names) == 0 {
		return "none"
	}
	parts := make([]string, len(names))
	for i, n := range names {
		parts[i] = quote(n)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// UserMessage is what the model reads for one utterance: the clock with the
// next days spelled out (so it never has to count weekdays), the names it may
// use, the session's tasks and the utterance.
func UserMessage(r Request, now time.Time) string {
	var b strings.Builder
	zone := ""
	if r.TimeZone != "" {
		zone = " (" + r.TimeZone + ")"
	}
	lang := r.Language
	if lang == "" {
		lang = "unknown"
	}
	fmt.Fprintf(&b, "Now: %s %s %s%s. Language: %s.\n", now.Weekday(), now.Format("2006-01-02"), now.Format("15:04"), zone, lang)
	b.WriteString("Next days:\n")
	for i := 0; i < 15; i++ {
		d := now.AddDate(0, 0, i)
		tag := map[int]string{0: " (today)", 1: " (tomorrow)", 2: " (day after tomorrow)"}[i]
		fmt.Fprintf(&b, "%s %s%s\n", d.Weekday(), d.Format("2006-01-02"), tag)
	}
	fmt.Fprintf(&b, "\nProjects: %s\nLabels: %s\n\nTasks of this session:\n", quoteAll(r.Projects), quoteAll(r.Labels))
	if len(r.Tasks) == 0 {
		b.WriteString("none yet\n")
	}
	for i, t := range r.Tasks {
		parts := []string{fmt.Sprintf("%d. %s", i+1, quote(t.Title))}
		if t.Deleted {
			parts = append(parts, "deleted")
		}
		for _, f := range [][2]string{{"date", t.Date}, {"time", t.Time}, {"deadline", t.Deadline}, {"recurrence", t.Recurrence}, {"project", t.Project}} {
			if f[1] != "" {
				parts = append(parts, f[0]+" "+f[1])
			}
		}
		if len(t.Labels) > 0 {
			parts = append(parts, "labels "+strings.Join(t.Labels, ", "))
		}
		if t.Priority >= 1 && t.Priority <= 3 {
			parts = append(parts, fmt.Sprintf("priority %d", t.Priority))
		}
		b.WriteString(strings.Join(parts, " · ") + "\n")
	}
	b.WriteString("\nEarlier utterances:\n")
	prev := r.Previous
	if len(prev) > previousShown {
		prev = prev[len(prev)-previousShown:]
	}
	if len(prev) == 0 {
		b.WriteString("none\n")
	}
	for _, p := range prev {
		b.WriteString("- " + quote(p) + "\n")
	}
	b.WriteString("\nUtterance: " + quote(strings.TrimSpace(r.Text)))
	return b.String()
}

// schema is the answer's shape (strict structured output).
var schema = func() map[string]any {
	nullable := func(t string) map[string]any { return map[string]any{"type": []string{t, "null"}} }
	fields := []string{"date", "time", "deadline", "recurrence", "project", "labels", "priority"}
	return map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []string{"actions"},
		"properties": map[string]any{
			"actions": map[string]any{
				"type": "array",
				"items": map[string]any{
					"type":                 "object",
					"additionalProperties": false,
					"required":             []string{"type", "ref", "title", "date", "time", "deadline", "recurrence", "project", "labels", "priority", "clear"},
					"properties": map[string]any{
						"type":       map[string]any{"type": "string", "enum": []string{"create", "update", "delete", "finish"}},
						"ref":        nullable("integer"),
						"title":      nullable("string"),
						"date":       nullable("string"),
						"time":       nullable("string"),
						"deadline":   nullable("string"),
						"recurrence": nullable("string"),
						"project":    nullable("string"),
						"labels":     map[string]any{"type": []string{"array", "null"}, "items": map[string]any{"type": "string"}},
						"priority":   nullable("integer"),
						"clear":      map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": fields}},
					},
				},
			},
		},
	}
}()

// Interpret asks the model what the utterance does to the session's tasks and
// returns the operations, checked against the request (see Clean).
func Interpret(ctx context.Context, client *http.Client, root, key string, c Config, r Request) ([]Action, error) {
	now, err := r.Validate()
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"model": c.InterpretModel,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": UserMessage(r, now)},
		},
		"response_format":       map[string]any{"type": "json_schema", "json_schema": map[string]any{"name": "task_operations", "strict": true, "schema": schema}},
		"max_completion_tokens": 2000,
	}
	if c.Reasoning != "" {
		body["reasoning_effort"] = c.Reasoning
	} else {
		body["temperature"] = 0
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, interpretTTL)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, root+"/v1/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", stt.ErrUnavailable, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", stt.ErrUnavailable, stage(err))
	}
	defer resp.Body.Close()
	answer, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("%w: reading the answer", stt.ErrUnavailable)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: the model answered %d", stt.ErrUnavailable, resp.StatusCode)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(answer, &out); err != nil || len(out.Choices) == 0 {
		return nil, fmt.Errorf("%w: the answer is not a chat completion", stt.ErrUnavailable)
	}
	var parsed struct {
		Actions []Action `json:"actions"`
	}
	if err := json.Unmarshal([]byte(out.Choices[0].Message.Content), &parsed); err != nil {
		return nil, fmt.Errorf("%w: the model's answer is not the operations", stt.ErrUnavailable)
	}
	return Clean(r, now, parsed.Actions), nil
}

// Clean keeps the operations the app can apply: a create has a title; an
// update or delete names a live task of the session; dates, times, priority
// and repetition are well formed; projects and labels are names the person
// has. A time without a day on a new task is today when still to come, else
// tomorrow; a repeating task without a day starts today. A finish comes once,
// last, after the operations it closes.
func Clean(r Request, now time.Time, in []Action) []Action {
	out := []Action{}
	finish := false
	live := func(ref *int) bool {
		return ref != nil && *ref >= 1 && *ref <= len(r.Tasks) && !r.Tasks[*ref-1].Deleted
	}
	for _, a := range in {
		switch a.Type {
		case "create":
			title := tidyTitle(a.Title)
			if title == "" {
				continue
			}
			act := Action{Type: "create", Title: &title, Clear: []string{}}
			fields(&act, a, r)
			alignWeekday(&act, "", now)
			if act.Date == nil && (act.Time != nil || act.Recurrence != nil) {
				d := dayFor(act.Time, now)
				act.Date = &d
			}
			out = append(out, act)
		case "update":
			if !live(a.Ref) {
				continue
			}
			ref := *a.Ref
			act := Action{Type: "update", Ref: &ref, Clear: []string{}}
			if t := tidyTitle(a.Title); t != "" && t != r.Tasks[ref-1].Title {
				act.Title = &t
			}
			fields(&act, a, r)
			alignWeekday(&act, r.Tasks[ref-1].Date, now)
			if act.Date == nil && r.Tasks[ref-1].Date == "" && (act.Time != nil || act.Recurrence != nil) {
				d := dayFor(act.Time, now)
				act.Date = &d
			}
			// The models clear the time when only the day moves ("mejor pasado
			// mañana"): a value goes away only when the person says so.
			if asksRemoval(r.Text) {
				act.Clear = clearList(a.Clear, act)
			}
			if act.Title == nil && act.Date == nil && act.Time == nil && act.Deadline == nil && act.Recurrence == nil &&
				act.Project == nil && act.Labels == nil && act.Priority == nil && len(act.Clear) == 0 {
				continue
			}
			out = append(out, act)
		case "delete":
			if !live(a.Ref) {
				continue
			}
			ref := *a.Ref
			out = append(out, Action{Type: "delete", Ref: &ref, Clear: []string{}})
		case "finish":
			finish = true
		}
	}
	if finish {
		out = append(out, Action{Type: "finish", Clear: []string{}})
	}
	return out
}

var weekdayRule = regexp.MustCompile(`^every (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$`)

// alignWeekday keeps a one-weekday rule ("every tuesday") and the task's day
// in step. A day the model gives wins: it reads days off the spelled-out
// calendar and gets them right, while the rule's weekday is a translation it
// sometimes slips on ("todos los martes" as "every monday" on a Tuesday).
// Without one, a task whose day (current, before an update) is another
// weekday moves to the rule's next day from today.
func alignWeekday(act *Action, current string, now time.Time) {
	if act.Recurrence == nil || !weekdayRule.MatchString(*act.Recurrence) {
		return
	}
	if act.Date != nil {
		if d, err := time.Parse("2006-01-02", *act.Date); err == nil {
			rule := "every " + strings.ToLower(d.Weekday().String())
			act.Recurrence = &rule
		}
		return
	}
	want := strings.TrimPrefix(*act.Recurrence, "every ")
	if d, err := time.Parse("2006-01-02", current); err == nil && strings.ToLower(d.Weekday().String()) == want {
		return
	}
	for i := 0; i < 7; i++ {
		d := now.AddDate(0, 0, i)
		if strings.ToLower(d.Weekday().String()) == want {
			day := d.Format("2006-01-02")
			act.Date = &day
			return
		}
	}
}

// dayFor is the day of a time said without one: today while it is still to
// come, otherwise tomorrow; today when there is no time.
func dayFor(hhmm *string, now time.Time) string {
	if hhmm != nil && *hhmm <= now.Format("15:04") {
		return now.AddDate(0, 0, 1).Format("2006-01-02")
	}
	return now.Format("2006-01-02")
}

// fields copies the well-formed attributes of a into act.
func fields(act *Action, a Action, r Request) {
	if a.Date != nil && validDate(*a.Date) {
		act.Date = ptr(*a.Date)
	}
	if a.Time != nil && reTime.MatchString(*a.Time) {
		act.Time = ptr(*a.Time)
	}
	if a.Deadline != nil && validDate(*a.Deadline) {
		act.Deadline = ptr(*a.Deadline)
	}
	if a.Recurrence != nil {
		if rule, err := recurrence.Canonicalize(strings.ToLower(strings.TrimSpace(*a.Recurrence))); err == nil && rule != "" {
			act.Recurrence = &rule
		}
	}
	if a.Project != nil {
		if p, ok := named(*a.Project, r.Projects); ok {
			act.Project = &p
		}
	}
	if a.Labels != nil {
		var labels []string
		for _, l := range a.Labels {
			if n, ok := named(l, r.Labels); ok && !contains(labels, n) {
				labels = append(labels, n)
			}
		}
		if len(labels) > 0 {
			act.Labels = labels
		}
	}
	if a.Priority != nil && *a.Priority >= 1 && *a.Priority <= 4 {
		act.Priority = ptr(*a.Priority)
	}
}

// removal matches the words with which a person takes a value away, in the
// dictation languages ("sin hora", "quítale la fecha", "without a date",
// "sans étiquette", "ohne Uhrzeit", "senza data", "sem prioridade", "zonder").
var removal = regexp.MustCompile(`\b(sin|quit\w*|borr\w*|elimin\w*|ningun\w*|without|remov\w*|delet\w*|clear\w*|sans|enlev\w*|supprim\w*|ohne|entfern\w*|senza|togli\w*|rimuov\w*|sem|zonder|verwijder\w*)\b`)

var unaccent = strings.NewReplacer("á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", "à", "a", "è", "e", "ì", "i", "ò", "o", "ù", "u",
	"â", "a", "ê", "e", "î", "i", "ô", "o", "û", "u", "ä", "a", "ö", "o", "ü", "u", "ñ", "n", "ç", "c", "ã", "a", "õ", "o")

// asksRemoval reports whether the utterance takes a value away.
func asksRemoval(text string) bool {
	return removal.MatchString(unaccent.Replace(strings.ToLower(text)))
}

// clearList keeps the known fields an update removes and does not also set.
func clearList(in []string, act Action) []string {
	set := map[string]bool{"date": act.Date != nil, "time": act.Time != nil, "deadline": act.Deadline != nil, "recurrence": act.Recurrence != nil,
		"project": act.Project != nil, "labels": act.Labels != nil, "priority": act.Priority != nil}
	out := []string{}
	for _, f := range in {
		if isSet, known := set[f]; known && !isSet && !contains(out, f) {
			out = append(out, f)
		}
	}
	return out
}

// named is the listed name equal to s ignoring case and surrounding space.
func named(s string, names []string) (string, bool) {
	k := strings.ToLower(strings.TrimSpace(s))
	if k == "" {
		return "", false
	}
	for _, n := range names {
		if strings.ToLower(strings.TrimSpace(n)) == k {
			return n, true
		}
	}
	return "", false
}

// tidyTitle trims a title, drops a final full stop, caps its length and puts
// its first letter in upper case.
func tidyTitle(p *string) string {
	if p == nil {
		return ""
	}
	t := strings.Join(strings.Fields(*p), " ")
	t = strings.TrimRight(t, ".")
	t = strings.TrimSpace(t)
	if runes(t) > maxTitle {
		t = string([]rune(t)[:maxTitle])
	}
	if t == "" {
		return ""
	}
	first, size := utf8.DecodeRuneInString(t)
	return string(unicode.ToUpper(first)) + t[size:]
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func ptr[T any](v T) *T { return &v }
