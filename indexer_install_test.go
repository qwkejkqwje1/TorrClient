package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
)

func TestTorznabAppsStateAndGuards(t *testing.T) {
	c := &Comp{}
	rec := httptest.NewRecorder()
	c.apiTorznabApps(rec, httptest.NewRequest(http.MethodGet, "/api/torznab/apps", nil))
	var st struct {
		Apps []struct {
			Kind, Site string
		} `json:"apps"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil || len(st.Apps) != 2 {
		t.Fatalf("ответ: %s", rec.Body.String())
	}
	for _, a := range st.Apps {
		if !strings.HasPrefix(a.Site, "https://") {
			t.Errorf("%s: нет ссылки на загрузку", a.Kind)
		}
	}
	rec = httptest.NewRecorder()
	c.apiTorznabApps(rec, httptest.NewRequest(http.MethodPut, "/api/torznab/apps", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT: код %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	c.apiTorznabApps(rec, httptest.NewRequest(http.MethodPost, "/api/torznab/apps", strings.NewReader(`{"kind":"nope","action":"install"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("неизвестная программа: код %d", rec.Code)
	}
}

func TestIndexerInstallWithoutWingetExplains(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("на Windows winget может быть — установка не запускается в тесте")
	}
	a, _ := indexerAppByKind("prowlarr")
	msg := startIndexerInstall(a, func(string, ...string) ([]byte, error) {
		t.Fatal("winget не должен вызываться")
		return nil, nil
	})
	if !strings.Contains(msg, "winget не найден") {
		t.Fatalf("сообщение: %q", msg)
	}
}
