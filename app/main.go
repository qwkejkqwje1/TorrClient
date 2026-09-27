package main

import (
	"embed"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

// singleInstance guard: a second TorrClient.exe should silently exit instead of
// opening another window/daemon (daemon and TorrServer are already guarded by
// their own ports).
var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	procCreateMutex  = kernel32.NewProc("CreateMutexW")
	procCloseHandle  = kernel32.NewProc("CloseHandle")
	singleInstanceMu syscall.Handle
)

// acquireSingleInstance не даёт подняться второму окну: повторный запуск
// молча завершается, вместо того чтобы открыть ещё одно окно и ещё один демон.
//
// Код ошибки берётся из третьего результата Call, а не из syscall.GetLastError().
// Тот сообщает об ошибке текущего потока, а поток между вызовом и проверкой
// успевает смениться — проверка «уже запущено» молча не срабатывала, и рядом
// открывалось второе окно. Проверено живым запуском: две оболочки работали
// одновременно.
func acquireSingleInstance() bool {
	name, err := syscall.UTF16PtrFromString("Local\\Torr1ClientPortableMutex")
	if err != nil {
		return true
	}
	h, _, callErr := procCreateMutex.Call(0, 0, uintptr(unsafe.Pointer(name)))
	hw := syscall.Handle(h)
	if hw == 0 {
		return true // мутекс не создался — просто работаем
	}
	if errors.Is(callErr, syscall.ERROR_ALREADY_EXISTS) {
		procCloseHandle.Call(uintptr(h))
		return false
	}
	singleInstanceMu = hw
	return true
}

//go:embed all:frontend/dist
var assets embed.FS

// driveFixed — DRIVE_FIXED из GetDriveTypeW.
const driveFixed = 3

var procGetDriveType = kernel32.NewProc("GetDriveTypeW")

// isLocalFixedDrive отвечает, лежит ли путь на локальном несъёмном диске.
// Пустой путь, UNC-путь и путь без буквы диска локальными не считаются: именно
// на них каталог данных окна держать нельзя.
func isLocalFixedDrive(path string) bool {
	vol := filepath.VolumeName(path)
	if len(vol) < 2 || vol[1] != ':' {
		return false
	}
	root, err := syscall.UTF16PtrFromString(vol + `\`)
	if err != nil {
		return false
	}
	t, _, _ := procGetDriveType.Call(uintptr(unsafe.Pointer(root)))
	return t == driveFixed
}

// chooseWebviewPath — выбор каталога данных окна, отдельно от окружения, чтобы
// решение можно было проверить без запуска окна.
//
// Рядом с программой каталог остаётся только на локальном диске: так сборка
// портативна и ничего не пишет на системный диск. На сетевом ресурсе его
// держать нельзя — WebView2 такие пути не поддерживает, а обрыв процесса
// оставляет на ресурсе открытые файлы, и каталог перестаёт открываться
// навсегда: окно не появляется вовсе, и приложение выглядит не запускающимся.
func chooseWebviewPath(exeDir string, localFixed bool, localAppData string) string {
	if localFixed && exeDir != "" {
		return filepath.Join(exeDir, ".webview")
	}
	// Это кэш окна, а не состояние пользователя: перенос на системный диск
	// портативности не ломает — настройки, отметки и избранное остаются рядом
	// с программой.
	base := localAppData
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "TorrClient", "webview")
}

// webviewDataPath keeps WebView2 user data (localStorage, HTTP cache). The
// folder sits next to the app binary when that binary is on a local disk, so
// the build stays portable; on a network share it moves to LOCALAPPDATA, where
// WebView2 can actually work. TC_WEBVIEW_DATA overrides the location.
func webviewDataPath() string {
	if v := os.Getenv("TC_WEBVIEW_DATA"); v != "" {
		return v
	}
	exeDir := ""
	if exe, err := os.Executable(); err == nil {
		exeDir = filepath.Dir(exe)
	}
	dir := chooseWebviewPath(exeDir, exeDir != "" && isLocalFixedDrive(exeDir), os.Getenv("LOCALAPPDATA"))
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// NOTE: must be built with -tags production (that's what "wails build" does).
// Without it, wails compiles a stub that shows an error dialog and exits.
func main() {
	if !acquireSingleInstance() {
		os.Exit(0)
	}
	defer procCloseHandle.Call(uintptr(singleInstanceMu))
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "TorrClient",
		Width:     1280,
		Height:    820,
		MinWidth:  900,
		MinHeight: 560,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		Windows: &windows.Options{
			WebviewUserDataPath: webviewDataPath(),
		},
		BackgroundColour: &options.RGBA{R: 14, G: 19, B: 26, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
