package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestNewerVer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"1.10.0", "1.9.0", true},
		{"v1.10.1", "1.10.0", true},
		{"1.10.0", "1.10.0-dev", false},
		{"1.9.9", "1.10.0", false},
		{"2.0", "1.99.99", true},
		{"мусор", "1.0.0", false},
	}
	for _, c := range cases {
		if got := newerVer(c.a, c.b); got != c.want {
			t.Errorf("newerVer(%q,%q)=%v", c.a, c.b, got)
		}
	}
}

func TestSafeName(t *testing.T) {
	for _, n := range []string{"../x.exe", "sub/x", "torrclient.json", "", "a..b"} {
		if _, ok := safeName(n); ok {
			t.Errorf("%q пропущен", n)
		}
	}
	if n, ok := safeName("./torrclient.exe"); !ok || n != "torrclient.exe" {
		t.Errorf("torrclient.exe: %q %v", n, ok)
	}
}

func TestTrustedDownload(t *testing.T) {
	if !trustedDownload("https://github.com/a/b/releases/download/v1/x.zip") ||
		trustedDownload("http://github.com/x") || trustedDownload("https://evil.example/x") {
		t.Fatal("проверка адреса загрузки")
	}
}

// Полный путь установки: релиз → проверка суммы → замена файла с .old.
func TestUpdateInstall(t *testing.T) {
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	for name, body := range map[string]string{"prog.bin": "NEW", "VERSION": "9.9.9", "../evil": "x", "torrclient.json": "{}"} {
		f, _ := zw.Create(name)
		f.Write([]byte(body))
	}
	zw.Close()
	ext := ".tar.gz"
	if runtime.GOOS == "windows" {
		ext = ".zip"
	}
	archName := "TorrClient-9.9.9-" + runtime.GOOS + "-" + runtime.GOARCH + ext
	arch := zb.Bytes()
	if ext == ".tar.gz" {
		arch = tarGz(t, map[string]string{"prog.bin": "NEW", "VERSION": "9.9.9", "../evil": "x"})
	}
	sum := sha256.Sum256(arch)
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			json.NewEncoder(w).Encode(relInfo{Tag: "v9.9.9", Assets: []relAsset{
				{Name: archName, URL: srv.URL + "/a"}, {Name: "SHA256SUMS.txt", URL: srv.URL + "/s"}}})
		case "/a":
			w.Write(arch)
		case "/s":
			w.Write([]byte(hex.EncodeToString(sum[:]) + "  " + archName + "\n"))
		}
	}))
	defer srv.Close()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "prog.bin"), []byte("OLD"), 0o755)
	oa, od, ot := updateAPI, updateDir, trustURL
	t.Cleanup(func() { updateAPI, updateDir, trustURL = oa, od, ot; upd = &updater{} })
	updateAPI, updateDir, trustURL = srv.URL+"/latest", func() string { return dir }, func(string) bool { return true }
	upd = &updater{}
	upd.check(true)
	if st := upd.status(); st["newer"] != true {
		t.Fatalf("новая версия не замечена: %+v", st)
	}
	restarted := make(chan bool, 1)
	upd.install(func() { restarted <- true })
	if st := upd.status(); st["state"] != "done" {
		t.Fatalf("установка: %+v", st)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "prog.bin")); string(b) != "NEW" {
		t.Fatalf("файл не заменён: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "prog.bin.old")); string(b) != "OLD" {
		t.Fatalf("старый файл не сохранён: %q", b)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "evil")); err == nil {
		t.Fatal("архив вышел за пределы папки")
	}
	if _, err := os.Stat(filepath.Join(dir, "torrclient.json")); err == nil {
		t.Fatal("архив затёр настройки")
	}
	<-restarted
	cleanupOld(dir)
	if _, err := os.Stat(filepath.Join(dir, "prog.bin.old")); err == nil {
		t.Fatal(".old не убран")
	}

	// Подменённый архив не устанавливается.
	arch = append([]byte{}, arch...)
	arch[len(arch)/2] ^= 0xff
	upd.install(nil)
	if st := upd.status(); st["state"] != "failed" {
		t.Fatalf("повреждённый архив установлен: %+v", st)
	}
}

func tarGz(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	for n, body := range files {
		tw.WriteHeader(&tar.Header{Name: n, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	return b.Bytes()
}
