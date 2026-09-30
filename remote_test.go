package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPinGuard(t *testing.T) {
	old := cfg.Load()
	t.Cleanup(func() { cfg.Store(old) })
	setCfg(&Config{RemoteEnabled: true, RemotePIN: "123456"})
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(299) })
	h := pinGuard(ok)
	do := func(method, path, cookie string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.RemoteAddr = "192.168.1.50:5000"
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: remoteCookie, Value: cookie})
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := do("GET", "/api/hello", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("без PIN: %d", w.Code)
	}
	if w := do("GET", "/?pin=000000", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("неверный PIN: %d", w.Code)
	}
	w := do("GET", "/?pin=123456", "")
	if w.Code != http.StatusSeeOther || !strings.Contains(w.Header().Get("Set-Cookie"), remoteCookie) {
		t.Fatalf("верный PIN: %d %q", w.Code, w.Header().Get("Set-Cookie"))
	}
	tok := remoteToken("123456")
	if w := do("GET", "/api/hello", tok); w.Code != 299 {
		t.Fatalf("с cookie: %d", w.Code)
	}
	if w := do("GET", "/api/backup", tok); w.Code != http.StatusForbidden {
		t.Fatalf("резервная копия с телефона: %d", w.Code)
	}
	if w := do("POST", "/api/torznab/apps", tok); w.Code != http.StatusForbidden {
		t.Fatalf("установка с телефона: %d", w.Code)
	}
	if w := do("GET", "/api/hello", remoteToken("654321")); w.Code != http.StatusUnauthorized {
		t.Fatalf("старая сессия после смены PIN: %d", w.Code)
	}
	setCfg(&Config{RemoteEnabled: false, RemotePIN: "123456"})
	if w := do("GET", "/api/hello", tok); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("выключенный доступ: %d", w.Code)
	}
}

func TestNewPIN(t *testing.T) {
	for i := 0; i < 50; i++ {
		p := newPIN()
		if len(p) != 6 || strings.Trim(p, "0123456789") != "" {
			t.Fatalf("PIN %q", p)
		}
	}
}

// Плеер телефона не знает cookie браузера: ссылка на поток несёт пропуск.
// Пропуск открывает только поток, не интерфейс, и серверу раздач не уходит.
func TestPinGuardStreamToken(t *testing.T) {
	old := cfg.Load()
	t.Cleanup(func() { cfg.Store(old) })
	setCfg(&Config{RemoteEnabled: true, RemotePIN: "123456"})
	var gotQuery string
	var remote bool
	h := pinGuard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery, remote = r.URL.RawQuery, isRemoteRequest(r)
		w.WriteHeader(299)
	}))
	do := func(method, path string) int {
		r := httptest.NewRequest(method, path, nil)
		r.RemoteAddr = "192.168.1.50:5000"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	tk := remoteStreamToken("123456")
	if tk == remoteToken("123456") {
		t.Fatal("пропуск потока совпадает с cookie сессии")
	}
	if c := do("GET", "/ts/stream/a.mkv?link=h&index=2&play&tk="+tk); c != 299 {
		t.Fatalf("поток с пропуском: %d", c)
	}
	if strings.Contains(gotQuery, "tk=") || !strings.Contains(gotQuery, "index=2") || !remote {
		t.Errorf("до сервера дошло %q (remote=%v)", gotQuery, remote)
	}
	if c := do("GET", "/api/hello?tk="+tk); c != http.StatusUnauthorized {
		t.Errorf("пропуск открыл интерфейс: %d", c)
	}
	if c := do("POST", "/ts/stream/a.mkv?tk="+tk); c != http.StatusUnauthorized {
		t.Errorf("пропуск принят для POST: %d", c)
	}
	if c := do("GET", "/ts/stream/a.mkv?tk=bad"); c != http.StatusUnauthorized {
		t.Errorf("неверный пропуск: %d", c)
	}
}

// Адрес виртуального адаптера (WSL, VirtualBox, VPN) не должен попадать в QR
// первым: телефон в домашнем Wi-Fi до него не достанет.
func TestSortLanAddrsPutsRealAdaptersFirst(t *testing.T) {
	list := []lanAddr{
		{IP: "172.24.160.1", Iface: "vEthernet (WSL)"},
		{IP: "192.168.56.1", Iface: "VirtualBox Host-Only Network"},
		{IP: "10.0.0.5", Iface: "Ethernet"},
		{IP: "192.168.1.34", Iface: "Беспроводная сеть"},
	}
	for i := range list {
		list[i].Virtual = virtualIface.MatchString(list[i].Iface)
	}
	sortLanAddrs(list)
	got := []string{}
	for _, a := range list {
		got = append(got, a.IP)
	}
	if strings.Join(got, ",") != "192.168.1.34,10.0.0.5,192.168.56.1,172.24.160.1" {
		t.Errorf("порядок = %v", got)
	}
	if virtualIface.MatchString("Wi-Fi") || virtualIface.MatchString("Ethernet 2") || virtualIface.MatchString("Беспроводная сеть") {
		t.Error("обычный адаптер принят за виртуальный")
	}
}
