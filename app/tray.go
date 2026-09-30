package main

// Трей: иконка в системном лотке и свёртывание окна вместо выхода.
//
// Своя реализация на Win32, а не готовая библиотека: сторонний модуль пришлось
// бы скачивать, а портативная сборка обязана собираться из того, что лежит
// рядом. Вызовы те же, что делает любая программа с иконкой в лотке:
//Shell_NotifyIconW для самой иконки и всплывающее меню по правой кнопке.
//
// Иконке нужен получатель сообщений, поэтому заводится невидимое окно со своей
// обработкой сообщений в отдельной горутине. Окно не появляется на экране:
// оно создаётся с родителем HWND_MESSAGE.
//
// Окно Win32 принадлежит потоку, который его создал: только этот поток получает
// его сообщения из GetMessage и только из него можно показать меню. Поэтому
// создание окна, очередь сообщений и меню живут в одной горутине, закреплённой
// за потоком (LockOSThread). Раньше окно создавалось в одном потоке, а очередь
// крутилась в другом — щелчки по иконке никуда не приходили, и выйти из
// программы через лоток было нельзя.

import (
	goruntime "runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// ---------- константы Win32 ----------

const (
	wmTrayCallback = 0x0400 + 1 // WM_USER + 1: сообщение от иконки
	wmCommand      = 0x0111
	wmDestroy      = 0x0002
	wmClose        = 0x0010
	wmNull         = 0x0000

	// wmShowWindow — просьба второго запуска показать окно. Раньше второй
	// запуск молча выходил, и спрятанное в лоток окно без иконки было не
	// вернуть ничем.
	wmShowWindow = 0x8000 + 2 // WM_APP + 2

	// Клик мышью приходит в lParam сообщения от иконки.
	wmRbuttonUp     = 0x0205
	wmLbuttonDblclk = 0x0203
	wmLbuttonUp     = 0x0202

	nimAdd    = 0
	nimDelete = 2

	nifMessage = 0x1
	nifIcon    = 0x2
	nifTip     = 0x4

	// Пункты меню: значения произвольные, главное — разные.
	menuOpen = 1
	menuQuit = 2

	mfString    = 0x0000
	mfSeparator = 0x0800

	tpmLeftAlign   = 0x0000
	tpmRightButton = 0x0002
	tpmReturnCmd   = 0x0100

	imageIcon      = 1
	lrLoadFromFile = 0x0010
	idiApplication = 32512

	// trayUID — номер иконки в лотке. Одна программа может держать несколько
	// иконок, и номер их различает.
	trayUID = 1

	// hwndMessage — родитель для окна, которого не видно на экране.
	hwndMessage = ^uintptr(2) // (HWND)-3

	// tipLen — длина подсказки в структуре иконки: 128 символов, включая
	// завершающий ноль. Больше система не возьмёт.
	tipLen = 128
)

// ---------- Win32 ----------

var (
	user32  = syscall.NewLazyDLL("user32.dll")
	shell32 = syscall.NewLazyDLL("shell32.dll")

	procShellNotifyIcon = shell32.NewProc("Shell_NotifyIconW")

	procRegisterClassEx  = user32.NewProc("RegisterClassExW")
	procCreateWindowEx   = user32.NewProc("CreateWindowExW")
	procDefWindowProc    = user32.NewProc("DefWindowProcW")
	procGetMessage       = user32.NewProc("GetMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessage  = user32.NewProc("DispatchMessageW")
	procPostQuitMessage  = user32.NewProc("PostQuitMessage")
	procDestroyWindow    = user32.NewProc("DestroyWindow")
	procLoadImage        = user32.NewProc("LoadImageW")
	procLoadIcon         = user32.NewProc("LoadIconW")
	procCreatePopupMenu  = user32.NewProc("CreatePopupMenu")
	procAppendMenu       = user32.NewProc("AppendMenuW")
	procDestroyMenu      = user32.NewProc("DestroyMenu")
	procTrackPopupMenu   = user32.NewProc("TrackPopupMenu")
	procSetForeground    = user32.NewProc("SetForegroundWindow")
	procGetCursorPos     = user32.NewProc("GetCursorPos")
	procPostMessage      = user32.NewProc("PostMessageW")
	procRegisterWinMsg   = user32.NewProc("RegisterWindowMessageW")
	procFindWindowEx     = user32.NewProc("FindWindowExW")
	procExtractIconEx    = shell32.NewProc("ExtractIconExW")
)

// notifyIconData — NOTIFYICONDATAW. Поля идут в том же порядке, что в Windows:
// структура передаётся системе целиком, и расхождение в порядке незаметно не
// останется — иконка просто не появится или подсказка окажется мусором.
type notifyIconData struct {
	CbSize          uint32
	HWnd            syscall.Handle
	UID             uint32
	Flags           uint32
	CallbackMessage uint32
	HIcon           syscall.Handle
	Tip             [tipLen]uint16
	State           uint32
	StateMask       uint32
	Info            [256]uint16
	Timeout         uint32
	InfoTitle       [64]uint16
	InfoFlags       uint32
	GuidItem        [16]byte
	BalloonIcon     syscall.Handle
}

type wndClassEx struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     syscall.Handle
	HIcon         syscall.Handle
	HCursor       syscall.Handle
	HbrBackground syscall.Handle
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       syscall.Handle
}

type trayMsg struct {
	HWnd    syscall.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

type point struct{ X, Y int32 }

// ---------- что выбрано в меню ----------

type trayCmd int

const (
	trayNone trayCmd = iota
	trayOpen
	trayQuit
)

// trayAction превращает выбранный пункт меню в команду.
//
// Отдельной функцией, чтобы разбор был проверяемым: меню живёт в системном
// вызове, и проверить его иначе можно только глазами на настоящем экране.
func trayAction(id uint32) trayCmd {
	switch id {
	case menuOpen:
		return trayOpen
	case menuQuit:
		return trayQuit
	}
	return trayNone
}

// trayTip готовит подсказку иконки.
//
// Подсказка живёт в структуре фиксированной длины, и перебор длины система не
// отвергает — она тихо обрезает строку, оставляя в лотке бессмыслицу. Обрезка
// делается здесь и проверяется отдельно.
func trayTip(title string) [tipLen]uint16 {
	var out [tipLen]uint16
	utf16, err := syscall.UTF16FromString(title)
	if err != nil {
		// Строка, которую нельзя выразить в UTF-16 (одиночный суррогат).
		// Подсказки не будет, но и мусора в лотке не будет тоже.
		return out
	}
	// Обрезается готовая последовательность, а не исходная строка: один символ
	// вне BMP занимает два элемента, и счёт по символам оставил бы буфер без
	// завершающего нуля — система читала бы строку за его пределами.
	if len(utf16) > tipLen {
		utf16 = utf16[:tipLen]
	}
	utf16[len(utf16)-1] = 0
	copy(out[:], utf16)
	return out
}

// trayIconPath ищет иконку рядом с программой. Пустого результата не бывает в
// смысле «ошибка»: без файла берётся стандартная иконка системы, и программа
// остаётся рабочей.
func trayIconPath(exe string) string {
	if exe == "" {
		return ""
	}
	for _, name := range []string{"app.ico", "icon.ico"} {
		if p := findUp(exe, name); p != "" {
			return p
		}
	}
	return ""
}

// ---------- сама иконка ----------

type trayIcon struct {
	hwnd  syscall.Handle
	hicon syscall.Handle
	once  sync.Once

	onOpen func()
	onQuit func()

	// title и exe — чтобы вернуть иконку, когда Проводник перезапустился, и
	// взять значок из самой программы, если рядом нет app.ico.
	title string
	exe   string

	// started — иконка показана. Повторный stop безопасен, как и start,
	// вызванный дважды: окно и иконка создаются один раз.
	started bool
}

var (
	trayMu      sync.Mutex
	trayActive  *trayIcon
	trayClassOK bool
	trayWndProc = syscall.NewCallback(trayWindowProc)

	// wmTaskbarCreated — сообщение, которое Проводник рассылает, поднявшись
	// заново (после сбоя или обновления). Иконки лотка при этом пропадают, и
	// каждая программа должна добавить свою ещё раз — иначе иконки нет до
	// перезапуска программы.
	wmTaskbarCreated = registerTaskbarCreated()
)

func registerTaskbarCreated() uint32 {
	p, err := syscall.UTF16PtrFromString("TaskbarCreated")
	if err != nil {
		return 0
	}
	r, _, _ := procRegisterWinMsg.Call(uintptr(unsafe.Pointer(p)))
	return uint32(r)
}

// showRunningWindow просит уже запущенную копию показать окно. Окно иконки
// — «только для сообщений», поэтому ищется среди них (родитель HWND_MESSAGE).
func showRunningWindow() bool {
	name, err := syscall.UTF16PtrFromString("TorrClientTrayWindow")
	if err != nil {
		return false
	}
	h, _, _ := procFindWindowEx.Call(hwndMessage, 0, uintptr(unsafe.Pointer(name)), 0)
	if h == 0 {
		return false
	}
	r, _, _ := procPostMessage.Call(h, wmShowWindow, 0, 0)
	return r != 0
}

// trayWindowProc — обработка сообщений невидимого окна.
//
// Функция обязана быть свободной: указатель на неё передаётся системе, и
// система ничего не знает о методах и получателях. Какую именно иконку
// относится сообщение, определяется через trayActive.
func trayWindowProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	if m := uint32(msg); m != 0 && (m == wmTaskbarCreated || m == wmShowWindow) {
		trayMu.Lock()
		cur := trayActive
		trayMu.Unlock()
		if cur != nil {
			if m == wmTaskbarCreated {
				cur.add(cur.title)
			} else {
				cur.fire(cur.onOpen)
			}
		}
		return 0
	}
	switch uint32(msg) {
	case wmTrayCallback:
		trayMu.Lock()
		cur := trayActive
		trayMu.Unlock()
		if cur == nil {
			break
		}
		switch uint32(lparam) {
		case wmLbuttonUp, wmLbuttonDblclk:
			cur.fire(cur.onOpen)
		case wmRbuttonUp:
			// Меню — здесь же, в потоке окна: из другого потока
			// TrackPopupMenu не показывается.
			cur.runMenu()
		}
		return 0
	case wmCommand:
		// Младшее слово wParam — номер выбранного пункта.
		trayMu.Lock()
		cur := trayActive
		trayMu.Unlock()
		if cur != nil {
			cur.fire(func() { cur.handle(trayAction(uint32(wparam) & 0xffff)) })
		}
		return 0
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := procDefWindowProc.Call(hwnd, msg, wparam, lparam)
	return ret
}

// fire выполняет действие от имени иконки. Действия идут не в обработчике
// сообщений напрямую: вызов мог бы привести к повторному входу в ту же
// обработку (например, показать окно из неё же), а так очередь сообщений
// продолжает крутиться.
func (t *trayIcon) fire(fn func()) {
	if fn == nil {
		return
	}
	go fn()
}

func (t *trayIcon) handle(cmd trayCmd) {
	switch cmd {
	case trayOpen:
		t.fire(t.onOpen)
	case trayQuit:
		t.fire(t.onQuit)
	}
}

// runMenu показывает меню по правой кнопке и выполняет выбранное.
//
// Меню создаётся на один показ: держать его всё время незачем, а хендл,
// созданный и не разрушенный, остаётся висеть до конца программы.
func (t *trayIcon) runMenu() {
	hMenu, _, _ := procCreatePopupMenu.Call()
	if hMenu == 0 {
		return
	}
	defer procDestroyMenu.Call(hMenu)

	open, _ := syscall.UTF16PtrFromString("Открыть TorrClient")
	quit, _ := syscall.UTF16PtrFromString("Выход")
	procAppendMenu.Call(hMenu, mfString, menuOpen, uintptr(unsafe.Pointer(open)))
	procAppendMenu.Call(hMenu, mfSeparator, 0, 0)
	procAppendMenu.Call(hMenu, mfString, menuQuit, uintptr(unsafe.Pointer(quit)))

	// Без переднего плана меню не закрывается, когда пользователь щёлкает
	// мимо него: окно, которому меню принадлежит, должно быть активным.
	procSetForeground.Call(uintptr(t.hwnd))
	var pt point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	id, _, _ := procTrackPopupMenu.Call(hMenu,
		tpmLeftAlign|tpmRightButton|tpmReturnCmd,
		uintptr(int(pt.X)), uintptr(int(pt.Y)), 0, uintptr(t.hwnd), 0)
	// Рекомендация Windows: пустое сообщение после меню, иначе повторное меню
	// иногда закрывается сразу же.
	procPostMessage.Call(uintptr(t.hwnd), wmNull, 0, 0)
	t.handle(trayAction(uint32(id)))
}

// start показывает иконку. Ошибка не фатальна: без иконки программа работает
// как прежде, просто закрытие окна означает выход.
func (t *trayIcon) start(title, iconPath string) error {
	var err error
	t.once.Do(func() {
		errc := make(chan error, 1)
		go func() {
			// Весь век окна — в одном потоке: создание, очередь, меню, уход.
			goruntime.LockOSThread()
			defer goruntime.UnlockOSThread()
			if e := t.createWindow(); e != nil {
				errc <- e
				return
			}
			t.title = title
			t.hicon = loadTrayIcon(iconPath, t.exe)
			// При автозапуске программа поднимается раньше Проводника, и
			// первая попытка отказывает — иконки не было вовсе. Пробуем
			// минуту, прежде чем сдаться.
			added := t.add(title)
			for i := 0; !added && i < 30; i++ {
				time.Sleep(2 * time.Second)
				added = t.add(title)
			}
			if !added {
				// Иконка не добавилась — окно без неё не нужно.
				procDestroyWindow.Call(uintptr(t.hwnd))
				t.hwnd = 0
				errc <- syscall.EINVAL
				return
			}
			t.started = true
			errc <- nil
			t.loop()
		}()
		err = <-errc
	})
	if err != nil || t.hwnd == 0 || !t.started {
		if err == nil {
			err = syscall.EINVAL
		}
		return err
	}
	return nil
}

// createWindow заводит невидимое окно: иконке нужен получатель сообщений.
func (t *trayIcon) createWindow() error {
	trayMu.Lock()
	registered := trayClassOK
	trayClassOK = true
	trayMu.Unlock()

	name, err := syscall.UTF16PtrFromString("TorrClientTrayWindow")
	if err != nil {
		return err
	}
	if !registered {
		wc := wndClassEx{
			CbSize:        uint32(unsafe.Sizeof(wndClassEx{})),
			LpfnWndProc:   trayWndProc,
			LpszClassName: name,
		}
		if ret, _, _ := procRegisterClassEx.Call(uintptr(unsafe.Pointer(&wc))); ret == 0 {
			trayMu.Lock()
			trayClassOK = false
			trayMu.Unlock()
			return syscall.GetLastError()
		}
	}
	empty, _ := syscall.UTF16PtrFromString("")
	hwnd, _, _ := procCreateWindowEx.Call(
		0,
		uintptr(unsafe.Pointer(name)),
		uintptr(unsafe.Pointer(empty)),
		0, 0, 0, 0, 0,
		hwndMessage, 0, 0, 0)
	if hwnd == 0 {
		return syscall.GetLastError()
	}
	t.hwnd = syscall.Handle(hwnd)
	trayMu.Lock()
	trayActive = t
	trayMu.Unlock()
	return nil
}

func (t *trayIcon) add(title string) bool {
	nid := notifyIconData{
		CbSize:          uint32(unsafe.Sizeof(notifyIconData{})),
		HWnd:            t.hwnd,
		UID:             trayUID,
		Flags:           nifMessage | nifIcon | nifTip,
		CallbackMessage: wmTrayCallback,
		HIcon:           t.hicon,
		Tip:             trayTip(title),
	}
	ret, _, _ := procShellNotifyIcon.Call(nimAdd, uintptr(unsafe.Pointer(&nid)))
	return ret != 0
}

// loop крутит очередь сообщений окна в потоке, создавшем окно. Ждёт на
// GetMessage, поэтому живёт в своей горутине: она не мешает ни окну
// программы, ни сторожу процессов. Выходит по WM_QUIT после WM_DESTROY.
func (t *trayIcon) loop() {
	var m trayMsg
	for {
		ret, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if ret == 0 || int(ret) == -1 {
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessage.Call(uintptr(unsafe.Pointer(&m)))
	}
}

// stop убирает иконку: без этого она остаётся в лотке после выхода, и
// программа выглядит работающей, когда её давно нет.
func (t *trayIcon) stop() {
	if t == nil || t.hwnd == 0 {
		return
	}
	nid := notifyIconData{
		CbSize: uint32(unsafe.Sizeof(notifyIconData{})),
		HWnd:   t.hwnd,
		UID:    trayUID,
	}
	procShellNotifyIcon.Call(nimDelete, uintptr(unsafe.Pointer(&nid)))
	// DestroyWindow работает только из потока окна, поэтому окну посылается
	// WM_CLOSE: его обработка по умолчанию и разрушит окно, и закончит очередь.
	procPostMessage.Call(uintptr(t.hwnd), wmClose, 0, 0)
	t.hwnd = 0
	t.started = false
	trayMu.Lock()
	if trayActive == t {
		trayActive = nil
	}
	trayMu.Unlock()
}

// loadTrayIcon берёт иконку из файла рядом с программой. Нет файла — берётся
// стандартная иконка системы: пустая иконка в лотке хуже, чем отсутствие
// иконки, а отсутствие иконки лучше, чем отказ программы запускаться.
func loadTrayIcon(path, exe string) syscall.Handle {
	if path != "" {
		p, err := syscall.UTF16PtrFromString(path)
		if err == nil {
			h, _, _ := procLoadImage.Call(0, uintptr(unsafe.Pointer(p)), imageIcon, 0, 0, lrLoadFromFile)
			if h != 0 {
				return syscall.Handle(h)
			}
		}
	}
	// Значок самой программы: он вшит в exe при сборке, и файл app.ico рядом
	// лежит не всегда — тогда в лотке была безликая стандартная иконка, которую
	// легко не заметить.
	if exe != "" {
		if p, err := syscall.UTF16PtrFromString(exe); err == nil {
			var small syscall.Handle
			if n, _, _ := procExtractIconEx.Call(uintptr(unsafe.Pointer(p)), 0, 0, uintptr(unsafe.Pointer(&small)), 1); n != 0 && small != 0 {
				return small
			}
		}
	}
	h, _, _ := procLoadIcon.Call(0, idiApplication)
	return syscall.Handle(h)
}
