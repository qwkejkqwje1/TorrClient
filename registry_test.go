package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestApiRegStatusAndPostOnly(t *testing.T) {
	c := &Comp{}
	rec := httptest.NewRecorder()
	c.apiReg(rec, httptest.NewRequest(http.MethodGet, "/api/reg", nil))
	var st map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("ответ не JSON: %s", rec.Body.String())
	}
	for _, k := range []string{"magnet", "torrent", "supported"} {
		if _, ok := st[k]; !ok {
			t.Errorf("в ответе нет поля %q: %v", k, st)
		}
	}
	for _, a := range []string{"install", "uninstall"} {
		rec := httptest.NewRecorder()
		c.apiReg(rec, httptest.NewRequest(http.MethodGet, "/api/reg?action="+a, nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("GET action=%s: код %d, ожидался 405 — чужая страница не должна менять систему", a, rec.Code)
		}
	}
}

func TestApiAutostartRejectsOtherMethods(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Comp{}).apiAutostart(rec, httptest.NewRequest(http.MethodDelete, "/api/autostart", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE: код %d, ожидался 405", rec.Code)
	}
}
