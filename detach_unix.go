//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// detachCmd отвязывает перезапущенную копию от сессии старого процесса.
func detachCmd(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
