package main

// Таймер сна: через заданное время или после текущей серии приложение
// закрывает плеер и, по желанию, усыпляет или выключает компьютер.
//
// За минуту до срабатывания интерфейс получает предупреждение и может
// отложить или отменить таймер: засыпать под фильм и проснуться от
// выключенного компьютера посреди сцены — не то, чего хотят.

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

type sleepTimer struct {
	Active bool      `json:"active"`
	Action string    `json:"action"` // stop | sleep | shutdown
	Mode   string    `json:"mode"`   // time | episode
	At     time.Time `json:"at,omitempty"`
	Warned bool      `json:"warned"`

	gen      int
	fileHash string
	fileID   int
}

var (
	sleepMu  sync.Mutex
	sleepCur sleepTimer
	// runningPlayers — запущенные приложением плееры: их таймер и закрывает.
	runningPlayers = map[*exec.Cmd]struct{}{}
	// sleepRun — само действие; подменяется в тестах, чтобы не выключить
	// машину, на которой они идут.
	sleepRun = runSleepAction
)

func trackPlayer(cmd *exec.Cmd)   { sleepMu.Lock(); runningPlayers[cmd] = struct{}{}; sleepMu.Unlock() }
func untrackPlayer(cmd *exec.Cmd) { sleepMu.Lock(); delete(runningPlayers, cmd); sleepMu.Unlock() }

// sleepNoteFile — наблюдение за плеером сообщило, какая серия играет. В
// режиме «после серии» смена файла — сигнал: серия кончилась.
func sleepNoteFile(hash string, id int) {
	sleepMu.Lock()
	t := sleepCur
	if !t.Active || t.Mode != "episode" {
		sleepMu.Unlock()
		return
	}
	if t.fileHash == "" {
		sleepCur.fileHash, sleepCur.fileID = hash, id
		sleepMu.Unlock()
		return
	}
	changed := t.fileHash != hash || t.fileID != id
	sleepMu.Unlock()
	if changed {
		fireSleep(t.gen)
	}
}

// sleepPlayerExited — плеер закрылся сам (серия или фильм кончились).
func sleepPlayerExited() {
	sleepMu.Lock()
	t := sleepCur
	sleepMu.Unlock()
	if t.Active && t.Mode == "episode" {
		fireSleep(t.gen)
	}
}

func armSleep(minutes int, mode, action string) sleepTimer {
	sleepMu.Lock()
	defer sleepMu.Unlock()
	if action != "sleep" && action != "shutdown" {
		action = "stop"
	}
	gen := sleepCur.gen + 1
	sleepCur = sleepTimer{Active: true, Action: action, Mode: "time", gen: gen}
	if mode == "episode" {
		sleepCur.Mode = "episode"
		// Страховка: серия не кончится никогда, если плеер на паузе.
		minutes = 180
	}
	if minutes < 1 {
		minutes = 1
	}
	sleepCur.At = time.Now().Add(time.Duration(minutes) * time.Minute)
	go sleepLoop(gen)
	return sleepCur
}

func cancelSleep() {
	sleepMu.Lock()
	sleepCur = sleepTimer{gen: sleepCur.gen + 1}
	sleepMu.Unlock()
	events.broadcast("sleep", map[string]any{"active": false})
}

func sleepLoop(gen int) {
	for {
		time.Sleep(time.Second)
		sleepMu.Lock()
		t := sleepCur
		if t.gen != gen || !t.Active {
			sleepMu.Unlock()
			return
		}
		left := time.Until(t.At)
		warn := !t.Warned && left <= time.Minute && t.Mode == "time"
		if warn {
			sleepCur.Warned = true
		}
		sleepMu.Unlock()
		if warn {
			events.broadcast("sleep", map[string]any{"active": true, "warn": true, "action": t.Action, "left": int(left.Seconds())})
		}
		if left <= 0 {
			fireSleep(gen)
			return
		}
	}
}

func fireSleep(gen int) {
	sleepMu.Lock()
	if sleepCur.gen != gen || !sleepCur.Active {
		sleepMu.Unlock()
		return
	}
	action := sleepCur.Action
	sleepCur = sleepTimer{gen: gen + 1}
	var cmds []*exec.Cmd
	for c := range runningPlayers {
		cmds = append(cmds, c)
	}
	sleepMu.Unlock()
	events.broadcast("sleep", map[string]any{"active": false, "fired": true, "action": action})
	sleepRun(action, cmds)
}

// runSleepAction закрывает плееры и выполняет выбранное действие.
func runSleepAction(action string, players []*exec.Cmd) {
	for _, c := range players {
		if c.Process != nil {
			_ = c.Process.Kill()
		}
	}
	// Позиции успевают записаться: плеер закрыт, наблюдение сохраняет их.
	time.Sleep(3 * time.Second)
	_ = viewedMarks.save()
	var cmd *exec.Cmd
	switch action {
	case "shutdown":
		switch runtime.GOOS {
		case "windows":
			cmd = exec.Command("shutdown", "/s", "/t", "30", "/c", "TorrClient: таймер сна")
		case "darwin":
			cmd = exec.Command("osascript", "-e", `tell app "System Events" to shut down`)
		default:
			cmd = exec.Command("systemctl", "poweroff")
		}
	case "sleep":
		switch runtime.GOOS {
		case "windows":
			cmd = exec.Command("rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0")
		case "darwin":
			cmd = exec.Command("pmset", "sleepnow")
		default:
			cmd = exec.Command("systemctl", "suspend")
		}
	}
	if cmd != nil {
		detachCmd(cmd)
		if err := cmd.Start(); err != nil {
			logLine("sleep: " + action + ": " + err.Error())
			return
		}
		go func() { _ = cmd.Wait() }()
	}
}

// apiSleep: GET — состояние, POST {minutes, mode, action} — завести,
// POST {cancel:true} — отменить, POST {extend:N} — отложить на N минут.
func (c *Comp) apiSleep(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var in struct {
			Minutes int    `json:"minutes"`
			Mode    string `json:"mode"`
			Action  string `json:"action"`
			Cancel  bool   `json:"cancel"`
			Extend  int    `json:"extend"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in); err != nil {
			writeJSONError(w, http.StatusBadRequest, "неразборчивый запрос")
			return
		}
		switch {
		case in.Cancel:
			cancelSleep()
		case in.Extend > 0:
			sleepMu.Lock()
			if sleepCur.Active {
				sleepCur.At = sleepCur.At.Add(time.Duration(in.Extend) * time.Minute)
				sleepCur.Warned = false
			}
			sleepMu.Unlock()
		default:
			armSleep(in.Minutes, in.Mode, in.Action)
		}
	}
	sleepMu.Lock()
	t := sleepCur
	sleepMu.Unlock()
	left := 0
	if t.Active {
		left = int(time.Until(t.At).Seconds())
	}
	jj(w, map[string]any{"active": t.Active, "action": t.Action, "mode": t.Mode, "left": left})
}
