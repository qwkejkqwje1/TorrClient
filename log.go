package main

// Журнал: строка с отметкой времени в torrclient.log с ротацией.

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// logMaxSize — предел файла журнала. По достижении файл переименовывается в
// torrclient.log.1, прежняя копия затирается: для диагностики хватает двух
// поколений, а вечный рост не нужен.
const logMaxSize = 1 << 20

var logFileMu sync.Mutex

// logPath — файл журнала в папке кэша: журнал нужен для разбора свежего сбоя,
// и хранить его наравне с состоянием не за что.
func logPath() string { return filepath.Join(cacheDir(), "torrclient.log") }

// logLine пишет строку в журнал в папке кэша. В файл — всегда, даже при
// --quiet: под десктоп-оболочкой демон работает без консоли, и журнал —
// единственный способ понять, что произошло.
//
// Папка берётся из настройки, а до её чтения — рядом с программой. Первые
// строки запуска (предупреждение о привязке наружу) могут поэтому остаться в
// прежнем файле; после чтения конфига в журнал уходит строка «Кэш: …», и по
// ней видно, куда писать дальше.
func logLine(line string) {
	logFileMu.Lock()
	defer logFileMu.Unlock()
	p := logPath()
	if fi, err := os.Stat(p); err == nil && fi.Size() >= logMaxSize {
		_ = os.Remove(p + ".1")
		_ = os.Rename(p, p+".1")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), line)
}

// logMsg пишет в консоль (если не --quiet) и в журнал.
func logMsg(format string, a ...any) {
	line := fmt.Sprintf(format, a...)
	if !*flagQuiet {
		fmt.Println(line)
	}
	logLine(line)
}

// logAlways пишет и в консоль, и в журнал независимо от --quiet: предупреждение
// об открытом наружу API не должно прятаться.
func logAlways(format string, a ...any) {
	line := fmt.Sprintf(format, a...)
	fmt.Println(line)
	logLine(line)
}
