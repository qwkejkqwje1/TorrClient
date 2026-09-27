package main

// Проверки решения «поднимать ли TorrServer заново». Ошибка здесь дорога:
// решение снимать и запускать заново на каждом круге сторожа превращалось в
// вечную гонку, в которой сервер не успевал открыть порт ни разу — окно
// открывалось, а поиск и раздачи молчали.

import (
	"testing"
	"time"
)

// Живой порт — трогать нечего.
func TestShouldSpawnTorrServerLeavesARunningServerAlone(t *testing.T) {
	if shouldSpawnTorrServer(true, false, time.Hour, time.Minute) {
		t.Error("сервер отвечает, а его собираются запускать заново")
	}
	if shouldSpawnTorrServer(true, true, time.Hour, time.Minute) {
		t.Error("сервер отвечает, а его собираются снять и запустить заново")
	}
}

// Главный случай: сервер уже запущен и ещё поднимается. Порт закрыт, но это не
// повод снимать процесс — иначе он не успеет открыть порт никогда.
func TestShouldSpawnTorrServerGivesASlowStartTime(t *testing.T) {
	grace := 90 * time.Second
	for _, age := range []time.Duration{0, time.Second, 30 * time.Second, grace - time.Millisecond} {
		if shouldSpawnTorrServer(false, true, age, grace) {
			t.Errorf("на возрасте %v запуск признан неудачным — сервер не успеет подняться", age)
		}
	}
}

// Срок вышел — значит, запуск действительно неудачный, и надо пробовать снова.
func TestShouldSpawnTorrServerRetriesAfterTheGrace(t *testing.T) {
	grace := 90 * time.Second
	if !shouldSpawnTorrServer(false, true, grace, grace) {
		t.Error("срок вышел, а повторной попытки не будет")
	}
	if !shouldSpawnTorrServer(false, true, time.Hour, grace) {
		t.Error("сервер висит час, а повторной попытки не будет")
	}
}

// Процесса нет и порт закрыт — поднимать нужно.
func TestShouldSpawnTorrServerStartsWhenNothingRuns(t *testing.T) {
	if !shouldSpawnTorrServer(false, false, 0, 90*time.Second) {
		t.Error("сервера нет, а запускать его не собираются")
	}
}

// Срок должен быть заметно больше круга сторожа: иначе проверка «ещё
// поднимается» не срабатывала бы ни разу, и гонка вернулась бы.
func TestTorrServerGraceOutlastsTheHealthLoop(t *testing.T) {
	if tsStartGrace <= healthEvery {
		t.Fatalf("срок запуска %v не больше круга сторожа %v", tsStartGrace, healthEvery)
	}
}
