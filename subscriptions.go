package main

// Подписки на сериалы: демон сам следит за выходом новых серий.
//
// Смысл в том, чтобы не спрашивать трекер руками каждый раз: подписался на
// сериал — и узнаёшь о новой серии событием в живую ленту. Позиция, от которой
// считается новизна, — последняя известная серия. Первая проверка новой
// подписки новизну не объявляет: иначе все найденные серии разом пришли бы как
// «новые», хотя вышли давно.

import (
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// subsCheckEvery — как часто подписки проверяются сами. Полчаса: серии
	// выходят неделями, а чаще значит только лишние запросы к трекеру.
	subsCheckEvery = 30 * time.Minute
	// subsFirstCheck — пауза после запуска. Демон только что поднялся и сам
	// ещё занят: проверять подписки сразу — значит мешать первому показу.
	subsFirstCheck = 90 * time.Second
	// subsMinPause — раньше этого срока подписку не проверяют даже по кнопке.
	subsMinPause = 10 * time.Minute
	// subsSearchPause — пауза между запросами к трекеру: подписок может быть
	// десяток, и сыпать ими подряд невежливо.
	subsSearchPause = 2 * time.Second

	// subsMaxNew — сколько находок уходит в событие. Больше не нужно: событие
	// сообщает «есть новые», а не перевозит всю выдачу.
	subsMaxNew = 5
)

type subscription struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Query — что искать на трекере. Отличается от названия: подписка
	// называется так, как её видит человек, а ищется так, как это пишут в
	// раздачах. По умолчанию совпадает с названием.
	Query string `json:"query"`

	// Season/Episode — последняя известная серия. Ноль означает «ещё не
	// проверяли»: первая проверка запоминает, что уже вышло, и молчит.
	Season  int `json:"season"`
	Episode int `json:"episode"`

	Provider string    `json:"provider"`
	Added    time.Time `json:"added"`
	Checked  time.Time `json:"checked"`
	LastSeen string    `json:"last_seen,omitempty"`
	NewCount int       `json:"new_count"`
}

var (
	subsMu   sync.Mutex
	subsList []*subscription
)

// subsPath — подписки лежат в папке постоянных данных: потерять их нечем
// восстановить, а список набирается долго.
func subsPath() string {
	return filepath.Join(dataDir(), "subscriptions.json")
}

func loadSubs() {
	subsMu.Lock()
	defer subsMu.Unlock()
	// Подписки набираются месяцами, и потерять их — значит заводить заново.
	// Файл новой версии, битый и чужой формат оставляют список как есть, но не
	// стирают файл: перезапись уничтожила бы то, что не прочиталось.
	_ = readStateDoc(subsPath(), &subsList)
}

func saveSubs() error {
	subsMu.Lock()
	defer subsMu.Unlock()
	return writeStateDoc(subsPath(), subsList)
}

// ---------- разбор сезона и серии ----------

var (
	// «S01E02», «s1.e2», «s01_e02»
	reSE = regexp.MustCompile(`(?i)s(\d{1,2})[\s._-]*e(\d{1,2})`)
	// «1x02» — запись, привычная по старым раздачам
	reX = regexp.MustCompile(`(?i)(?:^|[\s._\[(])(\d{1,2})x(\d{1,2})(?:[\s._\])]|$)`)
	// «1-8 сезон» — диапазон: сезоном считается его начало, иначе подписка
	// прыгнула бы на восьмой сезон, получив раздачу с первым.
	reSeasonRange = regexp.MustCompile(`(?i)(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*сезон`)
	// «3 сезон», «6 сезон 1080p»
	reSeasonBefore = regexp.MustCompile(`(?i)(\d{1,2})\s*сезон`)
	// «Сезон 3», «сезон 3-4». Число обязано кончиться границей слова: иначе
	// «сезон 1080p» прочитался бы как сезон 10 — так и было, пока стояло \d{1,2}
	// без проверки. Отрицательный просмотр вперёд Go не поддерживает, а \b
	// после цифры делает то же самое.
	reSeasonAfter = regexp.MustCompile(`(?i)сезон\D{0,3}(\d{1,2})\b`)
	// «4 серия», «8 серии» — число перед словом. Основная запись на трекере.
	reEpisodeBefore = regexp.MustCompile(`(?i)(\d{1,2})\s*сери[яийе]`)
	// «серии 1-10», «серия 5» — число после слова.
	reEpisodeWord = regexp.MustCompile(`(?i)сери[яийе]\D{0,3}(\d{1,2})\b`)
)

// parseEpisode достаёт из названия раздачи сезон и серию.
//
// Возвращает ok=false, когда ни сезона, ни серии в названии нет: сравнивать
// тогда нечего, и раздача в расчёт не берётся. Серия может быть нулевой —
// «сезон целиком»: сезон известен, а номер серии нет.
func parseEpisode(title string) (season, episode int, ok bool) {
	if m := reSE.FindStringSubmatch(title); m != nil {
		return atoiSafe(m[1]), atoiSafe(m[2]), true
	}
	if m := reX.FindStringSubmatch(title); m != nil {
		return atoiSafe(m[1]), atoiSafe(m[2]), true
	}
	season, seasonOK := 0, false
	if m := reSeasonRange.FindStringSubmatch(title); m != nil {
		season, seasonOK = atoiSafe(m[1]), true
	} else if m := reSeasonBefore.FindStringSubmatch(title); m != nil {
		season, seasonOK = atoiSafe(m[1]), true
	} else if m := reSeasonAfter.FindStringSubmatch(title); m != nil {
		season, seasonOK = atoiSafe(m[1]), true
	}
	episode, episodeOK := 0, false
	if m := reEpisodeBefore.FindStringSubmatch(title); m != nil {
		episode, episodeOK = atoiSafe(m[1]), true
	} else if m := reEpisodeWord.FindStringSubmatch(title); m != nil {
		episode, episodeOK = atoiSafe(m[1]), true
	}
	if seasonOK || episodeOK {
		return season, episode, true
	}
	return 0, 0, false
}

// subEpisode — сезон и серия для сравнения с известной позицией подписки.
//
// Отличается от parseEpisode одним: раздача без сезона в названии («5 серия»)
// относится к известному сезону подписки. Сезон пишут не в каждой раздаче, а
// серии выходят подряд — без этого правила такая находка не двигала бы подписку
// никогда. Пока сезон неизвестен, сравнивать не с чем: раздача не берётся.
func subEpisode(title string, wasSeason int) (season, episode int, ok bool) {
	season, episode, ok = parseEpisode(title)
	if !ok {
		return 0, 0, false
	}
	if season == 0 && episode > 0 && wasSeason > 0 {
		season = wasSeason
	}
	return season, episode, true
}

// newerEpisode отвечает, вышла ли серия позже известной.
func newerEpisode(season, episode, wasSeason, wasEpisode int) bool {
	if season != wasSeason {
		return season > wasSeason
	}
	return episode > wasEpisode
}

// normTitle приводит название к виду, по которому сравнивают: без регистра, без
// знаков и с «ё», приведённой к «е». Иначе «Ведьмак» не совпадёт с «Ведьмакъ»
// или с названием, где между словами стоит точка вместо пробела.
func normTitle(s string) string {
	low := strings.ToLower(strings.ReplaceAll(s, "ё", "е"))
	var b strings.Builder
	prevSpace := false
	for _, r := range low {
		keep := (r >= 'а' && r <= 'я') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if !keep {
			// Знак — то же, что пробел: «Доктор.Хаус» и «Доктор Хаус» — один
			// сериал, а два пробела подряд не должны удлинять строку.
			if !prevSpace {
				b.WriteRune(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	return strings.TrimSpace(b.String())
}

// matchSub отвечает, годится ли находка под подписку.
//
// Совпадение проверяется по границам слов, а не простым поиском подстроки:
// «Ведьмак 2» — другой сериал, и находить его в «Ведьмак (2019)» он не должен
// только потому, что год начинается с той же цифры. Через Contains так и
// получалось — подписка на «Дом 2» считала новой любую раздачу с годом 2019.
func matchSub(itemTitle, sub string) bool {
	item, want := normTitle(itemTitle), normTitle(sub)
	if want == "" {
		return false
	}
	for from := 0; from < len(item); {
		i := strings.Index(item[from:], want)
		if i < 0 {
			return false
		}
		start := from + i
		end := start + len(want)
		if (start == 0 || item[start-1] == ' ') && (end == len(item) || item[end] == ' ') {
			return true
		}
		from = start + 1
	}
	return false
}

// ---------- проверка ----------

// subSearch — поиск по трекеру. Тип, а не прямой вызов: проверка подписок
// должна быть проверяемой без сети, а подменить метод структуры нельзя.
type subSearch func(query string) ([]rutorItem, error)

// rutorSearchAll ищет по всем категориям: сериал может оказаться и в
// зарубежных, и в наших, и в аниме, а подписка не знает, кем он вышел.
func (c *Comp) rutorSearchAll(q string) ([]rutorItem, error) {
	return c.rutorSearch(q, 0, 0)
}

// checkSubsWith проверяет все подписки и сообщает о новых сериях. Возвращает
// число подписок, по которым новизна найдена.
func (c *Comp) checkSubsWith(search subSearch, force bool) int {
	subsMu.Lock()
	list := make([]*subscription, len(subsList))
	copy(list, subsList)
	subsMu.Unlock()

	found := 0
	for _, sub := range list {
		if !force && time.Since(sub.Checked) < subsMinPause {
			continue
		}
		items, err := search(sub.Query)
		if err != nil || len(items) == 0 {
			continue
		}
		if c.noteSubResult(sub, items) {
			found++
		}
		time.Sleep(subsSearchPause)
	}
	// Запоминается и то, что новизны не было: позиция «последняя известная
	// серия» сдвинулась, и без записи следующая проверка объявила бы ту же
	// серию новой.
	saveSubs()
	return found
}

// noteSubResult разбирает выдачу по одной подписке.
//
// Возвращает признак «объявлена новизна». Первая проверка подписки новизну не
// объявляет: она только запоминает, что уже вышло, — иначе все давние серии
// пришли бы как новые.
func (c *Comp) noteSubResult(sub *subscription, items []rutorItem) bool {
	best, bestItem, ok := bestEpisode(items, sub.Query, sub.Season)
	if !ok {
		return false
	}
	subsMu.Lock()
	defer subsMu.Unlock()

	// Первая проверка новизну не объявляет: она только запоминает, что уже
	// вышло. Иначе все давние серии пришли бы разом как новые.
	baseline := sub.Season == 0 && sub.Episode == 0
	var fresh []rutorItem
	if !baseline {
		for _, it := range items {
			if !matchSub(it.Title, sub.Query) {
				continue
			}
			s, e, ok := subEpisode(it.Title, sub.Season)
			if !ok {
				continue
			}
			if newerEpisode(s, e, sub.Season, sub.Episode) {
				fresh = append(fresh, it)
			}
		}
	}
	if len(fresh) > 0 {
		sub.NewCount += len(fresh)
		sub.LastSeen = fresh[0].Title
	}
	sub.Season = best
	sub.Episode = bestItem
	sub.Checked = time.Now()
	if len(fresh) == 0 {
		return false
	}
	// Событие уходит после сдвига позиции: в нём названа серия, до которой
	// подписка досмотрела, а не та, что была известна прежде.
	announceSubs(sub, fresh)
	return true
}

// bestEpisode находит самую позднюю серию в выдаче.
func bestEpisode(items []rutorItem, sub string, wasSeason int) (season, episode int, ok bool) {
	for _, it := range items {
		if !matchSub(it.Title, sub) {
			continue
		}
		s, e, parsed := subEpisode(it.Title, wasSeason)
		if !parsed {
			continue
		}
		if !ok || newerEpisode(s, e, season, episode) {
			season, episode, ok = s, e, true
		}
	}
	return season, episode, ok
}

// announceSubs сообщает интерфейсу о новых сериях.
func announceSubs(sub *subscription, fresh []rutorItem) {
	if len(fresh) > subsMaxNew {
		fresh = fresh[:subsMaxNew]
	}
	events.broadcast("subs", map[string]any{
		"id":      sub.ID,
		"title":   sub.Title,
		"season":  sub.Season,
		"episode": sub.Episode,
		"count":   len(fresh),
		"items":   fresh,
	})
}

// subsWatcher проверяет подписки по расписанию.
func (c *Comp) subsWatcher() {
	time.Sleep(subsFirstCheck)
	t := time.NewTicker(subsCheckEvery)
	defer t.Stop()
	for range t.C {
		c.checkSubs(false)
	}
}

// checkSubs проверяет подписки по расписанию и по кнопке.
//
// Поиск берётся из c.subSearch, а не вызывается напрямую: без подмены кнопка
// «проверить» поднимала бы настоящий запрос к трекеру прямо в тестах — сеть
// в проверке не должна участвовать, а запрос ушёл бы мимо подставы.
func (c *Comp) checkSubs(force bool) {
	search := c.subSearch
	if search == nil {
		search = c.rutorSearchAll
	}
	c.checkSubsWith(search, force)
}

// ---------- API ----------

func (c *Comp) apiSubs(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		subsMu.Lock()
		out := make([]*subscription, len(subsList))
		for i, s := range subsList {
			cp := *s
			out[i] = &cp
		}
		subsMu.Unlock()
		jj(w, map[string]any{"subs": out})
	case http.MethodPost:
		var in struct {
			Action string `json:"action"`
			ID     string `json:"id"`
			Title  string `json:"title"`
			Query  string `json:"query"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
			writeJSONError(w, http.StatusBadRequest, "неразборчивый запрос")
			return
		}
		switch in.Action {
		case "add":
			sub, err := addSub(in.Title, in.Query)
			if err != nil {
				writeJSONError(w, http.StatusBadRequest, err.Error())
				return
			}
			jj(w, map[string]any{"ok": true, "sub": sub})
		case "remove":
			removeSub(in.ID)
			jj(w, map[string]any{"ok": true})
		case "seen":
			// Сброс счётчика новизны: посмотрел — значит, больше не новое.
			markSubSeen(in.ID)
			jj(w, map[string]any{"ok": true})
		case "check":
			// Проверка по кнопке: сразу, а не по расписанию.
			go c.checkSubs(true)
			jj(w, map[string]any{"ok": true})
		default:
			writeJSONError(w, http.StatusBadRequest, "неизвестное действие: "+in.Action)
		}
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// addSub заводит подписку. Повторно ту же не заводим: две подписки на один
// сериал означали бы два запроса к трекеру и два сообщения об одном и том же.
func addSub(title, query string) (*subscription, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return nil, errSubNoTitle
	}
	q := strings.TrimSpace(query)
	if q == "" {
		q = title
	}
	subsMu.Lock()
	defer subsMu.Unlock()
	for _, s := range subsList {
		if normTitle(s.Title) == normTitle(title) {
			return s, nil
		}
	}
	sub := &subscription{
		ID:       "s" + time.Now().Format("20060102150405") + "-" + strconv.Itoa(len(subsList)),
		Title:    title,
		Query:    q,
		Provider: "rutor",
		Added:    time.Now(),
	}
	subsList = append(subsList, sub)
	// Новая подписка пишется сразу: без этой записи она жила бы до перезапуска
	// демона, а после него интерфейс показывал бы пустой список — и человек
	// заводил бы подписку заново.
	saveSubsLocked()
	return sub, nil
}

// removeSub убирает подписку.
func removeSub(id string) {
	subsMu.Lock()
	defer subsMu.Unlock()
	kept := subsList[:0]
	for _, s := range subsList {
		if s.ID != id {
			kept = append(kept, s)
		}
	}
	subsList = kept
	saveSubsLocked()
}

// markSubSeen обнуляет счётчик новых серий.
func markSubSeen(id string) {
	subsMu.Lock()
	defer subsMu.Unlock()
	for _, s := range subsList {
		if s.ID == id {
			s.NewCount = 0
		}
	}
	saveSubsLocked()
}

// saveSubsLocked пишет список. Вызывается под subsMu.
func saveSubsLocked() {
	_ = writeStateDoc(subsPath(), subsList)
}

// errSubNoTitle — отказ «не названо, за чем следить»: пустая подписка молча
// создала бы запись, по которой трекер спрашивать нечем.
var errSubNoTitle = errors.New("не названо, за чем следить")
