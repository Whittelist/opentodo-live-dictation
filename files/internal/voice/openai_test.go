package voice

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/OpenTodoApp/opentodo/internal/config"
)

// TestInterpretAgainstOpenAI runs the owner's dictation scenarios against the
// real model through Interpret and Clean. It needs a key and is skipped
// without one: OPENTODO_VOICE_TEST_KEY_FILE=<file> go test ./internal/voice -run OpenAI -v
// (OPENTODO_VOICE_INTERPRET_MODEL picks another model).
func TestInterpretAgainstOpenAI(t *testing.T) {
	file := os.Getenv("OPENTODO_VOICE_TEST_KEY_FILE")
	if file == "" {
		t.Skip("set OPENTODO_VOICE_TEST_KEY_FILE to run against OpenAI")
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	key := strings.TrimSpace(string(raw))
	cfg := ConfigFrom(config.LiveEnv{InterpretModel: os.Getenv("OPENTODO_VOICE_INTERPRET_MODEL"), Reasoning: os.Getenv("OPENTODO_VOICE_INTERPRET_REASONING")})
	var slowest time.Duration
	var total time.Duration
	calls := 0
	client := &http.Client{Timeout: 30 * time.Second}

	type check func(ts []Task) bool
	type scenario struct {
		name             string
		phrases          []string
		projects, labels []string
		ok               check
		// finishAt is the phrase that ends the dictation ("eso es todo"); -1:
		// none does, and a finish anywhere is a mistake.
		finishAt int
	}
	scenarios := []scenario{
		{"literal", []string{"Mañana tenemos una reunión a las tres.", "Ah, no. Esa reunión es a las tres y media, y es con mi amigo Marcos.", "Y el viernes tengo que comprar pan."}, nil, nil,
			func(ts []Task) bool {
				return len(ts) == 2 && ts[0].Date == "2026-11-22" && ts[0].Time == "15:30" && strings.Contains(strings.ToLower(ts[0].Title), "marcos") &&
					strings.HasPrefix(ts[0].Title, "Reuni") && ts[1].Date == "2026-11-27" && strings.HasPrefix(ts[1].Title, "Comprar pan")
			}, -1},
		{"long", []string{"Vale, a ver, el lunes tengo que llamar al dentista para pedir cita y también enviarle la factura a Pedro antes del jueves, eso es urgente.", "Y comprar leche.", "No. Espera. Lo del dentista mejor el martes por la mañana."}, nil, nil,
			func(ts []Task) bool {
				return len(ts) == 3 && strings.Contains(strings.ToLower(ts[0].Title), "dentista") && ts[0].Date == "2026-11-24" &&
					strings.Contains(strings.ToLower(ts[1].Title), "factura") && ts[1].Priority == 1 && strings.Contains(strings.ToLower(ts[2].Title), "leche")
			}, -1},
		{"fragments", []string{"Llamar a mamá", "a las ocho de la tarde", "mejor pasado mañana"}, nil, nil,
			func(ts []Task) bool { return len(ts) == 1 && ts[0].Time == "20:00" && ts[0].Date == "2026-11-23" }, -1},
		{"delete and repeat", []string{"Comprar bombillas", "Sacar la basura todos los martes", "Olvida lo de las bombillas"}, nil, nil,
			func(ts []Task) bool {
				return len(ts) == 2 && ts[0].Deleted && !ts[1].Deleted && ts[1].Recurrence == "every tuesday"
			}, -1},
		{"project and label", []string{"Preparar la presentación del jueves para el proyecto Trabajo", "Y que sea importante, con la etiqueta llamadas"}, []string{"Trabajo", "Casa"}, []string{"recados", "llamadas"},
			func(ts []Task) bool {
				return len(ts) == 1 && ts[0].Project == "Trabajo" && ts[0].Date == "2026-11-26" && ts[0].Priority == 2 && len(ts[0].Labels) == 1 && ts[0].Labels[0] == "llamadas"
			}, -1},
		{"filler", []string{"Eh... vale, a ver.", "Gracias."}, nil, nil, func(ts []Task) bool { return len(ts) == 0 }, -1},
		// The transcripts exactly as the live dictation produced them in the
		// end-to-end run: a new task that starts with "Y" after a correction.
		{"new task after a correction", []string{"Mañana tenemos una reunión a las tres.", "Ah, no. Esa reunión es a las tres y media. Y es con mi amigo Marcos.", "Y el viernes tengo que comprar pan."}, nil, nil,
			func(ts []Task) bool {
				return len(ts) == 2 && ts[0].Time == "15:30" && strings.Contains(strings.ToLower(ts[0].Title), "marcos") &&
					strings.HasPrefix(ts[1].Title, "Comprar pan") && ts[1].Date == "2026-11-27"
			}, -1},
		// The long dictation as the live session transcribed it (pre-roll included).
		{"long, live transcripts", []string{"Vale, a ver. A ver, el lunes tengo que llamar al dentista para pedir cita. Y también enviarle la factura a Pedro antes de jueves, eso es urgente.", "Y comprar leche.", "No. Espera. Lo del dentista mejor el martes por la mañana."}, nil, nil,
			func(ts []Task) bool {
				return len(ts) == 3 && ts[0].Date == "2026-11-24" && ts[0].Deadline == "" && ts[1].Deadline != "" && ts[1].Priority == 1 && ts[2].Deadline == ""
			}, -1},
		{"more after a correction", []string{"Llamar al fontanero mañana.", "No, mejor el lunes.", "Y también comprar bombillas.", "Además tengo que pagar la luz el día 30."}, nil, nil,
			func(ts []Task) bool {
				return len(ts) == 3 && ts[0].Date == "2026-11-23" && strings.Contains(strings.ToLower(ts[1].Title), "bombillas") &&
					strings.Contains(strings.ToLower(ts[2].Title), "luz") && ts[2].Date == "2026-11-30"
			}, -1},
		// The owner's own way of ending a dictation, from their first test.
		{"the owner ends", []string{"El martes tengo una reunión con Miguel a las tres.", "Y mañana hacer una cosa con Celeste en la plaza de la Virgen.", "Y algo más. Yo creo que eso es todo lo principal. Yo creo que por el momento eso está bien."}, nil, nil,
			func(ts []Task) bool {
				return len(ts) == 2 && ts[0].Date == "2026-11-24" && ts[0].Time == "15:00" && strings.Contains(strings.ToLower(ts[0].Title), "miguel") &&
					ts[1].Date == "2026-11-22" && strings.Contains(strings.ToLower(ts[1].Title), "celeste")
			}, 2},
		{"a task, then that is all", []string{"Llamar a Lucía el jueves.", "Y comprar pan. Eso es todo."}, nil, nil,
			func(ts []Task) bool { return len(ts) == 2 && strings.HasPrefix(ts[1].Title, "Comprar pan") }, 1},
		{"nothing more", []string{"Pagar el alquiler el día 1.", "Vale, nada más."}, nil, nil,
			func(ts []Task) bool { return len(ts) == 1 && ts[0].Date == "2026-12-01" }, 1},
		// An ending worded unlike any example in the prompt.
		{"an ending of its own", []string{"Revisar el correo del banco.", "Bueno, pues creo que con esto ya lo tengo todo."}, nil, nil,
			func(ts []Task) bool { return len(ts) == 1 }, 1},
		// Not the end of the dictation: a list inside a task, a correction closed.
		{"nothing more in a task", []string{"Comprar leche, huevos y nada más."}, nil, nil,
			func(ts []Task) bool { return len(ts) == 1 }, -1},
		{"a correction closed", []string{"Llamar a mamá mañana.", "No, a las cinco, ya está."}, nil, nil,
			func(ts []Task) bool { return len(ts) == 1 && ts[0].Time == "17:00" }, -1},
	}
	runs := 1
	if n, err := strconv.Atoi(os.Getenv("OPENTODO_VOICE_TEST_RUNS")); err == nil && n > 1 {
		runs = n
	}
	var all []scenario
	for i := 0; i < runs; i++ {
		all = append(all, scenarios...)
	}
	failures := 0
	for _, sc := range all {
		var tasks []Task
		var previous []string
		var log []string
		finishRight := true
		for i, text := range sc.phrases {
			start := time.Now()
			actions, err := Interpret(t.Context(), client, "https://api.openai.com", key, cfg, Request{
				Text: text, Language: "es", Now: "2026-11-21T16:05", TimeZone: "Europe/Madrid",
				Tasks: tasks, Previous: previous, Projects: sc.projects, Labels: sc.labels,
			})
			if err != nil {
				t.Fatalf("%s: %q: %v", sc.name, text, err)
			}
			took := time.Since(start)
			total += took
			calls++
			if took > slowest {
				slowest = took
			}
			acts, _ := json.Marshal(actions)
			log = append(log, took.Round(10*time.Millisecond).String()+" "+text+" -> "+string(acts))
			finished := len(actions) > 0 && actions[len(actions)-1].Type == "finish"
			if finished != (i == sc.finishAt) {
				finishRight = false
			}
			tasks = applyForTest(tasks, actions)
			previous = append(previous, text)
		}
		if !sc.ok(tasks) || !finishRight {
			failures++
			t.Errorf("%s: tasks = %+v, finish right = %v\n%s", sc.name, tasks, finishRight, strings.Join(log, "\n"))
		} else if os.Getenv("OPENTODO_VOICE_TEST_VERBOSE") != "" {
			t.Logf("%s ok: %s", sc.name, strings.Join(log, " | "))
		}
	}
	t.Logf("%s (reasoning %q): %d of %d scenario runs right; %d calls, mean %s, slowest %s", cfg.InterpretModel, cfg.Reasoning,
		len(all)-failures, len(all), calls, (total / time.Duration(max(calls, 1))).Round(10*time.Millisecond), slowest.Round(10*time.Millisecond))
}

// applyForTest applies operations the way the app does.
func applyForTest(tasks []Task, actions []Action) []Task {
	for _, a := range actions {
		switch a.Type {
		case "create":
			t := Task{Title: *a.Title}
			setForTest(&t, a)
			tasks = append(tasks, t)
		case "update":
			t := &tasks[*a.Ref-1]
			if a.Title != nil {
				t.Title = *a.Title
			}
			setForTest(t, a)
			for _, f := range a.Clear {
				switch f {
				case "date":
					t.Date = ""
				case "time":
					t.Time = ""
				case "deadline":
					t.Deadline = ""
				case "recurrence":
					t.Recurrence = ""
				case "project":
					t.Project = ""
				case "labels":
					t.Labels = nil
				case "priority":
					t.Priority = 0
				}
			}
		case "delete":
			tasks[*a.Ref-1].Deleted = true
		}
	}
	return tasks
}

func setForTest(t *Task, a Action) {
	if a.Date != nil {
		t.Date = *a.Date
	}
	if a.Time != nil {
		t.Time = *a.Time
	}
	if a.Deadline != nil {
		t.Deadline = *a.Deadline
	}
	if a.Recurrence != nil {
		t.Recurrence = *a.Recurrence
	}
	if a.Project != nil {
		t.Project = *a.Project
	}
	if a.Labels != nil {
		t.Labels = a.Labels
	}
	if a.Priority != nil {
		t.Priority = *a.Priority
	}
}
