package main

// Проверки того, что в трее проверяемо без настоящего экрана: разбор выбранного
// пункта меню, подсказка иконки и поиск файла иконки.
//
// Остальное — системные вызовы, и проверять их можно только на живом рабочем
// столе. Именно поэтому решения вынесены в функции: ошибка в разборе меню или
// в длине подсказки иначе замечалась бы только глазами.

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestTrayActionMapsMenuItemsToCommands(t *testing.T) {
	cases := []struct {
		id   uint32
		want trayCmd
	}{
		{menuOpen, trayOpen},
		{menuQuit, trayQuit},
		{0, trayNone},
		{99, trayNone},
	}
	for _, c := range cases {
		if got := trayAction(c.id); got != c.want {
			t.Errorf("пункт %d: команда %v, ожидалась %v", c.id, got, c.want)
		}
	}
}

// Подсказка обрезается по буферу: система не отвергает слишком длинную строку,
// а тихо обрезает её — в лотке остаётся бессмыслица. Обрезка наша, поэтому
// обрезанная строка остаётся осмысленной и завершается нулём.
func TestTrayTipFitsTheBufferAndEndsWithZero(t *testing.T) {
	short := trayTip("TorrClient")
	if got := utf16ToString(short[:]); got != "TorrClient" {
		t.Errorf("подсказка: %q, ожидалась %q", got, "TorrClient")
	}
	if short[tipLen-1] != 0 {
		t.Error("буфер подсказки не завершён нулём")
	}

	long := trayTip(strings.Repeat("а", tipLen*2))
	text := utf16ToString(long[:])
	if len([]rune(text)) != tipLen-1 {
		t.Errorf("длина обрезанной подсказки: %d, ожидалось %d", len([]rune(text)), tipLen-1)
	}
	if long[tipLen-1] != 0 {
		t.Error("переполненный буфер не завершён нулём: система читала бы за его пределами")
	}
}

// Иконка берётся рядом с программой: сборка портативная, и путь к файлу иконки
// прописать нельзя. Нет файла — берётся стандартная иконка системы, программа
// остаётся рабочей.
func TestTrayIconPathFindsTheIconNextToTheProgram(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app.ico"), []byte("ICO"), 0o600); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "TorrClient.exe")
	if got, want := trayIconPath(exe), filepath.Join(dir, "app.ico"); got != want {
		t.Errorf("иконка: %q, ожидалась %q", got, want)
	}

	empty := t.TempDir()
	if got := trayIconPath(filepath.Join(empty, "TorrClient.exe")); got != "" {
		t.Errorf("иконки рядом нет, а найдена: %q", got)
	}
	if got := trayIconPath(""); got != "" {
		t.Errorf("путь к программе неизвестен, а иконка найдена: %q", got)
	}
}

func utf16ToString(buf []uint16) string {
	return syscall.UTF16ToString(buf)
}

// «Выход» из лотка идёт через runtime.Quit, и Wails снова спрашивает
// OnBeforeClose: при выходе окно не должно прятаться в лоток.
func TestBeforeCloseLetsQuitThrough(t *testing.T) {
	a := &App{tray: &trayIcon{started: true}}
	a.quitting.Store(true)
	if a.beforeClose(context.Background()) {
		t.Fatal("выход из лотка отменён: окно спряталось вместо закрытия")
	}
}
