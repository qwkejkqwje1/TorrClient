//go:build !windows

package main

// Linux и macOS: открытие ссылок, обработчики magnet/.torrent и автозапуск через
// файлы .desktop (Linux). На macOS обработчики и автозапуск не поддерживаются:
// там они настраиваются пакетом приложения, а не файлом рядом с программой.

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

var errPlatformUnsupported = errors.New("на этой системе не поддерживается")

func platformOpenURL(rawurl string) {
	if runtime.GOOS == "darwin" {
		exec.Command("open", rawurl).Start()
		return
	}
	exec.Command("xdg-open", rawurl).Start()
}

// unixPlayerDirs — где пакетные менеджеры и установщики кладут плееры.
func unixPlayerDirs() []string {
	dirs := []string{"/usr/bin", "/usr/local/bin", "/snap/bin", "/opt/homebrew/bin", "/Applications"}
	if h, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(h, ".local", "bin"), filepath.Join(h, "Applications"))
	}
	return dirs
}

// regQueryString: реестра здесь нет.
func regQueryString(key, val string) string { return "" }

func linuxOnly() bool { return runtime.GOOS == "linux" }

func desktopDataDir() string {
	if v := os.Getenv("XDG_DATA_HOME"); v != "" {
		return filepath.Join(v, "applications")
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".local", "share", "applications")
}

func desktopConfigDir() string {
	if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
		return v
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".config")
}

// desktopExec заключает путь в кавычки по правилам Desktop Entry: пробелы и
// служебные символы в пути иначе разорвали бы команду.
func desktopExec(exe string) string {
	r := strings.NewReplacer(`\`, `\\\\`, `"`, `\"`, "`", "\\`", `$`, `\$`)
	return `"` + r.Replace(exe) + `"`
}

func magnetDesktopPath() string { return filepath.Join(desktopDataDir(), "torrclient-magnet.desktop") }
func torrentDesktopPath() string {
	return filepath.Join(desktopDataDir(), "torrclient-torrent.desktop")
}
func autostartPath() string {
	return filepath.Join(desktopConfigDir(), "autostart", "torrclient.desktop")
}

func platformHandlersSupported() bool { return linuxOnly() }

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func platformHandlersStatus() (magnet, torrent bool) {
	if !linuxOnly() {
		return false, false
	}
	return fileExists(magnetDesktopPath()), fileExists(torrentDesktopPath())
}

func writeDesktop(path, body string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(body), 0o644)
}

func platformInstallHandlers(exe string) error {
	if !linuxOnly() {
		return errPlatformUnsupported
	}
	x := desktopExec(exe)
	err := writeDesktop(magnetDesktopPath(), "[Desktop Entry]\nType=Application\nName=TorrClient (magnet)\nExec="+x+" --magnet %u\n"+
		"NoDisplay=true\nMimeType=x-scheme-handler/magnet;\n")
	if err != nil {
		return err
	}
	err = writeDesktop(torrentDesktopPath(), "[Desktop Entry]\nType=Application\nName=Добавить в TorrClient\nExec="+x+" --torrent %f\n"+
		"NoDisplay=true\nMimeType=application/x-bittorrent;\n")
	if err != nil {
		return err
	}
	// Без xdg-mime файлы всё равно лежат на месте: систему можно донастроить руками.
	if p, lerr := exec.LookPath("xdg-mime"); lerr == nil {
		exec.Command(p, "default", "torrclient-magnet.desktop", "x-scheme-handler/magnet").Run()
		exec.Command(p, "default", "torrclient-torrent.desktop", "application/x-bittorrent").Run()
	}
	return nil
}

func platformUninstallHandlers() error {
	if !linuxOnly() {
		return errPlatformUnsupported
	}
	os.Remove(magnetDesktopPath())
	os.Remove(torrentDesktopPath())
	return nil
}

func platformAutostartState() (enabled, supported bool) {
	if !linuxOnly() {
		return false, false
	}
	return fileExists(autostartPath()), true
}

func platformSetAutostart(exe string, on bool) error {
	if !linuxOnly() {
		return errPlatformUnsupported
	}
	if !on {
		os.Remove(autostartPath())
		return nil
	}
	return writeDesktop(autostartPath(), "[Desktop Entry]\nType=Application\nName=TorrClient\nExec="+desktopExec(exe)+" --open=false\n"+
		"X-GNOME-Autostart-enabled=true\n")
}

// migrateAutostart — только для Windows: там окно с лотком заменяет демон.
func migrateAutostart(exe string) {}
