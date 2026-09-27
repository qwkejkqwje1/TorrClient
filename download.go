package main

// Закачки на диск: менеджер задач, работник и срок жизни записей.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ---------- download manager ----------

type DLJob struct {
	ID       string `json:"id"`
	Hash     string `json:"hash"`
	Index    string `json:"index"`
	Name     string `json:"name"`
	FileName string `json:"file_name"`
	Total    int64  `json:"total"`
	Done     int64  `json:"done"`
	Status   string `json:"status"`
	Path     string `json:"path"`
	Error    string `json:"error,omitempty"`
	Start    string `json:"start"`

	cancel chan struct{} `json:"-"`
	// ended — признак, что работник вышел: по нему cancel закрывается один раз.
	ended bool
	// endedAt — когда задача стала терминальной. По нему авто-очистка решает,
	// пора ли убрать запись из списка. В JSON не попадает: интерфейсу это
	// внутреннее время не нужно.
	endedAt time.Time
}

// isTerminal сообщает, завершён ли статус — дальше работник его не меняет.
func (j *DLJob) isTerminal() bool {
	switch j.Status {
	case "done", "error", "cancelled":
		return true
	}
	return false
}

type DLManager struct {
	mu     sync.Mutex
	folder string
	jobs   map[string]*DLJob
	// lastNotify — время последнего события о прогрессе (UnixNano). Нужно,
	// чтобы поток чтения не сыпал событиями в ленту на каждый кусок файла.
	lastNotify atomic.Int64
}

// downloadStreamClient — клиент записи раздачи на диск. Таймаута нет: большой
// файл может качаться долго. Транспорт общий: соединения с сервером
// переиспользуются между задачами. Висеть вечно клиенту не даст сторож в run.
var downloadStreamClient = &http.Client{}

// dlStallTimeout — сколько сохранение может сидеть без единого байта, прежде
// чем быть прерванным ошибкой. Зависший поток и медленный источник различимы:
// медленный отдаёт хотя бы что-то, зависший — ничего.
const dlStallTimeout = 60 * time.Second

func NewDLManager(folder string) *DLManager {
	return &DLManager{folder: folder, jobs: map[string]*DLJob{}}
}

func (d *DLManager) SetFolder(f string) {
	d.mu.Lock()
	d.folder = f
	d.mu.Unlock()
}

// list отдаёт копии задач: статусы обновляются из горутины-работника, и
// сериализация копии не соревнуется с записью в оригинал.
func (d *DLManager) list() []*DLJob {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := []*DLJob{}
	for _, j := range d.jobs {
		cp := *j
		cp.cancel = nil
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j2 int) bool { return out[i].Start > out[j2].Start })
	return out
}

// cancel останавливает задачу, если работник ещё бежит.
func (d *DLManager) cancel(id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	j, ok := d.jobs[id]
	if !ok || j.ended || j.cancel == nil {
		return false
	}
	close(j.cancel)
	return true
}

// clean выбрасывает из памяти завершённые задачи: без этого список рос вечно.
func (d *DLManager) clean() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := 0
	for id, j := range d.jobs {
		if j.isTerminal() {
			delete(d.jobs, id)
			n++
		}
	}
	return n
}

func (c *Comp) apiDownload(w http.ResponseWriter, r *http.Request) {
	// Список читается GET'ом; всё, что меняет состояние, принимается только
	// POST'ом: GET-адрес дергается и картинкой с чужой страницы, а запуск и
	// отмена закачки состояние меняют.
	if r.Method == http.MethodGet {
		if r.URL.Query().Get("action") == "list" {
			jj(w, map[string]any{"jobs": c.dl.list(), "folder": curCfg().DownloadFolder})
			return
		}
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	switch r.URL.Query().Get("action") {
	case "start":
		q := r.URL.Query()
		var fileName string
		switch {
		case sanitizeName(q.Get("file")) != "":
			fileName = sanitizeName(q.Get("file"))
		case sanitizeName(q.Get("name")) != "":
			fileName = sanitizeName(q.Get("name")) + ".bin"
		default:
			fileName = fmt.Sprintf("download-%d.bin", time.Now().Unix())
		}
		job := &DLJob{
			ID:       fmt.Sprintf("%d", time.Now().UnixNano()),
			Hash:     q.Get("hash"),
			Index:    q.Get("index"),
			Name:     q.Get("name"),
			FileName: fileName,
			Total:    atoi64(q.Get("size")),
			Status:   "starting",
			Path:     uniquePath(curCfg().DownloadFolder, fileName),
			Start:    time.Now().Format("15:04:05"),
			cancel:   make(chan struct{}),
		}
		c.dl.mu.Lock()
		c.dl.jobs[job.ID] = job
		c.dl.mu.Unlock()
		go c.dl.run(job, curCfg().active())
		c.dl.notifyDownloadsNow()
		jj(w, map[string]any{"ok": true, "id": job.ID})
		return
	case "cancel":
		jj(w, map[string]any{"ok": c.dl.cancel(r.URL.Query().Get("id"))})
		return
	case "clean":
		jj(w, map[string]any{"ok": true, "removed": c.dl.clean()})
		return
	}
	http.NotFound(w, r)
}

func sanitizeName(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	s = strings.NewReplacer(
		"/", "_", "\\", "_", ":", "_", "*", "_", "?", "_",
		"\"", "_", "<", "_", ">", "_", "|", "_",
	).Replace(s)
	// Имена "." и ".." уводят filepath.Join вверх по дереву, а хвостовые точка
	// и пробелы Windows не принимает вовсе.
	s = strings.TrimRight(s, ". ")
	if s == "" || s == "." || s == ".." {
		return ""
	}
	// Зарезервированные имена устройств Windows с ними конфликтуют.
	base := s
	if i := strings.IndexByte(base, '.'); i >= 0 {
		base = base[:i]
	}
	switch strings.ToUpper(base) {
	case "CON", "PRN", "AUX", "NUL",
		"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return ""
	}
	// Усечение сохраняет начало имени и расширение, а не случайный хвост.
	if len(s) > 180 {
		ext := ""
		if i := strings.LastIndexByte(s, '.'); i > 0 && len(s)-i <= 12 {
			ext = s[i:]
			s = s[:i]
		}
		if len(s) > 180-len(ext) {
			s = s[:180-len(ext)]
		}
		s += ext
	}
	return s
}

func atoi64(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

// uniquePath подбирает имя файла, которого ещё нет: повторное скачивание не
// затирает готовый файл, а ложится рядом под суффиксом _1, _2, …
func uniquePath(dir, name string) string {
	cand := filepath.Join(dir, name)
	if !pathExists(cand) {
		return cand
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 1; i < 10000; i++ {
		cand = filepath.Join(dir, fmt.Sprintf("%s_%d%s", base, i, ext))
		if !pathExists(cand) {
			return cand
		}
	}
	return filepath.Join(dir, fmt.Sprintf("%s_%d%s", base, time.Now().UnixNano(), ext))
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (d *DLManager) run(job *DLJob, prof *Profile) {
	streamURL := strings.TrimRight(prof.URL, "/") + "/play/" + job.Hash + "/" + job.Index
	req, _ := http.NewRequest("GET", streamURL, nil)
	if prof.User != "" {
		req.SetBasicAuth(prof.User, prof.Pass)
	}
	resp, err := downloadStreamClient.Do(req)
	if err != nil {
		d.setStatus(job, "error", err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 206 {
		d.setStatus(job, "error", "HTTP status "+strconv.Itoa(resp.StatusCode))
		return
	}
	out, err := os.Create(job.Path)
	if err != nil {
		d.setStatus(job, "error", err.Error())
		return
	}
	defer out.Close()
	d.setStatus(job, "download", "")
	buf := make([]byte, 256*1024)
	var n int
	var rerr error

	// Сторож потока: если данные не идут dlStallTimeout подряд, загрузка
	// прерывается ошибкой, а не висит вечно. Тело закрывается, чтобы
	// разблокировать чтение, засевшее в сети.
	var lastProgress atomic.Int64
	lastProgress.Store(time.Now().UnixNano())
	stallDone := make(chan struct{})
	defer close(stallDone)
	var stalled atomic.Bool
	stallTimer := time.NewTimer(dlStallTimeout)
	go func() {
		defer stallTimer.Stop()
		for {
			select {
			case <-stallDone:
				return
			case <-stallTimer.C:
			}
			if time.Since(time.Unix(0, lastProgress.Load())) >= dlStallTimeout {
				stalled.Store(true)
				_ = out.Close()
				_ = resp.Body.Close()
				return
			}
			stallTimer.Reset(dlStallTimeout)
		}
	}()

	for {
		select {
		case <-job.cancel:
			out.Close()
			os.Remove(job.Path)
			d.setStatus(job, "cancelled", "")
			return
		default:
		}
		n, rerr = resp.Body.Read(buf)
		if n > 0 {
			lastProgress.Store(time.Now().UnixNano())
			if _, werr := out.Write(buf[:n]); werr != nil {
				d.setStatus(job, "error", werr.Error())
				return
			}
			d.mu.Lock()
			job.Done += int64(n)
			if job.Total == 0 {
				job.Total = resp.ContentLength
			}
			d.mu.Unlock()
			// Прогресс сообщается сразу, без ожидания следующего опроса: иначе
			// полоса подгрузки дёргалась бы раз в три секунды.
			d.notifyDownloads()
		}
		if rerr != nil {
			break
		}
	}
	if rerr != nil {
		_ = out.Close()
	}
	if rerr == io.EOF {
		d.setStatus(job, "done", "")
		return
	}
	if stalled.Load() {
		os.Remove(job.Path)
		d.setStatus(job, "error", "загрузка прервана: поток данных остановился на "+dlStallTimeout.String())
		return
	}
	d.setStatus(job, "error", rerr.Error())
}

func (d *DLManager) setStatus(job *DLJob, status, errText string) {
	d.mu.Lock()
	// Отменённая задача из канала остаётся отменённой: сетевой обрыв при её
	// прекращении не должен затирать отметку.
	if job.Status != "cancelled" && job.Status != "done" {
		job.Status = status
		job.Error = errText
	}
	job.ended = true
	if job.endedAt.IsZero() {
		job.endedAt = time.Now()
	}
	d.mu.Unlock()
	// Смена состояния уходит в ленту сразу: порог прогресса её не задерживает.
	d.notifyDownloadsNow()
}

// dlJobTTL — сколько завершённая задача остаётся в списке закачек. Без срока
// список растёт вечно: каждая закачка оставляет в нём запись навсегда, и окно
// закачек со временем превращается в свалку.
const dlJobTTL = 24 * time.Hour

// cleanOlder выбрасывает завершённые задачи, окончившиеся раньше cutoff.
func (d *DLManager) cleanOlder(cutoff time.Time) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := 0
	for id, j := range d.jobs {
		if j.isTerminal() && !j.endedAt.IsZero() && j.endedAt.Before(cutoff) {
			delete(d.jobs, id)
			n++
		}
	}
	return n
}

// janitor раз в час убирает из списка давно завершённые задачи.
func (d *DLManager) janitor() {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for range t.C {
		d.cleanOlder(time.Now().Add(-dlJobTTL))
	}
}

// ---------- protocol registration + cli ----------

type CLIHelper struct {
	cfg *Config
}

func (c *CLIHelper) addMagnet(link string, openUI bool) {
	prof := c.cfg.active()
	body, _ := json.Marshal(map[string]any{"action": "add", "link": link, "save_to_db": true})
	target := strings.TrimRight(prof.URL, "/") + "/torrents"
	req, _ := http.NewRequest("POST", target, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if prof.User != "" {
		req.SetBasicAuth(prof.User, prof.Pass)
	}
	resp, err := uploadClient.Do(req)
	if err != nil {
		fmt.Println("Сервер недоступен:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	if openUI {
		openBrowser(fmt.Sprintf("http://%s:%d?added=1", *flagHost, *flagPort))
	}
}

func (c *CLIHelper) addTorrentFile(path string, openUI bool) {
	prof := c.cfg.active()
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Println("Ошибка чтения файла:", err)
		os.Exit(1)
	}
	target := strings.TrimRight(prof.URL, "/") + "/torrent/upload"
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", filepath.Base(path))
	fw.Write(data)
	mw.WriteField("save", "1")
	mw.Close()
	req, _ := http.NewRequest("POST", target, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if prof.User != "" {
		req.SetBasicAuth(prof.User, prof.Pass)
	}
	resp, err := uploadClient.Do(req)
	if err != nil {
		fmt.Println("Сервер недоступен:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		fmt.Println("Сервер отверг файл:", resp.Status)
		os.Exit(1)
	}
	if openUI {
		openBrowser(fmt.Sprintf("http://%s:%d?added=1", *flagHost, *flagPort))
	}
}
