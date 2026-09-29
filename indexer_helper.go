package main

// Помощник настройки Torznab: находит Jackett и Prowlarr на этом компьютере и
// в локальной сети и добавляет их индексаторы одним нажатием.
//
// Просканировать «всю сеть» нельзя, да и незачем: Jackett и Prowlarr почти
// всегда стоят на этом же компьютере или на соседнем в той же подсети, на
// портах 9117 и 9696. Поэтому проверяются localhost и адреса /24 вокруг
// собственных частных адресов машины, и только эти два порта.
//
// Ключ API из чужого места не берётся. Для копии на этом же компьютере ключ
// читается из её собственного файла настроек и остаётся на стороне демона:
// интерфейс получает только признак «ключ найден».

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	portJackett  = 9117
	portProwlarr = 9696
)

// foundIndexer — найденный Jackett или Prowlarr.
type foundIndexer struct {
	Kind     string `json:"kind"` // jackett | prowlarr
	Base     string `json:"base"` // http://host:port
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Local    bool   `json:"local"`     // на этом же компьютере
	KeyFound bool   `json:"key_found"` // ключ можно взять из файла настроек
}

// Подменяются проверками: настоящий обход сети в тестах не нужен.
var (
	scanDialTimeout  = 400 * time.Millisecond
	scanProbeTimeout = 2 * time.Second
	scanPorts        = []int{portJackett, portProwlarr}
)

// privateIPv4 сообщает, что адрес из частных диапазонов.
func privateIPv4(ip net.IP) bool {
	ip4 := ip.To4()
	if ip4 == nil {
		return false
	}
	switch {
	case ip4[0] == 10:
		return true
	case ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31:
		return true
	case ip4[0] == 192 && ip4[1] == 168:
		return true
	}
	return false
}

// localAddrs — собственные частные IPv4-адреса машины.
func localAddrs() []net.IP {
	var out []net.IP
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && privateIPv4(n.IP) {
			out = append(out, n.IP.To4())
		}
	}
	return out
}

// scanHosts — что проверять: localhost и /24 вокруг каждого своего частного адреса.
func scanHosts(own []net.IP) []string {
	seen := map[string]bool{"127.0.0.1": true}
	hosts := []string{"127.0.0.1"}
	for _, ip := range own {
		for i := 1; i <= 254; i++ {
			h := fmt.Sprintf("%d.%d.%d.%d", ip[0], ip[1], ip[2], i)
			if !seen[h] {
				seen[h] = true
				hosts = append(hosts, h)
			}
		}
	}
	return hosts
}

// probeIndexer по главной странице определяет, что за сервис слушает на адресе.
// Пустой ответ означает «не Jackett и не Prowlarr».
func probeIndexer(ctx context.Context, base string) string {
	ctx, cancel := context.WithTimeout(ctx, scanProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/", nil)
	if err != nil {
		return ""
	}
	cl := &http.Client{
		Timeout: scanProbeTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return http.ErrUseLastResponse
			}
			// Не уходим за пределы того же хоста: чужой редирект ничего не доказывает.
			if req.URL.Host != via[0].URL.Host {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
	resp, err := cl.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	low := strings.ToLower(string(body) + " " + resp.Header.Get("Server") + " " + resp.Request.URL.Path)
	switch {
	case strings.Contains(low, "prowlarr"):
		return "prowlarr"
	case strings.Contains(low, "jackett"):
		return "jackett"
	}
	return ""
}

// scanIndexers обходит адреса и порты параллельно и возвращает найденное.
func scanIndexers(ctx context.Context, hosts []string, ports []int, isLocal func(host string) bool) []foundIndexer {
	type job struct {
		host string
		port int
	}
	jobs := make(chan job)
	var mu sync.Mutex
	var found []foundIndexer
	var wg sync.WaitGroup
	for w := 0; w < 96; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				if ctx.Err() != nil {
					continue
				}
				addr := net.JoinHostPort(j.host, strconv.Itoa(j.port))
				d := net.Dialer{Timeout: scanDialTimeout}
				conn, err := d.DialContext(ctx, "tcp", addr)
				if err != nil {
					continue
				}
				conn.Close()
				base := "http://" + addr
				kind := probeIndexer(ctx, base)
				if kind == "" {
					continue
				}
				local := isLocal != nil && isLocal(j.host)
				f := foundIndexer{Kind: kind, Base: base, Host: j.host, Port: j.port, Local: local}
				if local {
					f.KeyFound = localIndexerKey(kind) != ""
				}
				mu.Lock()
				found = append(found, f)
				mu.Unlock()
			}
		}()
	}
	for _, h := range hosts {
		for _, p := range ports {
			jobs <- job{h, p}
		}
	}
	close(jobs)
	wg.Wait()
	sort.Slice(found, func(i, k int) bool {
		if found[i].Local != found[k].Local {
			return found[i].Local
		}
		if found[i].Kind != found[k].Kind {
			return found[i].Kind < found[k].Kind
		}
		return found[i].Host < found[k].Host
	})
	return found
}

// ---------- ключ из собственного файла настроек ----------

var (
	reJackettKey  = regexp.MustCompile(`"APIKey"\s*:\s*"([^"]+)"`)
	reProwlarrKey = regexp.MustCompile(`<ApiKey>\s*([^<\s]+)\s*</ApiKey>`)
)

// indexerConfigPaths — где сервис хранит свои настройки на этой машине.
func indexerConfigPaths(kind string) []string {
	name, file := "Jackett", "ServerConfig.json"
	if kind == "prowlarr" {
		name, file = "Prowlarr", "config.xml"
	}
	var dirs []string
	if runtime.GOOS == "windows" {
		if v := os.Getenv("ProgramData"); v != "" {
			dirs = append(dirs, filepath.Join(v, name))
		}
		if v := os.Getenv("APPDATA"); v != "" {
			dirs = append(dirs, filepath.Join(v, name))
		}
	}
	if d, err := os.UserConfigDir(); err == nil {
		dirs = append(dirs, filepath.Join(d, name), filepath.Join(d, strings.ToLower(name)))
	}
	if h, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(h, ".config", name))
	}
	out := make([]string, 0, len(dirs))
	for _, d := range dirs {
		out = append(out, filepath.Join(d, file))
	}
	return out
}

// indexerKeyPaths подменяется проверками.
var indexerKeyPaths = indexerConfigPaths

// localIndexerKey читает ключ API из файла настроек на этом компьютере.
func localIndexerKey(kind string) string {
	re := reJackettKey
	if kind == "prowlarr" {
		re = reProwlarrKey
	}
	for _, p := range indexerKeyPaths(kind) {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if m := re.FindSubmatch(b); m != nil {
			return strings.TrimSpace(string(m[1]))
		}
	}
	return ""
}

// isOwnHost: адрес принадлежит этому компьютеру.
func isOwnHost(host string) bool {
	if host == "127.0.0.1" || host == "localhost" || host == "::1" {
		return true
	}
	for _, ip := range localAddrs() {
		if ip.String() == host {
			return true
		}
	}
	return false
}

// ---------- обработчики ----------

// apiTorznabDiscover — POST /api/torznab/discover. Только POST: обход сети —
// действие, а не чтение, и чужая страница не должна запускать его сама.
func (c *Comp) apiTorznabDiscover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "только POST")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	start := time.Now()
	hosts := scanHosts(localAddrs())
	found := scanIndexers(ctx, hosts, scanPorts, isOwnHost)
	if found == nil {
		found = []foundIndexer{}
	}
	jj(w, map[string]any{"ok": true, "found": found, "scanned": len(hosts), "ms": time.Since(start).Milliseconds()})
}

// jackettAllURL — общий адрес всех настроенных в Jackett индексаторов.
func jackettAllURL(base string) string {
	return strings.TrimRight(base, "/") + "/api/v2.0/indexers/all/results/torznab/api"
}

// prowlarrIndexers спрашивает у Prowlarr список включённых торрент-индексаторов.
func prowlarrIndexers(base, key string) ([]TorznabSource, error) {
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(base, "/")+"/api/v1/indexer", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Api-Key", key)
	resp, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
	if err != nil {
		return nil, errors.New("Prowlarr не ответил")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, errors.New("Prowlarr отклонил ключ API")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Prowlarr ответил кодом %d", resp.StatusCode)
	}
	var list []struct {
		ID       int    `json:"id"`
		Name     string `json:"name"`
		Enable   bool   `json:"enable"`
		Protocol string `json:"protocol"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&list); err != nil {
		return nil, errors.New("ответ Prowlarr не разобран")
	}
	var out []TorznabSource
	for _, it := range list {
		if !it.Enable || (it.Protocol != "" && !strings.EqualFold(it.Protocol, "torrent")) {
			continue
		}
		out = append(out, TorznabSource{
			Name:   "Prowlarr: " + strings.TrimSpace(it.Name),
			URL:    strings.TrimRight(base, "/") + "/" + strconv.Itoa(it.ID) + "/api",
			APIKey: key,
		})
	}
	return out, nil
}

// apiTorznabDiscoverAdd — POST /api/torznab/discover/add {kind, base, api_key?}.
// Добавляет найденное в список индексаторов. Ключ берётся из запроса, а для
// копии на этом компьютере — из её файла настроек.
func (c *Comp) apiTorznabDiscoverAdd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "только POST")
		return
	}
	var in struct {
		Kind   string `json:"kind"`
		Base   string `json:"base"`
		APIKey string `json:"api_key"`
	}
	if err := decodeTorznabBody(w, r, &in); err != nil {
		writeJSONError(w, http.StatusBadRequest, "тело запроса не разобрано")
		return
	}
	u, err := url.Parse(strings.TrimSpace(in.Base))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		writeJSONError(w, http.StatusBadRequest, "неверный адрес сервиса")
		return
	}
	base := u.Scheme + "://" + u.Host
	key := strings.TrimSpace(in.APIKey)
	if key == "" && isOwnHost(u.Hostname()) {
		key = localIndexerKey(in.Kind)
	}
	var add []TorznabSource
	switch in.Kind {
	case "jackett":
		if key == "" {
			writeJSONError(w, http.StatusBadRequest, "нужен ключ API: он в правом верхнем углу главной страницы Jackett")
			return
		}
		add = []TorznabSource{{Name: "Jackett (" + u.Host + ")", URL: jackettAllURL(base), APIKey: key}}
	case "prowlarr":
		if key == "" {
			writeJSONError(w, http.StatusBadRequest, "нужен ключ API: Prowlarr → Настройки → Общие → Ключ API")
			return
		}
		add, err = prowlarrIndexers(base, key)
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, err.Error())
			return
		}
		if len(add) == 0 {
			writeJSONError(w, http.StatusBadRequest, "в Prowlarr нет включённых торрент-индексаторов: добавьте их там")
			return
		}
	default:
		writeJSONError(w, http.StatusBadRequest, "неизвестный вид сервиса")
		return
	}
	merged := mergeFoundSources(curCfg().TorznabSources, add)
	clean, err := cleanTorznabSources(merged, curCfg().TorznabSources)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if uerr := updateCfg(func(nc *Config) { nc.TorznabSources = clean }); uerr != nil {
		writeJSONError(w, http.StatusInternalServerError, uerr.Error())
		return
	}
	torznabSearch.reset()
	jj(w, map[string]any{"ok": true, "added": len(add), "sources": maskTorznabSources(curCfg().TorznabSources)})
}

// mergeFoundSources дописывает найденное к существующему списку. Источник с тем
// же именем обновляется (повторное нажатие не плодит дубли, а чинит ключ).
func mergeFoundSources(old, add []TorznabSource) []TorznabSource {
	out := append([]TorznabSource(nil), old...)
	for _, a := range add {
		replaced := false
		for i := range out {
			if strings.EqualFold(strings.TrimSpace(out[i].Name), a.Name) {
				out[i] = a
				replaced = true
				break
			}
		}
		if !replaced {
			out = append(out, a)
		}
	}
	return out
}
