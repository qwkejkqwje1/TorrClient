package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	daemonPort = 8099
	tsPort     = 8090

	// healthEvery — как часто проверяется, живы ли TorrServer и демон. Пять
	// секунд — компромисс: падение замечается быстро, а лишних обращений к
	// своим же портам не много.
	healthEvery = 5 * time.Second
	// healthTimeout — срок ответа на проверку. Открытый, но зависший процесс
	// должен считаться упавшим, а не живым.
	healthTimeout = 2 * time.Second
	// tsStartGrace — сколько ждать, прежде чем считать запуск TorrServer
	// неудачным и снимать процесс. Сервер тратит время на проверку DNS и
	// открытие базы, и на медленной машине это заметно больше десяти секунд.
	// Меньший срок приводил к беде: сторож каждые пять секунд снимал ещё не
	// поднявшийся сервер и запускал новый — вечная гонка, в которой TorrServer
	// не успевал открыть порт ни разу, и поиск с раздачами молчали.
	tsStartGrace = 90 * time.Second

	// tsReadyWait, daemonReadyWait — сколько ждать готовности после запуска.
	// Срок настоящий, по часам: прежде он задавался числом попыток, и одна проба
	// съедала до healthTimeout, поэтому «12 секунд» оборачивались минутой с
	// лишним. Значения прежние — 48 × 250 мс и 60 × 250 мс, — но теперь они
	// означают то, что написано.
	tsReadyWait     = 12 * time.Second
	daemonReadyWait = 15 * time.Second

	// restartLimit — сколько раз подряд сторож поднимает один и тот же процесс,
	// прежде чем признать, что дело не в случайном падении, и замолчать.
	//
	// Без счёта отсутствующий или сломанный файл означал бы попытку запуска
	// каждые пять секунд без конца: пользователь видел бы мелькание процессов
	// и ни одного объяснения.
	restartLimit = 3
	// restartBackoff — пауза, на которую сторож замолкает, исчерпав попытки.
	// Заметно больше круга сторожа, но не настолько, чтобы починенный файл
	// ждал перезапуска программы.
	restartBackoff = 2 * time.Minute

	// problemEvent — имя события, которым оболочка сообщает странице о беде.
	// Имя одно на двоих: страница подписана на него, программа его шлёт.
	problemEvent = "torrclient:problem"
)

// App struct
type App struct {
	ctx context.Context
	mu  sync.Mutex
	// quitting — пользователь выбрал «Выход»: окно закрывается по-настоящему,
	// а не прячется в лоток.
	quitting atomic.Bool

	cmd   *exec.Cmd
	tsCmd *exec.Cmd

	// tsSpawned — когда запущен наш TorrServer. По нему видно, сколько он уже
	// поднимается: пока срок не вышел, трогать его нельзя.
	tsSpawned time.Time

	closing bool

	// tsBusy / daemonBusy не дают двум запускам одного и того же процесса
	// наложиться: старт из startup и сторож из healthLoop иначе подняли бы по
	// две копии.
	tsBusy     bool
	daemonBusy bool

	// tsGuard / daemonGuard считают неудачные перезапуски подряд. Сломанный
	// файл не должен приводить к запуску каждые пять секунд без конца.
	tsGuard     restartGuard
	daemonGuard restartGuard

	// tray — иконка в системном лотке. Пока её нет, закрытие окна означает
	// выход, как прежде; появилась — окно прячется, а раздача продолжается.
	tray *trayIcon
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		tsGuard:     restartGuard{limit: restartLimit, backoff: restartBackoff},
		daemonGuard: restartGuard{limit: restartLimit, backoff: restartBackoff},
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// TorrServer и демон не зависят друг от друга: последовательный запуск
	// складывал их ожидания (до ~27 сек при проблемах), параллельный — нет.
	go a.startTorrServer()
	go a.startDaemon()
	go a.healthLoop(ctx)
	// Лоток поднимается отдельно и не может помешать запуску: без иконки
	// программа работает как прежде.
	go a.setupTray()
}

// setupTray показывает иконку в системном лотке.
//
// Иконка нужна не для красоты: закрытое окно раньше означало остановку —
// вместе с демоном и раздачами. Теперь окно прячется, раздача идёт, а вернуть
// окно можно двойным щелчком по иконке.
func (a *App) setupTray() {
	exe := ""
	if p, err := os.Executable(); err == nil {
		exe = p
	}
	t := &trayIcon{onOpen: a.showWindow, onQuit: a.quitApp}
	if err := t.start("TorrClient", trayIconPath(exe)); err != nil {
		// Лоток не поднялся — молчим: окно и так работает, а сообщение о
		// неудавшейся иконке только пугает.
		return
	}
	a.mu.Lock()
	a.tray = t
	a.mu.Unlock()
}

// beforeClose решает, что делать при закрытии окна. Возврат true отменяет
// закрытие.
//
// Прятать окно, а не выходить: программа раздаёт торренты в фоне, и закрытие
// окна в такой программе не должно означать «перестать раздавать». Выход
// остаётся в меню иконки.
func (a *App) beforeClose(ctx context.Context) bool {
	a.mu.Lock()
	tray := a.tray
	a.mu.Unlock()
	// Выход из лотка идёт через runtime.Quit, а Wails перед выходом снова
	// спрашивает OnBeforeClose. Без отметки «выходим» окно пряталось и тут,
	// и «Выход» в меню лотка ничего не завершал.
	if tray == nil || !tray.started || a.quitting.Load() {
		return false
	}
	runtime.WindowHide(ctx)
	return true
}

// showWindow возвращает окно из лотка. Снимается и свёрнутое состояние:
// свёрнутое окно показать мало — оно осталось бы свёрнутым.
func (a *App) showWindow() {
	if a.ctx == nil {
		return
	}
	runtime.WindowUnminimise(a.ctx)
	runtime.WindowShow(a.ctx)
}

// quitApp завершает программу по команде из лотка.
func (a *App) quitApp() {
	if a.ctx == nil {
		return
	}
	a.quitting.Store(true)
	runtime.Quit(a.ctx)
}

// healthLoop поднимает упавший процесс заново — но не бесконечно.
//
// Без сторожа падение TorrServer выглядело бы так: окно открылось, интерфейс
// работает, а поиск и раздачи молчат — и связать это с упавшим процессом
// пользователь не может, потому что процесс запускает не он.
func (a *App) healthLoop(ctx context.Context) {
	t := time.NewTicker(healthEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.watchProcesses(time.Now())
		}
	}
}

// watchProcesses — один круг сторожа.
//
// Оба процесса проверяются одновременно. Прежде круг был последовательным, и
// ответа TorrServer (до двух секунд на пробу) ждали прежде, чем спросить о
// демоне: упавший демон замечался не за пять секунд, а за минуты, да ещё и
// каждая проба readiness откладывала проверку соседа.
func (a *App) watchProcesses(now time.Time) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		a.watchOne("TorrServer", &a.tsGuard, a.startTorrServer, now)
	}()
	go func() {
		defer wg.Done()
		a.watchOne("демон", &a.daemonGuard, a.startDaemon, now)
	}()
	wg.Wait()
}

// watchOne поднимает один процесс, считая неудачные попытки подряд.
//
// Исчерпав попытки, сторож замолкает на паузу и один раз говорит об этом
// пользователю: молчаливое «Запуск TorrClient...» на экране не даёт понять,
// что именно сломалось и куда смотреть.
func (a *App) watchOne(name string, g *restartGuard, start func() (restartOutcome, string), now time.Time) {
	a.mu.Lock()
	allowed := g.allowed(now)
	a.mu.Unlock()
	if !allowed {
		return
	}

	out, reason := start()

	a.mu.Lock()
	gaveUp := g.note(now, out)
	wait := g.waiting(now)
	a.mu.Unlock()
	if !gaveUp {
		return
	}
	msg := fmt.Sprintf("%s: не удалось запустить %d раза подряд, попытки приостановлены на %v",
		name, restartLimit, wait.Round(time.Second))
	if reason != "" {
		msg += " — " + reason
	}
	a.reportProblem(msg)
}

// reportProblem показывает беду в окне.
//
// Событие уходит странице-оболочке: пока демон не поднялся, на экране именно
// она, и без этого сообщения причина остаётся невидимой. Во время проверок
// окна нет, и ctx пуст — тогда показывать нечего.
func (a *App) reportProblem(msg string) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, problemEvent, msg)
}

// shutdown kills spawned servers when the app exits
func (a *App) shutdown(ctx context.Context) {
	a.mu.Lock()
	a.closing = true
	// Иконка убирается до выхода: иначе она остаётся в лотке, и программа
	// выглядит работающей, когда её давно нет.
	a.tray.stop()
	defer a.mu.Unlock()
	if a.tsCmd != nil {
		// Ждать здесь не нужно: процесс убирает горутина, поставленная при
		// запуске. Второй Wait вернул бы ошибку на ровном месте.
		_ = a.tsCmd.Process.Kill()
		a.tsCmd = nil
	}
	if a.cmd != nil {
		_ = a.cmd.Process.Kill()
		a.cmd = nil
	}
}

func portOpen(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// daemonAlive спрашивает у демона /api/hello: открытый порт ещё не значит, что
// процесс отвечает — зависший демон держит сокет, но не обслуживает его.
func daemonAlive() bool {
	cl := &http.Client{Timeout: healthTimeout}
	resp, err := cl.Get(fmt.Sprintf("http://127.0.0.1:%d/api/hello", daemonPort))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func findUp(exe, name string) string {
	d := filepath.Dir(exe)
	for {
		p := filepath.Join(d, name)
		if fileExists(p) {
			return p
		}
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
		d = parent
	}
	return ""
}

func daemonPath() string {
	if v := os.Getenv("TC_DAEMON"); v != "" && fileExists(v) {
		return v
	}
	if exe, err := os.Executable(); err == nil {
		es, ee := os.Stat(exe)
		// Walk up from the GUI binary; skip any torrclient.exe that is a
		// byte-identical self-copy (SameFile) of the running binary itself.
		d := filepath.Dir(exe)
		for {
			p := filepath.Join(d, "torrclient.exe")
			if fileExists(p) {
				if fs, fe := os.Stat(p); fe == nil {
					if !(ee == nil && os.SameFile(fs, es)) {
						return p
					}
				}
			}
			parent := filepath.Dir(d)
			if parent == d {
				break
			}
			d = parent
		}
	}
	return ""
}

// shouldSpawnTorrServer решает, поднимать ли сервер заново. Отдельной функцией,
// потому что цена ошибки здесь высока: решение «снять и запустить заново» на
// каждом круге сторожа превращается в вечную гонку, в которой сервер не
// успевает открыть порт ни разу.
func shouldSpawnTorrServer(portUp, prevRunning bool, prevAge, grace time.Duration) bool {
	if portUp {
		return false
	}
	// Прежний запуск ещё жив и укладывается в срок — значит, он ещё
	// поднимается, и мешать ему нечем.
	if prevRunning && prevAge < grace {
		return false
	}
	return true
}

// waitReady ждёт готовности, но не дольше срока и не дольше жизни процесса.
//
// Срок отсчитывается по времени, а не по числу попыток. Прежде попыток было
// фиксированное число, и одна проба могла занять весь срок ответа (две секунды):
// заявленные «12 секунд» на деле превращались в 108, а «15» — в 135, и всё это
// время окно ждало впустую, тогда как рядом стоял упавший процесс. Одна проба
// может занять до healthTimeout — поэтому ожидание ограничено сроком плюс одна
// проба, а не сроком точно.
//
// Живость и готовность проверяются отдельно, потому что это разные вопросы:
// «отвечает ли» и «есть ли кому отвечать». Мёртвого не ждут ни секунды: причина
// отказа известна сразу, и сказать о ней полезнее, чем ждать.
func waitReady(timeout, pause time.Duration, ready, alive func() bool) bool {
	deadline := time.Now().Add(timeout)
	for {
		if ready() {
			return true
		}
		if !alive() {
			return false
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(pause)
	}
}

// foreignHolder отвечает, держит ли порт чужая программа.
//
// Открытый порт сам по себе ничего не говорит: за ним может стоять наш
// поднимающийся процесс. А вот если порт открыт, своего процесса мы не
// запускали и наша проверка живости молчит — значит, порт занят кем-то другим,
// и наш сюда не встанет. Без этого различия отказ выглядел бы как «не открыл
// порт за 15 секунд» и уводил бы искать причину не там.
func foreignHolder(portOpen, weStarted, alive bool) bool {
	return portOpen && !weStarted && !alive
}

// torrServerReady отвечает, готов ли TorrServer обслуживать запросы, и заодно
// называет его версию.
//
// Открытый порт готовностью не является: сервер открывает сокет раньше, чем
// закончит проверку DNS и открытие базы, и запрос в этот промежуток рвётся —
// снаружи это выглядит как «поиск молчит» при живом процессе. Поэтому
// готовность подтверждается ответом /echo: он отдаёт строку версии и
// авторизации не требует.
//
// Проверено живым запуском на сборке, которая лежит рядом с программой
// (MatriX.144.1): ответ 200, тело «MatriX.144.1». Сборка без /echo (ответ 404)
// тоже считается готовой: она отвечает по HTTP, значит сервер живой. Это
// запасной путь, а не отказ.
func torrServerReady(port int) (bool, string) {
	cl := &http.Client{Timeout: healthTimeout}
	resp, err := cl.Get(fmt.Sprintf("http://127.0.0.1:%d/echo", port))
	if err != nil {
		return false, ""
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return true, ""
	}
	if resp.StatusCode != http.StatusOK {
		return false, ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 128))
	if err != nil {
		return false, ""
	}
	version := strings.TrimSpace(string(body))
	return version != "", version
}

// startTorrServer поднимает TorrServer, если его порт не отвечает. Повторный
// вызов из сторожа безопасен: живому серверу дают время подняться.
//
// Второй результат — причина неудачи для сообщения в окне. Строка возвращается
// вместе с исходом, а не хранится в поле: у TorrServer и демона причины разные,
// и общее поле путало бы их между собой.
func (a *App) startTorrServer() (restartOutcome, string) {
	a.mu.Lock()
	if a.tsBusy || a.closing {
		a.mu.Unlock()
		return restartSkipped, ""
	}
	a.tsBusy = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.tsBusy = false
		a.mu.Unlock()
	}()

	portUp := portOpen(tsPort)
	a.mu.Lock()
	prev := a.tsCmd
	prevAge := time.Since(a.tsSpawned)
	a.mu.Unlock()
	// Готовность подтверждается ответом /echo, а не открытым портом: сокет
	// открывается раньше, чем сервер начнёт отвечать, и запрос в этот
	// промежуток рвётся — снаружи это выглядит как «поиск молчит» при живом
	// процессе. Спрашивать есть смысл только когда порт уже открыт.
	if portUp {
		if ready, _ := torrServerReady(tsPort); ready {
			// Сервер отвечает — прежние падения не в счёт.
			return restartOK, ""
		}
	}
	if !shouldSpawnTorrServer(portUp, prev != nil, prevAge, tsStartGrace) {
		// Порт открыт, но готовности нет, либо прежний запуск ещё укладывается
		// в срок: он ещё поднимается, и мешать ему нечем.
		return restartSkipped, ""
	}
	path := torrServerPath()
	if path == "" {
		return restartFailed, "файл TorrServer-windows-amd64.exe не найден рядом с программой"
	}
	if prev != nil {
		// Срок вышел, а порт закрыт — запуск признан неудачным, и место
		// освобождается. Живой процесс снимается, иначе он держал бы базу.
		_ = prev.Process.Kill()
	}

	cmd := exec.Command(path)
	cmd.Dir = filepath.Dir(path)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		return restartFailed, "запуск: " + err.Error()
	}
	a.mu.Lock()
	a.tsCmd = cmd
	a.tsSpawned = time.Now()
	closing := a.closing
	a.mu.Unlock()
	// Процесс убирается отдельной горутиной: тогда «a.tsCmd != nil» означает
	// «наш сервер ещё жив», и решать по этому признаку можно, не спрашивая
	// систему. Заодно отпускается хендл — иначе он копился бы с каждым
	// перезапуском.
	go func() {
		_ = cmd.Wait()
		a.mu.Lock()
		if a.tsCmd == cmd {
			a.tsCmd = nil
		}
		a.mu.Unlock()
	}()
	if closing {
		// Окно уже закрыто: поздно стартовавший процесс не должен остаться сиротой.
		_ = cmd.Process.Kill()
		return restartSkipped, ""
	}
	ready := func() bool {
		ok, _ := torrServerReady(tsPort)
		return ok
	}
	alive := func() bool {
		// Горутина, отпускающая хендл, обнуляет поле при выходе: отдельного
		// опроса системы не нужно.
		a.mu.Lock()
		cur := a.tsCmd
		a.mu.Unlock()
		return cur == cmd
	}
	if waitReady(tsReadyWait, 250*time.Millisecond, ready, alive) {
		return restartOK, ""
	}
	if !alive() {
		return restartFailed, "процесс TorrServer завершился, не начав отвечать"
	}
	return restartFailed, fmt.Sprintf("TorrServer не начал отвечать за %v (порт %d)", tsReadyWait, tsPort)
}

func torrServerPath() string {
	if v := os.Getenv("TC_SERVER"); v != "" {
		if _, err := os.Stat(v); err == nil {
			return v
		}
	}
	if exe, err := os.Executable(); err == nil {
		if p := findUp(exe, "TorrServer-windows-amd64.exe"); p != "" {
			return p
		}
	}
	return ""
}

// startDaemon поднимает демон, если его порт не отвечает. Как и у TorrServer,
// повторный вызов из сторожа безопасен.
//
// Второй результат — причина неудачи, как и у startTorrServer.
func (a *App) startDaemon() (restartOutcome, string) {
	a.mu.Lock()
	if a.daemonBusy || a.closing {
		a.mu.Unlock()
		return restartSkipped, ""
	}
	a.daemonBusy = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.daemonBusy = false
		a.mu.Unlock()
	}()

	if daemonAlive() {
		return restartOK, ""
	}
	path := daemonPath()
	if path == "" {
		return restartFailed, "файл torrclient.exe не найден рядом с программой"
	}
	a.mu.Lock()
	prev := a.cmd
	a.mu.Unlock()
	if foreignHolder(portOpen(daemonPort), prev != nil, false) {
		// Порт занят, а нашего демона нет: держит чужая программа. Свой сюда не
		// встанет, и ждать нечего — говорим сразу, а не через пятнадцать секунд.
		return restartFailed, fmt.Sprintf("порт %d занят другой программой", daemonPort)
	}
	// Прежний демон отпускается до запуска нового: два демона на одном
	// порту — лишняя работа и лишние сообщения об ошибке привязки.
	if prev != nil {
		_ = prev.Process.Kill()
	}
	cmd := exec.Command(path, "--port", "8099", "--host", "127.0.0.1", "--open=false", "--quiet")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	// Демон под присмотром окна: после автообновления ему достаточно выйти —
	// сторож поднимет его заново уже из нового файла.
	cmd.Env = append(os.Environ(), "TC_SUPERVISED=1")
	if err := cmd.Start(); err != nil {
		return restartFailed, "запуск: " + err.Error()
	}
	a.mu.Lock()
	a.cmd = cmd
	closing := a.closing
	a.mu.Unlock()
	// Хендл отпускается горутиной: без неё он копился бы с каждым
	// перезапуском, а «a.cmd != nil» врало бы про живого демона.
	go func() {
		_ = cmd.Wait()
		a.mu.Lock()
		if a.cmd == cmd {
			a.cmd = nil
		}
		a.mu.Unlock()
	}()
	if closing {
		// Окно уже закрыто: поздно стартовавший демон не должен остаться сиротой.
		_ = cmd.Process.Kill()
		return restartSkipped, ""
	}
	// Ждём ответа, а не открытия сокета: зависший демон держит порт, но не
	// обслуживает его. Считаем итерации, а не секунды: при закрытом порте отказ
	// приходит сразу, а срок ответа нужен лишь на случай «принимает, но молчит».
	ready := func() bool { return daemonAlive() }
	alive := func() bool {
		a.mu.Lock()
		cur := a.cmd
		a.mu.Unlock()
		return cur == cmd
	}
	if waitReady(daemonReadyWait, 250*time.Millisecond, ready, alive) {
		return restartOK, ""
	}
	if !alive() {
		return restartFailed, "демон завершился, не начав отвечать"
	}
	return restartFailed, fmt.Sprintf("демон не начал отвечать за 15 секунд (порт %d)", daemonPort)
}
