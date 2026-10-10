package main

// «Смотрим вместе»: управление запущенным плеером из окна.
//
// Синхронизацию ведёт интерфейс: он обменивается состоянием с друзьями (через
// WebRTC или MQTT) и через этот адрес ставит паузу, продолжает, перематывает,
// чуть ускоряет плеер, чтобы догнать, и выводит сообщения чата поверх видео.
// Демон только знает, какой плеер запущен последним и как с ним говорить:
// mpv — по своему каналу управления, VLC — по http-интерфейсу.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"

	"strconv"
	"strings"
	"sync"
	"time"
)

// ctlState — что сейчас показывает плеер.
type ctlState struct {
	Pos    float64 `json:"pos"`
	Dur    float64 `json:"dur"`
	Paused bool    `json:"paused"`
	Rate   float64 `json:"rate"`
	Path   string  `json:"path,omitempty"`
}

// playerCtl — команды плееру. osd == nil — плеер не умеет показывать текст.
type playerCtl struct {
	state func(ctx context.Context) (ctlState, error)
	pause func(ctx context.Context, on bool) error
	seek  func(ctx context.Context, pos float64) error
	rate  func(ctx context.Context, v float64) error
	osd   func(ctx context.Context, text string, ms int) error
}

type ctlSession struct {
	ctl    *playerCtl
	player string
	hash   string
	fileID int
	nowID  int64
	since  time.Time
}

var (
	ctlMu  sync.Mutex
	ctlCur *ctlSession
)

func ctlSet(s *ctlSession) { ctlMu.Lock(); ctlCur = s; ctlMu.Unlock() }
func ctlClear(s *ctlSession) {
	ctlMu.Lock()
	if ctlCur == s {
		ctlCur = nil
	}
	ctlMu.Unlock()
}
func ctlGet() *ctlSession { ctlMu.Lock(); defer ctlMu.Unlock(); return ctlCur }

// ---------- mpv ----------

// mpvCall отправляет несколько команд одной записью и собирает ответы по
// номерам. Между ответами mpv шлёт события — они пропускаются.
func mpvCall(ctx context.Context, endpoint string, cmds ...[]any) ([]mpvReply, error) {
	conn, err := dialPlayer(endpoint)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	release := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer release()
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-time.After(playerReadTimeout):
			_ = conn.Close()
		case <-stop:
		}
	}()
	var b bytes.Buffer
	for i, c := range cmds {
		line, err := json.Marshal(map[string]any{"command": c, "request_id": 100 + i})
		if err != nil {
			return nil, err
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	if _, err := conn.Write(b.Bytes()); err != nil {
		return nil, err
	}
	out := make([]mpvReply, len(cmds))
	got := 0
	reader := bufio.NewReader(io.LimitReader(conn, maxPlayerBody))
	for lines := 0; got < len(cmds) && lines < 64; lines++ {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			break
		}
		var r mpvReply
		if json.Unmarshal(bytes.TrimSpace(line), &r) != nil || r.RequestID < 100 || r.RequestID >= 100+len(cmds) {
			continue
		}
		out[r.RequestID-100] = r
		got++
	}
	if got < len(cmds) {
		return out, errors.New("mpv ответил не на все команды")
	}
	return out, nil
}

func mpvOK(r []mpvReply, err error) error {
	if err != nil {
		return err
	}
	for _, x := range r {
		if x.Error != "success" {
			return errors.New("mpv: " + x.Error)
		}
	}
	return nil
}

func mpvCtl(endpoint string) *playerCtl {
	return &playerCtl{
		state: func(ctx context.Context) (ctlState, error) {
			r, err := mpvCall(ctx, endpoint, []any{"get_property", "time-pos"}, []any{"get_property", "duration"}, []any{"get_property", "pause"}, []any{"get_property", "speed"}, []any{"get_property", "path"})
			if err != nil {
				return ctlState{}, err
			}
			var s ctlState
			pos, ok := r[0].num()
			if !ok {
				return ctlState{}, errors.New("mpv не сообщил позицию")
			}
			s.Pos = pos
			s.Dur, _ = r[1].num()
			_ = json.Unmarshal(r[2].Data, &s.Paused)
			if v, ok := r[3].num(); ok {
				s.Rate = v
			}
			_ = json.Unmarshal(r[4].Data, &s.Path)
			return s, nil
		},
		pause: func(ctx context.Context, on bool) error {
			return mpvOK(mpvCall(ctx, endpoint, []any{"set_property", "pause", on}))
		},
		seek: func(ctx context.Context, pos float64) error {
			return mpvOK(mpvCall(ctx, endpoint, []any{"seek", pos, "absolute+exact"}))
		},
		rate: func(ctx context.Context, v float64) error {
			return mpvOK(mpvCall(ctx, endpoint, []any{"set_property", "speed", v}))
		},
		osd: func(ctx context.Context, text string, ms int) error {
			return mpvOK(mpvCall(ctx, endpoint, []any{"show-text", text, ms}))
		},
	}
}

// ---------- VLC ----------

type vlcStatus struct {
	State    string  `json:"state"`
	Time     float64 `json:"time"`
	Length   float64 `json:"length"`
	Position float64 `json:"position"`
	Rate     float64 `json:"rate"`
}

// parseVLCCtl читает состояние VLC. Позиция в секундах у VLC целая, поэтому
// точнее брать долю (position) от длины.
func parseVLCCtl(body []byte) (ctlState, error) {
	var v vlcStatus
	if err := json.Unmarshal(body, &v); err != nil {
		return ctlState{}, err
	}
	s := ctlState{Pos: v.Time, Dur: v.Length, Paused: v.State != "playing", Rate: v.Rate}
	if v.Length > 0 && v.Position > 0 && v.Position <= 1 {
		s.Pos = v.Position * v.Length
	}
	if math.IsNaN(s.Pos) || s.Pos < 0 {
		s.Pos = 0
	}
	return s, nil
}

func vlcCtl(p httpPoller) *playerCtl {
	do := func(ctx context.Context, query string) ([]byte, error) {
		u := p.url
		if query != "" {
			u += "?" + query
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, err
		}
		req.SetBasicAuth("", p.password)
		resp, err := playerClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("VLC ответил кодом %d", resp.StatusCode)
		}
		return io.ReadAll(io.LimitReader(resp.Body, maxPlayerBody))
	}
	return &playerCtl{
		state: func(ctx context.Context) (ctlState, error) {
			b, err := do(ctx, "")
			if err != nil {
				return ctlState{}, err
			}
			return parseVLCCtl(b)
		},
		pause: func(ctx context.Context, on bool) error {
			cmd := "pl_forceresume"
			if on {
				cmd = "pl_forcepause"
			}
			_, err := do(ctx, "command="+cmd)
			return err
		},
		seek: func(ctx context.Context, pos float64) error {
			_, err := do(ctx, "command=seek&val="+strconv.Itoa(int(math.Round(pos))))
			return err
		},
		rate: func(ctx context.Context, v float64) error {
			_, err := do(ctx, "command=rate&val="+strconv.FormatFloat(v, 'f', 3, 64))
			return err
		},
	}
}

// ---------- адрес для окна ----------

type ctlCommand struct {
	Action string  `json:"action"`
	Val    float64 `json:"val"`
	Text   string  `json:"text"`
	Ms     int     `json:"ms"`
}

func (c *Comp) apiTogetherPlayer(w http.ResponseWriter, r *http.Request) {
	s := ctlGet()
	if r.Method == http.MethodGet {
		if s == nil {
			jj(w, map[string]any{"active": false})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), playerReadTimeout)
		defer cancel()
		st, err := s.ctl.state(ctx)
		out := map[string]any{"active": true, "player": s.player, "hash": s.hash, "file": nowFileOf(s), "osd": s.ctl.osd != nil, "at": time.Now().UnixMilli()}
		if err != nil {
			out["error"] = err.Error()
		} else {
			out["pos"], out["dur"], out["paused"], out["rate"] = st.Pos, st.Dur, st.Paused, st.Rate
		}
		jj(w, out)
		return
	}
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "только GET и POST")
		return
	}
	if s == nil {
		writeJSONError(w, http.StatusConflict, "плеер не запущен или не умеет управляться")
		return
	}
	var cmd ctlCommand
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&cmd); err != nil {
		writeJSONError(w, http.StatusBadRequest, "неразборчивая команда")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), playerReadTimeout)
	defer cancel()
	var err error
	switch cmd.Action {
	case "pause":
		err = s.ctl.pause(ctx, true)
	case "play":
		err = s.ctl.pause(ctx, false)
	case "seek":
		if cmd.Val < 0 || math.IsNaN(cmd.Val) || cmd.Val > maxPositionSeconds {
			writeJSONError(w, http.StatusBadRequest, "неверная позиция")
			return
		}
		err = s.ctl.seek(ctx, cmd.Val)
	case "rate":
		if cmd.Val < 0.5 || cmd.Val > 2 {
			writeJSONError(w, http.StatusBadRequest, "скорость вне 0.5–2")
			return
		}
		err = s.ctl.rate(ctx, cmd.Val)
	case "osd":
		if s.ctl.osd == nil {
			jj(w, map[string]any{"ok": false, "unsupported": true})
			return
		}
		ms := cmd.Ms
		if ms <= 0 || ms > 15000 {
			ms = 5000
		}
		err = s.ctl.osd(ctx, osdSafe(cmd.Text), ms)
	default:
		writeJSONError(w, http.StatusBadRequest, "неизвестная команда")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	jj(w, map[string]any{"ok": true})
}

// osdSafe — текст для экранной подписи mpv: без управляющих знаков и
// расширений свойств (${…} mpv подставил бы как значение свойства).
func osdSafe(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 32 && r != '\n' {
			return -1
		}
		return r
	}, s)
	s = strings.ReplaceAll(s, "${", "$ {")
	if len([]rune(s)) > 300 {
		s = string([]rune(s)[:300]) + "…"
	}
	return s
}

// nowFileOf — какой файл раздачи сейчас идёт: плейлист мог уйти на следующую серию.
func nowFileOf(s *ctlSession) int {
	nowMu.Lock()
	defer nowMu.Unlock()
	if it, ok := nowMap[s.nowID]; ok {
		return it.FileIndex
	}
	return s.fileID
}
