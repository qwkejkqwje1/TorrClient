package main

// Проверки журнала наблюдения. Прежде ошибка чтения папки отбрасывалась
// целиком, и наблюдатель молчал ровно одинаково в двух разных случаях: когда
// папка пуста и когда папки нет вовсе. По журналу это было неразличимо, а ищут
// причину именно в нём — «торренты не добавляются».

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Одна и та же ошибка попадает в журнал один раз: опрос идёт каждые две
// секунды, и без памяти о прошлой жалобе журнал превратился бы в одну и ту же
// строку, а настоящие находки в нём потерялись бы.
func TestWatcherReportsTheSameErrorOnce(t *testing.T) {
	w := NewWatcher("", func(string) {})
	denied := errors.New("отказано в доступе")
	for i := 0; i < 5; i++ {
		w.noteFolderError(`D:\TorrClientPortable\watch`, denied)
	}
	if n := len(w.snapshotLog()); n != 1 {
		t.Fatalf("одна и та же ошибка попала в журнал %d раз, ожидался 1", n)
	}
	w.noteFolderError(`D:\TorrClientPortable\watch`, errors.New("диск не найден"))
	if n := len(w.snapshotLog()); n != 2 {
		t.Fatalf("другая ошибка не попала в журнал: записей %d, ожидалось 2", n)
	}
}

// Вылеченная папка не должна выглядеть сломанной до перезапуска — и повторное
// подтверждение не должно засорять журнал.
func TestWatcherReportsFolderRecovery(t *testing.T) {
	w := NewWatcher("", func(string) {})
	w.noteFolderError(`D:\TorrClientPortable\watch`, errors.New("диск не найден"))
	w.noteFolderOK()
	log := w.snapshotLog()
	if len(log) != 2 {
		t.Fatalf("записей %d, ожидалось 2: %v", len(log), log)
	}
	if !strings.Contains(log[1], "снова доступна") {
		t.Errorf("о восстановлении папки не сказано: %q", log[1])
	}
	w.noteFolderOK()
	if n := len(w.snapshotLog()); n != 2 {
		t.Errorf("повторное подтверждение добавило запись: стало %d", n)
	}
}

// Наблюдатель за папкой, которой нет, обязан сказать об этом в журнале. Под
// файлом папки не бывает — отказ не зависит от машины, в отличие от
// несуществующего диска.
func TestWatcherReportsUnreadableFolder(t *testing.T) {
	file := filepath.Join(t.TempDir(), "не-папка")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("подготовка: %v", err)
	}
	w := NewWatcher(file, func(string) {})
	w.Start()

	deadline := time.Now().Add(6 * time.Second)
	var log []string
	for time.Now().Before(deadline) {
		log = w.snapshotLog()
		if len(log) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(log) == 0 {
		t.Fatal("о недоступной папке в журнале наблюдения ничего не сказано")
	}
	if !strings.Contains(log[0], "Папка недоступна") {
		t.Errorf("запись журнала: %q", log[0])
	}
	if !strings.Contains(log[0], file) {
		t.Errorf("в записи не назван путь: %q", log[0])
	}
}
