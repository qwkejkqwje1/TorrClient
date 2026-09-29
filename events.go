package main

// Живая лента событий: интерфейс узнаёт об изменениях сразу, а не опросом.
//
// Прежде окно закачек переспрашивало список каждые три секунды, а отметки
// просмотра — каждые десять. Опрос не только запаздывал (прогресс подгрузки
// дёргался раз в три секунды), но и работал вхолостую: между изменениями список
// приходил тем же самым. Теперь демон сам сообщает, что изменилось.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// eventHub рассылает события всем подключённым интерфейсам.
type eventHub struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
}

var events = &eventHub{subs: map[chan []byte]struct{}{}}

// subscribe заводит канал подписчика. Буфер небольшой: лента сообщает «что
// изменилось», а не хранит историю — если интерфейс не успевает читать, то при
// переполнении из буфера вытесняется самое старое, и следующее актуальное
// событие доезжает на его место.
func (h *eventHub) subscribe() chan []byte {
	ch := make(chan []byte, 8)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *eventHub) unsubscribe(ch chan []byte) {
	h.mu.Lock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
	h.mu.Unlock()
}

// count — сколько интерфейсов сейчас слушает. По нему сторож раздач решает,
// стоит ли вообще спрашивать сервер: без слушателей это были бы пустые запросы.
func (h *eventHub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

// broadcast отправляет событие всем подписчикам, не дожидаясь медленных:
// застрявший интерфейс не должен задерживать остальных.
func (h *eventHub) broadcast(name string, data any) {
	payload, err := json.Marshal(data)
	if err != nil {
		return
	}
	frame := []byte("event: " + name + "\ndata: " + string(payload) + "\n\n")
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- frame:
		default:
			// Буфер полон, и роняется самое старое, а не новое. Отбрасывать
			// новое — значит застрявший интерфейс получал бы устаревшие кадры
			// и никогда не добрался бы до актуального состояния: следующее
			// событие тоже отбрасывалось бы, освобождения места не происходит.
			// Здесь место освобождается сразу, и в канале всегда свежайшее.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- frame:
			default:
			}
		}
	}
}

// apiEvents — канал серверных событий (Server-Sent Events).
func (c *Comp) apiEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "поток не поддерживается")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Connection", "keep-alive")
	// Обратный прокси не должен копить ответ: иначе события придут пачкой.
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	ch := events.subscribe()
	defer events.unsubscribe(ch)

	// Первое событие сразу: интерфейс видит, что канал жив, и переключается на
	// него, не дожидаясь первой новости.
	fmt.Fprint(w, "event: hello\ndata: {}\n\n")
	flusher.Flush()

	// Пустой комментарий раз в полминуты: соединение через промежуточные узлы
	// закрывается по молчанию, а «: ping» молчанием не считается.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case frame, ok := <-ch:
			if !ok {
				return
			}
			if _, err := w.Write(frame); err != nil {
				return
			}
			flusher.Flush()
		case <-ping.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// torrentsSnapshot спрашивает у TorrServer список раздач в исходном виде.
func (c *Comp) torrentsSnapshot() ([]byte, error) {
	// active() без профилей возвращает профиль по умолчанию, а не nil, так что
	// проверка на nil здесь была мёртвой: сломанная настройка молча уходила в
	// попытку поговорить с 127.0.0.1 и выглядела как «сервер не отвечает».
	// Проверяется то, что на самом деле может быть пустым, — сам адрес.
	prof := curCfg().active()
	if prof == nil || strings.TrimSpace(prof.URL) == "" {
		return nil, fmt.Errorf("не задан адрес сервера")
	}
	body, _ := json.Marshal(map[string]any{"action": "list"})
	req, err := http.NewRequest("POST", strings.TrimRight(prof.URL, "/")+"/torrents", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if prof.User != "" {
		req.SetBasicAuth(prof.User, prof.Pass)
	}
	cl := &http.Client{Timeout: 8 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, 4<<20))
}

// torrentsWatcher следит за состоянием раздач на сервере и сообщает интерфейсу,
// когда оно изменилось.
//
// Спрашивает сам демон, а не каждый открытый интерфейс: раздачи живут на
// сервере, и без этого сторожa окно закачек опрашивало бы его само — ровно то,
// что SSE и убирает. Запрос уходит только когда есть кому слушать.
func (c *Comp) torrentsWatcher() {
	c.torrentsWatcherStop(nil)
}

// torrentsWatcherStop — сторож с возможностью остановиться.
//
// Отдельный метод нужен не для удобства: цикл без выхода переживает проверку и
// продолжает ходить на сервер уже после её завершения, а следующая проверка
// принимает его события за свои. Остановка приходит по done: nil означает
// «работать вечно», как в настоящей программе.
func (c *Comp) torrentsWatcherStop(done <-chan struct{}) {
	var last []byte
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
		}
		if events.count() == 0 {
			continue
		}
		raw, err := c.torrentsSnapshot()
		if err != nil {
			continue
		}
		// Снимок сравнивается байтами, а не строкой: на большой библиотеке
		// string(raw) каждые две секунды — это лишняя копия в мегабайты и
		// мегабайтное сравнение на ровном месте. bytes.Equal не копирует
		// ничего, а снимок всё равно нужен целиком — его отдаёт событие.
		if bytes.Equal(raw, last) {
			continue
		}
		last = raw
		events.broadcast("torrents", json.RawMessage(raw))
	}
}

// dlNotifyEvery — как часто прогресс закачки уходит в ленту. Читается поток
// кусками по 256 КБ, и без порога события сыпались бы десятками в секунду на
// ровном месте.
const dlNotifyEvery = 700 * time.Millisecond

// notifyDownloads сообщает интерфейсу о прогрессе закачек, не чаще порога.
func (d *DLManager) notifyDownloads() {
	now := time.Now().UnixNano()
	prev := d.lastNotify.Load()
	if now-prev < int64(dlNotifyEvery) {
		return
	}
	if !d.lastNotify.CompareAndSwap(prev, now) {
		return
	}
	d.notifyDownloadsNow()
}

// notifyDownloadsNow отправляет список закачек немедленно — так сообщается о
// смене состояния: смена статуса не должна теряться из-за порога прогресса.
//
// Порог при этом сдвигается: событие уже отправлено, и без сдвига первый же
// прогресс после него прошёл бы порог и отправил то же самое вторым кадром.
// Тут это особенно заметно — загрузка начинается notifyDownloadsNow, и сразу
// после старта лента получала список дважды.
//
// Папка закачек в событие не входит: её интерфейс знает из /api/hello, а
// обращение к глобальному конфигу здесь падало бы, если событие шлётся до его
// публикации (так бывает в проверках и при запуске CLI-помощника).
func (d *DLManager) notifyDownloadsNow() {
	// Сдвиг до отправки: если отправка не сдвинет окно, следующий прогресс
	// пройдёт порог на пустом месте.
	d.lastNotify.Store(time.Now().UnixNano())
	events.broadcast("downloads", map[string]any{"jobs": d.list()})
}

// notifyPositions сообщает об изменении отметки просмотра.
func notifyPositions(hash string, fileID int, mark viewedMark) {
	events.broadcast("positions", map[string]any{
		"hash":       hash,
		"file_index": fileID,
		"pos":        mark.Pos,
		"duration":   mark.Duration,
		"done":       mark.Done,
		"updated":    mark.Updated,
	})
}
