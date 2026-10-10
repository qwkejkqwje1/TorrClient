package main

// Танцоры раздела «Аудио»: 3D-модели VRM и записи движений (.vrma, .fbx
// Mixamo, .bvh), которые пользователь загрузил сам. Файлы лежат в папке данных
// демона, а не в браузере: так модель одна и та же и в окне программы, и в
// браузере, и на другом устройстве с этим же демоном. В программу модели не
// вшиваются — у персонажей и записей свои авторы и лицензии.

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const dancerMaxBytes = 96 << 20

var dancerNameRe = regexp.MustCompile(`^[\p{L}\p{N} _.()\[\]-]{1,100}$`)

func dancerDir() string { return filepath.Join(dataDir(), "dancers") }

// dancerKind — модель или движение по расширению; "" — файл не подходит.
func dancerKind(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".vrm":
		return "model"
	case ".vrma", ".fbx", ".bvh":
		return "anim"
	}
	return ""
}

// dancerPath — путь к файлу в папке танцоров; имя без каталогов и точек в начале.
func dancerPath(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || name != filepath.Base(name) || strings.HasPrefix(name, ".") || !dancerNameRe.MatchString(name) || dancerKind(name) == "" {
		return "", errors.New("неподходящее имя файла: нужны .vrm, .vrma, .fbx или .bvh")
	}
	return filepath.Join(dancerDir(), name), nil
}

type dancerFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Kind string `json:"kind"`
}

func dancerList() []dancerFile {
	out := []dancerFile{}
	ents, err := os.ReadDir(dancerDir())
	if err != nil {
		return out
	}
	for _, e := range ents {
		if e.IsDir() || dancerKind(e.Name()) == "" {
			continue
		}
		if info, err := e.Info(); err == nil && info.Mode().IsRegular() {
			out = append(out, dancerFile{Name: e.Name(), Size: info.Size(), Kind: dancerKind(e.Name())})
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

func (c *Comp) apiDancer(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/dancer" || r.URL.Path == "/api/dancer/" {
		jj(w, map[string]any{"files": dancerList()})
		return
	}
	if r.URL.Path != "/api/dancer/file" {
		http.NotFound(w, r)
		return
	}
	p, err := dancerPath(r.URL.Query().Get("n"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		f, err := os.Open(p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, "", info.ModTime(), f)
	case http.MethodPost, http.MethodPut:
		if err := os.MkdirAll(dancerDir(), 0o755); err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		tmp, err := os.CreateTemp(dancerDir(), ".up-*")
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		n, cerr := io.Copy(tmp, http.MaxBytesReader(w, r.Body, dancerMaxBytes))
		if err := tmp.Close(); cerr == nil {
			cerr = err
		}
		if cerr == nil && n == 0 {
			cerr = errors.New("пустой файл")
		}
		if cerr != nil {
			os.Remove(tmp.Name())
			writeJSONError(w, http.StatusBadRequest, "не удалось сохранить: "+cerr.Error())
			return
		}
		if err := os.Rename(tmp.Name(), p); err != nil {
			os.Remove(tmp.Name())
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		jj(w, map[string]any{"ok": true, "files": dancerList()})
	case http.MethodDelete:
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		jj(w, map[string]any{"ok": true, "files": dancerList()})
	default:
		writeJSONError(w, http.StatusMethodNotAllowed, "только GET, POST и DELETE")
	}
}
