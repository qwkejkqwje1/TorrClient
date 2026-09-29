package main

// Наблюдение за папкой и добавление найденных .torrent.

import (
	"bytes"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ---------- watch folder ----------

type Watcher struct {
	mu      sync.Mutex
	folder  string
	op      func(path string)
	onAdd   func(path string)
	seen    map[string]bool
	log     []string
	started time.Time
	// lastErr — последняя жалоба на папку. Нужна, чтобы одна и та же ошибка
	// попадала в журнал один раз, а не каждые две секунды.
	lastErr string
}

func NewWatcher(folder string, onAdd func(path string)) *Watcher {
	return &Watcher{folder: folder, onAdd: onAdd, seen: map[string]bool{}, started: time.Now()}
}

// LastError отдаёт последнюю жалобу на папку наблюдения под замком.
//
// Отдельным методом, потому что lastErr читают теперь не только внутри
// наблюдателя: отчёт о состоянии спрашивает его снаружи, и чтение поля мимо
// замка ловило бы гонку с noteFolderError.
func (w *Watcher) LastError() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.lastErr
}

func (w *Watcher) SetFolder(f string) {
	w.mu.Lock()
	w.folder = f
	w.mu.Unlock()
}

// noteFolderError сообщает о недоступной папке один раз на ошибку. Опрос идёт
// каждые две секунды, и без этой памяти журнал наблюдения превратился бы в одну
// и ту же строку — настоящие находки в нём потерялись бы.
func (w *Watcher) noteFolderError(folder string, err error) {
	msg := err.Error()
	w.mu.Lock()
	fresh := w.lastErr != msg
	w.lastErr = msg
	w.mu.Unlock()
	if fresh {
		w.addLog("Папка недоступна: " + folder + " — " + msg)
	}
}

// noteFolderOK снимает прежнюю жалобу, когда папка снова читается: иначе
// вылеченная папка выглядела бы сломанной до перезапуска.
func (w *Watcher) noteFolderOK() {
	w.mu.Lock()
	was := w.lastErr
	w.lastErr = ""
	w.mu.Unlock()
	if was != "" {
		w.addLog("Папка снова доступна")
	}
}

func (w *Watcher) Start() {
	next := time.Now()
	go func() {
		for {
			w.mu.Lock()
			f := w.folder
			w.mu.Unlock()
			if f != "" {
				entries, err := os.ReadDir(f)
				if err != nil {
					// Прежде ошибка чтения отбрасывалась целиком, и наблюдатель
					// молчал ровно одинаково при пустой папке и при папке,
					// которой нет. Теперь причина видна в журнале наблюдения —
					// там, где её и ищут: «торренты не добавляются».
					w.noteFolderError(f, err)
				} else {
					w.noteFolderOK()
					now := time.Now()
					torrentSeen := map[string]bool{}
					for _, e := range entries {
						if e.IsDir() {
							continue
						}
						lower := strings.ToLower(e.Name())
						p := filepath.Join(f, e.Name())
						if strings.HasSuffix(lower, ".torrent") {
							torrentSeen[p] = true
							w.mu.Lock()
							done := w.seen[p]
							w.seen[p] = true
							w.mu.Unlock()
							if !done {
								w.addLog("Найден файл: " + e.Name())
								w.onAdd(p)
							}
							continue
						}
						if strings.HasSuffix(lower, ".torrent.ok") {
							// Устаревшие отметки об обработке убираются: они нужны
							// только интерфейсу, а вечно копить мусор незачем.
							if fi, err := e.Info(); err == nil && now.Sub(fi.ModTime()) > 7*24*time.Hour {
								os.Remove(p)
							}
						}
					}
					// Записи о файлах, которых больше нет (обработанных, удалённых
					// вручную), из памяти выбрасываются, иначе она растёт вечно.
					if now.After(next) {
						next = now.Add(60 * time.Second)
						w.mu.Lock()
						for k := range w.seen {
							if _, ok := torrentSeen[k]; !ok && !existsOnDisk(k) {
								delete(w.seen, k)
							}
						}
						w.mu.Unlock()
					}
				}
			}
			time.Sleep(2 * time.Second)
		}
	}()
}

// existsOnDisk отвечает, существует ли файл: переименованный .torrent в виде
// .torrent.ok живёт на диске, но в seen числится под старым путём, и такое
// совпадение отбрасывается проверкой.
func existsOnDisk(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (w *Watcher) addLog(s string) {
	w.mu.Lock()
	w.log = append(w.log, fmt.Sprintf("%s  %s", time.Now().Format("15:04:05"), s))
	if len(w.log) > 200 {
		w.log = w.log[len(w.log)-200:]
	}
	w.mu.Unlock()
}

// snapshotLog отдаёт копию журнала: читатель не должен видеть запись, которая
// ещё дозаписывается.
func (w *Watcher) snapshotLog() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]string, len(w.log))
	copy(out, w.log)
	return out
}

func (c *Comp) apiWatch(w http.ResponseWriter, r *http.Request) {
	jj(w, map[string]any{
		"folder": curCfg().WatchFolder,
		"log":    c.watch.snapshotLog(),
	})
}

// uploadClient — загрузка .torrent на сервер. Срок обязателен: без него
// зависший сервер вешал бы горутину наблюдателя папки навсегда.
var uploadClient = &http.Client{Timeout: 60 * time.Second}

func (c *Comp) addTorrentFromFile(path string, openUI bool) {
	prof := curCfg().active()
	fn := filepath.Base(path)
	data, err := os.ReadFile(path)
	if err != nil {
		c.watch.addLog("Ошибка чтения " + fn + ": " + err.Error())
		return
	}
	target := strings.TrimRight(prof.URL, "/") + "/torrent/upload"
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", fn)
	fw.Write(data)
	mw.WriteField("save", "1")
	mw.Close()
	req, err := http.NewRequest("POST", target, &buf)
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if prof.User != "" {
		req.SetBasicAuth(prof.User, prof.Pass)
	}
	resp, err := uploadClient.Do(req)
	if err != nil {
		c.watch.addLog("Сервер недоступен: " + fn)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		// fallback to old 1.1.x endpoint
		target2 := strings.TrimRight(prof.URL, "/") + "/upload"
		req2, _ := http.NewRequest("POST", target2, bytes.NewReader(buf.Bytes()))
		req2.Header.Set("Content-Type", mw.FormDataContentType())
		if prof.User != "" {
			req2.SetBasicAuth(prof.User, prof.Pass)
		}
		resp2, err2 := uploadClient.Do(req2)
		if err2 != nil {
			c.watch.addLog("Ошибка: " + fn)
			return
		}
		defer resp2.Body.Close()
		if resp2.StatusCode != 200 {
			c.watch.addLog("Сервер отверг файл " + fn + ": " + string(body))
			return
		}
	}
	c.watch.addLog("Добавлен на сервер: " + fn)
	// move file aside
	done := path + ".ok"
	os.Rename(path, done)
	if openUI {
		openBrowser(fmt.Sprintf("http://%s:%d", *flagHost, *flagPort))
	}
}
