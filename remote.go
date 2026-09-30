package main

// Доступ с телефона.
//
// Основной сервер слушает только 127.0.0.1: API без пароля, и открывать его
// в сеть нельзя. Для телефона поднимается второй слушатель на всех адресах
// (порт RemotePort), и каждый запрос через него проходит проверку PIN-кода.
// QR-код в настройках содержит адрес вместе с PIN: телефон открывает его
// камерой, получает cookie сессии и дальше работает как обычный интерфейс.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"math/big"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

const (
	defaultRemotePort = 8100
	remoteCookie      = "tc_remote"
)

// remoteSalt отличает cookie сессии от самого PIN'а. Постоянна, чтобы
// телефон не спрашивал PIN после каждого перезапуска; смена PIN'а в настройках
// обнуляет все выданные сессии.
var remoteSalt = []byte("torrclient-remote-v1:")

// pinGate — не больше 8 попыток ввода PIN'а за 10 минут с одного адреса:
// шесть цифр — миллион вариантов, и перебор при таком пороге бессмыслен.
var pinGate = newRateLimiter(8, 10*time.Minute)

func newPIN() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "000000"
	}
	return fmt.Sprintf("%06d", n.Int64())
}

func remoteToken(pin string) string {
	h := sha256.New()
	h.Write(remoteSalt)
	h.Write([]byte(pin))
	return hex.EncodeToString(h.Sum(nil))
}

// remoteStreamToken — пропуск для ссылки на поток. Плеер на телефоне (VLC,
// MX Player) получает только адрес и cookie браузера не знает, поэтому пропуск
// идёт в самой ссылке. Это не cookie сессии: он открывает только поток и
// плейлист, а не интерфейс и не настройки.
func remoteStreamToken(pin string) string {
	h := sha256.New()
	h.Write(remoteSalt)
	h.Write([]byte("stream:"))
	h.Write([]byte(pin))
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// streamPath — адреса, которые открывает пропуск в ссылке: только чтение потока.
func streamPath(p string) bool {
	return strings.HasPrefix(p, "/ts/stream") || strings.HasPrefix(p, "/ts/play/") || strings.HasPrefix(p, "/ts/playlist")
}

// remoteCtxKey помечает запрос, пришедший через доступ с телефона: интерфейсу
// надо знать, что он открыт на телефоне, — тогда «Смотреть» играет там же, а
// не запускает плеер на компьютере.
type remoteCtxKey struct{}

func isRemoteRequest(r *http.Request) bool {
	v, _ := r.Context().Value(remoteCtxKey{}).(bool)
	return v
}

func remotePort(c *Config) int {
	if c.RemotePort > 0 && c.RemotePort < 65536 {
		return c.RemotePort
	}
	return defaultRemotePort
}

// remoteBlocked — ручки, недоступные с телефона: смена самого доступа,
// резервная копия с ключами, реестр и автозапуск Windows, установка программ.
func remoteBlocked(r *http.Request) bool {
	p := r.URL.Path
	switch p {
	case "/api/remote", "/api/backup", "/api/restore", "/api/reg", "/api/autostart":
		return true
	case "/api/torznab/apps", "/api/update":
		return r.Method != http.MethodGet
	}
	return false
}

func pinEqual(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// pinGuard пропускает запрос только с верной cookie или верным ?pin=.
func pinGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cfg := curCfg()
		pin := cfg.RemotePIN
		if !cfg.RemoteEnabled || pin == "" {
			http.Error(w, "remote access disabled", http.StatusServiceUnavailable)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), remoteCtxKey{}, true))
		if ck, err := r.Cookie(remoteCookie); err == nil && pinEqual(ck.Value, remoteToken(pin)) {
			if remoteBlocked(r) {
				writeJSONError(w, http.StatusForbidden, "недоступно с телефона")
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		// Ссылка для плеера телефона: пропуск в адресе, только поток и только
		// чтение. Пропуск вырезается до передачи серверу раздач.
		if tk := r.URL.Query().Get("tk"); tk != "" && streamPath(r.URL.Path) && safeMethod(r.Method) {
			if pinEqual(tk, remoteStreamToken(pin)) {
				q := r.URL.Query()
				q.Del("tk")
				r.URL.RawQuery = q.Encode()
				next.ServeHTTP(w, r)
				return
			}
			writeJSONError(w, http.StatusUnauthorized, "ссылка устарела: откройте её заново")
			return
		}
		try := r.URL.Query().Get("pin")
		if try == "" && r.Method == http.MethodPost && r.URL.Path == "/remote-login" {
			try = r.FormValue("pin")
		}
		if try != "" {
			if ok, _ := pinGate.allow(clientKey(r), time.Now()); !ok {
				remoteLoginPage(w, "Слишком много попыток. Подождите 10 минут.", http.StatusTooManyRequests)
				return
			}
			if pinEqual(strings.TrimSpace(try), pin) {
				http.SetCookie(w, &http.Cookie{
					Name: remoteCookie, Value: remoteToken(pin), Path: "/",
					HttpOnly: true, SameSite: http.SameSiteLaxMode,
					MaxAge: 30 * 24 * 3600,
				})
				http.Redirect(w, r, "/", http.StatusSeeOther)
				return
			}
			remoteLoginPage(w, "Неверный PIN.", http.StatusUnauthorized)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/ts/") {
			writeJSONError(w, http.StatusUnauthorized, "нужен PIN")
			return
		}
		remoteLoginPage(w, "", http.StatusUnauthorized)
	})
}

func remoteLoginPage(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	fmt.Fprintf(w, `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>TorrClient</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#1c1c1c;padding:24px;border-radius:12px;width:min(320px,90vw)}input,button{width:100%%;box-sizing:border-box;font-size:20px;padding:10px;border-radius:8px;border:1px solid #444;margin-top:10px}
input{background:#000;color:#fff;text-align:center;letter-spacing:6px}button{background:#3b82f6;color:#fff;border:0}.e{color:#f87171;margin-top:8px}</style></head>
<body><form method="post" action="/remote-login"><b>TorrClient</b><div>Введите PIN из настроек на компьютере</div>
<input name="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus><button>Войти</button><div class="e">%s</div></form></body></html>`, html.EscapeString(msg))
}

// lanAddr — адрес компьютера в сети и сетевой адаптер, которому он принадлежит.
type lanAddr struct {
	IP      string `json:"ip"`
	Iface   string `json:"iface"`
	Virtual bool   `json:"virtual"`
}

// virtualIface — адаптеры, до которых телефон в домашнем Wi-Fi не достанет:
// виртуальные машины, WSL, Docker, VPN. Раньше адрес такого адаптера мог
// оказаться первым и попасть в QR-код — телефон стучался в никуда.
var virtualIface = regexp.MustCompile(`(?i)vethernet|virtualbox|vmware|hyper-v|wsl|docker|vbox|virbr|^br-|\btap|^tun|wireguard|^wg\d|tailscale|zerotier|hamachi|radmin|openvpn|vpn|npcap|bluetooth`)

// lanAddrs — адреса компьютера в локальной сети: сначала обычные адаптеры
// (Wi-Fi, Ethernet), потом виртуальные; внутри — 192.168.* первым.
func lanAddrs() []lanAddr {
	var out, other []lanAddr
	ifs, _ := net.Interfaces()
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || ip.IsLinkLocalUnicast() {
				continue
			}
			la := lanAddr{IP: ip.String(), Iface: ifc.Name, Virtual: virtualIface.MatchString(ifc.Name)}
			if !ip.IsPrivate() {
				// Не частный адрес (например, у провайдера с CGNAT или у
				// виртуальной машины) пригодится, только если частных нет.
				other = append(other, la)
				continue
			}
			out = append(out, la)
		}
	}
	if len(out) == 0 {
		out = other
	}
	sortLanAddrs(out)
	return out
}

func sortLanAddrs(out []lanAddr) {
	rank := func(a lanAddr) int {
		r := 0
		if a.Virtual {
			r += 2
		}
		if !strings.HasPrefix(a.IP, "192.168.") {
			r++
		}
		return r
	}
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
}

// lanIPs — адреса из lanAddrs без имён адаптеров.
func lanIPs() []string {
	var out []string
	for _, a := range lanAddrs() {
		out = append(out, a.IP)
	}
	return out
}

// remoteSrv управляет вторым слушателем: включение и выключение в настройках
// применяются сразу, без перезапуска программы.
type remoteSrv struct {
	mu      sync.Mutex
	srv     *http.Server
	port    int
	handler http.Handler
	lastErr string
}

var remote = &remoteSrv{}

func (s *remoteSrv) apply() {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg := curCfg()
	want := cfg.RemoteEnabled && cfg.RemotePIN != "" && s.handler != nil
	port := remotePort(cfg)
	if s.srv != nil && (!want || s.port != port) {
		_ = s.srv.Close()
		s.srv = nil
	}
	if !want || s.srv != nil {
		if !want {
			s.lastErr = ""
		}
		return
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
	// После автообновления старая копия ещё держит порт долю секунды.
	for i := 0; err != nil && i < 20 && os.Getenv("TC_UPDATE_RESTART") == "1"; i++ {
		time.Sleep(250 * time.Millisecond)
		ln, err = net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
	}
	if err != nil {
		s.lastErr = err.Error()
		logAlways("Доступ с телефона: порт %d занят: %v", port, err)
		return
	}
	s.lastErr = ""
	s.port = port
	s.srv = &http.Server{
		Handler:           pinGuard(originGuard(s.handler)),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}
	srv := s.srv
	go func() { _ = srv.Serve(ln) }()
	logMsg("  Доступ с телефона: порт %d", port)
}

func (s *remoteSrv) state() (running bool, errText string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.srv != nil, s.lastErr
}

// apiRemote — состояние доступа с телефона (GET) и его настройка (POST
// {enabled, new_pin, port}). Ручка работает только на основном сервере.
func (c *Comp) apiRemote(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var req struct {
			Enabled *bool `json:"enabled"`
			NewPIN  bool  `json:"new_pin"`
			Port    int   `json:"port"`
			// Firewall — разрешить доступ в брандмауэре Windows (запрос UAC).
			Firewall bool `json:"firewall"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "bad json")
			return
		}
		if req.Port != 0 && (req.Port < 1024 || req.Port > 65535 || req.Port == *flagPort) {
			writeJSONError(w, http.StatusBadRequest, "порт должен быть от 1024 до 65535 и не совпадать с основным")
			return
		}
		if req.Firewall {
			if err := firewallAllow(remotePort(curCfg())); err != nil {
				writeJSONError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		err := updateCfg(func(nc *Config) {
			if req.Enabled != nil {
				nc.RemoteEnabled = *req.Enabled
			}
			if req.NewPIN || nc.RemotePIN == "" {
				nc.RemotePIN = newPIN()
			}
			if req.Port != 0 {
				nc.RemotePort = req.Port
			}
		})
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		remote.apply()
	}
	cfg := curCfg()
	running, errText := remote.state()
	port := remotePort(cfg)
	var urls []string
	type addrOut struct {
		lanAddr
		URL string `json:"url"`
		QR  string `json:"qr,omitempty"`
	}
	addrs := []addrOut{}
	for _, a := range lanAddrs() {
		u := fmt.Sprintf("http://%s:%d/?pin=%s", a.IP, port, cfg.RemotePIN)
		urls = append(urls, u)
		ao := addrOut{lanAddr: a, URL: u}
		// QR — к каждому адресу: у компьютера с VPN или виртуальной машиной
		// адресов несколько, и выбрать нужный должен человек, а не порядок.
		if running {
			if png, err := qrcode.Encode(u, qrcode.Medium, 256); err == nil {
				ao.QR = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
			}
		}
		addrs = append(addrs, ao)
	}
	out := map[string]any{
		"enabled":  cfg.RemoteEnabled,
		"running":  running,
		"error":    errText,
		"port":     port,
		"pin":      cfg.RemotePIN,
		"urls":     urls,
		"addrs":    addrs,
		"firewall": firewallState(port),
	}
	if len(addrs) > 0 && addrs[0].QR != "" {
		out["qr"] = addrs[0].QR
	}
	w.Header().Set("Cache-Control", "no-store")
	jj(w, out)
}
