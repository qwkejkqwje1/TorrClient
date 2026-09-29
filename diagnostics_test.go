package main

// Проверки отчёта о состоянии.
//
// Смысл проверок в том, что отчёт собирают тогда, когда что-то уже сломалось.
// Ошибка в нём опаснее его отсутствия: человек почитает исправный отчёт и
// начнёт чинить не то.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormPathСравниваетОдинИТотЖеПуть(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{`C:\Данные`, `C:\данные`, true},      // регистр на Windows не различает
		{`C:\Данные\`, `C:\Данные`, true},     // хвостовой разделитель
		{`C:\Данные`, `C:\Данные2`, false},    // разные папки
		{`  C:\Данные  `, `C:\Данные`, true},  // пробелы от набора пути
		{`C:\данные\под`, `C:\данные`, false}, // подпапка — не та же папка
		{``, ``, false},                   // пустые не равны ничему
		{`C:\данные`, ``, false},          // одна пустая — не совпадение
		{`C:\`, `C:\`, true},              // корень не теряет разделитель
		{`C:\Данные/`, `C:\Данные`, true}, // смешанные разделители
	}
	for _, c := range cases {
		if got := sameFolder(c.a, c.b); got != c.want {
			t.Errorf("sameFolder(%q, %q) = %v, хотели %v", c.a, c.b, got, c.want)
		}
	}
}

func TestSplitKeyValueРазбираетОтветСервера(t *testing.T) {
	cases := []struct {
		in    string
		wantK string
		wantV string
	}{
		{`version="2.1.1"`, "version", `"2.1.1"`},
		{`version = 2.1.1 `, "version", "2.1.1"},
		{`беззнаков`, "беззнаков", ""},
		{"", "", ""},
	}
	for _, c := range cases {
		k, v := splitKeyValue(c.in)
		if k != c.wantK || v != c.wantV {
			t.Errorf("splitKeyValue(%q) = (%q, %q), хотели (%q, %q)", c.in, k, v, c.wantK, c.wantV)
		}
	}
}

func TestDirStatsСчитаетФайлыИРазмер(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.log"), []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "под"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "под", "b.json"), []byte("12"), 0o600); err != nil {
		t.Fatal(err)
	}
	files, size := dirStats(dir)
	if files != 2 {
		t.Errorf("файлов %d, хотели 2", files)
	}
	if size != 7 {
		t.Errorf("байт %d, хотели 7", size)
	}
}

func TestDirStatsПустаяПапкаИПустойПутьНеЛомаютОтчёт(t *testing.T) {
	if f, s := dirStats(t.TempDir()); f != 0 || s != 0 {
		t.Errorf("пустая папка: файлов %d, байт %d", f, s)
	}
	// Пустой путь — обычное дело: настройка может быть не задана. Отчёт обязан
	// это пережить, а не падать.
	if f, s := dirStats("  "); f != 0 || s != 0 {
		t.Errorf("пустой путь: файлов %d, байт %d", f, s)
	}
}

func TestDirStatsНесуществующаяПапкаНеОшибка(t *testing.T) {
	f, s := dirStats(filepath.Join(t.TempDir(), "нет-такой"))
	if f != 0 || s != 0 {
		t.Errorf("несуществующая папка: файлов %d, байт %d", f, s)
	}
}

func TestCollectReportВидитСовпадениеКэшаИДанных(t *testing.T) {
	// Это самая дорогая поломка из возможных: кэш принято уводить на
	// очищаемый диск, и подписки уезжают вместе с ним молча.
	dir := t.TempDir()
	rep := collectReport(&Config{
		Profiles:        []*Profile{},
		WatchFolder:     dir,
		DownloadFolder:  dir,
		CacheFolder:     dir,
		DataFolder:      dir,
		ActiveProfileID: "",
	}, true, "")

	found := ""
	for _, p := range rep.Problems {
		if strings.Contains(p.Where, "кэш и данные") {
			found = p.Reason
		}
	}
	if found == "" {
		t.Fatalf("совпадение папок не отмечено, замечания: %+v", rep.Problems)
	}
	if !strings.Contains(found, "подписки") {
		t.Errorf("в замечании не сказано, что пропадёт: %q", found)
	}
}

func TestCollectReportРазныеПапкиБезЗамечанийОСовпадении(t *testing.T) {
	base := t.TempDir()
	rep := collectReport(&Config{
		Profiles:       []*Profile{},
		WatchFolder:    base,
		DownloadFolder: base,
		CacheFolder:    base,
		DataFolder:     filepath.Join(base, "данные"),
	}, true, "")
	for _, p := range rep.Problems {
		if strings.Contains(p.Where, "кэш и данные") {
			t.Errorf("ложное замечание при разных папках: %q", p.Reason)
		}
	}
}

func TestCollectReportОтмечаетНедоступнуюПапку(t *testing.T) {
	// На месте папки данных лежит файл: MkdirAll обязан вернуть отказ, иначе
	// проверка папок проходила бы на несуществующем месте.
	base := t.TempDir()
	dataPath := filepath.Join(base, "данные")
	if err := os.WriteFile(dataPath, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	rep := collectReport(&Config{
		Profiles:       []*Profile{},
		WatchFolder:    base,
		DownloadFolder: base,
		CacheFolder:    base,
		DataFolder:     dataPath,
	}, true, "")

	if rep.Folders["data"].OK {
		t.Errorf("папка на месте файла отмечена как доступна: %+v", rep.Folders["data"])
	}
	if rep.Folders["data"].Reason == "" {
		t.Error("причина отказа не сообщена — по отчёту будет нечего понять")
	}
	found := false
	for _, p := range rep.Problems {
		if strings.Contains(p.Where, "папка data") {
			found = true
		}
	}
	if !found {
		t.Errorf("недоступная папка не попала в замечания: %+v", rep.Problems)
	}
}

func TestCollectReportБезПрофилейНеПаникует(t *testing.T) {
	rep := collectReport(&Config{}, true, "")
	if len(rep.Servers) != 0 {
		t.Errorf("серверов %d при пустом конфиге", len(rep.Servers))
	}
	if !strings.Contains(rep.Text(), "не заданы") {
		t.Error("отчёт молчит про отсутствие серверов вместо прямого признания")
	}
}

func TestReportTextПоказываетЗамечанияЧитаемо(t *testing.T) {
	dir := t.TempDir()
	rep := collectReport(&Config{
		Profiles:       []*Profile{},
		WatchFolder:    dir,
		DownloadFolder: dir,
		CacheFolder:    dir,
		DataFolder:     dir,
	}, true, "")
	text := rep.Text()

	for _, want := range []string{
		"TorrClient " + version,
		"Собрано:",
		"Система:",
		"-- Серверы --",
		"-- Папки --",
		"-- Файлы состояния --",
		"-- Замечания --",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("в отчёте нет %q", want)
		}
	}
}

func TestReportTextНеТащитСекреты(t *testing.T) {
	// Отчёт предназначен для пересылки. Ключ TMDB и пароли в нём быть не
	// должны — иначе «пришлите отчёт» отправляет их кому-то третьему.
	key := "579c7357a4562eadfef772aa9f48d75e"
	dir := t.TempDir()
	rep := collectReport(&Config{
		Profiles:        []*Profile{{ID: "a", Name: "Домашний", URL: "http://127.0.0.1:8090"}},
		WatchFolder:     dir,
		DownloadFolder:  dir,
		CacheFolder:     dir,
		DataFolder:      dir,
		ActiveProfileID: "a",
		TMDBApiKey:      key,
		TMDBAccessToken: "токен",
	}, true, "")

	if strings.Contains(rep.Text(), key) {
		t.Error("ключ TMDB попал в отчёт")
	}
	b, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), key) {
		t.Error("ключ TMDB попал в отчёт в JSON")
	}
	if strings.Contains(string(b), "токен") {
		t.Error("токен TMDB попал в отчёт в JSON")
	}
}

func TestStateFileReportОтсутствующийФайлНеОшибка(t *testing.T) {
	// На свежей установке файла состояния ещё нет. Отчёт обязан сказать «ещё не
	// создан», а не «ошибка»: иначе человек начнёт чинить то, что не сломано.
	st := stateFileReport(filepath.Join("нет", "такого", "viewed.json"))
	if !st.OK {
		t.Error("отсутствующий файл отмечен как проблема")
	}
	if st.Exists {
		t.Error("отсутствующий файл отмечен как существующий")
	}
}

func TestApiDiagnosticsОтдаётТекстИJson(t *testing.T) {
	cache, data := useStorageDirs(t)
	// Порт 1 закрыт на этой машине: соединение отклоняется сразу, без ожидания
	// таймаута, и проверка не зависит от того, запущен ли TorrServer.
	c := &Comp{}
	setCfg(&Config{
		Profiles:        []*Profile{{ID: "a", Name: "Проверка", URL: "http://127.0.0.1:1"}},
		ActiveProfileID: "a",
		WatchFolder:     cache,
		DownloadFolder:  cache,
		CacheFolder:     cache,
		DataFolder:      data,
	})

	rr := httptest.NewRecorder()
	c.apiDiagnostics(rr, httptest.NewRequest(http.MethodGet, "/api/diagnostics", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("код %d, ждали 200: %s", rr.Code, rr.Body.String())
	}

	var rep report
	if err := json.Unmarshal(rr.Body.Bytes(), &rep); err != nil {
		t.Fatalf("ответ не разобран: %v\n%s", err, rr.Body.String())
	}
	if rep.Version != version {
		t.Errorf("в отчёте версия %q, а сборка %q", rep.Version, version)
	}
	if len(rep.Servers) != 1 {
		t.Fatalf("серверов %d, ждали 1", len(rep.Servers))
	}
	// Закрытый порт обязан попасть в замечания, иначе отчёт утешил бы человека
	// насчёт неработающего сервера.
	marked := false
	for _, p := range rep.Problems {
		if strings.Contains(p.Where, "сервер Проверка") {
			marked = true
		}
	}
	if !marked {
		t.Errorf("недоступный сервер не попал в замечания: %+v", rep.Problems)
	}

	// Тот же отчёт текстом — ради него всё и затевалось.
	rr2 := httptest.NewRecorder()
	c.apiDiagnostics(rr2, httptest.NewRequest(http.MethodGet, "/api/diagnostics?format=text", nil))
	if ct := rr2.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("для текста Content-Type %q", ct)
	}
	if !strings.Contains(rr2.Body.String(), "TorrClient "+version) {
		t.Errorf("в тексте нет версии:\n%s", rr2.Body.String())
	}
}
