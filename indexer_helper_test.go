package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func pageStub(t *testing.T, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestPrivateIPv4AndScanHosts(t *testing.T) {
	for ip, want := range map[string]bool{"192.168.1.5": true, "10.0.0.2": true, "172.20.1.1": true, "172.32.0.1": false, "8.8.8.8": false} {
		if got := privateIPv4(net.ParseIP(ip)); got != want {
			t.Errorf("%s: %v, ожидалось %v", ip, got, want)
		}
	}
	hosts := scanHosts([]net.IP{net.ParseIP("192.168.1.5").To4(), net.ParseIP("192.168.1.9").To4()})
	if len(hosts) != 255 || hosts[0] != "127.0.0.1" {
		t.Fatalf("адресов %d (ожидалось 255: localhost и 254 соседа без повторов)", len(hosts))
	}
}

func TestProbeIndexer(t *testing.T) {
	for body, want := range map[string]string{
		"<html><title>Jackett</title></html>":         "jackett",
		"<html><title>Prowlarr</title></html>":        "prowlarr",
		"<html><title>Какой-то роутер</title></html>": "",
	} {
		srv := pageStub(t, body)
		if got := probeIndexer(context.Background(), srv.URL); got != want {
			t.Errorf("%q: %q, ожидалось %q", body, got, want)
		}
	}
}

func TestScanIndexersFindsService(t *testing.T) {
	srv := pageStub(t, "Jackett")
	port, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	found := scanIndexers(context.Background(), []string{"127.0.0.1"}, []int{port, 1}, func(string) bool { return true })
	if len(found) != 1 || found[0].Kind != "jackett" || found[0].Port != port || !found[0].Local {
		t.Fatalf("найдено: %+v", found)
	}
}

func TestLocalIndexerKey(t *testing.T) {
	dir := t.TempDir()
	jp := filepath.Join(dir, "ServerConfig.json")
	pp := filepath.Join(dir, "config.xml")
	os.WriteFile(jp, []byte(`{"Port":9117,"APIKey": "abc123jackett"}`), 0o600)
	os.WriteFile(pp, []byte("<Config>\n  <ApiKey>prowkey456</ApiKey>\n</Config>"), 0o600)
	old := indexerKeyPaths
	indexerKeyPaths = func(kind string) []string {
		if kind == "prowlarr" {
			return []string{filepath.Join(dir, "нет.xml"), pp}
		}
		return []string{jp}
	}
	t.Cleanup(func() { indexerKeyPaths = old })
	if k := localIndexerKey("jackett"); k != "abc123jackett" {
		t.Errorf("ключ Jackett: %q", k)
	}
	if k := localIndexerKey("prowlarr"); k != "prowkey456" {
		t.Errorf("ключ Prowlarr: %q", k)
	}
}

func discoverAdd(t *testing.T, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	(&Comp{}).apiTorznabDiscoverAdd(rec, httptest.NewRequest("POST", "/api/torznab/discover/add", strings.NewReader(body)))
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestDiscoverAddJackett(t *testing.T) {
	setCfg(defaultConfig())
	t.Cleanup(func() { setCfg(defaultConfig()) })
	// Чужой адрес без ключа: ключ брать неоткуда.
	if code, _ := discoverAdd(t, `{"kind":"jackett","base":"http://192.0.2.10:9117"}`); code != http.StatusBadRequest {
		t.Fatalf("без ключа ожидали 400, получили %d", code)
	}
	code, out := discoverAdd(t, `{"kind":"jackett","base":"http://192.0.2.10:9117/UI","api_key":"KEY123456"}`)
	if code != http.StatusOK {
		t.Fatalf("код %d: %v", code, out)
	}
	src := curCfg().TorznabSources
	if len(src) != 1 || src[0].APIKey != "KEY123456" || !strings.HasSuffix(src[0].URL, "/api/v2.0/indexers/all/results/torznab/api") ||
		!strings.Contains(src[0].URL, "192.0.2.10:9117") {
		t.Fatalf("источник добавлен неверно: %+v", src)
	}
	// Повтор не плодит дубль.
	discoverAdd(t, `{"kind":"jackett","base":"http://192.0.2.10:9117","api_key":"NEWKEY9999"}`)
	src = curCfg().TorznabSources
	if len(src) != 1 || src[0].APIKey != "NEWKEY9999" {
		t.Fatalf("повторное добавление должно обновлять, а не дублировать: %+v", src)
	}
	if code, _ := discoverAdd(t, `{"kind":"jackett","base":"ftp://x"}`); code != http.StatusBadRequest {
		t.Errorf("неверная схема: %d", code)
	}
}

func TestDiscoverAddProwlarr(t *testing.T) {
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("X-Api-Key")
		if r.URL.Path != "/api/v1/indexer" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`[{"id":3,"name":"RuTracker","enable":true,"protocol":"torrent"},
			{"id":4,"name":"Выключенный","enable":false,"protocol":"torrent"},
			{"id":5,"name":"Usenet","enable":true,"protocol":"usenet"}]`))
	}))
	t.Cleanup(srv.Close)
	setCfg(defaultConfig())
	t.Cleanup(func() { setCfg(defaultConfig()) })
	code, out := discoverAdd(t, `{"kind":"prowlarr","base":"`+srv.URL+`","api_key":"PKEY123456"}`)
	if code != http.StatusOK || out["added"].(float64) != 1 {
		t.Fatalf("код %d: %v", code, out)
	}
	src := curCfg().TorznabSources
	if gotKey != "PKEY123456" || len(src) != 1 || src[0].Name != "Prowlarr: RuTracker" || !strings.HasSuffix(src[0].URL, "/3/api") {
		t.Fatalf("Prowlarr: ключ=%q источники=%+v", gotKey, src)
	}
}

func TestDiscoverEndpointsRequirePost(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Comp{}).apiTorznabDiscover(rec, httptest.NewRequest("GET", "/api/torznab/discover", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("обход сети по GET должен отвергаться: %d", rec.Code)
	}
}
