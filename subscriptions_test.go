package main

// Подписки на сериалы: разбор серий, поиск новизны и ручка /api/subs.
//
// Здесь проверяется то, что нельзя увидеть глазами на живой странице: что
// первая проверка подписки только запоминает вышедшее (иначе разом пришли бы
// все давние серии как новые), что находка без сезона в названии всё равно
// двигает подписку и что список переживает перезапуск демона.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// useSubsStore подменяет папку постоянных данных и очищает список подписок: он
// глобальный, и без сброса проверки влияли бы друг на друга.
func useSubsStore(t *testing.T) {
	t.Helper()
	useStorageDirs(t)
	subsMu.Lock()
	subsList = nil
	subsMu.Unlock()
	t.Cleanup(func() {
		subsMu.Lock()
		subsList = nil
		subsMu.Unlock()
	})
}

func TestParseEpisode(t *testing.T) {
	cases := []struct {
		title          string
		season, episod int
		ok             bool
	}{
		{"Ведьмак (2019) S01E02 1080p", 1, 2, true},
		{"Ведьмак s1.e2 WEB-DL", 1, 2, true},
		{"Доктор Хаус 3x07 HDTVRip", 3, 7, true},
		{"Сериал [Сезон 3] (2020) BDRip", 3, 0, true},
		{"Кухня 6 сезон 1080p", 6, 0, true},
		{"Доктор Хаус [1-8 сезон] HDTVRip", 1, 0, true},
		{"Ведьмак (2019) [Сезон 3] 4 серия 1080p", 3, 4, true},
		{"Сериал сезон 1080p", 0, 0, false},
		{"Сериал серия 5 1080p", 0, 5, true},
		{"Матрица (1999) 1080p", 0, 0, false},
		{"", 0, 0, false},
	}
	for _, c := range cases {
		s, e, ok := parseEpisode(c.title)
		if ok != c.ok || (ok && (s != c.season || e != c.episod)) {
			t.Errorf("%q: получено сезон %d серия %d (%v), ждали сезон %d серия %d (%v)",
				c.title, s, e, ok, c.season, c.episod, c.ok)
		}
	}
}

// Раздача без сезона относится к известному сезону подписки: сезон пишут не в
// каждой раздаче, и без этого правила такая находка не двигала бы её никогда.
func TestSubEpisodeTakesTheKnownSeason(t *testing.T) {
	if s, e, ok := subEpisode("Ведьмак 5 серия 1080p", 3); !ok || s != 3 || e != 5 {
		t.Fatalf("серия без сезона: получено %d,%d,%v", s, e, ok)
	}
	// Пока сезон не известен, раздача без сезона — первый сезон: так пишут
	// аниме и мультсериалы, и иначе они не сравнивались бы с «1 сезон».
	if s, _, ok := subEpisode("Ведьмак 5 серия 1080p", 0); !ok || s != 1 {
		t.Fatalf("сезон неизвестен: получено %d,%v", s, ok)
	}
}

// Запись аниме и мультсериалов: «[1-12 из 24]», «[TV-2]», «эпизоды», пачки.
func TestParseEpisodeAnime(t *testing.T) {
	cases := []struct {
		title           string
		season, episode int
	}{
		{"Магическая битва / Jujutsu Kaisen [TV-2] [1-23 из 23] [2023, WEB-DL 1080p]", 2, 23},
		{"Ван-Пис / One Piece [TV] [1-1100 из XXXX] [1999]", 0, 1100},
		{"Блуи / Bluey (2018) [12 из 52] WEB-DLRip", 0, 12},
		{"Смешарики эпизоды 1-15 (2024)", 0, 15},
		{"Arcane S02E01-09 1080p", 2, 9},
		{"Arcane S02E01-E03 1080p", 2, 3},
		{"Фрирен / Sousou no Frieren [01-28] [2023]", 0, 28},
		{"Аватар / Avatar Season 3 Episode 5", 3, 5},
	}
	for _, c := range cases {
		s, e, ok := parseEpisode(c.title)
		if !ok || s != c.season || e != c.episode {
			t.Errorf("%q: получено %d/%d (%v), ждали %d/%d", c.title, s, e, ok, c.season, c.episode)
		}
	}
	if _, e, _ := parseEpisode("Фильм [2019-2020] 1080p"); e != 0 {
		t.Errorf("годы прочитаны как серии: %d", e)
	}
}

func TestNewerEpisode(t *testing.T) {
	cases := []struct {
		s, e, ws, we int
		want         bool
	}{
		{3, 5, 3, 4, true},
		{3, 4, 3, 4, false},
		{4, 1, 3, 9, true},
		{2, 9, 3, 1, false},
	}
	for _, c := range cases {
		if got := newerEpisode(c.s, c.e, c.ws, c.we); got != c.want {
			t.Errorf("сезон %d серия %d против %d,%d: %v, ждали %v", c.s, c.e, c.ws, c.we, got, c.want)
		}
	}
}

// matchSub ищет по названию без знаков и регистра: иначе «Ведьмак» не нашёл бы
// «ВЕДЬМАК.», а «Доктор Хаус» — «Доктор.Хаус».
func TestMatchSubIgnoresPunctuation(t *testing.T) {
	if !matchSub("ВЕДЬМАК. Сезон 1 (2019)", "ведьмак") {
		t.Error("раздача не опознана: различаются регистр и точка")
	}
	if !matchSub("Доктор.Хаус [1-8 сезон]", "Доктор Хаус") {
		t.Error("точка вместо пробела мешает опознанию")
	}
	if matchSub("Ведьмак (2019)", "Ведьмак 2") {
		t.Error("другое название признано своим")
	}
}

// Самая поздняя серия берётся по сравнению сезона и серии, а не по порядку
// строк в выдаче: трекер отдаёт их как попало.
func TestBestEpisode(t *testing.T) {
	items := []rutorItem{
		{Title: "Ведьмак [Сезон 2] 8 серия 1080p"},
		{Title: "Ведьмак [Сезон 3] 4 серия 1080p"},
		{Title: "Ведьмак [Сезон 3] 2 серия 720p"},
		{Title: "Другой сериал [Сезон 9] 1 серия"},
	}
	s, e, ok := bestEpisode(items, "Ведьмак", 0)
	if !ok || s != 3 || e != 4 {
		t.Fatalf("получилось сезон %d серия %d (%v), ждали 3-4", s, e, ok)
	}
	if _, _, ok := bestEpisode([]rutorItem{{Title: "Матрица (1999)"}}, "Матрица", 0); ok {
		t.Fatal("раздача без серии признана серией")
	}
}

// Первая проверка подписки новизну не объявляет: она только запоминает, что уже
// вышло. Иначе свежая подписка принесла бы разом все серии сериала как новые.
func TestFirstSubsCheckOnlyRemembers(t *testing.T) {
	useSubsStore(t)
	sub, err := addSub("Ведьмак", "")
	if err != nil {
		t.Fatalf("подписка не завелась: %v", err)
	}
	items := []rutorItem{{Title: "Ведьмак (2019) [Сезон 3] 4 серия 1080p"}}
	c := &Comp{}

	if got := c.checkSubsWith(func(string) ([]rutorItem, error) { return items, nil }, true); got != 0 {
		t.Fatalf("первая проверка объявила новизну: %d", got)
	}
	if sub.Season != 3 || sub.Episode != 4 {
		t.Fatalf("позиция не запомнена: сезон %d серия %d", sub.Season, sub.Episode)
	}
	// Повторная проверка с той же выдачей молчит: новизны нет.
	if got := c.checkSubsWith(func(string) ([]rutorItem, error) { return items, nil }, true); got != 0 {
		t.Fatalf("повторная проверка объявила новизну: %d", got)
	}
}

// Находка позже известной серии объявляется и переживает перезапуск демона:
// счётчик новизны и позиция записываются на диск.
func TestSubsAnnounceANewerEpisodeAndKeepIt(t *testing.T) {
	useSubsStore(t)
	sub, err := addSub("Ведьмак", "")
	if err != nil {
		t.Fatalf("подписка не завелась: %v", err)
	}
	c := &Comp{}
	base := []rutorItem{{Title: "Ведьмак (2019) [Сезон 3] 4 серия 1080p"}}
	c.checkSubsWith(func(string) ([]rutorItem, error) { return base, nil }, true)

	// Серия без сезона в названии: она относится к известному сезону.
	fresh := append([]rutorItem{}, base...)
	fresh = append(fresh, rutorItem{Title: "Ведьмак (2019) 5 серия 1080p"})
	if got := c.checkSubsWith(func(string) ([]rutorItem, error) { return fresh, nil }, true); got != 1 {
		t.Fatalf("новая серия не объявлена: %d", got)
	}
	if sub.NewCount != 1 {
		t.Fatalf("счётчик новизны: %d, ждали 1", sub.NewCount)
	}
	if sub.Episode != 5 || sub.Season != 3 {
		t.Fatalf("позиция сдвинулась не туда: сезон %d серия %d", sub.Season, sub.Episode)
	}
	if !strings.Contains(sub.LastSeen, "5 серия") {
		t.Fatalf("название находки не запомнено: %q", sub.LastSeen)
	}
	if _, err := os.Stat(subsPath()); err != nil {
		t.Fatalf("файл подписок не записан: %v", err)
	}
	// Перечитывание с диска — как после перезапуска демона.
	subsMu.Lock()
	subsList = nil
	subsMu.Unlock()
	loadSubs()
	subsMu.Lock()
	defer subsMu.Unlock()
	if len(subsList) != 1 || subsList[0].Episode != 5 || subsList[0].NewCount != 1 {
		t.Fatalf("после перечитывания подписка не та: %+v", subsList)
	}
}

// Подписка, проверенная только что, по расписанию не проверяется: чаще раза в
// subsMinPause трекер не спрашивают. Кнопка «Проверить» этот срок игнорирует.
func TestSubsCheckRespectsThePause(t *testing.T) {
	useSubsStore(t)
	if _, err := addSub("Ведьмак", ""); err != nil {
		t.Fatalf("подписка не завелась: %v", err)
	}
	subsMu.Lock()
	subsList[0].Checked = time.Now()
	subsMu.Unlock()

	calls := 0
	search := func(string) ([]rutorItem, error) { calls++; return nil, nil }
	c := &Comp{}
	c.checkSubsWith(search, false)
	if calls != 0 {
		t.Fatalf("трекер спрошен %d раз, хотя подписка проверена только что", calls)
	}
	c.checkSubsWith(search, true)
	if calls != 1 {
		t.Fatalf("проверка по кнопке не спросила трекер: %d", calls)
	}
}

// Одно и то же действие дважды подписку не удваивает: иначе на один сериал
// уходило бы два запроса к трекеру и приходило два сообщения об одной находке.
func TestAddSubIsIdempotent(t *testing.T) {
	useSubsStore(t)
	first, err := addSub("Ведьмак", "")
	if err != nil {
		t.Fatalf("подписка не завелась: %v", err)
	}
	second, err := addSub("  ВЕДЬМАК. ", "")
	if err != nil {
		t.Fatalf("повторная подписка отказала: %v", err)
	}
	if first.ID != second.ID {
		t.Fatalf("завелась вторая подписка: %s и %s", first.ID, second.ID)
	}
	if _, err := addSub("   ", ""); err == nil {
		t.Fatal("подписка без названия завелась")
	}
}

// Ручка /api/subs: список, добавление, сброс новизны, снятие и проверка по
// кнопке. Проверяется и то, что список отдаётся копией: правка ответа не должна
// менять состояние демона.
func TestSubsAPI(t *testing.T) {
	useSubsStore(t)
	// Поиск подменён: кнопка «проверить» поднимает фоновую горутину, и без
	// подмены она ушла бы в настоящий трекер прямо во время проверки.
	asked := make(chan string, 4)
	c := &Comp{subSearch: func(string) ([]rutorItem, error) {
		select {
		case asked <- "спросили":
		default:
		}
		return nil, nil
	}}
	post := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		c.apiSubs(w, httptest.NewRequest(http.MethodPost, "/api/subs", strings.NewReader(body)))
		return w
	}
	subs := func() []subscription {
		w := httptest.NewRecorder()
		c.apiSubs(w, httptest.NewRequest(http.MethodGet, "/api/subs", nil))
		var out struct {
			Subs []subscription `json:"subs"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("ответ не разобран: %v (%s)", err, w.Body.String())
		}
		return out.Subs
	}

	if w := post(`{"action":"add","title":"Ведьмак"}`); w.Code != http.StatusOK {
		t.Fatalf("подписка не завелась: %d %s", w.Code, w.Body.String())
	}
	list := subs()
	if len(list) != 1 || list[0].Title != "Ведьмак" {
		t.Fatalf("список после добавления: %+v", list)
	}
	id := list[0].ID

	// Правка отданного списка не должна менять состояние демона.
	list[0].Title = "подменённое"
	if again := subs(); again[0].Title != "Ведьмак" {
		t.Fatalf("ответ ручки — сам список, а не копия: %q", again[0].Title)
	}

	if w := post(`{"action":"seen","id":"` + id + `"}`); w.Code != http.StatusOK {
		t.Fatalf("сброс новизны отказал: %d", w.Code)
	}
	if w := post(`{"action":"check"}`); w.Code != http.StatusOK {
		t.Fatalf("проверка по кнопке отказала: %d", w.Code)
	}
	// Ручка отвечает сразу, а проверка идёт фоном. Ждём её, иначе тест
	// завершился бы, оставив горутину в списке подписок, — и следующая
	// проверка увидела бы чужое состояние.
	select {
	case <-asked:
	case <-time.After(2 * time.Second):
		t.Error("проверка по кнопке не дошла до трекера — подмена не сработала")
	}
	if w := post(`{"action":"удалить"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("неизвестное действие принято: %d", w.Code)
	}
	if w := post(`{`); w.Code != http.StatusBadRequest {
		t.Fatalf("неразборчивый запрос принят: %d", w.Code)
	}
	if w := post(`{"action":"remove","id":"` + id + `"}`); w.Code != http.StatusOK {
		t.Fatalf("снятие подписки отказало: %d", w.Code)
	}
	if len(subs()) != 0 {
		t.Fatal("подписка осталась после снятия")
	}

	w := httptest.NewRecorder()
	c.apiSubs(w, httptest.NewRequest(http.MethodDelete, "/api/subs", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("чужой метод принят: %d", w.Code)
	}
}

func TestCleanSubQuery(t *testing.T) {
	cases := map[string]string{
		"Магическая битва / Jujutsu Kaisen [TV-2] [1-23 из 23] [2023, WEB-DL 1080p]": "Магическая битва",
		"Блуи (2018) [12 из 52]":                 "Блуи",
		"Ведьмак 3 сезон 1-8 серии 1080p":        "Ведьмак",
		"Jujutsu.Kaisen.S02E05.1080p.WEB-DL.mkv": "Jujutsu Kaisen",
		"Смешарики":                              "Смешарики",
		"Дом 2":                                  "Дом 2",
	}
	for in, want := range cases {
		if got := cleanSubQuery(in); got != want {
			t.Errorf("%q → %q, ждали %q", in, got, want)
		}
	}
}
