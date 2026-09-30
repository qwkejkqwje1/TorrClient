//go:build windows

package main

// Брандмауэр Windows и доступ с телефона.
//
// Второй слушатель открыт на всех адресах, но входящие соединения по
// умолчанию режет брандмауэр: при первом запуске Windows спрашивает
// разрешение, и если окно пропустили или нажали «Отмена», Windows сама
// заводит запрещающее правило. Тогда телефон не видит программу вовсе —
// «сервер словно не работает». Кнопка в настройках убирает запрет и
// разрешает порт — один запрос прав администратора (UAC).

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"unsafe"
)

const firewallRuleName = "TorrClient remote"

func hiddenCmd(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return cmd
}

// firewallState — есть ли наше разрешающее правило. Проверка без прав
// администратора: netsh отвечает кодом 0, только если правило нашлось.
func firewallState(port int) map[string]any {
	err := hiddenCmd("netsh", "advfirewall", "firewall", "show", "rule", "name="+firewallRuleName).Run()
	return map[string]any{"supported": true, "rule": err == nil}
}

// firewallCommands — что выполняется с правами администратора: сперва
// снимаются правила для самой программы (среди них и запрещающее, которое
// Windows создала после «Отмены»), затем разрешаются программа и порт для
// всех профилей сети — домашний Wi-Fi Windows нередко считает «общественным».
func firewallCommands(exe string, port int) string {
	q := `"` + exe + `"`
	return strings.Join([]string{
		`netsh advfirewall firewall delete rule name=all dir=in program=` + q,
		`netsh advfirewall firewall delete rule name="` + firewallRuleName + `"`,
		fmt.Sprintf(`netsh advfirewall firewall add rule name="%s" dir=in action=allow protocol=TCP localport=%d profile=any enable=yes`, firewallRuleName, port),
		`netsh advfirewall firewall add rule name="` + firewallRuleName + `" dir=in action=allow program=` + q + ` profile=any enable=yes`,
	}, " & ")
}

type shellExecuteInfo struct {
	cbSize       uint32
	fMask        uint32
	hwnd         uintptr
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     uintptr
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    uintptr
	dwHotKey     uint32
	hIcon        uintptr
	hProcess     syscall.Handle
}

// firewallAllow выполняет команды через «Запуск от имени администратора»:
// Windows покажет запрос UAC, и без согласия ничего не изменится.
func firewallAllow(port int) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	shell32 := syscall.NewLazyDLL("shell32.dll")
	proc := shell32.NewProc("ShellExecuteExW")
	verb, _ := syscall.UTF16PtrFromString("runas")
	file, _ := syscall.UTF16PtrFromString("cmd.exe")
	params, _ := syscall.UTF16PtrFromString("/c " + firewallCommands(exe, port))
	info := shellExecuteInfo{fMask: 0x00000040 /* SEE_MASK_NOCLOSEPROCESS */, lpVerb: verb, lpFile: file, lpParameters: params, nShow: 0}
	info.cbSize = uint32(unsafe.Sizeof(info))
	if r, _, e := proc.Call(uintptr(unsafe.Pointer(&info))); r == 0 {
		if errno, ok := e.(syscall.Errno); ok && errno == 1223 {
			return errors.New("отменено: Windows не получила разрешения администратора")
		}
		return fmt.Errorf("не удалось запросить права администратора: %v", e)
	}
	if info.hProcess != 0 {
		_, _ = syscall.WaitForSingleObject(info.hProcess, 60000)
		_ = syscall.CloseHandle(info.hProcess)
	}
	if st := firewallState(port); st["rule"] != true {
		return errors.New("правило не появилось — попробуйте ещё раз")
	}
	return nil
}
