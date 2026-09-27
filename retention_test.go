package main

// Хранение: отметки просмотра и список закачек не должны расти вечно.
//
// Сеть тесты не трогают: оба склада живут в памяти, а на диск смотрит только
// проверка обрезки при чтении.

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// useTempViewed подменяет склад отметок пустым и возвращает файл на место.
func useTempViewed(t *testing.T) *viewedStore {
	t.Helper()
	saved := viewedMarks
	s := &viewedStore{data: map[string]map[int]*viewedMark{}}
	viewedMarks = s

	path := viewedPath()
	backup, err := os.ReadFile(path)
	hadBackup := err == nil
	t.Cleanup(func() {
		viewedMarks = saved
		if hadBackup {
			os.WriteFile(path, backup, 0o600)
			return
		}
		os.Remove(path)
	})
	return s
}

func daysAgo(n int) int64 { return time.Now().Add(-time.Duration(n) * 24 * time.Hour).Unix() }

// Отметка, к которой не обращались дольше срока, на диске не нужна: серии
// давно нет ни в библиотеке, ни на диске, а запись о ней остаётся.
func TestViewedPruneDropsStaleMarks(t *testing.T) {
	s := useTempViewed(t)
	s.data["свежая"] = map[int]*viewedMark{1: {Pos: 10, Updated: daysAgo(1)}}
	s.data["старая"] = map[int]*viewedMark{1: {Pos: 20, Updated: daysAgo(91)}}

	if n := s.prune(viewedMaxAge); n != 1 {
		t.Fatalf("выброшено %d отметок, ожидалась 1", n)
	}
	if _, ok := s.data["старая"]; ok {
		t.Error("старая раздача осталась в складе")
	}
	if _, ok := s.data["свежая"]; !ok {
		t.Error("свежая отметка выброшена")
	}
}

// Раздача без оставшихся файлов уходит целиком: пустая группа — тот же мусор.
func TestViewedPruneDropsEmptyHashGroups(t *testing.T) {
	s := useTempViewed(t)
	s.data["одна"] = map[int]*viewedMark{
		1: {Updated: daysAgo(100)},
		2: {Updated: daysAgo(100)},
	}

	s.prune(viewedMaxAge)

	if len(s.data) != 0 {
		t.Errorf("пустые группы остались: %v", s.data)
	}
}

// Граница обрезки не должна срабатывать на отметке, которая ещё внутри срока.
func TestViewedPruneKeepsMarksInsideTheWindow(t *testing.T) {
	s := useTempViewed(t)
	inside := time.Now().Add(-viewedMaxAge + time.Minute).Unix()
	s.data["на грани"] = map[int]*viewedMark{1: {Updated: inside}}

	if n := s.prune(viewedMaxAge); n != 0 {
		t.Fatalf("выброшено %d отметок, ожидалось 0", n)
	}
	if _, ok := s.data["на грани"]; !ok {
		t.Error("отметка внутри срока выброшена")
	}
}

// Файл, оставшийся от прежних запусков, обрезается при чтении, а не ждёт
// суточного сторожа.
func TestViewedLoadPrunesTheFileOnDisk(t *testing.T) {
	s := useTempViewed(t)
	b, err := json.Marshal(map[string]map[int]*viewedMark{
		"старая": {1: {Pos: 5, Updated: daysAgo(120)}},
		"свежая": {1: {Pos: 7, Updated: daysAgo(1)}},
	})
	if err != nil {
		t.Fatalf("не собрать файл отметок: %v", err)
	}
	if err := os.WriteFile(viewedPath(), b, 0o600); err != nil {
		t.Fatalf("не записать файл отметок: %v", err)
	}

	s.load()

	if _, ok := s.data["старая"]; ok {
		t.Error("старая отметка не выброшена при чтении")
	}
	if _, ok := s.data["свежая"]; !ok {
		t.Error("свежая отметка не прочитана")
	}

	raw, err := os.ReadFile(viewedPath())
	if err != nil {
		t.Fatalf("файл отметок не читается: %v", err)
	}
	var onDisk map[string]map[int]*viewedMark
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("файл отметок не разобран: %v", err)
	}
	if _, ok := onDisk["старая"]; ok {
		t.Error("старая отметка осталась в файле на диске")
	}
}

// Завершённая задача старше суток уходит из списка, свежая и работающая — нет.
func TestDLCleanOlderDropsFinishedJobs(t *testing.T) {
	d := NewDLManager(t.TempDir())
	d.jobs = map[string]*DLJob{
		"старая": {ID: "старая", Status: "done", endedAt: time.Now().Add(-25 * time.Hour)},
		"свежая": {ID: "свежая", Status: "error", endedAt: time.Now()},
		"бежит":  {ID: "бежит", Status: "download"},
	}

	if n := d.cleanOlder(time.Now().Add(-dlJobTTL)); n != 1 {
		t.Fatalf("выброшено %d задач, ожидалась 1", n)
	}
	if _, ok := d.jobs["старая"]; ok {
		t.Error("давно завершённая задача осталась в списке")
	}
	if _, ok := d.jobs["свежая"]; !ok {
		t.Error("недавно завершённая задача выброшена")
	}
	if _, ok := d.jobs["бежит"]; !ok {
		t.Error("работающая задача выброшена")
	}
}

// Задача без времени завершения не выбрасывается: удалять по незнанию нельзя.
func TestDLCleanOlderKeepsJobsWithoutEndTime(t *testing.T) {
	d := NewDLManager(t.TempDir())
	d.jobs = map[string]*DLJob{"без времени": {ID: "без времени", Status: "done"}}

	if n := d.cleanOlder(time.Now().Add(time.Hour)); n != 0 {
		t.Fatalf("выброшено %d задач, ожидалось 0", n)
	}
}

// Время завершения ставит сам переход в терминальный статус — иначе обрезке
// не по чему считать срок.
func TestDLSetStatusStampsTheEndTime(t *testing.T) {
	d := NewDLManager(t.TempDir())
	j := &DLJob{ID: "1", Status: "download"}
	d.jobs = map[string]*DLJob{"1": j}

	d.setStatus(j, "done", "")

	if j.endedAt.IsZero() {
		t.Fatal("время завершения не проставлено")
	}
	if j.Status != "done" {
		t.Errorf("статус = %q, ожидался done", j.Status)
	}
}

// Повторный переход не переписывает уже поставленное время: задача не должна
// считаться свежей из-за позднего сетевого обрыва.
func TestDLSetStatusKeepsTheFirstEndTime(t *testing.T) {
	d := NewDLManager(t.TempDir())
	first := time.Now().Add(-2 * time.Hour)
	j := &DLJob{ID: "1", Status: "download", endedAt: first}
	d.jobs = map[string]*DLJob{"1": j}

	d.setStatus(j, "done", "")

	if !j.endedAt.Equal(first) {
		t.Errorf("время завершения переписано: %v → %v", first, j.endedAt)
	}
}
