package main

// Конфигурация демона: чтение, публикация снимков и запись на диск.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

// ---------- config ----------

type Profile struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	User    string `json:"user,omitempty"`
	Pass    string `json:"pass,omitempty"`
	SSLSkip bool   `json:"ssl_skip,omitempty"`
}

type Player struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	Path  string `json:"path,omitempty"`
	Args  string `json:"args,omitempty"`
	Found bool   `json:"found"`
}

type Config struct {
	Profiles        []*Profile `json:"profiles"`
	ActiveProfileID string     `json:"active_profile_id"`
	Players         []*Player  `json:"players"`
	WatchFolder     string     `json:"watch_folder"`
	DownloadFolder  string     `json:"download_folder"`
	// CacheFolder — где лежат одноразовые данные: кэш постеров и оценок
	// (tmdb-cache.json) и журнал (torrclient.log). Потерять их не страшно —
	// кэш соберётся заново, журнал нужен только для разбора свежего сбоя.
	// Поэтому папку можно указать на диск, который очищается при перезагрузке.
	CacheFolder string `json:"cache_folder,omitempty"`
	// DataFolder — где лежат постоянные данные: отметки просмотра и склад
	// избранного с закладками. Их потеря не восполняется ничем, и папка должна
	// быть на постоянном диске.
	DataFolder      string              `json:"data_folder,omitempty"`
	TMDBApiKey      string              `json:"tmdb_api_key,omitempty"`
	TMDBAccessToken string              `json:"tmdb_access_token,omitempty"`
	profileByID     map[string]*Profile `json:"-"`
}

func defaultConfig() *Config {
	return &Config{
		Profiles: []*Profile{
			{ID: "local", Name: "Локальный", URL: "http://127.0.0.1:8090"},
		},
		ActiveProfileID: "local",
		Players:         defaultPlayers(),
		WatchFolder:     filepath.Join(exeDir(), "watch"),
		DownloadFolder:  filepath.Join(exeDir(), "downloads"),
		// По умолчанию и кэш, и постоянные данные лежат рядом с программой:
		// так вёл себя демон до появления этих настроек, и переносить данные
		// уже работающей копии при обновлении не за что.
		CacheFolder: exeDir(),
		DataFolder:  exeDir(),
	}
}

func loadConfig() *Config {
	cfg := defaultConfig()
	b, err := os.ReadFile(confPath())
	if err != nil {
		return cfg
	}
	var c Config
	if json.Unmarshal(b, &c) == nil {
		if len(c.Profiles) > 0 {
			cfg.Profiles = c.Profiles
		}
		if c.ActiveProfileID != "" {
			cfg.ActiveProfileID = c.ActiveProfileID
		}
		if len(c.Players) > 0 {
			cfg.Players = c.Players
		}
		if c.WatchFolder != "" {
			cfg.WatchFolder = c.WatchFolder
		}
		if c.DownloadFolder != "" {
			cfg.DownloadFolder = c.DownloadFolder
		}
		if c.CacheFolder != "" {
			cfg.CacheFolder = c.CacheFolder
		}
		if c.DataFolder != "" {
			cfg.DataFolder = c.DataFolder
		}
		if c.TMDBApiKey != "" {
			cfg.TMDBApiKey = c.TMDBApiKey
		}
		if c.TMDBAccessToken != "" {
			cfg.TMDBAccessToken = c.TMDBAccessToken
		}
	}
	if cfg.ActiveProfileID == "" {
		cfg.ActiveProfileID = cfg.Profiles[0].ID
	}
	applyDetected(cfg)
	mapProfiles(cfg)
	return cfg
}

// absToExe resolves a config path relative to the executable's directory so
// the portable build works from any working directory or drive.
func absToExe(p string) string {
	if p == "" || filepath.IsAbs(p) {
		return p
	}
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), p)
}

// applyStoragePaths разрешает пути настроек от каталога программы и создаёт
// сами папки. Отдельной функцией, потому что те же действия нужны при запуске,
// после возврата архива и после смены папок, и расходиться им нельзя: путь,
// который не разрешили, читается относительно рабочего каталога — то есть
// куда попало.
func applyStoragePaths(c *Config) {
	c.WatchFolder = absToExe(c.WatchFolder)
	c.DownloadFolder = absToExe(c.DownloadFolder)
	c.CacheFolder = absToExe(c.CacheFolder)
	c.DataFolder = absToExe(c.DataFolder)
	for _, p := range []string{c.WatchFolder, c.DownloadFolder, c.CacheFolder, c.DataFolder} {
		os.MkdirAll(p, 0o755)
	}
}

// reloadConfigPaths перечитывает конфиг с диска, разрешает пути и создаёт
// папки, не трогая склады. Нужно там, где новые адреса должны быть известны
// раньше, чем в них что-то ляжет: возврат архива кладёт отметки просмотра уже
// по тому пути, который пришёл в возвращённых настройках.
func reloadConfigPaths() {
	nc := loadConfig()
	applyStoragePaths(nc)
	setCfg(nc)
}

// cacheDir и dataDir — папки, куда ложатся одноразовые и постоянные данные.
//
// Пустая настройка означает «рядом с программой»: так ведёт себя портативная
// сборка и так же — уже настроенные копии, в файле которых этих полей ещё нет.
// Снимка конфига может не быть вовсе: журнал пишется с первых строк запуска,
// до того как конфиг прочитан, и падать на этом он не должен.
func cacheDir() string { return storageDir(func(c *Config) string { return c.CacheFolder }) }
func dataDir() string  { return storageDir(func(c *Config) string { return c.DataFolder }) }

func storageDir(pick func(*Config) string) string {
	if c := curCfg(); c != nil {
		if p := strings.TrimSpace(pick(c)); p != "" {
			return absToExe(p)
		}
	}
	return exeDir()
}

// moveStateFiles переносит постоянные данные в новую папку.
//
// Без переноса смена папки выглядела бы как «всё пропало»: файлы остались бы
// в прежнем каталоге, а читаются уже из нового — пустыми. Переносятся только
// те файлы, которых на новом месте нет: своё, уже накопленное, чужой копией не
// затирается. Каждый перенесённый файл назван в возвращаемом списке, чтобы о
// переносе можно было сказать вслух, а не догадываться по пропавшим отметкам.
func moveStateFiles(from, to string, names ...string) []string {
	if from == "" || to == "" || from == to {
		return nil
	}
	var moved []string
	for _, name := range names {
		dst := filepath.Join(to, name)
		if _, err := os.Stat(dst); err == nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(from, name))
		if err != nil {
			continue
		}
		if err := writeFileAtomic(dst, data, 0o600); err != nil {
			continue
		}
		moved = append(moved, name)
	}
	return moved
}

func applyDetected(cfg *Config) {
	scanPlayersInto(cfg)
}

func mapProfiles(cfg *Config) {
	cfg.profileByID = map[string]*Profile{}
	for _, p := range cfg.Profiles {
		cfg.profileByID[p.ID] = p
	}
}

// cfg — текущая конфигурация. Публикуется снимками: после setCfg объект
// никем не мутируется, поэтому чтение из любого обработчика безопасно, а
// правки готовятся на копии (clone) и публикуются одной операцией.
var cfg atomic.Pointer[Config]

// cfgMu охраняет цепочку «копия → правка → публикация → запись на диск»
// целиком. Иначе два параллельных изменения могли переплестись: сначала
// опубликованы оба снимка, а на диск потом записан не тот, что в памяти.
var cfgMu sync.Mutex

// curCfg отдаёт актуальный снимок конфигурации.
func curCfg() *Config { return cfg.Load() }

// setCfg публикует новый снимок и строит по нему индекс профилей.
func setCfg(c *Config) {
	mapProfiles(c)
	cfg.Store(c)
}

// clone готовит изменяемую копию снимка: объекты профилей и плееров тоже
// копируются, чтобы правка не задела уже опубликованный снимок.
func (c *Config) clone() *Config {
	nc := *c
	nc.Profiles = make([]*Profile, len(c.Profiles))
	for i, p := range c.Profiles {
		cp := *p
		nc.Profiles[i] = &cp
	}
	nc.Players = make([]*Player, len(c.Players))
	for i, p := range c.Players {
		cp := *p
		nc.Players[i] = &cp
	}
	nc.profileByID = nil
	return &nc
}

// updateCfg атомарно меняет конфигурацию: fn правит копию текущего снимка,
// итог публикуется и пишется на диск одной критической секцией. Ошибка записи
// на диск возвращается вызывающему: молчать о ней — значит обещать, что
// настройка сохранилась, когда она пропадёт при перезапуске.
func updateCfg(fn func(nc *Config)) error {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	nc := curCfg().clone()
	fn(nc)
	setCfg(nc)
	return saveConfigLocked(nc)
}

// saveConfigLocked пишет конфиг на диск. Вызывается под cfgMu из updateCfg.
func saveConfigLocked(c *Config) error {
	b, _ := json.MarshalIndent(c, "", "  ")
	return writeFileAtomic(confPath(), b, 0o600)
}

// writeFileAtomic пишет файл через временный сосед и переименование: сбой
// посередине не оставляет битый файл на месте старого.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmpName)
		return fmt.Errorf("запись временного файла не удалась")
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

func (c *Config) active() *Profile {
	if c.profileByID != nil {
		if p, ok := c.profileByID[c.ActiveProfileID]; ok && p != nil {
			return p
		}
	}
	if len(c.Profiles) > 0 {
		return c.Profiles[0]
	}
	return &Profile{URL: "http://127.0.0.1:8090"}
}
