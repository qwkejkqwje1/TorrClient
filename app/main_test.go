package main

// Проверки выбора каталога данных окна. Окно держит там localStorage и кэш, и
// место для него выбирается не по вкусу: на сетевом ресурсе WebView2 работать
// не может, а обрыв процесса оставляет на ресурсе открытые файлы — после этого
// каталог не открывается, и приложение выглядит не запускающимся вовсе.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Главный случай: программа лежит на сетевом диске. Каталог данных окна обязан
// уйти на системный диск, а не остаться рядом с программой.
func TestChooseWebviewPathLeavesTheNetworkDrive(t *testing.T) {
	got := chooseWebviewPath(`Y:\TorrClientPortableX`, false, `C:\Users\user\AppData\Local`)
	want := filepath.Join(`C:\Users\user\AppData\Local`, "TorrClient", "webview")
	if got != want {
		t.Fatalf("каталог данных: %q, ожидался %q", got, want)
	}
	if strings.HasPrefix(got, `Y:\`) {
		t.Errorf("каталог данных остался на сетевом диске: %q", got)
	}
}

// На локальном диске поведение прежнее: каталог рядом с программой, сборка
// остаётся портативной.
func TestChooseWebviewPathStaysPortableOnALocalDisk(t *testing.T) {
	got := chooseWebviewPath(`C:\Apps\TorrClient`, true, `C:\Users\user\AppData\Local`)
	want := filepath.Join(`C:\Apps\TorrClient`, ".webview")
	if got != want {
		t.Fatalf("каталог данных: %q, ожидался %q", got, want)
	}
}

// Без известного каталога системы всё равно нужен пригодный путь, а не пустая
// строка: пустая означала бы «рядом с программой» уже внутри WebView2.
func TestChooseWebviewPathAlwaysAnswersSomethingUsable(t *testing.T) {
	for _, tc := range []struct {
		name             string
		exeDir           string
		local            bool
		localAppData     string
		wantUnderSysTemp bool
	}{
		{"пустой каталог программы и нет LOCALAPPDATA", "", false, "", true},
		{"каталог программы неизвестен", "", true, `C:\Users\user\AppData\Local`, false},
	} {
		got := chooseWebviewPath(tc.exeDir, tc.local, tc.localAppData)
		if got == "" {
			t.Errorf("%s: путь пуст", tc.name)
			continue
		}
		if !filepath.IsAbs(got) {
			t.Errorf("%s: путь не абсолютный: %q", tc.name, got)
		}
		if tc.wantUnderSysTemp && !strings.HasPrefix(got, os.TempDir()) {
			t.Errorf("%s: путь %q вне временного каталога %q", tc.name, got, os.TempDir())
		}
		if !tc.wantUnderSysTemp && !strings.HasPrefix(got, tc.localAppData) {
			t.Errorf("%s: путь %q вне LOCALAPPDATA %q", tc.name, got, tc.localAppData)
		}
	}
}

// Сетевые, UNC- и относительные пути локальными не считаются — иначе каталог
// данных окна снова оказался бы на ресурсе, который его не выдерживает.
func TestIsLocalFixedDriveRejectsNonLocalPaths(t *testing.T) {
	for _, p := range []string{
		"",
		`\\VBoxSvr\D_DRIVE\TorrClientPortableX`,
		`\\server\share\app`,
		`относительный\путь`,
		`/tmp/что-то`,
	} {
		if isLocalFixedDrive(p) {
			t.Errorf("путь %q признан локальным диском", p)
		}
	}
}

// Каталог временных файлов лежит на системном диске — на нём проверка обязана
// ответить «да», иначе выбор каталога данных всегда уходил бы в LOCALAPPDATA.
func TestIsLocalFixedDriveAcceptsTheSystemDisk(t *testing.T) {
	if !isLocalFixedDrive(t.TempDir()) {
		t.Skip("временный каталог не на локальном диске — проверка неприменима")
	}
}

// Переменная окружения перекрывает выбор: ею пользуются и проверки, и тот, кому
// нужно увести кэш окна в известное место.
func TestWebviewDataPathHonoursTheOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TC_WEBVIEW_DATA", dir)
	if got := webviewDataPath(); got != dir {
		t.Fatalf("каталог данных: %q, ожидался %q", got, dir)
	}
}

// Без перекрытия каталог создаётся и оказывается пригодным: пустой путь до
// WebView2 не доходит.
func TestWebviewDataPathCreatesTheChosenFolder(t *testing.T) {
	t.Setenv("TC_WEBVIEW_DATA", "")
	t.Setenv("LOCALAPPDATA", filepath.Join(t.TempDir(), "Local"))

	got := webviewDataPath()
	if got == "" {
		t.Fatal("каталог данных не выбран")
	}
	fi, err := os.Stat(got)
	if err != nil || !fi.IsDir() {
		t.Fatalf("каталог данных %q не создан: %v", got, err)
	}
	// Программа при проверке запущена с сетевого диска (Y:), поэтому каталог
	// обязан быть вне её каталога.
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		if !isLocalFixedDrive(exeDir) && strings.HasPrefix(got, exeDir) {
			t.Errorf("на сетевом диске каталог данных остался рядом с программой: %q", got)
		}
	}
}
