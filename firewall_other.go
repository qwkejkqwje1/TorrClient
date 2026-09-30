//go:build !windows

package main

import "errors"

// На Linux и macOS брандмауэр программа не трогает: у каждого дистрибутива
// свой, и включён он по умолчанию редко.
func firewallState(port int) map[string]any { return map[string]any{"supported": false} }

func firewallAllow(port int) error {
	return errors.New("настройка брандмауэра есть только в Windows")
}
