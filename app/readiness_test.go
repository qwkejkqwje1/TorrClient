package main

// Проверки готовности TorrServer и ожидания ответа.
//
// Открытый порт готовностью не является: сервер открывает сокет раньше, чем
// начнёт отвечать, и запрос в этот промежуток рвётся — снаружи это выглядит как
// «поиск молчит» при живом процессе. Поэтому готовность подтверждается ответом
// /echo, а ожидание прекращается, как только запущенный процесс завершился.
//
// Проверки ходят на местный сервер-заглушку, а не на настоящий TorrServer:
// доказательство не должно зависеть от того, что запущено на машине. Что
// /echo у настоящей сборки действительно отвечает, проверено живым запуском
// (MatriX.144.1 — ответ 200, тело «MatriX.144.1»).

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// portOf достаёт номер порта у сервера-заглушки.
func portOf(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	addr, ok := srv.Listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("адрес сервера-заглушки не разобран: %v", srv.Listener.Addr())
	}
	return addr.Port
}

// Настоящий ответ /echo: сервер готов, и версия прочитана.
func TestTorrServerReadyReadsTheVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/echo" {
			t.Errorf("спросили %q, а готовность подтверждается /echo", r.URL.Path)
		}
		_, _ = w.Write([]byte("MatriX.144.1\n"))
	}))
	defer srv.Close()

	ready, version := torrServerReady(portOf(t, srv))
	if !ready {
		t.Fatal("сервер ответил, а готовым не признан")
	}
	if version != "MatriX.144.1" {
		t.Errorf("версия %q, ожидалась %q", version, "MatriX.144.1")
	}
}

// Сборка без /echo: сервер отвечает по HTTP, значит живой. Отказ в этом случае
// был бы регрессом — такой сервер работал бы, а мы бы считали его мёртвым.
func TestTorrServerReadyAcceptsABuildWithoutEcho(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()

	if ready, _ := torrServerReady(portOf(t, srv)); !ready {
		t.Error("сервер отвечает 404 на /echo, а готовым не признан")
	}
}

// Отказ сервера готовностью не является.
func TestTorrServerReadyRejectsAnErrorAnswer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	if ready, _ := torrServerReady(portOf(t, srv)); ready {
		t.Error("ответ 500 признан готовностью")
	}
}

// Пустое тело готовностью не является: тело и есть признак того, что запрос
// дошёл до обработчика, а не только до сокета.
func TestTorrServerReadyRejectsAnEmptyBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if ready, _ := torrServerReady(portOf(t, srv)); ready {
		t.Error("пустое тело признано готовностью")
	}
}

// Закрытый порт — не готов, и отвечает об этом быстро, а не по сроку.
func TestTorrServerReadyRejectsAClosedPort(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	port := portOf(t, srv)
	srv.Close()

	start := time.Now()
	if ready, _ := torrServerReady(port); ready {
		t.Error("закрытый порт признан готовым сервером")
	}
	if elapsed := time.Since(start); elapsed > healthTimeout {
		t.Errorf("отказ занял %v — это больше срока ответа %v", elapsed, healthTimeout)
	}
}

// Готовность с первой попытки: ждать нечего.
func TestWaitReadyReturnsAsSoonAsReady(t *testing.T) {
	calls := 0
	ready := func() bool { calls++; return true }
	alive := func() bool {
		t.Error("живость спрашивают, когда готовность уже есть")
		return true
	}
	if !waitReady(5, time.Millisecond, ready, alive) {
		t.Error("готовность не замечена")
	}
	if calls != 1 {
		t.Errorf("готовность спрошена %d раз, ожидался один", calls)
	}
}

// Процесс завершился — ждать нечего, и срок тут ни при чём. Ради этого ожидание
// и разделено на «готов» и «жив».
//
// Число попыток намеренно маленькое, а пауза большая: без проверки живости
// ожидание отработало бы все попытки и проверка упала бы по времени, а не
// зависла на тысячи секунд.
func TestWaitReadyGivesUpAsSoonAsTheProcessIsGone(t *testing.T) {
	ready := func() bool { return false }
	alive := func() bool { return false }

	start := time.Now()
	if waitReady(3, time.Second, ready, alive) {
		t.Error("мёртвый процесс признан готовым")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("ожидание заняло %v — живость проверена, а срок отработан", elapsed)
	}
}

// Срок вышел — отказ, а не бесконечное ожидание.
func TestWaitReadyGivesUpAfterTheTriesRunOut(t *testing.T) {
	calls := 0
	ready := func() bool { calls++; return false }
	alive := func() bool { return true }

	if waitReady(4, time.Millisecond, ready, alive) {
		t.Error("отсутствующая готовность признана готовностью")
	}
	if calls != 4 {
		t.Errorf("готовность спрошена %d раз, ожидалось 4", calls)
	}
}

// Запоздалая готовность всё же замечается: серверу нужно время.
func TestWaitReadyWaitsForALateAnswer(t *testing.T) {
	tries := 0
	ready := func() bool { tries++; return tries >= 3 }
	if !waitReady(10, time.Millisecond, ready, func() bool { return true }) {
		t.Error("запоздалая готовность не замечена")
	}
}

// Порт занят чужой программой: открыт, своего процесса нет, живости нет.
func TestForeignHolderRecognisesAForeignProgram(t *testing.T) {
	if !foreignHolder(true, false, false) {
		t.Error("чужой процесс на порту не распознан")
	}
}

// Наш поднимающийся процесс и живой сервер чужими не считаются.
func TestForeignHolderLeavesOurOwnProcessAlone(t *testing.T) {
	for _, tc := range []struct {
		name      string
		portOpen  bool
		weStarted bool
		alive     bool
	}{
		{"наш процесс запущен", true, true, false},
		{"наш процесс отвечает", true, true, true},
		{"порт открыт и живость есть", true, false, true},
		{"порт закрыт", false, false, false},
		{"порт закрыт, хотя процесс запущен", false, true, false},
	} {
		if foreignHolder(tc.portOpen, tc.weStarted, tc.alive) {
			t.Errorf("%s: признано чужим процессом", tc.name)
		}
	}
}
