package main

// Ограничитель поисковых обращений: окно, раздельность клиентов и ответ 429.

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Сверх порога обращения придерживаются, а не уходят на трекер за капчей.
func TestRateLimiterBlocksBeyondTheLimit(t *testing.T) {
	l := newRateLimiter(3, time.Minute)
	now := time.Now()
	for i := 0; i < 3; i++ {
		if ok, _ := l.allow("10.0.0.1", now); !ok {
			t.Fatalf("обращение %d отклонено внутри порога", i+1)
		}
	}
	ok, wait := l.allow("10.0.0.1", now)
	if ok {
		t.Fatal("обращение сверх порога пропущено")
	}
	if wait <= 0 || wait > time.Minute {
		t.Fatalf("ожидание вне окна: %v", wait)
	}
}

// Чужой адрес считается отдельно: окно одного клиента не должно закрывать
// поиск другому.
func TestRateLimiterKeepsClientsApart(t *testing.T) {
	l := newRateLimiter(1, time.Minute)
	now := time.Now()
	if ok, _ := l.allow("10.0.0.1", now); !ok {
		t.Fatal("первый клиент отклонён")
	}
	if ok, _ := l.allow("10.0.0.2", now); !ok {
		t.Fatal("второй клиент отклонён из-за первого")
	}
}

// Окно скользящее: обращения, вышедшие за срок, больше не считаются.
func TestRateLimiterForgetsOldHits(t *testing.T) {
	l := newRateLimiter(1, time.Minute)
	start := time.Now()
	if ok, _ := l.allow("10.0.0.1", start); !ok {
		t.Fatal("первое обращение отклонено")
	}
	if ok, _ := l.allow("10.0.0.1", start.Add(time.Second)); ok {
		t.Fatal("второе обращение пропущено внутри окна")
	}
	if ok, _ := l.allow("10.0.0.1", start.Add(2*time.Minute)); !ok {
		t.Fatal("через окно обращение не пропущено")
	}
}

// Обработчик отвечает 429 с Retry-After и до трекера не доходит.
func TestLimitSearchAnswersTooManyRequests(t *testing.T) {
	saved := searchGate
	searchGate = newRateLimiter(1, time.Minute)
	defer func() { searchGate = saved }()

	var calls int
	h := limitSearch(func(w http.ResponseWriter, r *http.Request) { calls++ })
	req := httptest.NewRequest("GET", "/api/rutor/search?query=x", nil)
	req.RemoteAddr = "10.0.0.9:1234"

	h(httptest.NewRecorder(), req)
	rec := httptest.NewRecorder()
	h(rec, req)

	if calls != 1 {
		t.Fatalf("обработчик вызван %d раз, ожидался 1", calls)
	}
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("код %d, ожидался 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("нет заголовка Retry-After")
	}
}
