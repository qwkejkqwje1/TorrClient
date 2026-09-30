package main

// Тесты плейлиста, наблюдения за плеером и отметок просмотра.
//
// Прежний запуск отдавал плееру ссылку на один файл: сериал открывался первой
// серией, и списка серий у плеера не было вовсе. Позицию при этом считали по
// времени с момента запуска — при паузе и перемотке она врала, а продолжалось
// воспроизведение всегда с нуля, потому что параметр pos TorrServer не
// разбирает.
//
// Сеть тесты не трогают: состояние раздачи отдаёт локальный сервер, а ответы
// плееров разбираются из строк.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// episodeFiles — раздача сериала: три серии, посторонний файл и файл без номера.
// Номер — это index в адресе потока, и без него ссылка ведёт не туда.
func episodeFiles() []*torrentFile {
	return []*torrentFile{
		{ID: 1, Path: "Сериал/01. Серия 1.mkv", Length: 1000},
		{ID: 2, Path: "Сериал/02. Серия 2.mkv", Length: 1000},
		{ID: 3, Path: "Сериал/03. Серия 3.mkv", Length: 1000},
		{ID: 4, Path: "Сериал/readme.txt", Length: 10},
		{ID: 0, Path: "Сериал/без номера.mkv", Length: 10},
	}
}

// Плейлист обязан нести все серии: именно списка серий плеер и не видел.
func TestBuildPlaylistListsEveryEpisode(t *testing.T) {
	got := buildPlaylist("http://127.0.0.1:8099", "abc123", playableFiles(episodeFiles()), 0)

	for _, want := range []string{"01. Серия 1.mkv", "02. Серия 2.mkv", "03. Серия 3.mkv"} {
		if !strings.Contains(got, want) {
			t.Errorf("в плейлисте нет %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "readme.txt") {
		t.Errorf("в плейлист попал невоспроизводимый файл:\n%s", got)
	}
	if strings.Contains(got, "без номера") {
		t.Errorf("в плейлист попал файл без номера:\n%s", got)
	}
	if n := strings.Count(got, "#EXTINF"); n != 3 {
		t.Errorf("серий в плейлисте: %d, ожидалось 3", n)
	}
	if !strings.HasPrefix(got, "#EXTM3U\n") {
		t.Errorf("плейлист не начинается с заголовка:\n%s", got)
	}
}

// Ссылки обязаны вести на демон, а не на сам TorrServer: только через демон
// проходит вход на сервер с паролем.
func TestBuildPlaylistPointsAtTheDaemon(t *testing.T) {
	got := buildPlaylist("http://127.0.0.1:8099", "abc123", playableFiles(episodeFiles()), 0)
	for _, line := range strings.Split(got, "\n") {
		if !strings.HasPrefix(line, "http") {
			continue
		}
		if !strings.HasPrefix(line, "http://127.0.0.1:8099/ts/stream/") {
			t.Errorf("ссылка ведёт не на демон: %q", line)
		}
		for _, want := range []string{"link=abc123", "&play"} {
			if !strings.Contains(line, want) {
				t.Errorf("в ссылке нет %q: %q", want, line)
			}
		}
	}
	if n := strings.Count(got, "index=1&play"); n != 1 {
		t.Errorf("серия с номером 1 встречается %d раз, ожидался один", n)
	}
}

// Нажатая серия — первая в плейлисте, дальше список продолжается: иначе выбор
// серии ничего не значит.
func TestBuildPlaylistStartsFromTheChosenEpisode(t *testing.T) {
	got := buildPlaylist("http://127.0.0.1:8099", "abc123", playableFiles(episodeFiles()), 2)
	if strings.Contains(got, "01. Серия 1.mkv") {
		t.Errorf("плейлист начался раньше выбранной серии:\n%s", got)
	}
	if !strings.Contains(got, "02. Серия 2.mkv") || !strings.Contains(got, "03. Серия 3.mkv") {
		t.Errorf("в плейлисте нет выбранной серии и следующей:\n%s", got)
	}
	first := strings.Index(got, "index=2")
	second := strings.Index(got, "index=3")
	if first < 0 || second < 0 || first > second {
		t.Errorf("порядок серий нарушен:\n%s", got)
	}
}

// Файла с указанным номером в раздаче уже нет — показываем список целиком:
// пустой плейлист хуже полного.
func TestBuildPlaylistShowsEverythingWhenTheChosenFileIsGone(t *testing.T) {
	got := buildPlaylist("http://127.0.0.1:8099", "abc123", playableFiles(episodeFiles()), 99)
	if n := strings.Count(got, "#EXTINF"); n != 3 {
		t.Errorf("серий в плейлисте: %d, ожидалось 3", n)
	}
}

// Плеер опознаёт плейлист и по расширению: одного заголовка ответа мало.
func TestPlaylistURLPointsAtTheDaemonAndEndsWithM3U(t *testing.T) {
	got := playlistURL("http://127.0.0.1:8099", "abc123", "Сериал", 2)
	if !strings.HasPrefix(got, "http://127.0.0.1:8099/api/playlist/") {
		t.Errorf("адрес плейлиста = %q", got)
	}
	if !strings.Contains(got, ".m3u?") {
		t.Errorf("адрес плейлиста не оканчивается на .m3u: %q", got)
	}
	for _, want := range []string{"hash=abc123", "index=2"} {
		if !strings.Contains(got, want) {
			t.Errorf("в адресе нет %q: %q", want, got)
		}
	}
	if strings.Contains(got, "/") && strings.Contains(strings.SplitN(got, "?", 2)[0], "Сериал") {
		t.Errorf("название в пути не закодировано: %q", got)
	}
}

// Имя файла плейлиста не должно содержать разделителей пути и управляющих
// знаков: плееру имя показывают.
func TestPlaylistNameDropsPathSeparators(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"Сериал/Сезон 1", "Сериал_Сезон 1.m3u"},
		{`a\b`, "a_b.m3u"},
		{"a\"b", "ab.m3u"},
		{"", "playlist.m3u"},
		{"   ", "playlist.m3u"},
	} {
		if got := playlistName(tc.in); got != tc.want {
			t.Errorf("playlistName(%q) = %q, ожидалось %q", tc.in, got, tc.want)
		}
	}
	if got := playlistName(strings.Repeat("я", 200)); len(got) > 90 {
		t.Errorf("имя не обрезано: %d знаков", len(got))
	}
}

// Остановленный VLC — это «нет ответа», а не позиция ноль: записав ноль, мы
// стёрли бы отметку, на которую пользователь рассчитывал.
func TestParseVLCStatusDoesNotReportStoppedAsZero(t *testing.T) {
	_, err := parseVLCStatus([]byte(`{"time":0,"length":0,"state":"stopped"}`))
	if err == nil {
		t.Fatal("остановленный VLC принят за позицию ноль")
	}
}

func TestParseVLCStatusReadsPosition(t *testing.T) {
	got, err := parseVLCStatus([]byte(`{"time":812.5,"length":2700,"state":"playing"}`))
	if err != nil {
		t.Fatalf("разбор ответа VLC: %v", err)
	}
	if got.Position != 812.5 || got.Duration != 2700 {
		t.Errorf("позиция/длительность = %v/%v, ожидалось 812.5/2700", got.Position, got.Duration)
	}
}

// Порт для связи выбирается за мгновение до запуска, и за это время его может
// занять другая программа. Ответ без состояния — это чужой ответ, и назвать его
// надо отдельно, иначе он выглядит как «плеер молчит».
func TestParseVLCStatusRejectsAForeignAnswer(t *testing.T) {
	_, err := parseVLCStatus([]byte(`{"hello":"world"}`))
	if err == nil {
		t.Fatal("чужой ответ принят за ответ VLC")
	}
	if !strings.Contains(err.Error(), "не плеер") {
		t.Errorf("причина = %q, ожидалось упоминание чужого ответа", err.Error())
	}
	if _, err := parseVLCStatus([]byte("не json")); err == nil {
		t.Fatal("неразборчивый ответ принят за ответ VLC")
	}
}

// Семейство MPC сообщает миллисекунды: его собственный интерфейс делит то же
// число на 1000, чтобы напечатать чч:мм:сс.
func TestParseMPCVariablesReadsMilliseconds(t *testing.T) {
	doc := []byte(`<html><body><p id="file">x</p><p id="position">812500</p>` +
		`<p id="duration">2700000</p></body></html>`)
	got, err := parseMPCVariables(doc)
	if err != nil {
		t.Fatalf("разбор переменных MPC: %v", err)
	}
	if got.Position != 812.5 || got.Duration != 2700 {
		t.Errorf("позиция/длительность = %v/%v, ожидалось 812.5/2700", got.Position, got.Duration)
	}
}

// Сборка, сократившая position до pos, — одна ветка развития семейства. Ставка
// на одно написание сломала бы весь канал на другой сборке.
func TestParseMPCVariablesAcceptsTheShortNames(t *testing.T) {
	got, err := parseMPCVariables([]byte(`<p id="pos">5000</p><p id="dur">60000</p>`))
	if err != nil {
		t.Fatalf("разбор коротких имён MPC: %v", err)
	}
	if got.Position != 5 || got.Duration != 60 {
		t.Errorf("позиция/длительность = %v/%v, ожидалось 5/60", got.Position, got.Duration)
	}
}

func TestParseMPCVariablesRejectsAPageWithoutPosition(t *testing.T) {
	if _, err := parseMPCVariables([]byte(`<p id="file">x</p>`)); err == nil {
		t.Fatal("страница без позиции принята за ответ MPC")
	}
}

// Правдоподобие: мусор в ответе не должен становиться позицией, иначе плеер
// получит переход за границу фильма.
func TestUnbelievablePositionIsDropped(t *testing.T) {
	if got := secondsOrZero(0); got != 0 {
		t.Errorf("ноль = %v", got)
	}
	if got := secondsOrZero(-5); got != 0 {
		t.Errorf("отрицательная позиция = %v", got)
	}
	if got := secondsOrZero(maxPositionSeconds + 1); got != 0 {
		t.Errorf("позиция за границей = %v", got)
	}
	if got := secondsOrZero(90); got != 90 {
		t.Errorf("обычная позиция = %v, ожидалось 90", got)
	}
}

// Досмотр ставится на доле длительности, а не по факту начала потока: сервер
// отмечает файл просмотренным уже при подключении, и «начал» у него неотличимо
// от «досмотрел».
func TestMarkAfterReadingUsesTheWatchedShare(t *testing.T) {
	const duration = 1000
	// Порог прежнего клиента — восемь десятых длительности, и он записан
	// числом: если сверять с самой постоянной, проверка ничего не значит.
	almost := markAfterReading(viewedMark{}, false, playerReading{Position: 799, Duration: duration})
	if almost.Done {
		t.Errorf("на позиции 799 из %v серия уже считается просмотренной", duration)
	}
	if almost.Pos != 799 {
		t.Errorf("позиция = %v, ожидалось 799", almost.Pos)
	}
	done := markAfterReading(viewedMark{}, false, playerReading{Position: 800, Duration: duration})
	if !done.Done {
		t.Errorf("на позиции 800 из %v досмотр не поставлен", duration)
	}
	if done.Pos != 0 {
		t.Errorf("досмотренная серия продолжается с %v, ожидался ноль", done.Pos)
	}
	if watchedShare != 0.8 {
		t.Errorf("порог досмотра = %v, у прежнего клиента было 0.8", watchedShare)
	}
}

// Отметка досмотра не снимается сама: плеер может открыть серию заново с
// начала, и «просмотрено» от этого не пропадает.
func TestMarkAfterReadingKeepsTheDoneFlag(t *testing.T) {
	got := markAfterReading(viewedMark{Done: true}, true, playerReading{Position: 30, Duration: 1000})
	if !got.Done {
		t.Error("отметка досмотра потеряна")
	}
	if got.Pos != 30 {
		t.Errorf("позиция = %v, ожидалась 30", got.Pos)
	}
}

// Плеер не сообщил длительность — досмотр поставить нельзя, иначе серия
// закроется на первом же замере.
func TestMarkAfterReadingWithoutDuration(t *testing.T) {
	got := markAfterReading(viewedMark{}, false, playerReading{Position: 900})
	if got.Done {
		t.Error("досмотр поставлен без длительности")
	}
	if got.Pos != 900 {
		t.Errorf("позиция = %v, ожидалась 900", got.Pos)
	}
}

// Отметки просмотра переживают перезапуск демона: иначе продолжение с места
// остановки работает только до закрытия программы.
func TestViewedStoreKeepsMarksAfterReload(t *testing.T) {
	saved := viewedMarks
	defer func() { viewedMarks = saved }()
	viewedMarks = &viewedStore{data: map[string]map[int]*viewedMark{}}

	path := viewedPath()
	backup, err := os.ReadFile(path)
	hadBackup := err == nil
	defer func() {
		if hadBackup {
			os.WriteFile(path, backup, 0o600)
			return
		}
		os.Remove(path)
	}()

	viewedMarks.set("abc123", 2, viewedMark{Pos: 812.5, Duration: 2700})
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("отметка не сохранена на диск: %v", err)
	}

	reloaded := &viewedStore{data: map[string]map[int]*viewedMark{}}
	reloaded.load()
	got, ok := reloaded.get("abc123", 2)
	if !ok {
		t.Fatal("после перезагрузки отметка не найдена")
	}
	if got.Pos != 812.5 || got.Duration != 2700 {
		t.Errorf("позиция/длительность = %v/%v, ожидалось 812.5/2700", got.Pos, got.Duration)
	}
	if got.Updated == 0 {
		t.Error("у отметки нет времени обновления")
	}
	if _, ok := reloaded.get("abc123", 3); ok {
		t.Error("отметка нашлась у файла, которого не отмечали")
	}
	if _, ok := reloaded.get("нет такого", 2); ok {
		t.Error("отметка нашлась у раздачи, которой не отмечали")
	}
}

// Файл без номера отметить нельзя: номер — это и ключ отметки, и index потока.
func TestViewedStoreIgnoresFilesWithoutANumber(t *testing.T) {
	saved := viewedMarks
	defer func() { viewedMarks = saved }()
	viewedMarks = &viewedStore{data: map[string]map[int]*viewedMark{}}

	viewedMarks.set("abc123", 0, viewedMark{Pos: 10})
	viewedMarks.set("", 2, viewedMark{Pos: 10})
	if len(viewedMarks.data) != 0 {
		t.Errorf("отметки заведены на пустой номер: %v", viewedMarks.data)
	}
}

// Досмотренный файл начинается заново — это и есть «следующая серия». Прежний
// расчёт по времени с момента запуска этого не различал.
func TestResumeOfIgnoresAFinishedFile(t *testing.T) {
	saved := viewedMarks
	defer func() { viewedMarks = saved }()
	viewedMarks = &viewedStore{data: map[string]map[int]*viewedMark{}}

	viewedMarks.set("abc123", 1, viewedMark{Pos: 800, Duration: 1000})
	if got := resumeOf("abc123", 1); got != 800 {
		t.Errorf("продолжение = %v, ожидалось 800", got)
	}
	// Отметка досмотра может нести и последнюю позицию: интерфейс пишет её
	// вместе с признаком «просмотрено». Начинать с конца такой серии нельзя.
	viewedMarks.set("abc123", 2, viewedMark{Pos: 990, Duration: 1000, Done: true})
	if got := resumeOf("abc123", 2); got != 0 {
		t.Errorf("досмотренный файл продолжается с %v, ожидался ноль", got)
	}
	if got := resumeOf("abc123", 3); got != 0 {
		t.Errorf("неизвестный файл продолжается с %v, ожидался ноль", got)
	}
}

// Интерфейс читает отметки по именам полей, а JS их различает: file_index и
// timecode — та же форма, что у списка /viewed.
func TestApiPositionsSpeaksTheFieldNamesTheUiReads(t *testing.T) {
	saved := viewedMarks
	defer func() { viewedMarks = saved }()
	viewedMarks = &viewedStore{data: map[string]map[int]*viewedMark{}}

	body := strings.NewReader(`{"hash":"abc123","file_index":2,"timecode":812.5,"duration":2700}`)
	rec := httptest.NewRecorder()
	(&Comp{}).apiPositions(rec, httptest.NewRequest(http.MethodPost, "/api/positions", body))
	if rec.Code != http.StatusOK {
		t.Fatalf("запись отметки ответила кодом %d: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	(&Comp{}).apiPositions(rec, httptest.NewRequest(http.MethodGet, "/api/positions", nil))
	got := rec.Body.String()
	for _, want := range []string{`"hash":"abc123"`, `"file_index":2`, `"timecode":812.5`} {
		if !strings.Contains(got, want) {
			t.Errorf("в ответе нет %s: %s", want, got)
		}
	}
}

// Время отметки нужно интерфейсу: без него «продолжить просмотр» не выстроить
// по свежести, и список пришлось бы сортировать по порядку серий.
func TestApiPositionsReportsWhenTheMarkWasWritten(t *testing.T) {
	saved := viewedMarks
	defer func() { viewedMarks = saved }()
	viewedMarks = &viewedStore{data: map[string]map[int]*viewedMark{}}

	body := strings.NewReader(`{"hash":"abc123","file_index":2,"timecode":812.5,"duration":2700}`)
	rec := httptest.NewRecorder()
	(&Comp{}).apiPositions(rec, httptest.NewRequest(http.MethodPost, "/api/positions", body))

	rec = httptest.NewRecorder()
	(&Comp{}).apiPositions(rec, httptest.NewRequest(http.MethodGet, "/api/positions", nil))
	var rows []struct {
		Updated int64 `json:"updated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
		t.Fatalf("ответ не разобран: %v (%s)", err, rec.Body.String())
	}
	if len(rows) != 1 || rows[0].Updated <= 0 {
		t.Errorf("время отметки не сообщено: %s", rec.Body.String())
	}
}

// Досмотрено — не то же самое, что «стоит на нуле»: отметку досмотра интерфейс
// показывает отдельно.
func TestApiPositionsKeepsTheDoneFlag(t *testing.T) {
	saved := viewedMarks
	defer func() { viewedMarks = saved }()
	viewedMarks = &viewedStore{data: map[string]map[int]*viewedMark{}}

	body := strings.NewReader(`{"hash":"abc123","file_index":2,"done":true}`)
	rec := httptest.NewRecorder()
	(&Comp{}).apiPositions(rec, httptest.NewRequest(http.MethodPost, "/api/positions", body))

	rec = httptest.NewRecorder()
	(&Comp{}).apiPositions(rec, httptest.NewRequest(http.MethodGet, "/api/positions", nil))
	var rows []struct {
		Done bool `json:"done"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
		t.Fatalf("ответ не разобран: %v (%s)", err, rec.Body.String())
	}
	if len(rows) != 1 || !rows[0].Done {
		t.Errorf("отметка досмотра потеряна: %s", rec.Body.String())
	}
}

// Запись отметки без раздачи отвергается: иначе она легла бы в никуда.
func TestApiPositionsRejectsAMarkWithoutAHash(t *testing.T) {
	body := strings.NewReader(`{"file_index":2,"timecode":10}`)
	rec := httptest.NewRecorder()
	(&Comp{}).apiPositions(rec, httptest.NewRequest(http.MethodPost, "/api/positions", body))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("ответ кодом %d, ожидался 400", rec.Code)
	}
}

// fakeTorrServer подменяет TorrServer: отдаёт состояние раздачи, по которому
// строится плейлист.
func fakeTorrServer(t *testing.T, st torrentStatus) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/stream" {
			http.NotFound(w, r)
			return
		}
		// Подпись stat идёт без значения (так же, как её ставит интерфейс),
		// поэтому проверяется наличие, а не значение.
		if !r.URL.Query().Has("stat") {
			http.Error(w, `{"error":"no stat"}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(st)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// useFakeServer направляет запросы к подделанному серверу.
func useFakeServer(t *testing.T, srv *httptest.Server) {
	t.Helper()
	saved := curCfg()
	setCfg(&Config{
		Profiles:        []*Profile{{ID: "t", Name: "Тест", URL: srv.URL}},
		ActiveProfileID: "t",
	})
	t.Cleanup(func() { cfg.Store(saved) })
}

// Плееру уходит адрес плейлиста, а не ссылка на одну серию: ровно из-за этого
// VLC видел одну серию и не видел списка.
func TestLaunchURLHandsThePlayerAPlaylist(t *testing.T) {
	srv := fakeTorrServer(t, torrentStatus{
		Hash:  "abc123",
		Title: "Сериал",
		Files: episodeFiles(),
	})
	useFakeServer(t, srv)

	req := httptest.NewRequest(http.MethodPost, "/api/player/launch", nil)
	got, mode := (&Comp{}).launchURL(req, "abc123", "Сериал", "http://127.0.0.1:8099/ts/stream/x?link=abc123", 2)
	if mode != "playlist" {
		t.Fatalf("способ запуска = %q, ожидался playlist (адрес %q)", mode, got)
	}
	if !strings.Contains(got, "/api/playlist/") || !strings.Contains(got, ".m3u?") {
		t.Errorf("адрес плейлиста = %q", got)
	}
	if !strings.Contains(got, "hash=abc123") {
		t.Errorf("в адресе нет раздачи: %q", got)
	}
}

// Раздача не ответила — запускаем одной ссылкой: запуск важнее способа.
func TestLaunchURLFallsBackWhenTheServerIsSilent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"torrent connection timeout"}`, http.StatusInternalServerError)
	}))
	defer srv.Close()
	useFakeServer(t, srv)

	direct := "http://127.0.0.1:8099/ts/stream/x?link=abc123&index=2&play"
	req := httptest.NewRequest(http.MethodPost, "/api/player/launch", nil)
	got, mode := (&Comp{}).launchURL(req, "abc123", "Сериал", direct, 2)
	if mode != "file" || got != direct {
		t.Errorf("получилось %q (%s), ожидалась прежняя ссылка", got, mode)
	}
}

// Без раздачи адрес не трогается: запуск по прямой ссылке остаётся возможным.
func TestLaunchURLKeepsTheDirectLinkWithoutAHash(t *testing.T) {
	direct := "http://127.0.0.1:8099/ts/stream/x?link=abc123&index=2&play"
	req := httptest.NewRequest(http.MethodPost, "/api/player/launch", nil)
	got, mode := (&Comp{}).launchURL(req, "", "", direct, 2)
	if mode != "file" || got != direct {
		t.Errorf("получилось %q (%s), ожидалась прежняя ссылка", got, mode)
	}
}

// Плейлист по запросу интерфейса: серии в теле, имя файла — из названия раздачи.
func TestApiPlaylistServesTheWholeSeries(t *testing.T) {
	srv := fakeTorrServer(t, torrentStatus{Hash: "abc123", Title: "Сериал", Files: episodeFiles()})
	useFakeServer(t, srv)

	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8099/api/playlist?hash=abc123&index=2", nil)
	rec := httptest.NewRecorder()
	(&Comp{}).apiPlaylist(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("ответ кодом %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "mpegurl") {
		t.Errorf("тип содержимого = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "Сериал.m3u") {
		t.Errorf("имя файла = %q", cd)
	}
	body := rec.Body.String()
	// Выбранная серия и все следующие за ней — две из трёх.
	if n := strings.Count(body, "#EXTINF"); n != 2 {
		t.Errorf("серий в плейлисте: %d, ожидалось 2\n%s", n, body)
	}
	if strings.Contains(body, "01. Серия 1.mkv") {
		t.Errorf("плейлист начался раньше выбранной серии:\n%s", body)
	}
	// Адрес демона берётся из самого запроса: плеер должен ходить туда же, куда
	// пришёл запрос, а не по зашитому адресу.
	if !strings.Contains(body, "http://127.0.0.1:8099/ts/stream/") {
		t.Errorf("ссылки ведут не на адрес запроса:\n%s", body)
	}
}

func TestApiPlaylistAsksForTheHash(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Comp{}).apiPlaylist(rec, httptest.NewRequest(http.MethodGet, "/api/playlist", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("ответ кодом %d, ожидался 400", rec.Code)
	}
}

// Раздача без воспроизводимых файлов — не плейлист: плееру нечего играть.
func TestApiPlaylistRefusesATorrentWithoutPlayableFiles(t *testing.T) {
	srv := fakeTorrServer(t, torrentStatus{Hash: "abc123", Files: []*torrentFile{
		{ID: 1, Path: "readme.txt"},
		{ID: 2, Path: "cover.jpg"},
	}})
	useFakeServer(t, srv)

	rec := httptest.NewRecorder()
	(&Comp{}).apiPlaylist(rec, httptest.NewRequest(http.MethodGet, "/api/playlist?hash=abc123", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("ответ кодом %d, ожидался 404: %s", rec.Code, rec.Body.String())
	}
}

// Отказ сервера передаётся словами, а не кодом: по коду причина не видна.
func TestApiPlaylistTellsWhyTheServerRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"torrent connection timeout"}`, http.StatusInternalServerError)
	}))
	defer srv.Close()
	useFakeServer(t, srv)

	rec := httptest.NewRecorder()
	(&Comp{}).apiPlaylist(rec, httptest.NewRequest(http.MethodGet, "/api/playlist?hash=abc123", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("ответ кодом %d, ожидался 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "torrent connection timeout") {
		t.Errorf("причина не передана: %s", rec.Body.String())
	}
}

// Состояние раздачи читается с подписью сервера: через демон проходит вход на
// сервер с паролем, и без подписи запрос получил бы отказ.
func TestTorrentStatusSignsTheRequest(t *testing.T) {
	var gotUser, gotPass string
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser, gotPass, _ = r.BasicAuth()
		gotQuery = r.URL.RawQuery
		io.WriteString(w, `{"hash":"abc123","stat":3,"stat_string":"Работает","torrent_size":1000}`)
	}))
	defer srv.Close()

	saved := curCfg()
	setCfg(&Config{
		Profiles:        []*Profile{{ID: "t", URL: srv.URL, User: "u", Pass: "p"}},
		ActiveProfileID: "t",
	})
	defer func() { cfg.Store(saved) }()

	st, err := fetchTorrentStatus("abc123")
	if err != nil {
		t.Fatalf("состояние раздачи: %v", err)
	}
	if st.Stat != 3 || st.TorrentSize != 1000 {
		t.Errorf("состояние = %+v", st)
	}
	if gotUser != "u" || gotPass != "p" {
		t.Errorf("подпись = %q/%q, ожидалась u/p", gotUser, gotPass)
	}
	if !strings.Contains(gotQuery, "link=abc123") || !strings.Contains(gotQuery, "stat") {
		t.Errorf("запрос = %q", gotQuery)
	}
}

// Разбор состояния: имена полей приходят от TorrServer, и список файлов обязан
// прочитаться — по нему строится плейлист.
func TestTorrentStatusReadsTheFileList(t *testing.T) {
	srv := fakeTorrServer(t, torrentStatus{
		Hash: "abc123",
		Files: []*torrentFile{
			{ID: 1, Path: "Сериал/01. Серия 1.mkv", Length: 1000},
			{ID: 2, Path: "Сериал/02. Серия 2.mkv", Length: 2000},
		},
	})
	useFakeServer(t, srv)

	st, err := fetchTorrentStatus("abc123")
	if err != nil {
		t.Fatalf("состояние раздачи: %v", err)
	}
	if len(st.Files) != 2 {
		t.Fatalf("файлов: %d, ожидалось 2", len(st.Files))
	}
	if st.Files[1].ID != 2 || st.Files[1].Length != 2000 {
		t.Errorf("второй файл = %+v", st.Files[1])
	}
	if got := playableFiles(st.Files); len(got) != 2 {
		t.Errorf("воспроизводимых файлов: %d, ожидалось 2", len(got))
	}
}

// Файл без номера в плейлист не попадает: номер — это index в адресе потока.
func TestPlayableFilesNeedsTheNumber(t *testing.T) {
	files := []*torrentFile{
		{ID: 1, Path: "a.mkv"},
		{ID: 0, Path: "b.mkv"},
		{ID: 2, Path: ""},
		{ID: 3, Path: "c.MKV"},
		{ID: 4, Path: "d.avi"},
		{ID: 5, Path: "e.mp3"},
		{ID: 6, Path: "f.zip"},
		nil,
	}
	got := playableFiles(files)
	if len(got) != 4 {
		t.Fatalf("воспроизводимых файлов: %d, ожидалось 4 (%v)", len(got), got)
	}
	for _, f := range got {
		if f.ID == 0 || f.ID == 2 || f.ID == 6 {
			t.Errorf("в список попал %+v", f)
		}
	}
}

// Отметки просмотра лежат рядом с демоном — файлом, а не в памяти: только так
// они переживают перезапуск.
func TestViewedPathIsNextToTheDaemon(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skip("путь к исполняемому файлу недоступен")
	}
	if got, want := viewedPath(), filepath.Join(filepath.Dir(exe), "viewed.json"); got != want {
		t.Errorf("путь отметок = %q, ожидался %q", got, want)
	}
}

// С телефона «На компьютере»: плеер на компьютере получает локальный адрес,
// а не адрес телефона с входом по PIN — иначе он получал отказ.
func TestLaunchURLFromThePhoneUsesTheLocalAddress(t *testing.T) {
	req := httptest.NewRequest("POST", "http://192.168.1.34:8100/api/player/launch", nil)
	req = req.WithContext(context.WithValue(req.Context(), remoteCtxKey{}, true))
	got, _ := (&Comp{}).launchURL(req, "", "", "http://192.168.1.34:8100/ts/stream/a.mkv?link=h&index=1&play", 1)
	if got != localBase()+"/ts/stream/a.mkv?link=h&index=1&play" {
		t.Errorf("адрес для плеера = %q", got)
	}
}
