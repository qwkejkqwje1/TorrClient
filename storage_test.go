package main

// Кэш и постоянные данные лежат в разных папках, и обе задаются настройкой.
//
// Разделение не для красоты: кэш постеров и журнал можно положить на диск,
// который очищается при перезагрузке, — потерять их не страшно, они соберутся
// заново. Отметки просмотра и избранное так класть нельзя: «продолжить
// просмотр» и свой список после перезагрузки не восстановить ничем.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// useStorageDirs подменяет конфиг на временный и отдаёт корни кэша и склада.
func useStorageDirs(t *testing.T) (cache, data string) {
	t.Helper()
	saved := cfg.Load()
	cache, data = t.TempDir(), t.TempDir()
	c := defaultConfig()
	c.CacheFolder = cache
	c.DataFolder = data
	cfg.Store(c)
	t.Cleanup(func() { cfg.Store(saved) })
	return cache, data
}

// keepConfigFile возвращает файл настроек на место: обработчики пишут его на
// диск, а прогон не должен оставлять после себя чужие настройки.
func keepConfigFile(t *testing.T) {
	t.Helper()
	path := confPath()
	backup, err := os.ReadFile(path)
	had := err == nil
	t.Cleanup(func() {
		if had {
			os.WriteFile(path, backup, 0o600)
			return
		}
		os.Remove(path)
	})
}

// Путь к файлу кэша берётся из настройки: иначе диск, который очищается при
// перезагрузке, остался бы неиспользованным, а кэш писался бы рядом с exe.
func TestCacheFilesFollowTheSetting(t *testing.T) {
	cache, _ := useStorageDirs(t)
	if got, want := tmdbCachePath(), filepath.Join(cache, "tmdb-cache.json"); got != want {
		t.Errorf("кэш метаданных: %q, ожидался %q", got, want)
	}
	if got, want := logPath(), filepath.Join(cache, "torrclient.log"); got != want {
		t.Errorf("журнал: %q, ожидался %q", got, want)
	}
}

// Отметки просмотра и склад избранного — состояние, а не кэш: они лежат в папке
// постоянных данных и на очищаемый диск не уезжают.
func TestStateFilesFollowTheSetting(t *testing.T) {
	_, data := useStorageDirs(t)
	if got, want := viewedPath(), filepath.Join(data, "viewed.json"); got != want {
		t.Errorf("отметки просмотра: %q, ожидался %q", got, want)
	}
	if got, want := userDataPath(), filepath.Join(data, "userdata.json"); got != want {
		t.Errorf("склад избранного: %q, ожидался %q", got, want)
	}
}

// Пустая настройка означает «рядом с программой». Так выглядят копии, в файле
// которых этих полей ещё нет: обновление не должно уводить их данные в другое
// место — иначе после обновления всё выглядело бы пропавшим.
func TestStorageFallsBackToTheProgramFolder(t *testing.T) {
	saved := cfg.Load()
	c := defaultConfig()
	c.CacheFolder = ""
	c.DataFolder = ""
	cfg.Store(c)
	t.Cleanup(func() { cfg.Store(saved) })

	if got, want := tmdbCachePath(), filepath.Join(exeDir(), "tmdb-cache.json"); got != want {
		t.Errorf("кэш метаданных при пустой настройке: %q, ожидался %q", got, want)
	}
	if got, want := viewedPath(), filepath.Join(exeDir(), "viewed.json"); got != want {
		t.Errorf("отметки просмотра при пустой настройке: %q, ожидался %q", got, want)
	}
	if got, want := logPath(), filepath.Join(exeDir(), "torrclient.log"); got != want {
		t.Errorf("журнал при пустой настройке: %q, ожидался %q", got, want)
	}
}

// Относительный путь считается от каталога программы: иначе он читался бы
// относительно рабочего каталога — то есть куда попало. Заодно проверяется, что
// папка создаётся сразу, а не при первой записи в неё.
func TestApplyStoragePathsResolvesRelativeToTheProgram(t *testing.T) {
	c := defaultConfig()
	c.WatchFolder = t.TempDir()
	c.DownloadFolder = t.TempDir()
	c.CacheFolder = "tc-storage-test-cache"
	c.DataFolder = filepath.Join("tc-storage-test-data")
	applyStoragePaths(c)
	t.Cleanup(func() {
		os.RemoveAll(c.CacheFolder)
		os.RemoveAll(c.DataFolder)
	})

	for _, p := range []string{c.CacheFolder, c.DataFolder} {
		if !filepath.IsAbs(p) {
			t.Errorf("путь остался относительным: %q", p)
		}
		if fi, err := os.Stat(p); err != nil || !fi.IsDir() {
			t.Errorf("папка не создана: %q (%v)", p, err)
		}
	}
}

// Настройки пишутся относительными путями: файл едет вместе с программой, и
// копия, переехавшая на диск с другой буквой, остаётся рабочей. Прежде в файл
// ложились абсолютные пути (`D:\TorrClient\watch`), и переезд ломал папки —
// хотя README обещал, что папки считаются от программы.
func TestConfigIsSavedWithPathsRelativeToTheProgram(t *testing.T) {
	keepConfigFile(t)
	saved := cfg.Load()
	c := defaultConfig()
	cfg.Store(c)
	t.Cleanup(func() { cfg.Store(saved) })

	if err := saveConfigLocked(c); err != nil {
		t.Fatalf("настройки не записаны: %v", err)
	}
	b, err := os.ReadFile(confPath())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("записанные настройки не разбираются: %v (%s)", err, b)
	}
	if got, want := m["watch_folder"], "watch"; got != want {
		t.Errorf("watch_folder в файле: %v, ожидалось %q", got, want)
	}
	if got, want := m["download_folder"], "downloads"; got != want {
		t.Errorf("download_folder в файле: %v, ожидалось %q", got, want)
	}
	for _, key := range []string{"watch_folder", "download_folder", "cache_folder", "data_folder"} {
		if s, ok := m[key].(string); ok && s != "" && filepath.IsAbs(s) {
			t.Errorf("%s записан абсолютным: %q", key, s)
		}
	}

	// Прочитанное назад указывает туда же, куда указывало в памяти: иначе
	// переносимость была бы куплена ценой поломанных путей на этой машине.
	// Разрешение путей — тот же шаг, что делает демон при запуске.
	back := loadConfig()
	applyStoragePaths(back)
	if got, want := back.WatchFolder, filepath.Join(exeDir(), "watch"); got != want {
		t.Errorf("прочитано: %q, ожидалось %q", got, want)
	}
	if got, want := back.DataFolder, exeDir(); got != want {
		t.Errorf("прочитано: %q, ожидалось %q", got, want)
	}
}

// Папка вне каталога программы остаётся абсолютной: намеренно указанный диск
// с данными молча переписывать нельзя — это уводило бы отметки и избранное не
// туда, и выглядело бы как «всё пропало».
func TestConfigKeepsPathsOutsideTheProgramAbsolute(t *testing.T) {
	keepConfigFile(t)
	outside := t.TempDir()
	c := defaultConfig()
	c.DataFolder = outside
	c.WatchFolder = outside

	if err := saveConfigLocked(c); err != nil {
		t.Fatalf("настройки не записаны: %v", err)
	}
	b, err := os.ReadFile(confPath())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("записанные настройки не разбираются: %v (%s)", err, b)
	}
	for _, key := range []string{"data_folder", "watch_folder"} {
		if got, want := m[key], outside; got != want {
			t.Errorf("%s в файле: %v, ожидалось %q", key, got, want)
		}
	}
}

// Смена папки постоянных данных переносит накопленное. Без переноса отметки и
// избранное остались бы в прежней папке, а читались бы из новой — то есть
// пустой, и смена настройки выглядела бы как «всё пропало».
func TestMoveStateFilesCarriesTheStoreOver(t *testing.T) {
	from, to := t.TempDir(), t.TempDir()
	for _, name := range []string{"viewed.json", "userdata.json"} {
		if err := os.WriteFile(filepath.Join(from, name), []byte(`{"х":{}}`), 0o600); err != nil {
			t.Fatalf("подготовка %s: %v", name, err)
		}
	}
	moved := moveStateFiles(from, to, "viewed.json", "userdata.json")
	if len(moved) != 2 {
		t.Fatalf("перенесено файлов: %d (%v), ожидалось 2", len(moved), moved)
	}
	for _, name := range []string{"viewed.json", "userdata.json"} {
		if _, err := os.Stat(filepath.Join(to, name)); err != nil {
			t.Errorf("%s не оказался в новой папке: %v", name, err)
		}
	}
	// Прежние файлы остаются на месте: перенос — это копия, и решать, что
	// старое место больше не нужно, не дело этой функции.
	if _, err := os.Stat(filepath.Join(from, "viewed.json")); err != nil {
		t.Errorf("прежний файл пропал: %v", err)
	}
}

// Своё, уже накопленное в новой папке, чужой копией не затирается: иначе
// случайное указание папки, где уже лежит склад, стёрло бы его.
func TestMoveStateFilesKeepsWhatIsAlreadyThere(t *testing.T) {
	from, to := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(from, "viewed.json"), []byte("старое"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(to, "viewed.json"), []byte("своё"), 0o600); err != nil {
		t.Fatal(err)
	}
	if moved := moveStateFiles(from, to, "viewed.json"); len(moved) != 0 {
		t.Errorf("перенесено поверх своего: %v", moved)
	}
	got, err := os.ReadFile(filepath.Join(to, "viewed.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "своё" {
		t.Errorf("файл в новой папке перезаписан: %q", got)
	}
}

// Файлы состояния разложены по своим папкам: настройки — рядом с программой (в
// них записаны обе папки, и читать их больше неоткуда), отметки и избранное — в
// папке постоянных данных.
func TestStateFilePathSplitsConfigFromTheRest(t *testing.T) {
	_, data := useStorageDirs(t)
	if got, want := stateFilePath("torrclient.json"), confPath(); got != want {
		t.Errorf("настройки: %q, ожидался %q", got, want)
	}
	if got, want := stateFilePath("viewed.json"), filepath.Join(data, "viewed.json"); got != want {
		t.Errorf("отметки просмотра: %q, ожидался %q", got, want)
	}
	if got, want := stateFilePath("userdata.json"), filepath.Join(data, "userdata.json"); got != want {
		t.Errorf("избранное: %q, ожидался %q", got, want)
	}
}

// Смена папок через настройки: поле доходит из запроса до конфига, а склад
// переезжает. Проверяется через обработчик, потому что здесь важен весь путь —
// запрос, сохранение, перенос, — а не отдельная функция.
func TestDirsActionStoresStorageFoldersAndMovesTheStore(t *testing.T) {
	keepConfigFile(t)
	saved := cfg.Load()
	oldData := t.TempDir()
	c := defaultConfig()
	c.WatchFolder = t.TempDir()
	c.DownloadFolder = t.TempDir()
	c.CacheFolder = t.TempDir()
	c.DataFolder = oldData
	cfg.Store(c)
	t.Cleanup(func() { cfg.Store(saved) })

	if err := os.WriteFile(filepath.Join(oldData, "viewed.json"), []byte(`{"х":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	newCache, newData := t.TempDir(), t.TempDir()
	body, err := json.Marshal(map[string]string{
		"action":       "dirs",
		"cache_folder": newCache,
		"data_folder":  newData,
	})
	if err != nil {
		t.Fatal(err)
	}

	comp := &Comp{}
	rr := httptest.NewRecorder()
	comp.apiProfiles(rr, httptest.NewRequest(http.MethodPost, "/api/profiles", bytes.NewReader(body)))
	if rr.Code != http.StatusOK {
		t.Fatalf("код %d, ожидался 200: %s", rr.Code, rr.Body.String())
	}
	if got := curCfg().CacheFolder; got != newCache {
		t.Errorf("папка кэша в конфиге: %q, ожидалась %q", got, newCache)
	}
	if got := curCfg().DataFolder; got != newData {
		t.Errorf("папка постоянных данных в конфиге: %q, ожидалась %q", got, newData)
	}
	if _, err := os.Stat(filepath.Join(newData, "viewed.json")); err != nil {
		t.Errorf("отметки просмотра не переехали: %v", err)
	}
	// Перенос называется в ответе: интерфейс по нему говорит, что именно
	// переехало, — иначе перенос выглядел бы как пропажа из прежнего места.
	var resp struct {
		Moved []string `json:"moved"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("ответ не разобран: %v", err)
	}
	if len(resp.Moved) != 1 || resp.Moved[0] != "viewed.json" {
		t.Errorf("в ответе о переносе: %v, ожидалось [viewed.json]", resp.Moved)
	}
	// Настройки после смены папок остаются читаемыми: конфиг записан на диск.
	if _, err := os.Stat(confPath()); err != nil {
		t.Errorf("конфиг не записан: %v", err)
	}
}

// Архив собирается из своих папок: настройки — от программы, отметки и
// избранное — из папки постоянных данных. Иначе после разнесения папок архив
// стал бы «пустым состоянием»: скачался бы, а отметок в нём нет.
func TestBackupTakesStateFilesFromTheirFolders(t *testing.T) {
	keepConfigFile(t)
	_, data := useStorageDirs(t)
	if err := os.WriteFile(confPath(), []byte(`{"active_profile_id":"local"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "viewed.json"), []byte(`{"х":{"1":{"pos":5}}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	comp := &Comp{}
	rr := httptest.NewRecorder()
	comp.apiBackup(rr, httptest.NewRequest(http.MethodGet, "/api/backup", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("код %d, ожидался 200: %s", rr.Code, rr.Body.String())
	}

	zr, err := zip.NewReader(bytes.NewReader(rr.Body.Bytes()), int64(rr.Body.Len()))
	if err != nil {
		t.Fatalf("ответ не разобран как архив: %v", err)
	}
	got := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("файл %s в архиве не открылся: %v", f.Name, err)
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("файл %s в архиве не прочитан: %v", f.Name, err)
		}
		got[f.Name] = string(b)
	}
	if _, ok := got["torrclient.json"]; !ok {
		t.Error("настройки в архив не попали")
	}
	if !strings.Contains(got["viewed.json"], `"pos":5`) {
		t.Errorf("отметки просмотра в архиве: %q", got["viewed.json"])
	}
}

// Возврат архива раскладывает файлы по папкам из возвращённых настроек: архив
// может прийти с другой машины, где папка постоянных данных своя. Положив
// отметки по прежнему адресу, демон сказал бы «восстановлено», а читал бы их из
// новой папки — то есть пустой. Проверка нарочно кладёт в архив отметки раньше
// настроек: порядок файлов в архиве задаёт не этот код.
func TestRestorePutsStateFilesWhereTheConfigPoints(t *testing.T) {
	keepConfigFile(t)
	_, oldData := useStorageDirs(t)
	if err := os.WriteFile(filepath.Join(oldData, "viewed.json"), []byte(`{"старое":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	newData, newCache := t.TempDir(), t.TempDir()
	settings, err := json.Marshal(map[string]string{
		"active_profile_id": "local",
		"watch_folder":      t.TempDir(),
		"download_folder":   t.TempDir(),
		"cache_folder":      newCache,
		"data_folder":       newData,
	})
	if err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	// Отметка в архиве — свежая: у записи без времени правки сторож обрезки
	// выбросил бы её сразу после чтения, и проверка читала бы пустой файл,
	// ничего не доказывая.
	fresh := fmt.Sprintf(`{"новое":{"1":{"pos":7,"updated":%d}}}`, time.Now().Unix())
	for _, f := range []struct{ name, body string }{
		{"viewed.json", fresh},
		{"torrclient.json", string(settings)},
	} {
		fw, err := zw.Create(f.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write([]byte(f.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	comp := &Comp{}
	rr := httptest.NewRecorder()
	comp.apiRestore(rr, httptest.NewRequest(http.MethodPost, "/api/restore", bytes.NewReader(buf.Bytes())))
	if rr.Code != http.StatusOK {
		t.Fatalf("код %d, ожидался 200: %s", rr.Code, rr.Body.String())
	}

	restored, err := os.ReadFile(filepath.Join(newData, "viewed.json"))
	if err != nil {
		t.Fatalf("отметки не попали в папку из настроек: %v", err)
	}
	if !strings.Contains(string(restored), "новое") {
		t.Errorf("отметки в новой папке: %q", restored)
	}
	if b, err := os.ReadFile(filepath.Join(oldData, "viewed.json")); err == nil && strings.Contains(string(b), "новое") {
		t.Error("отметки легли в прежнюю папку, откуда их уже не читают")
	}
	if got := curCfg().DataFolder; got != newData {
		t.Errorf("папка постоянных данных после возврата архива: %q, ожидалась %q", got, newData)
	}
}
