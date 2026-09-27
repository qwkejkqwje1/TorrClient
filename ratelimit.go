package main

// Ограничение частоты поисковых обращений.
//
// Поиск ходит на трекер, а трекер отвечает капчей на частые запросы. Кэш выдачи
// (searchCacheStore) уже снимает повторные обращения за одним и тем же запросом,
// но разные запросы — перебор страниц, смена категории, дёрганье кнопки — шли
// на трекер напрямую. Придержать их дешевле, чем объяснять пользователю, почему
// вместо выдачи пришла капча.

import (
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// searchLimit / searchWindow — сколько поисковых запросов принимается с одного
// адреса за окно. Порог с запасом: живой работе (поиск, пролистывание страниц)
// тридцати в минуту хватает, а случайный цикл в интерфейсе обрывается.
const (
	searchLimit  = 30
	searchWindow = time.Minute
)

// rateLimiter — окно обращений по ключу (адресу клиента).
type rateLimiter struct {
	mu    sync.Mutex
	hits  map[string][]time.Time
	limit int
	win   time.Duration
}

func newRateLimiter(limit int, win time.Duration) *rateLimiter {
	return &rateLimiter{hits: map[string][]time.Time{}, limit: limit, win: win}
}

// allow сообщает, пропускать ли обращение, и сколько ждать при отказе.
func (l *rateLimiter) allow(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	cutoff := now.Add(-l.win)
	kept := make([]time.Time, 0, len(l.hits[key]))
	for _, t := range l.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.limit {
		l.hits[key] = kept
		return false, kept[0].Add(l.win).Sub(now)
	}
	l.hits[key] = append(kept, now)
	// Пустые записи не держатся: иначе карта росла бы вместе с числом
	// когда-либо обращавшихся адресов.
	if len(l.hits) > 512 {
		for k, v := range l.hits {
			if len(v) == 0 || !v[len(v)-1].After(cutoff) {
				delete(l.hits, k)
			}
		}
	}
	return true, 0
}

var searchGate = newRateLimiter(searchLimit, searchWindow)

// limitSearch оборачивает обработчик поиска: частые обращения получают 429 с
// Retry-After, а не уходят на трекер.
func limitSearch(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if ok, wait := searchGate.allow(clientKey(r), time.Now()); !ok {
			secs := int(wait.Seconds()) + 1
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			writeJSONError(w, http.StatusTooManyRequests,
				fmt.Sprintf("слишком много поисковых запросов, подождите %d с", secs))
			return
		}
		next(w, r)
	}
}

// clientKey — адрес клиента без порта. Порт у каждого соединения свой, и по
// полному адресу окно считалось бы для каждого соединения отдельно.
func clientKey(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
