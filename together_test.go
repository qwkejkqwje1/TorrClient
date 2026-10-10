package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseVLCCtl(t *testing.T) {
	s, err := parseVLCCtl([]byte(`{"state":"paused","time":61,"length":120,"position":0.5125,"rate":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if !s.Paused || s.Dur != 120 || s.Pos < 61.4 || s.Pos > 61.6 || s.Rate != 1 {
		t.Fatalf("неверно прочитано: %+v", s)
	}
	s, _ = parseVLCCtl([]byte(`{"state":"playing","time":10,"length":0,"position":0}`))
	if s.Paused || s.Pos != 10 {
		t.Fatalf("без длины позиция берётся из time: %+v", s)
	}
}

func TestOsdSafe(t *testing.T) {
	got := osdSafe("Вася: ${filename}\x07 привет")
	if strings.Contains(got, "${") || strings.ContainsRune(got, 7) {
		t.Fatalf("подпись не очищена: %q", got)
	}
	if n := len([]rune(osdSafe(strings.Repeat("я", 500)))); n > 301 {
		t.Fatalf("длинная подпись не обрезана: %d", n)
	}
}

// fakeMpv отвечает на команды так, как mpv: с событиями между ответами.
func fakeMpv(t *testing.T) (string, *[]string) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "mpv.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Skip("unix-сокеты недоступны:", err)
	}
	t.Cleanup(func() { l.Close() })
	var seen []string
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				r := bufio.NewReader(c)
				for {
					line, err := r.ReadBytes('\n')
					if err != nil {
						return
					}
					var req struct {
						Command []any `json:"command"`
						ID      int   `json:"request_id"`
					}
					_ = json.Unmarshal(line, &req)
					seen = append(seen, string(line))
					c.Write([]byte(`{"event":"property-change"}` + "\n"))
					var data any
					if len(req.Command) > 1 && req.Command[0] == "get_property" {
						switch req.Command[1] {
						case "time-pos":
							data = 42.5
						case "duration":
							data = 100.0
						case "pause":
							data = true
						case "speed":
							data = 1.0
						case "path":
							data = "http://x/stream?index=3"
						}
					}
					b, _ := json.Marshal(map[string]any{"data": data, "error": "success", "request_id": req.ID})
					c.Write(append(b, '\n'))
				}
			}(conn)
		}
	}()
	return sock, &seen
}

func TestMpvCtl(t *testing.T) {
	sock, seen := fakeMpv(t)
	ctl := mpvCtl(sock)
	st, err := ctl.state(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.Pos != 42.5 || st.Dur != 100 || !st.Paused || st.Rate != 1 {
		t.Fatalf("состояние: %+v", st)
	}
	if err := ctl.pause(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if err := ctl.osd(context.Background(), "привет", 3000); err != nil {
		t.Fatal(err)
	}
	all := strings.Join(*seen, "")
	if !strings.Contains(all, `["set_property","pause",false]`) || !strings.Contains(all, `"show-text"`) {
		t.Fatalf("команды не дошли: %s", all)
	}
}
