package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeExe кладёт пустой файл: плеер опознаётся по существованию файла, его
// содержимое поиску не нужно.
func writeExe(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("не создать папку %s: %v", filepath.Dir(p), err)
	}
	if err := os.WriteFile(p, []byte("MZ"), 0o755); err != nil {
		t.Fatalf("не создать файл %s: %v", p, err)
	}
}

// Портативная сборка: плеер просто распакован рядом, установщика не было, в
// реестре о нём ничего нет.
func TestDetectPlayersFindsAPlayerUnpackedIntoAFolder(t *testing.T) {
	dir := t.TempDir()
	writeExe(t, filepath.Join(dir, "vlc.exe"))
	got := detectPlayersIn([]string{dir})
	if got["vlc"] != filepath.Join(dir, "vlc.exe") {
		t.Fatalf("плеер, распакованный прямо в папку, не найден: %q", got["vlc"])
	}
}

func TestDetectPlayersFindsMpvInsideItsOwnFolder(t *testing.T) {
	dir := t.TempDir()
	writeExe(t, filepath.Join(dir, "mpv", "mpv.exe"))
	got := detectPlayersIn([]string{dir})
	if got["mpv"] != filepath.Join(dir, "mpv", "mpv.exe") {
		t.Fatalf("mpv в своей папке не найден: %q", got["mpv"])
	}
}

// Папка с именем файла — не плеер: прежде поиск этого не различал.
func TestDetectPlayersIgnoresAFolderNamedLikeAPlayer(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "vlc.exe"), 0o755); err != nil {
		t.Fatalf("не создать папку: %v", err)
	}
	if got := detectPlayersIn([]string{dir}); got["vlc"] != "" {
		t.Fatalf("папка принята за плеер: %q", got["vlc"])
	}
}

// Порядок корней — порядок предпочтения: из двух найденных берётся первый.
func TestDetectPlayersPrefersTheFirstRoot(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	writeExe(t, filepath.Join(a, "mpc-be64.exe"))
	writeExe(t, filepath.Join(b, "mpc-be64.exe"))
	got := detectPlayersIn([]string{a, b})
	if got["mpcbe"] != filepath.Join(a, "mpc-be64.exe") {
		t.Fatalf("взят плеер не из первого корня: %q", got["mpcbe"])
	}
}

// Установщик VLC пишет папку в реестр, и в пути есть пробелы.
func TestParseRegQueryKeepsTheSpacesInThePath(t *testing.T) {
	out := "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\VideoLAN\\VLC\r\n" +
		"    InstallDir    REG_SZ    C:\\Program Files\\VideoLAN\\VLC\r\n\r\n"
	got := parseRegQuery(out, "InstallDir")
	if got != `C:\Program Files\VideoLAN\VLC` {
		t.Fatalf("путь из реестра прочитан неверно: %q", got)
	}
}

// В ключе PotPlayer рядом с папкой программы лежат числовые настройки, и первой
// строкой с REG_ идёт число, а не путь.
func TestParseRegQuerySkipsNumbersWhenTheValueNameIsUnknown(t *testing.T) {
	out := "HKEY_CURRENT_USER\\Software\\DAUM\\PotPlayer64\r\n" +
		"    Count    REG_DWORD    0x2\r\n" +
		"    InstallPath    REG_SZ    C:\\Program Files\\DAUM\\PotPlayer\r\n"
	got := parseRegQuery(out, "")
	if got != `C:\Program Files\DAUM\PotPlayer` {
		t.Fatalf("вместо пути взято число: %q", got)
	}
}

// Путь может быть записан через %ИМЯ%: os.ExpandEnv такие имена не раскрывает.
func TestExpandWinEnvExpandsPercentNames(t *testing.T) {
	t.Setenv("TC_PLAYER_ROOT", `D:\players`)
	got := expandWinEnv(`%TC_PLAYER_ROOT%\VLC\vlc.exe`)
	if got != `D:\players\VLC\vlc.exe` {
		t.Fatalf("переменная в пути не раскрыта: %q", got)
	}
}

// Плеер кладут рядом с программой — этот каталог обязан попадать в поиск.
func TestPlayerRootsLooksNextToTheProgram(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skipf("не узнать путь к программе: %v", err)
	}
	base := strings.ToLower(filepath.Clean(filepath.Dir(exe)))
	for _, r := range playerRoots() {
		if strings.ToLower(filepath.Clean(r)) == base {
			return
		}
	}
	t.Fatalf("папка программы (%s) не проверяется: портативный плеер рядом не найдётся", base)
}

// Ищется ровно то, что предлагается настроить: плеер, добавленный в поиск и
// забытый в списке по умолчанию, не появится в настройках никогда.
func TestEveryDetectedPlayerIsInTheDefaultList(t *testing.T) {
	known := map[string]bool{}
	for _, p := range defaultPlayers() {
		known[p.Key] = true
	}
	for _, key := range playerOrder {
		if !known[key] {
			t.Errorf("плеер %q ищется, но его нет в списке по умолчанию", key)
		}
	}
	for _, m := range []map[string][]string{playerRel, playerNames} {
		for key := range m {
			if !known[key] {
				t.Errorf("плеер %q описан в путях поиска, но его нет в списке по умолчанию", key)
			}
		}
	}
	for _, q := range playerRegKeys {
		if !known[q.Player] {
			t.Errorf("плеер %q ищется в реестре, но его нет в списке по умолчанию", q.Player)
		}
	}
}
