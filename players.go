package main

// Поиск внешних плееров: реестр, известные каталоги, PATH.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ---------- player detection ----------

func defaultArgs() map[string]string {
	return map[string]string{
		"vlc":     `"{url}" --play-and-exit`,
		"pot":     `"{url}"`,
		"mpc":     `"{url}"`,
		"mpcbe":   `"{url}"`,
		"mpv":     `"{url}"`,
		"km":      `"{url}"`,
		"browser": `inbrowser`,
	}
}

// defaultPlayers — плееры, которые ищутся на машине. Порядок важен: он же порядок
// предпочтения при автовыборе, поэтому первыми идут те, что умеют сообщать позицию
// (VLC, PotPlayer, MPC, MPV), а KMPlayer — последним: позицию он не отдаёт.
func defaultPlayers() []*Player {
	return []*Player{
		{Key: "vlc", Name: "VLC", Args: defaultArgs()["vlc"]},
		{Key: "pot", Name: "PotPlayer", Args: defaultArgs()["pot"]},
		{Key: "mpc", Name: "MPC-HC", Args: defaultArgs()["mpc"]},
		{Key: "mpcbe", Name: "MPC-BE", Args: defaultArgs()["mpcbe"]},
		{Key: "mpv", Name: "MPV", Args: defaultArgs()["mpv"]},
		{Key: "km", Name: "KMPlayer", Args: defaultArgs()["km"]},
	}
}

func findExe(p string) bool {
	if p == "" {
		return false
	}
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

// playerOrder — порядок обхода: он же порядок предпочтения при автовыборе.
var playerOrder = []string{"vlc", "pot", "mpc", "mpcbe", "mpv", "km"}

// playerRel — где плеер обычно лежит относительно корня поиска.
var playerRel = map[string][]string{
	"vlc": {
		`VideoLAN\VLC\vlc.exe`,
		`VideoLAN\x64\vlc.exe`,
		`VLC\vlc.exe`,
		`Programs\VideoLAN\VLC\vlc.exe`,
		`Programs\VLC\vlc.exe`,
		`PortableApps\VLCPortable\App\vlc\vlc.exe`,
	},
	"pot": {
		`DAUM\PotPlayer\PotPlayerMini64.exe`,
		`DAUM\PotPlayer\PotPlayerMini.exe`,
		`PotPlayer\PotPlayerMini64.exe`,
		`PotPlayer64\PotPlayerMini64.exe`,
		`PotPlayer\PotPlayer64.exe`,
		`Programs\DAUM\PotPlayer\PotPlayerMini64.exe`,
	},
	"mpc": {
		`MPC-HC\mpc-hc64.exe`,
		`MPC-HC64\mpc-hc64.exe`,
		`MPC-HC\mpc-hc.exe`,
		`K-Lite Codec Pack\MPC-HC\mpc-hc64.exe`,
		`K-Lite Codec Pack\MPC-HC\mpc-hc.exe`,
		`K-Lite Codec Pack\MPC-HC64\mpc-hc64.exe`,
		`Programs\MPC-HC\mpc-hc64.exe`,
	},
	"mpcbe": {
		`MPC-BE\mpc-be64.exe`,
		`MPC-BE x64\mpc-be64.exe`,
		`MPC-BE\mpc-be.exe`,
		`MPC-BE\MPC-BE.exe`,
		`Programs\MPC-BE\mpc-be64.exe`,
	},
	"mpv": {
		`mpv\mpv.exe`,
		`mpv-x86_64\mpv.exe`,
		`shinchiro\mpv\mpv.exe`,
		`Programs\mpv\mpv.exe`,
		`mpv.net\mpvnet.exe`,
		`Programs\mpv.net\mpvnet.exe`,
	},
	"km": {
		`KMPlayer\KMPlayer.exe`,
		`KMPlayer64\KMPlayer64.exe`,
		`The KMPlayer\KMPlayer.exe`,
		`Programs\KMPlayer\KMPlayer.exe`,
	},
}

// playerNames — имена файлов: ими плеер опознаётся в папке без подкаталогов,
// рядом с самой программой и в `PATH`.
var playerNames = map[string][]string{
	"vlc":   {"vlc.exe"},
	"pot":   {"PotPlayerMini64.exe", "PotPlayerMini.exe", "PotPlayer64.exe", "PotPlayer.exe"},
	"mpc":   {"mpc-hc64.exe", "mpc-hc.exe"},
	"mpcbe": {"mpc-be64.exe", "mpc-be.exe", "MPC-BE.exe"},
	"mpv":   {"mpv.exe", "mpvnet.exe"},
	"km":    {"KMPlayer64.exe", "KMPlayer.exe"},
}

// playerRegKeys — ключи реестра, куда установщики пишут папку программы.
var playerRegKeys = []struct{ Key, Value, Player, Exe string }{
	{`HKLM\SOFTWARE\VideoLAN\VLC`, "InstallDir", "vlc", "vlc.exe"},
	{`HKLM\SOFTWARE\WOW6432Node\VideoLAN\VLC`, "InstallDir", "vlc", "vlc.exe"},
	{`HKCU\Software\DAUM\PotPlayer64`, "", "pot", "PotPlayerMini64.exe"},
	{`HKCU\Software\DAUM\PotPlayer`, "", "pot", "PotPlayerMini.exe"},
	{`HKLM\SOFTWARE\MPC-HC`, "ExePath", "mpc", "mpc-hc64.exe"},
	{`HKLM\SOFTWARE\MPC-BE`, "ExePath", "mpcbe", "mpc-be64.exe"},
}

// playerRoots — где вообще искать. Системные папки программ, папка самой программы
// с `tools` (портативная сборка кладёт плеер рядом), корни дисков: плееры часто
// просто распаковывают в `D:\VLC` и никуда не устанавливают.
func playerRoots() []string {
	var roots []string
	seen := map[string]bool{}
	add := func(p string) {
		if p == "" {
			return
		}
		p = filepath.Clean(p)
		k := strings.ToLower(p)
		if seen[k] {
			return
		}
		fi, err := os.Stat(p)
		if err != nil || !fi.IsDir() {
			return
		}
		seen[k] = true
		roots = append(roots, p)
	}
	for _, e := range []string{"ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
		"LOCALAPPDATA", "APPDATA", "ProgramData", "USERPROFILE"} {
		add(os.Getenv(e))
	}
	if exe, err := os.Executable(); err == nil {
		d := filepath.Dir(exe)
		add(d)
		add(filepath.Join(d, "tools"))
		add(filepath.Join(d, "players"))
	}
	// Флоппи и `Z:` не трогаем: `A:` отвечает по несколько секунд, а сетевые диски
	// подвешивают поиск.
	for _, d := range "CDEFGHIJ" {
		add(string(d) + `:\`)
	}
	return roots
}

// detectPlayersIn ищет плееры только по переданным корням — без реестра и без
// `PATH`. Так проверка подставляет свой каталог и не зависит от того, что стоит на
// машине сборки.
func detectPlayersIn(roots []string) map[string]string {
	found := map[string]string{}
	for _, key := range playerOrder {
		for _, r := range roots {
			for _, rel := range playerRel[key] {
				if p := filepath.Join(r, rel); findExe(p) {
					found[key] = p
					break
				}
			}
			if found[key] != "" {
				break
			}
		}
	}
	for _, key := range playerOrder {
		if found[key] != "" {
			continue
		}
		for _, r := range roots {
			for _, n := range playerNames[key] {
				if p := filepath.Join(r, n); findExe(p) {
					found[key] = p
					break
				}
			}
			if found[key] != "" {
				break
			}
		}
	}
	return found
}

func detectPlayers() map[string]string {
	found := detectPlayersIn(playerRoots())
	// Реестр читается только там, где файловый поиск ничего не дал: `reg.exe` на
	// машине может быть закрыт политикой, и падать из-за этого поиск не должен.
	for _, q := range playerRegKeys {
		if found[q.Player] != "" {
			continue
		}
		dir := regQueryString(q.Key, q.Value)
		if dir == "" {
			continue
		}
		if strings.HasSuffix(strings.ToLower(dir), ".exe") {
			if findExe(dir) {
				found[q.Player] = dir
			}
			continue
		}
		if p := filepath.Join(dir, q.Exe); findExe(p) {
			found[q.Player] = p
		}
	}
	// `PATH`: плеер мог быть поставлен пакетным менеджером или распакован в
	// отдельную папку, добавленную в переменную.
	for _, key := range playerOrder {
		if found[key] != "" {
			continue
		}
		for _, n := range playerNames[key] {
			if p, err := exec.LookPath(n); err == nil {
				found[key] = p
				break
			}
		}
	}
	return found
}

// scanPlayersInto заполняет пустые пути найденным и добавляет те плееры, которых в
// настройках ещё нет. Без этого кнопка «Автообнаружение» не показывала новый плеер:
// список был собран один раз при первом запуске.
func scanPlayersInto(cfg *Config) []*Player {
	det := detectPlayers()
	known := map[string]bool{}
	for _, p := range cfg.Players {
		known[p.Key] = true
		if p.Path == "" && det[p.Key] != "" {
			p.Path = det[p.Key]
		}
		p.Found = findExe(p.Path)
	}
	for _, d := range defaultPlayers() {
		if known[d.Key] {
			continue
		}
		if det[d.Key] != "" {
			d.Path = det[d.Key]
			d.Found = true
		}
		cfg.Players = append(cfg.Players, d)
	}
	return cfg.Players
}

func regQueryString(key, val string) string {
	args := []string{"query", key}
	if val != "" {
		args = append(args, "/v", val)
	}
	out, err := exec.Command(`reg.exe`, args...).CombinedOutput()
	if err != nil {
		return ""
	}
	return parseRegQuery(string(out), val)
}

// parseRegQuery вынимает значение из вывода `reg query`. Строка выглядит так:
//
//	InstallPath    REG_SZ    C:\Program Files\DAUM\PotPlayer
//
// Значение может содержать пробелы, поэтому берётся весь остаток строки, а не
// второе поле: прежде путь обрезался по первому пробелу.
func parseRegQuery(out, val string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		i := strings.Index(line, "REG_")
		if i < 0 {
			continue
		}
		rest := line[i:]
		sp := strings.IndexAny(rest, " \t")
		if sp < 0 {
			continue
		}
		v := strings.Trim(strings.TrimSpace(rest[sp+1:]), `"`)
		if v == "" {
			continue
		}
		// Имя значения не задано — значит читается весь ключ, и рядом с папкой
		// программы там лежат числовые настройки. Путь выбирается по виду.
		if val == "" && !looksLikePath(v) {
			continue
		}
		return expandWinEnv(v)
	}
	return ""
}

// looksLikePath отличает путь от числа: `REG_DWORD 0x2` — не папка программы.
func looksLikePath(v string) bool {
	if v == "" {
		return false
	}
	if strings.HasPrefix(v, `\\`) || strings.HasPrefix(v, "%") {
		return true
	}
	return len(v) > 2 && v[1] == ':'
}

// expandWinEnv раскрывает `%ИМЯ%` — так записаны пути в реестре. `os.ExpandEnv`
// здесь не годится: он понимает только `$ИМЯ`.
func expandWinEnv(s string) string {
	for i := 0; i < 8; i++ {
		a := strings.Index(s, "%")
		if a < 0 {
			break
		}
		b := strings.Index(s[a+1:], "%")
		if b < 0 {
			break
		}
		name := s[a+1 : a+1+b]
		v := os.Getenv(name)
		if v == "" {
			break
		}
		s = s[:a] + v + s[a+1+b+1:]
	}
	return s
}
