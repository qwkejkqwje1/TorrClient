package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEtagMatchesStage1(t *testing.T) {
	cases := []struct {
		header string
		want   bool
	}{
		{`"abc"`, true},
		{`W/"abc"`, true},
		{`"x", "abc"`, true},
		{`*`, true},
		{`"other"`, false},
		{``, false},
	}
	for _, c := range cases {
		if got := etagMatches(c.header, `"abc"`); got != c.want {
			t.Errorf("etagMatches(%q) = %v, ожидалось %v", c.header, got, c.want)
		}
	}
}

func TestItoaLenStage1(t *testing.T) {
	for _, n := range []int{0, 1, 9, 10, 255, 262144, 1234567890} {
		if got, want := itoaLen(n), strings.TrimSpace(strings.Join([]string{itoaRef(n)}, "")); got != want {
			t.Errorf("itoaLen(%d) = %q, ожидалось %q", n, got, want)
		}
	}
}

func itoaRef(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func TestCopyStreamStage1(t *testing.T) {
	src := make([]byte, 3<<20+17)
	for i := range src {
		src[i] = byte(i * 7)
	}
	var dst bytes.Buffer
	n, err := copyStream(&dst, bytes.NewReader(src), nil)
	if err != nil {
		t.Fatal(err)
	}
	if n != int64(len(src)) || !bytes.Equal(dst.Bytes(), src) {
		t.Fatalf("поток искажён: скопировано %d из %d", n, len(src))
	}
}

func TestHandleRootETagAndGzipStage1(t *testing.T) {
	c := &Comp{}
	meta, ok := webAssetMeta["app.js"]
	if !ok || meta.etag == "" {
		t.Skip("app.js не вшит в эту сборку")
	}

	// Тот же ETag — 304 без тела.
	req := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	req.Header.Set("If-None-Match", meta.etag)
	rec := httptest.NewRecorder()
	c.handleRoot(rec, req)
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Fatalf("ожидался 304 без тела, получено %d и %d байт", rec.Code, rec.Body.Len())
	}

	// Клиент понимает gzip — тело сжато и распаковывается в исходное.
	req = httptest.NewRequest(http.MethodGet, "/app.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec = httptest.NewRecorder()
	c.handleRoot(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("ожидался 200, получено %d", rec.Code)
	}
	if len(meta.gz) > 0 {
		if rec.Header().Get("Content-Encoding") != "gzip" {
			t.Fatal("ожидался Content-Encoding: gzip")
		}
		zr, err := gzip.NewReader(rec.Body)
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(zr)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, webAssets["app.js"]) {
			t.Fatal("распакованное тело не совпадает с app.js")
		}
	}

	// Без Accept-Encoding — исходное тело без сжатия.
	req = httptest.NewRequest(http.MethodGet, "/app.js", nil)
	rec = httptest.NewRecorder()
	c.handleRoot(rec, req)
	if rec.Header().Get("Content-Encoding") != "" || !bytes.Equal(rec.Body.Bytes(), webAssets["app.js"]) {
		t.Fatal("без gzip тело должно совпадать с app.js байт в байт")
	}
}
