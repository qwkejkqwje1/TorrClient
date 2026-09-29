package main

// Проверки живой ленты событий.
//
// Лента — то, чем интерфейс жив: показ прогресса, отметки просмотра и новые
// серии приходят событием, а не опросом. Если она молча перестанет работать,
// интерфейс не сломается — он просто перестанет обновляться сам, и это
// замечаешь поздно. Поэтому лента проверяется целиком: подписка, формат кадра,
// отключение, пропуск при переполненном буфере и сторож, который не должен
// спрашивать сервер, когда слушать некому.
//
// Всё проверяется на месте: настоящий сервер поднимается httptest-ом, а
// ожидание идёт по каналу с пределом времени, чтобы висящая лента роняла
// проверку, а не молчала.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// freshHub даёт отдельную ленту: проверки не должны мешать друг другу через
// общий events, иначе порядок выполнения решал бы, что именно пришло в канал.
func freshHub() *eventHub {
	return &eventHub{subs: map[chan []byte]struct{}{}}
}

// take читает кадр с пределом ожидания. Предел обязателен: лента, которая не
// прислала ничего, должна ронять проверку, а не висеть до конца прогона.
func take(t *testing.T, ch chan []byte) string {
	t.Helper()
	select {
	case b := <-ch:
		return string(b)
	case <-time.After(3 * time.Second):
		t.Fatal("событие не пришло")
		return ""
	}
}

func TestHubDeliversAFrameToEverySubscriber(t *testing.T) {
	h := freshHub()
	first := h.subscribe()
	second := h.subscribe()

	if got := h.count(); got != 2 {
		t.Fatalf("подписчиков %d, ожидалось 2", got)
	}

	h.broadcast("torrents", map[string]any{"n": 1})

	// Оба получают одно и то же: лента рассылает, а не раздаёт каждому своё.
	a, b := take(t, first), take(t, second)
	if a != b {
		t.Errorf("подписчики получили разное:\n%q\n%q", a, b)
	}
	if a != `event: torrents`+"\n"+`data: {"n":1}`+"\n\n" {
		t.Errorf("кадр собран неверно: %q", a)
	}
}

func TestHubUnsubscribeStopsDelivery(t *testing.T) {
	h := freshHub()
	ch := h.subscribe()
	h.broadcast("x", 1)
	take(t, ch)

	h.unsubscribe(ch)
	if got := h.count(); got != 0 {
		t.Fatalf("после отписки подписчиков %d, ожидалось 0", got)
	}

	// Канал отправки закрыт: писать в него больше нельзя, и падение при
	// рассылке — это ровно то, что мы проверяем (паника, а не «доставлено»).
	h.broadcast("x", 2)
	select {
	case _, open := <-ch:
		if open {
			t.Error("событие доставлено отписавшемуся")
		}
	case <-time.After(time.Second):
		t.Error("канал не закрыт после отписки")
	}
}

// Повторная отписка безопасна: канал закрыт один раз, и вторая попытка не
// должна ни паниковать на закрытом канале, ни снимать чужую подписку.
func TestHubUnsubscribeTwiceIsSafe(t *testing.T) {
	h := freshHub()
	ch := h.subscribe()
	h.unsubscribe(ch)
	h.unsubscribe(ch)
	if got := h.count(); got != 0 {
		t.Fatalf("подписчиков %d после двух отписок, ожидалось 0", got)
	}
	// Чужой канал не тронут: отписка одного не должна снимать остальных.
	other := h.subscribe()
	h.unsubscribe(ch)
	if got := h.count(); got != 1 {
		t.Errorf("чужая подписка снята вместе со своей: осталось %d", got)
	}
	h.broadcast("x", 9)
	if got := take(t, other); !strings.Contains(got, "9") {
		t.Errorf("чужой подписчик событие не получил: %q", got)
	}
}

// Переполненный буфер роняет старое, а не рассылку: застрявший интерфейс не
// должен задерживать остальных, и очередь не должна расти без предела.
func TestHubDropsTheOverflowInsteadOfBlocking(t *testing.T) {
	h := freshHub()
	ch := h.subscribe() // буфер на 8

	// Заливаем сверх буфера. Если бы рассылка блокировалась, проверка бы
	// зависла — а это и есть тот отказ, которого здесь быть не должно.
	for i := 0; i < 40; i++ {
		h.broadcast("fill", i)
	}

	if got := h.count(); got != 1 {
		t.Fatalf("подписчик отвалился при переполнении: осталось %d", got)
	}
	// В канале ровно 8 — вместимость, а не 40. И доставлены последние, а не
	// первые: показывать устаревшее состояние незачем, а отбрасывать новое
	// нельзя — тогда следующее актуальное событие тоже не доедет.
	seen := make([]string, 0, 8)
	for len(ch) > 0 {
		seen = append(seen, take(t, ch))
	}
	if len(seen) != 8 {
		t.Fatalf("в канале %d кадров, ожидалось 8 (вместимость)", len(seen))
	}
	// 32..39: восемь самых свежих из сорока.
	if got := extractData(seen[0]); got != "32" {
		t.Errorf("первым осталось %q — старое не вытеснено, окно не освобождено", got)
	}
	if got := extractData(seen[len(seen)-1]); got != "39" {
		t.Errorf("последним пришло %q, а не самое свежее (39)", got)
	}
}

// Значение, которое нельзя превратить в JSON, не должно ронять рассылку: буфер
// с названием события всё равно остаётся пригодным.
func TestHubSkipsUnmarshalableData(t *testing.T) {
	h := freshHub()
	ch := h.subscribe()

	// Канал — не сериализуемое в JSON значение.
	h.broadcast("bad", make(chan int))

	if got := h.count(); got != 1 {
		t.Fatalf("подписчик потерян после негодного события: осталось %d", got)
	}
	select {
	case b := <-ch:
		if b != nil {
			t.Errorf("негодное событие всё же отправлено: %q", b)
		}
	default:
	}

	// Следующее корректное событие проходит — рассылка не залипла.
	h.broadcast("good", 1)
	if got := take(t, ch); !strings.Contains(got, "good") {
		t.Errorf("после негодного события кадр не дошёл: %q", got)
	}
}

// Ручка потока: заголовки, приветственное событие и живая доставка.
func TestApiEventsStreamsFrames(t *testing.T) {
	h := freshHub()
	prev := events
	events = h
	t.Cleanup(func() { events = prev })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		(&Comp{}).apiEvents(w, r)
	}))
	defer srv.Close()

	req, _ := http.NewRequest("GET", srv.URL, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	resp, err := (&http.Client{}).Do(req.WithContext(ctx))
	if err != nil {
		t.Fatalf("поток не открылся: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидался 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("Content-Type %q — поток событий браузер не примет", ct)
	}
	// Без этих заголовков прокси копит ответ и события приходят пачкой.
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control %q, ожидался no-store", resp.Header.Get("Cache-Control"))
	}
	if resp.Header.Get("X-Accel-Buffering") != "no" {
		t.Errorf("X-Accel-Buffering %q, ожидался no", resp.Header.Get("X-Accel-Buffering"))
	}

	// Первое событие приходит сразу, не дожидаясь новости: по нему интерфейс
	// понимает, что канал жив.
	buf := make([]byte, 64)
	n, err := resp.Body.Read(buf)
	if err != nil || !strings.Contains(string(buf[:n]), "event: hello") {
		t.Fatalf("приветствия нет: прочитал %q, ошибка %v", string(buf[:n]), err)
	}

	// И живое событие доходит по тому же соединению.
	h.broadcast("torrents", map[string]any{"k": "v"})
	deadline := time.Now().Add(3 * time.Second)
	for {
		n, err = resp.Body.Read(buf)
		got := string(buf[:n])
		if strings.Contains(got, "torrents") {
			break
		}
		if err != nil {
			t.Fatalf("поток оборвался: %v (прочитал %q)", err, got)
		}
		if time.Now().After(deadline) {
			t.Fatalf("событие не дошло по потоку: %q", got)
		}
	}
}

// Закрытие клиента обязано освобождать подписку: иначе лента копит каналы
// ушедших окон, и рассылка стоит впустую.
func TestApiEventsReleasesTheSubscriberOnClose(t *testing.T) {
	h := freshHub()
	prev := events
	events = h
	t.Cleanup(func() { events = prev })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		(&Comp{}).apiEvents(w, r)
	}))
	defer srv.Close()

	req, _ := http.NewRequest("GET", srv.URL, nil)
	ctx, cancel := context.WithCancel(context.Background())
	resp, err := (&http.Client{}).Do(req.WithContext(ctx))
	if err != nil {
		t.Fatalf("поток не открылся: %v", err)
	}
	buf := make([]byte, 64)
	_, _ = resp.Body.Read(buf)
	if h.count() != 1 {
		t.Fatalf("подписчик не появился: %d", h.count())
	}

	cancel()
	resp.Body.Close()
	srv.Close()

	deadline := time.Now().Add(3 * time.Second)
	for h.count() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("после закрытия осталось %d подписчиков — утечка", h.count())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Поток, который нельзя выталкивать, должен сказать об этом кодом, а не
// молча висеть.
func TestApiEventsRefusesAStreamItCannotFlush(t *testing.T) {
	w := &noFlushWriter{header: http.Header{}}
	(&Comp{}).apiEvents(w, httptest.NewRequest("GET", "/api/events", nil))
	if w.code != http.StatusInternalServerError {
		t.Errorf("статус %d, ожидался 500 — интерфейс поймёт, что потока нет", w.code)
	}
}

// noFlushWriter — ResponseWriter без http.Flusher.
type noFlushWriter struct {
	header http.Header
	code   int
}

func (w *noFlushWriter) Header() http.Header { return w.header }
func (w *noFlushWriter) Write(b []byte) (int, error) {
	return len(b), nil
}
func (w *noFlushWriter) WriteHeader(code int) { w.code = code }

// ---------- сторож раздач ----------

// torrentsSnapshot спрашивает сервер и отдаёт ответ как есть.
func TestTorrentsSnapshotAsksTheServer(t *testing.T) {
	var gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		b := make([]byte, 64)
		n, _ := r.Body.Read(b)
		gotBody = string(b[:n])
		_, _ = w.Write([]byte(`[{"hash":"abc"}]`))
	}))
	defer srv.Close()

	useStorageDirs(t)
	cur := curCfg()
	cur.Profiles[0].URL = srv.URL
	cur.Profiles[0].User = "u"
	cur.Profiles[0].Pass = "p"

	raw, err := (&Comp{}).torrentsSnapshot()
	if err != nil {
		t.Fatalf("снимок не снят: %v", err)
	}
	if string(raw) != `[{"hash":"abc"}]` {
		t.Errorf("ответ сервера искажён: %q", raw)
	}
	if !strings.Contains(gotBody, `"action":"list"`) {
		t.Errorf("тело запроса %q, ожидался action=list", gotBody)
	}
	// Сервер с паролем без авторизации ответит ошибкой, а не раздачей.
	if !strings.HasPrefix(gotAuth, "Basic ") {
		t.Errorf("Authorization %q — пароль не ушёл", gotAuth)
	}
}

// Снимок без адреса сервера — ошибка, а не пустой ответ: пустой выглядел бы
// как «раздач нет» и молчал бы о сломанной настройке.
//
// Проверяется пустой адрес, а не отсутствие профиля: active() при пустом
// списке профилей возвращает профиль по умолчанию, и проверка на nil здесь
// была бы мёртвой — именно это и было дефектом в коде.
func TestTorrentsSnapshotWithoutAnAddressFails(t *testing.T) {
	useStorageDirs(t)
	cur := curCfg()
	cur.Profiles[0].URL = "   "
	if _, err := (&Comp{}).torrentsSnapshot(); err == nil {
		t.Error("без адреса сервера вернулась пустая выдача вместо ошибки")
	}
}

// Сторож не должен ходить на сервер, когда слушать некому: без интерфейсов
// это были бы пустые запросы каждые две секунды.
func TestTorrentsWatcherStaysQuietWithoutSubscribers(t *testing.T) {
	h := freshHub()
	prev := events
	events = h
	t.Cleanup(func() { events = prev })

	var mu sync.Mutex
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	useStorageDirs(t)
	cur := curCfg()
	cur.Profiles[0].URL = srv.URL
	cur.Profiles[0].User = ""
	cur.Profiles[0].Pass = ""

	// Сторож крутится вечно, поэтому он запускается с остановкой: горутина,
	// пережившая проверку, продолжила бы ходить на сервер и отправлять события
	// уже в следующую проверку.
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		(&Comp{}).torrentsWatcherStop(stop)
	}()
	time.Sleep(2500 * time.Millisecond) // больше двух тиков по 2 с
	close(stop)
	<-done

	mu.Lock()
	defer mu.Unlock()
	if hits != 0 {
		t.Errorf("сторож спросил сервер %d раз без подписчиков — пустые запросы", hits)
	}
}

// Изменение состояния раздач уходит в ленту, а одинаковые снимки молчат:
// лента сообщает «что изменилось», и повтор каждые две секунды событиями
// превратила бы её в шум.
func TestTorrentsWatcherSendsOnlyOnChange(t *testing.T) {
	h := freshHub()
	prev := events
	events = h
	t.Cleanup(func() { events = prev })
	ch := h.subscribe()

	// Снимки выдаёт подмена полей: сторож ходит на сервер, но нам нужно
	// проверить только решение «слать или молчать», а не работу HTTP.
	var mu sync.Mutex
	body := `[{"hash":"a"}]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		b := body
		mu.Unlock()
		_, _ = w.Write([]byte(b))
	}))
	defer srv.Close()

	useStorageDirs(t)
	cur := curCfg()
	cur.Profiles[0].URL = srv.URL
	cur.Profiles[0].User = ""
	cur.Profiles[0].Pass = ""

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		(&Comp{}).torrentsWatcherStop(stop)
	}()
	defer func() {
		close(stop)
		<-done
	}()

	// Первое состояние — событие.
	got := take(t, ch)
	if !strings.Contains(got, "event: torrents") {
		t.Errorf("первый снимок не объявлен: %q", got)
	}
	// Тело события — сырой снимок сервера, а не обёртка: интерфейс ждёт его
	// как список раздач.
	var items []map[string]any
	if err := json.Unmarshal([]byte(extractData(got)), &items); err != nil {
		t.Fatalf("тело события не список раздач: %v (%q)", err, got)
	}

	// Повтор молчит: тот же снимок событием не является.
	select {
	case b := <-ch:
		t.Errorf("одинаковый снимок объявлен событием: %q", b)
	case <-time.After(1200 * time.Millisecond):
	}

	// Изменение объявляется.
	mu.Lock()
	body = `[{"hash":"b"}]`
	mu.Unlock()
	deadline := time.Now().Add(6 * time.Second)
	for {
		select {
		case b := <-ch:
			if strings.Contains(string(b), `"b"`) {
				return
			}
		case <-time.After(500 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatal("изменение состояния не дошло до ленты")
		}
	}
}

// extractData достаёт поле data из кадра SSE.
func extractData(frame string) string {
	for _, line := range strings.Split(frame, "\n") {
		if strings.HasPrefix(line, "data: ") {
			return strings.TrimPrefix(line, "data: ")
		}
	}
	return ""
}

// ---------- порог прогресса ----------

// Прогресс не должен сыпать событиями на ровном месте: порог отсекает поток.
func TestNotifyDownloadsRespectsTheThreshold(t *testing.T) {
	h := freshHub()
	prev := events
	events = h
	t.Cleanup(func() { events = prev })
	ch := h.subscribe()

	d := NewDLManager(t.TempDir())
	d.notifyDownloadsNow()
	take(t, ch)

	// Сразу после события порог не прошёл — лишнего события быть не должно.
	for i := 0; i < 20; i++ {
		d.notifyDownloads()
	}
	select {
	case b := <-ch:
		t.Fatalf("порог прогресса не сработал: лишнее событие %q", b)
	case <-time.After(300 * time.Millisecond):
	}
}

// Смена состояния не должна теряться из-за порога прогресса: загрузка
// перешла в «скачивается», и это важнее, чем экономия одного события.
func TestNotifyDownloadsNowIgnoresTheThreshold(t *testing.T) {
	h := freshHub()
	prev := events
	events = h
	t.Cleanup(func() { events = prev })
	ch := h.subscribe()

	d := NewDLManager(t.TempDir())
	// Подряд, без ожидания: порог прошёл бы по времени, но здесь важно, что
	// смена состояния сообщается всегда.
	for i := 0; i < 3; i++ {
		d.notifyDownloadsNow()
		take(t, ch)
	}
}
