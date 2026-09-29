//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// detachCmd запускает новую копию без окна консоли и в своей группе
// процессов: Ctrl+C в старой консоли её не заденет.
func detachCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000200}
}
