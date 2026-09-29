package main

// Проверки версии формата файлов состояния.
//
// Отметки просмотра, избранное и подписки восстановить нечем, поэтому чтение
// незнакомого или битого файла обязано быть безопасным: склад остаётся пустым,
// а сам файл — нет. Проверяется именно это, потому что вред приходит не от
// отказа прочитать, а от молчаливой перезаписи: после неё вернуть данные уже
// нечем.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type stateSample struct {
	Favorites []string `json:"favorites"`
	Bookmarks []string `json:"bookmarks"`
}

func stateTmp(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "state.json")
}

// Данные, записанные с номером формата, читаются обратно без потерь.
func TestStateDocRoundTrip(t *testing.T) {
	p := stateTmp(t)
	want := stateSample{Favorites: []string{"a", "b"}, Bookmarks: []string{"c"}}
	if err := writeStateDoc(p, want); err != nil {
		t.Fatalf("не записано: %v", err)
	}
	var got stateSample
	if err := readStateDoc(p, &got); err != nil {
		t.Fatalf("не прочитано: %v", err)
	}
	if len(got.Favorites) != 2 || got.Favorites[0] != "a" || got.Favorites[1] != "b" {
		t.Errorf("избранное искажено: %v", got.Favorites)
	}
	if len(got.Bookmarks) != 1 || got.Bookmarks[0] != "c" {
		t.Errorf("закладки искажены: %v", got.Bookmarks)
	}
}

// Номер формата пишется в файл: без него следующая сборка не отличит свой
// формат от прежнего, и весь смысл проверки пропадёт.
func TestStateDocWritesTheVersion(t *testing.T) {
	p := stateTmp(t)
	if err := writeStateDoc(p, stateSample{Favorites: []string{"a"}}); err != nil {
		t.Fatalf("не записано: %v", err)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("файл не читается: %v", err)
	}
	var doc stateDoc
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("файл не разобран: %v", err)
	}
	if doc.Version != stateFormat {
		t.Errorf("в файле версия %d, ожидалась %d", doc.Version, stateFormat)
	}
}

// Файл прежних сборок — без номера и без обёртки — читается как был. Это
// главный случай: у миллиона установок он на диске уже сегодня, и поломка
// здесь означала бы потерю избранного у всех сразу.
func TestStateDocReadsTheOldFileWithoutVersion(t *testing.T) {
	p := stateTmp(t)
	old := `{"favorites":["a","b"],"bookmarks":["c"]}`
	if err := os.WriteFile(p, []byte(old), 0o600); err != nil {
		t.Fatalf("прежний файл не записан: %v", err)
	}
	var got stateSample
	if err := readStateDoc(p, &got); err != nil {
		t.Fatalf("прежний файл не прочитан: %v", err)
	}
	if len(got.Favorites) != 2 || got.Favorites[1] != "b" {
		t.Errorf("прежний файл прочитан неверно: %+v", got)
	}
	if len(got.Bookmarks) != 1 || got.Bookmarks[0] != "c" {
		t.Errorf("прежние закладки потеряны: %v", got.Bookmarks)
	}
}

// Файл новой версии читаться отказывается. Молча прочесть его как свой — значит
// на следующей записи затереть содержимое, которого не понял.
func TestStateDocRefusesANewerFormat(t *testing.T) {
	p := stateTmp(t)
	future := stateDoc{Version: stateFormat + 1, Data: json.RawMessage(`{"favorites":["a"]}`)}
	b, _ := json.Marshal(future)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatalf("файл не записан: %v", err)
	}
	var got stateSample
	err := readStateDoc(p, &got)
	if err == nil {
		t.Fatal("файл более новой версии прочитан как свой — содержимое будет затёрто")
	}
	if !strings.Contains(err.Error(), "более новой") {
		t.Errorf("отказ невнятен: %v", err)
	}
	if len(got.Favorites) != 0 {
		t.Errorf("в склад попало что-то при отказе: %v", got.Favorites)
	}
}

// Прежняя версия (номер меньше нашего) читается: она понятна и потерять её
// данные нет причин.
func TestStateDocReadsAnOlderFormat(t *testing.T) {
	p := stateTmp(t)
	old := stateDoc{Version: 1, Data: json.RawMessage(`{"favorites":["a"]}`)}
	b, _ := json.Marshal(old)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatalf("файл не записан: %v", err)
	}
	var got stateSample
	if err := readStateDoc(p, &got); err != nil {
		t.Fatalf("прежняя версия не прочитана: %v", err)
	}
	if len(got.Favorites) != 1 || got.Favorites[0] != "a" {
		t.Errorf("прежняя версия прочитана неверно: %+v", got)
	}
}

// Отсутствующий файл — обычное дело при первом запуске, а не поломка.
func TestStateDocMissingFileIsAnError(t *testing.T) {
	var got stateSample
	err := readStateDoc(filepath.Join(t.TempDir(), "нет-такого.json"), &got)
	if err == nil {
		t.Error("отсутствие файла ошибкой не названо — вызывающий не отличит его от успеха")
	}
	if !os.IsNotExist(err) {
		t.Errorf("ошибка не про отсутствие файла: %v", err)
	}
}

// Мусор вместо данных читается как пусто, но файл остаётся на месте: иначе
// следующая запись уничтожила бы то, что ещё можно разобрать вручную.
func TestStateDocKeepsUnreadableFile(t *testing.T) {
	p := stateTmp(t)
	broken := `{"favorites": [`
	if err := os.WriteFile(p, []byte(broken), 0o600); err != nil {
		t.Fatalf("битый файл не записан: %v", err)
	}
	var got stateSample
	if err := readStateDoc(p, &got); err == nil {
		t.Error("битый файл принят за разобранный")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("битый файл стёрт: %v", err)
	}
	if string(b) != broken {
		t.Errorf("содержимое битого файла изменено: %q", b)
	}
}

// Пустой склад пишется и читается без появления «null» вместо списка:
// интерфейс ждёт массив, и null в ответе ломает перебор.
func TestStateDocKeepsEmptyLists(t *testing.T) {
	p := stateTmp(t)
	if err := writeStateDoc(p, stateSample{Favorites: []string{}, Bookmarks: []string{}}); err != nil {
		t.Fatalf("не записано: %v", err)
	}
	var got stateSample
	if err := readStateDoc(p, &got); err != nil {
		t.Fatalf("не прочитано: %v", err)
	}
	if got.Favorites == nil || got.Bookmarks == nil {
		t.Errorf("пустые списки стали nil: %+v", got)
	}
}

// Запись поверх прежнего файла не оставляет его содержимого рядом: склад после
// пересохранения должен содержать ровно то, что записали.
func TestStateDocOverwritesTheOldFile(t *testing.T) {
	p := stateTmp(t)
	if err := os.WriteFile(p, []byte(`{"favorites":["старое"],"bookmarks":null}`), 0o600); err != nil {
		t.Fatalf("прежний файл не записан: %v", err)
	}
	if err := writeStateDoc(p, stateSample{Favorites: []string{"новое"}, Bookmarks: []string{}}); err != nil {
		t.Fatalf("не перезаписано: %v", err)
	}
	var got stateSample
	if err := readStateDoc(p, &got); err != nil {
		t.Fatalf("не прочитано после перезаписи: %v", err)
	}
	if len(got.Favorites) != 1 || got.Favorites[0] != "новое" {
		t.Errorf("прежнее содержимое выжило: %v", got.Favorites)
	}
	for _, f := range got.Favorites {
		if f == "старое" {
			t.Error("прежняя запись не затёрта — файл дописан, а не перезаписан")
		}
	}
}
