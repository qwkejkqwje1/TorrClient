package main

// Проверки периодического сброса отметок просмотра.
//
// Отметка во время просмотра живёт в памяти, и на диск её клала одна запись —
// при закрытии плеера. Аварийное завершение (перезагрузка, отключение диска,
// снятие процесса) уносило позицию всего сеанса. Теперь отметку пишет сброс раз
// в полминуты, а запись на каждый замер по-прежнему не нужна: файл отметок
// переписывается целиком.

import (
	"os"
	"sync"
	"testing"
	"time"
)

// fastWatch подставляет короткие шаги наблюдения: иначе проверка сброса ждала
// бы полминуты, а проверка «нет записи на каждый замер» — час.
func fastWatch(t *testing.T, tick, flush time.Duration) {
	t.Helper()
	savedTick, savedFlush := watchInterval, viewedFlushInterval
	watchInterval, viewedFlushInterval = tick, flush
	t.Cleanup(func() { watchInterval, viewedFlushInterval = savedTick, savedFlush })
}

// emptyViewedMarks даёт чистый склад отметок: чужие записи не должны влиять на
// проверку, а файл после неё остаётся во временной папке.
func emptyViewedMarks(t *testing.T) {
	t.Helper()
	saved := viewedMarks
	viewedMarks = &viewedStore{data: map[string]map[int]*viewedMark{}}
	t.Cleanup(func() { viewedMarks = saved })
}

// waitForFile ждёт появления файла и отдаёт признак «дождались».
func waitForFile(path string, limit time.Duration) bool {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return false
}

func TestViewedFlushDueOnlyAfterTheInterval(t *testing.T) {
	fastWatch(t, 5*time.Millisecond, 30*time.Second)
	start := time.Now()
	if !viewedFlushDue(time.Time{}, start) {
		t.Error("самый первый сброс не срабатывает: до него отметке негде лежать")
	}
	if viewedFlushDue(start, start.Add(29*time.Second)) {
		t.Error("сброс срабатывает раньше шага")
	}
	if !viewedFlushDue(start, start.Add(30*time.Second)) {
		t.Error("сброс не срабатывает на шаге")
	}
}

// Пока плеер играет и канал не закрыт, отметка обязана оказаться на диске:
// именно этого не хватало — аварийное завершение съедало позицию сеанса.
func TestViewedMarkReachesDiskWhileThePlayerRuns(t *testing.T) {
	useStorageDirs(t)
	emptyViewedMarks(t)
	fastWatch(t, 5*time.Millisecond, 20*time.Millisecond)

	done := make(chan struct{})
	var once sync.Once
	stop := func() { once.Do(func() { close(done) }) }
	defer stop()

	watchWithoutChannel("abc123", 1, done)
	if !waitForFile(viewedPath(), 3*time.Second) {
		t.Fatal("отметка не попала на диск, пока плеер играл")
	}
	stop()
	// Дать горутине закончить запись при закрытии плеера: иначе она писала бы в
	// папку, которую проверка уже убирает.
	time.Sleep(50 * time.Millisecond)
}

// Обратная сторона: сброс не должен превратиться в запись на каждый замер.
// Плеер закрывается — файл появляется и без сброса, записью при выходе.
func TestViewedMarkIsNotWrittenOnEveryTick(t *testing.T) {
	useStorageDirs(t)
	emptyViewedMarks(t)
	fastWatch(t, 5*time.Millisecond, time.Hour)

	done := make(chan struct{})
	var once sync.Once
	stop := func() { once.Do(func() { close(done) }) }
	defer stop()

	watchWithoutChannel("abc123", 1, done)
	// Двадцати замерам хватит, чтобы запись на каждый замер себя выдала.
	time.Sleep(100 * time.Millisecond)
	if _, err := os.Stat(viewedPath()); err == nil {
		t.Fatal("отметка писалась на диск на каждом замере")
	}
	stop()
	if !waitForFile(viewedPath(), 3*time.Second) {
		t.Fatal("при закрытии плеера отметка не попала на диск")
	}
}
