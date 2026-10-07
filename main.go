package main

// Демон TorrClient: точка входа, общие типы и ответы API.

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

// appVersion — номер версии из файла VERSION (одно место правды: его же
// читают build_daemon.bat и tools/make-release.py).
//
//go:embed VERSION
var appVersionRaw string

func appVersion() string { return strings.TrimSpace(appVersionRaw) }

// version подставляется при сборке: build_daemon.bat передаёт
// -ldflags "-X main.version=...". Без флагов — номер из VERSION с пометкой dev.
var version string

func init() {
	if version == "" {
		version = "TorrClient " + appVersion() + "-dev"
	}
}

var (
	flagPort    = flag.Int("port", 8099, "daemon http port")
	flagHost    = flag.String("host", "127.0.0.1", "daemon bind addr")
	flagOpen    = flag.Bool("open", true, "open browser on start")
	flagMagnet  = flag.String("magnet", "", "add magnet link to active server, then exit")
	flagTorrent = flag.String("torrent", "", "add .torrent file path to active server, then exit")
	flagQuiet   = flag.Bool("quiet", false, "suppress console output")
)

// exeDir — каталог выполняемого файла. Портативная сборка держит данные рядом
// с собой, и все пути строятся от него, а не от рабочего каталога.
func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return filepath.Dir(os.Args[0])
	}
	return filepath.Dir(exe)
}

// confPath — файл настроек рядом с программой, и только там. Он указывает на
// папки кэша и постоянных данных, поэтому искать его по настройке было бы
// нечем: файл с настройкой лежит в том же месте, о котором спрашивает.
func confPath() string {
	return filepath.Join(exeDir(), "torrclient.json")
}

// ---------- companion server ----------

type Comp struct {
	httpSrv *http.Server
	dl      *DLManager
	watch   *Watcher
	// subSearch — куда ходить за выдачей трекера. Пусто в настоящей работе, а в
	// проверках подменяется: проверка подписок не должна ходить в сеть.
	subSearch subSearch
}

func main() {
	flag.Parse()
	// Автозапуск старых версий поднимал голый демон — без иконки в лотке.
	if exe, err := os.Executable(); err == nil {
		go migrateAutostart(exe)
	}

	// Вне loopback API открывается без пароля: профили (включая пароли к
	// серверу), позиции просмотра и управление раздачами доступны любому, кто
	// достанет до адреса. Молчать об этом — плохая услуга.
	if h := strings.ToLower(strings.TrimSpace(*flagHost)); h != "127.0.0.1" && h != "localhost" && h != "::1" {
		logAlways("ВНИМАНИЕ: демон привязан к %s, API не защищён паролем.", *flagHost)
		logAlways("Профили, пароли, позиции просмотра и управление раздачами доступны всем, кто может достичь этого адреса.")
	}

	cur := loadConfig()
	applyStoragePaths(cur)
	setCfg(cur)
	loadUserDataStore()
	// Подписки на сериалы — постоянные данные: они набираются долго, и потерять
	// их нечем восстановить. Читаются до запуска службы, иначе первый же запрос
	// интерфейса вернул бы пустой список и стёр бы его на диске.
	loadSubs()
	// Отметки просмотра читаются до запуска службы: ими пользуется и плейлист,
	// и продолжение с места остановки.
	viewedMarks.load()
	// Кэш метаданных читается до запуска службы: постеры и оценки переживают
	// перезапуск, и первый показ библиотеки не ждёт ответа сервиса.
	loadTmdbCache()
	go tmdbSaver()
	// Сторож отметок просмотра: без него прошлогодние записи оставались бы в
	// viewed.json навсегда.
	go viewedJanitor()

	if *flagMagnet != "" {
		clr := &CLIHelper{cfg: curCfg()}
		clr.addMagnet(*flagMagnet, true)
		return
	}
	if *flagTorrent != "" {
		clr := &CLIHelper{cfg: curCfg()}
		clr.addTorrentFile(*flagTorrent, true)
		return
	}

	c := &Comp{}
	c.dl = NewDLManager(curCfg().DownloadFolder)
	// Сторож закачек: завершённые задачи старше суток уходят из списка сами.
	go c.dl.janitor()
	// Сторож раздач: он один спрашивает сервер, а интерфейсы получают готовое
	// событие — вместо того чтобы опрашивать сервер каждый сам.
	go c.torrentsWatcher()
	// Сторож подписок: демон сам спрашивает трекер о новых сериях и сообщает о
	// них событием. Интерфейс может быть закрыт — подписка продолжает работать.
	go c.subsWatcher()
	c.watch = NewWatcher(curCfg().WatchFolder, func(path string) { c.addTorrentFromFile(path, true) })

	mux := http.NewServeMux()
	mux.HandleFunc("/", c.handleRoot)
	// Проба готовности для окна-оболочки: она стучится сюда, прежде чем уйти
	// на UI. Ручка нарочно отдаёт пустой 204 — содержимое ей не нужно.
	mux.HandleFunc("/net", c.apiNet)
	mux.HandleFunc("/ts/", c.handleProxy)
	mux.HandleFunc("/api/hello", c.apiHello)
	mux.HandleFunc("/api/profiles", c.apiProfiles)
	mux.HandleFunc("/api/player/", c.apiPlayer)
	mux.HandleFunc("/api/playlist", c.apiPlaylist)
	mux.HandleFunc("/api/playlist/", c.apiPlaylist)
	mux.HandleFunc("/api/positions", c.apiPositions)
	mux.HandleFunc("/api/watch", c.apiWatch)
	mux.HandleFunc("/api/meta", c.apiMeta)
	mux.HandleFunc("/api/tmdb", c.apiTmdb)
	mux.HandleFunc("/api/ratings", c.apiRatings)
	mux.HandleFunc("/api/img", c.apiImg)

	mux.HandleFunc("/api/tv_eps", c.apiTvEps)
	// Поисковые эндпоинты придерживаются ограничителем: частые обращения
	// получают 429, а не уходят на трекер за капчей.
	mux.HandleFunc("/api/top24", limitSearch(c.apiTop24))
	mux.HandleFunc("/api/topcat", limitSearch(c.apiTopcat))
	mux.HandleFunc("/api/kinozal/search", limitSearch(c.apiKinozalSearch))

	mux.HandleFunc("/api/rutor/search", limitSearch(c.apiRutorSearch))
	mux.HandleFunc("/api/rutor/settings", c.apiRutorSettings)
	// Torznab-поиск идёт напрямую в индексаторы, поэтому ограничитель здесь
	// обязателен: иначе один человек с кнопкой «ещё» уронит и трекер, и себя.
	mux.HandleFunc("/api/torznab/search", limitSearch(c.apiTorznabSearch))
	// Этап 2: потоковый параллельный поиск и «популярное за всё время».
	mux.HandleFunc("/api/torznab/stream", limitSearch(c.apiTorznabStream))
	mux.HandleFunc("/api/popular", limitSearch(c.apiPopular))
	mux.HandleFunc("/api/discover", limitSearch(c.apiDiscover))
	// Рекомендации TMDB по фильмам и сериалам из библиотеки.
	mux.HandleFunc("/api/recommend", c.apiRecommend)
	mux.HandleFunc("/api/torznab/test", c.apiTorznabTest)
	mux.HandleFunc("/api/torznab/sources", c.apiTorznabSources)
	mux.HandleFunc("/api/torznab/discover", c.apiTorznabDiscover)
	mux.HandleFunc("/api/torznab/discover/add", c.apiTorznabDiscoverAdd)
	mux.HandleFunc("/api/torznab/apps", c.apiTorznabApps)
	mux.HandleFunc("/api/autobuffer", c.apiAutoBuffer)
	mux.HandleFunc("/api/kinozal/add", c.apiKinozalAdd)
	mux.HandleFunc("/api/kinozal/mirrors", c.apiKinozalMirrors)
	mux.HandleFunc("/api/userdata", c.apiUserData)
	// Подписки на сериалы: список, добавление, снятие и проверка по кнопке.
	mux.HandleFunc("/api/subs", c.apiSubs)
	mux.HandleFunc("/api/sleep", c.apiSleep)
	mux.HandleFunc("/api/tsupdate", c.apiTsUpdate)
	mux.HandleFunc("/api/devices", c.apiDevices)
	mux.HandleFunc("/api/handoff", c.apiHandoff)
	mux.HandleFunc("/api/download", c.apiDownload)
	// Доступны ли папки загрузок и наблюдения: путь на отключённом диске
	// выглядит правильным, а писать в него нельзя.
	mux.HandleFunc("/api/folders", c.apiFolders)
	mux.HandleFunc("/api/reg", c.apiReg)
	mux.HandleFunc("/api/autostart", c.apiAutostart)
	// Живая лента: интерфейс узнаёт об изменениях сразу, а не опросом.
	mux.HandleFunc("/api/events", c.apiEvents)
	// Резервная копия состояния одним архивом и её возврат.
	mux.HandleFunc("/api/backup", c.apiBackup)
	mux.HandleFunc("/api/restore", c.apiRestore)
	// Отчёт о состоянии установки: версии, папки, серверы и файлы данных разом.
	mux.HandleFunc("/api/diagnostics", c.apiDiagnostics)
	// Доступ с телефона по QR и PIN: ручка настройки и второй слушатель.
	mux.HandleFunc("/api/remote", c.apiRemote)
	// Проверка и установка обновлений из GitHub Releases.
	mux.HandleFunc("/api/update", c.apiUpdate)
	cleanupOld(exeDir())
	mux.HandleFunc("/remote-login", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/", http.StatusSeeOther) })
	remote.handler = mux
	remote.apply()

	c.httpSrv = &http.Server{
		Addr:              fmt.Sprintf("%s:%d", *flagHost, *flagPort),
		Handler:           hostGuard(originGuard(mux)),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}

	listener, err := net.Listen("tcp", c.httpSrv.Addr)
	// После обновления новая копия стартует, пока старая ещё отпускает порт.
	for i := 0; err != nil && i < 20 && os.Getenv("TC_UPDATE_RESTART") == "1"; i++ {
		time.Sleep(250 * time.Millisecond)
		listener, err = net.Listen("tcp", c.httpSrv.Addr)
	}
	if err != nil {
		logAlways("Ошибка запуска: %v", err)
		os.Exit(1)
	}

	base := fmt.Sprintf("http://%s:%d", *flagHost, *flagPort)
	logMsg("")
	logMsg("  =============================================")
	logMsg("  %s", version)
	logMsg("  UI:  %s", base)
	cur = curCfg()
	logMsg("  Сервер: %s", cur.active().URL)
	logMsg("  Watch folder: %s", cur.WatchFolder)
	logMsg("  Downloads: %s", cur.DownloadFolder)
	// Кэш и постоянные данные называются отдельно: это разные папки, и по
	// строке в журнале видно, куда демон пишет дальше, — до неё строки ушли
	// рядом с программой.
	logMsg("  Кэш: %s", cur.CacheFolder)
	logMsg("  Постоянные данные: %s", cur.DataFolder)
	logMsg("  =============================================")
	logMsg("")
	// Папки проверяются сразу при запуске, а не только по запросу интерфейса.
	// Путь на отключённом диске выглядит правильным, и без этой строки о
	// неработающей папке узнают по последствиям — пустому журналу наблюдения и
	// пустым «Загрузкам», — а не по причине.
	for _, msg := range folderProblems(
		checkFolder(cur.WatchFolder),
		checkFolder(cur.DownloadFolder),
		checkFolder(cur.CacheFolder),
		checkFolder(cur.DataFolder),
	) {
		logMsg("  ВНИМАНИЕ: %s", msg)
	}

	if *flagOpen {
		go func() {
			time.Sleep(400 * time.Millisecond)
			openBrowser(base)
		}()
	}

	c.watch.Start()
	// Завершение по Ctrl+C: сервер останавливается штатно, и отметки просмотра,
	// последний раз обновлённые плеером, дописываются на диск.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = c.httpSrv.Shutdown(ctx)
		_ = viewedMarks.save()
	}()

	serveErr := c.httpSrv.Serve(listener)
	if serveErr != nil && serveErr != http.ErrServerClosed {
		fmt.Println("Ошибка сервера:", serveErr)
	}
}

// ---------- helpers ----------

func jj(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// writeJSONError отдаёт причину телом JSON, а не текстом: интерфейс читает её
// и показывает рядом с источником, вместо «ничего не найдено».
func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
