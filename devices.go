package main

// «Отправить на устройство»: продолжить просмотр на другом экране с того же
// места.
//
// Устройства двух видов. Первое — открытый интерфейс TorrClient на другом
// устройстве (телефон, планшет, второй компьютер): каждое окно интерфейса
// отмечается у демона, и отправка приходит туда событием «handoff» с
// раздачей, серией и позицией. Второе — телевизоры и приставки с DLNA
// (MediaRenderer) в той же сети: им демон сам передаёт адрес потока
// TorrServer и переводит на нужное время.

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"path"
	"strings"
	"sync"
	"time"
)

type uiDevice struct {
	ID     string    `json:"id"`
	Name   string    `json:"name"`
	Kind   string    `json:"kind"` // phone | tablet | pc
	Remote bool      `json:"remote"`
	Seen   time.Time `json:"-"`
}

type dlnaDevice struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"` // tv
	control string
	service string
}

var (
	devMu    sync.Mutex
	uiDevs   = map[string]*uiDevice{}
	dlnaDevs = map[string]*dlnaDevice{}
	dlnaAt   time.Time
)

const uiDeviceTTL = 75 * time.Second

func noteUIDevice(d uiDevice) {
	d.ID = strings.TrimSpace(d.ID)
	if d.ID == "" || len(d.ID) > 64 {
		return
	}
	if len([]rune(d.Name)) > 60 {
		d.Name = string([]rune(d.Name)[:60])
	}
	d.Seen = time.Now()
	devMu.Lock()
	uiDevs[d.ID] = &d
	devMu.Unlock()
}

// ---------- DLNA ----------

const ssdpAddr = "239.255.255.250:1900"

// ssdpSearch рассылает M-SEARCH и собирает адреса описаний устройств.
func ssdpSearch(wait time.Duration) []string {
	conn, err := net.ListenPacket("udp4", ":0")
	if err != nil {
		return nil
	}
	defer conn.Close()
	dst, err := net.ResolveUDPAddr("udp4", ssdpAddr)
	if err != nil {
		return nil
	}
	for _, st := range []string{"urn:schemas-upnp-org:device:MediaRenderer:1", "urn:schemas-upnp-org:service:AVTransport:1"} {
		msg := "M-SEARCH * HTTP/1.1\r\nHOST: " + ssdpAddr + "\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: " + st + "\r\n\r\n"
		_, _ = conn.WriteTo([]byte(msg), dst)
	}
	_ = conn.SetReadDeadline(time.Now().Add(wait))
	seen := map[string]bool{}
	var out []string
	buf := make([]byte, 4096)
	for {
		n, _, err := conn.ReadFrom(buf)
		if err != nil {
			break
		}
		if loc := ssdpLocation(string(buf[:n])); loc != "" && !seen[loc] {
			seen[loc] = true
			out = append(out, loc)
		}
	}
	return out
}

func ssdpLocation(resp string) string {
	for _, line := range strings.Split(resp, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if ok && strings.EqualFold(strings.TrimSpace(k), "location") {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

type upnpService struct {
	Type    string `xml:"serviceType"`
	Control string `xml:"controlURL"`
}
type upnpDevice struct {
	Name     string        `xml:"friendlyName"`
	UDN      string        `xml:"UDN"`
	Services []upnpService `xml:"serviceList>service"`
	Devices  []upnpDevice  `xml:"deviceList>device"`
}
type upnpRoot struct {
	URLBase string     `xml:"URLBase"`
	Device  upnpDevice `xml:"device"`
}

// findAVTransport ищет службу AVTransport в устройстве и вложенных.
func findAVTransport(d upnpDevice) (upnpDevice, upnpService, bool) {
	for _, s := range d.Services {
		if strings.Contains(s.Type, ":AVTransport:") {
			return d, s, true
		}
	}
	for _, sub := range d.Devices {
		if dd, s, ok := findAVTransport(sub); ok {
			if dd.Name == "" {
				dd.Name = d.Name
			}
			return dd, s, true
		}
	}
	return d, upnpService{}, false
}

// parseRendererDesc разбирает описание устройства в адрес управления.
func parseRendererDesc(loc string, body []byte) (*dlnaDevice, error) {
	var root upnpRoot
	if err := xml.Unmarshal(body, &root); err != nil {
		return nil, err
	}
	dev, svc, ok := findAVTransport(root.Device)
	if !ok {
		return nil, errors.New("нет AVTransport")
	}
	base, err := url.Parse(loc)
	if err != nil {
		return nil, err
	}
	if root.URLBase != "" {
		if b, err := url.Parse(root.URLBase); err == nil {
			base = b
		}
	}
	ctl, err := base.Parse(strings.TrimSpace(svc.Control))
	if err != nil {
		return nil, err
	}
	id := strings.TrimSpace(dev.UDN)
	if id == "" {
		id = loc
	}
	name := strings.TrimSpace(dev.Name)
	if name == "" {
		name = base.Hostname()
	}
	return &dlnaDevice{ID: "dlna:" + id, Name: name, Kind: "tv", control: ctl.String(), service: strings.TrimSpace(svc.Type)}, nil
}

var dlnaClient = &http.Client{Timeout: 6 * time.Second}

// scanDLNA обновляет список телевизоров. Результат держится минуту: поиск
// занимает секунды, а телевизоры не появляются каждую секунду.
func scanDLNA(force bool) {
	devMu.Lock()
	fresh := time.Since(dlnaAt) < time.Minute
	devMu.Unlock()
	if fresh && !force {
		return
	}
	found := map[string]*dlnaDevice{}
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, loc := range ssdpSearch(2500 * time.Millisecond) {
		wg.Add(1)
		go func(loc string) {
			defer wg.Done()
			resp, err := dlnaClient.Get(loc)
			if err != nil {
				return
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			d, err := parseRendererDesc(loc, body)
			if err != nil {
				return
			}
			mu.Lock()
			found[d.ID] = d
			mu.Unlock()
		}(loc)
	}
	wg.Wait()
	devMu.Lock()
	dlnaDevs, dlnaAt = found, time.Now()
	devMu.Unlock()
}

func soapCall(d *dlnaDevice, action, args string) error {
	svc := d.service
	if svc == "" {
		svc = "urn:schemas-upnp-org:service:AVTransport:1"
	}
	body := `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:` +
		action + ` xmlns:u="` + svc + `"><InstanceID>0</InstanceID>` + args + `</u:` + action + `></s:Body></s:Envelope>`
	req, err := http.NewRequest(http.MethodPost, d.control, bytes.NewBufferString(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", `text/xml; charset="utf-8"`)
	req.Header.Set("SOAPAction", `"`+svc+`#`+action+`"`)
	resp, err := dlnaClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("%s: HTTP %d %s", action, resp.StatusCode, upnpErrText(b))
	}
	return nil
}

func upnpErrText(b []byte) string {
	s := string(b)
	if i := strings.Index(s, "<errorDescription>"); i >= 0 {
		s = s[i+len("<errorDescription>"):]
		if j := strings.Index(s, "<"); j >= 0 {
			return s[:j]
		}
	}
	return ""
}

func xmlEsc(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func videoMime(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".avi":
		return "video/x-msvideo"
	case ".ts", ".m2ts":
		return "video/mp2t"
	case ".webm":
		return "video/webm"
	case ".mov":
		return "video/quicktime"
	}
	return "video/x-matroska"
}

func hms(sec float64) string {
	s := int(sec)
	return fmt.Sprintf("%d:%02d:%02d", s/3600, s/60%60, s%60)
}

// lanStreamBase — адрес TorrServer, по которому до него достучится
// телевизор. Локальный 127.0.0.1 телевизору не годится: подставляется адрес
// этого компьютера в той же сети, что и телевизор.
func lanStreamBase(prof *Profile, toward string) (string, error) {
	u, err := url.Parse(strings.TrimRight(prof.URL, "/"))
	if err != nil {
		return "", err
	}
	if !isLocalURL(prof.URL) {
		return u.String(), nil
	}
	tv, err := url.Parse(toward)
	if err != nil {
		return "", err
	}
	host := tv.Host
	if tv.Port() == "" {
		host = net.JoinHostPort(tv.Hostname(), "80")
	}
	c, err := net.DialTimeout("udp4", host, 2*time.Second)
	if err != nil {
		return "", err
	}
	defer c.Close()
	ip := c.LocalAddr().(*net.UDPAddr).IP.String()
	port := u.Port()
	if port == "" {
		port = "8090"
	}
	u.Host = net.JoinHostPort(ip, port)
	return u.String(), nil
}

// castDLNA отправляет серию на телевизор и переводит на позицию.
func castDLNA(d *dlnaDevice, hash string, index int, pos float64, title string) error {
	prof := curCfg().active()
	if prof == nil {
		return errors.New("нет активного сервера")
	}
	base, err := lanStreamBase(prof, d.control)
	if err != nil {
		return err
	}
	name := "video.mkv"
	if st, err := fetchTorrentStatus(hash); err == nil {
		for _, f := range st.Files {
			if f.ID == index {
				name = path.Base(strings.ReplaceAll(f.Path, "\\", "/"))
			}
		}
		if title == "" {
			title = st.Title
		}
	}
	if title == "" {
		title = name
	}
	stream := base + "/stream/" + url.PathEscape(name) + "?link=" + url.QueryEscape(hash) + "&index=" + fmt.Sprint(index) + "&play"
	didl := `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>` +
		xmlEsc(title) + `</dc:title><upnp:class>object.item.videoItem.movie</upnp:class><res protocolInfo="http-get:*:` + videoMime(name) + `:*">` + xmlEsc(stream) + `</res></item></DIDL-Lite>`
	_ = soapCall(d, "Stop", "")
	if err := soapCall(d, "SetAVTransportURI", "<CurrentURI>"+xmlEsc(stream)+"</CurrentURI><CurrentURIMetaData>"+xmlEsc(didl)+"</CurrentURIMetaData>"); err != nil {
		return err
	}
	if err := soapCall(d, "Play", "<Speed>1</Speed>"); err != nil {
		return err
	}
	if pos > 5 {
		// Телевизору нужно время открыть поток: переход до этого он отвергает.
		go func() {
			for i := 0; i < 8; i++ {
				time.Sleep(3 * time.Second)
				if soapCall(d, "Seek", "<Unit>REL_TIME</Unit><Target>"+hms(pos)+"</Target>") == nil {
					return
				}
			}
		}()
	}
	return nil
}

// ---------- API ----------

// apiDevices: POST — отметка окна интерфейса; GET — куда можно отправить
// (?self=ID исключает себя, ?scan=1 — заново искать телевизоры).
func (c *Comp) apiDevices(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var d uiDevice
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&d); err != nil {
			writeJSONError(w, http.StatusBadRequest, "неразборчивый запрос")
			return
		}
		d.Remote = isRemoteRequest(r)
		noteUIDevice(d)
		jj(w, map[string]any{"ok": true})
		return
	}
	q := r.URL.Query()
	if q.Get("tv") != "0" {
		scanDLNA(q.Get("scan") == "1")
	}
	self := q.Get("self")
	devMu.Lock()
	out := []map[string]any{}
	for id, d := range uiDevs {
		if time.Since(d.Seen) > uiDeviceTTL {
			delete(uiDevs, id)
			continue
		}
		if id == self {
			continue
		}
		out = append(out, map[string]any{"id": d.ID, "name": d.Name, "kind": d.Kind, "type": "app"})
	}
	for _, d := range dlnaDevs {
		out = append(out, map[string]any{"id": d.ID, "name": d.Name, "kind": d.Kind, "type": "dlna"})
	}
	devMu.Unlock()
	jj(w, map[string]any{"devices": out})
}

// apiHandoff отправляет серию на устройство. Позиция берётся свежая из
// отметок демона — плеер на компьютере сообщает её каждые несколько секунд, а
// интерфейс мог прочитать её минуту назад.
func (c *Comp) apiHandoff(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		Target    string  `json:"target"`
		From      string  `json:"from"`
		Hash      string  `json:"hash"`
		Index     int     `json:"index"`
		Pos       float64 `json:"pos"`
		Title     string  `json:"title"`
		StopLocal bool    `json:"stop_local"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in); err != nil || in.Hash == "" || in.Target == "" {
		writeJSONError(w, http.StatusBadRequest, "не указано, что и куда отправить")
		return
	}
	if m, ok := viewedMarks.get(in.Hash, in.Index); ok && !m.Done && m.Pos > 0 {
		in.Pos = m.Pos
	}
	if in.StopLocal {
		sleepMu.Lock()
		var cmds []*exec.Cmd
		for c := range runningPlayers {
			cmds = append(cmds, c)
		}
		sleepMu.Unlock()
		for _, c := range cmds {
			if c.Process != nil {
				_ = c.Process.Kill()
			}
		}
	}
	if strings.HasPrefix(in.Target, "dlna:") {
		devMu.Lock()
		d := dlnaDevs[in.Target]
		devMu.Unlock()
		if d == nil {
			writeJSONError(w, http.StatusNotFound, "телевизор пропал из сети — обновите список")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		errc := make(chan error, 1)
		go func() { errc <- castDLNA(d, in.Hash, in.Index, in.Pos, in.Title) }()
		select {
		case err := <-errc:
			if err != nil {
				writeJSONError(w, http.StatusBadGateway, "телевизор не принял поток: "+err.Error())
				return
			}
		case <-ctx.Done():
			writeJSONError(w, http.StatusGatewayTimeout, "телевизор не ответил")
			return
		}
		jj(w, map[string]any{"ok": true, "pos": in.Pos, "name": d.Name})
		return
	}
	devMu.Lock()
	d := uiDevs[in.Target]
	devMu.Unlock()
	if d == nil || time.Since(d.Seen) > uiDeviceTTL {
		writeJSONError(w, http.StatusNotFound, "устройство не в сети — откройте на нём TorrClient")
		return
	}
	from := ""
	devMu.Lock()
	if f := uiDevs[in.From]; f != nil {
		from = f.Name
	}
	devMu.Unlock()
	events.broadcast("handoff", map[string]any{
		"target": in.Target, "from": from, "hash": in.Hash, "index": in.Index, "pos": in.Pos, "title": in.Title,
	})
	jj(w, map[string]any{"ok": true, "pos": in.Pos, "name": d.Name})
}
