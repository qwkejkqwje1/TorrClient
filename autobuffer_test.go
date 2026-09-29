package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPlanBufferGrowsWhenSlower(t *testing.T) {
	fast, slow := planBuffer(200, 0), planBuffer(8, 0)
	if !(slow.CacheSize > fast.CacheSize && slow.PreloadCache > fast.PreloadCache) {
		t.Fatalf("медленному каналу запас должен быть больше: быстро %+v, медленно %+v", fast, slow)
	}
	few := planBuffer(200, 2)
	if few.PreloadCache <= fast.PreloadCache || !strings.Contains(few.Why, "мало сидов") {
		t.Fatalf("мало сидов — предзагрузка должна вырасти: %+v", few)
	}
}

func TestMeasureMbpsCountsBytes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(make([]byte, 2<<20))
	}))
	defer srv.Close()
	m, err := measureMbps(context.Background(), srv.URL, 5*time.Second)
	if err != nil || m <= 0 {
		t.Fatalf("замер: %v %v", m, err)
	}
}

func TestApiAutoBufferWithGivenSpeed(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Comp{}).apiAutoBuffer(rec, httptest.NewRequest(http.MethodPost, "/api/autobuffer", strings.NewReader(`{"mbps":20}`)))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"PreloadCache":40`) {
		t.Fatalf("код %d: %s", rec.Code, rec.Body.String())
	}
}
