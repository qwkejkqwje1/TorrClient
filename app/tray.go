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

import (
	"sync"
	"syscall"
	"unsafe"
)

// ---------- константы Win32 ----------

const (
	wmTrayCallback = 0x0400 + 1 // WM_USER + 1: сообщение от иконки
	wmCommand      = 0x0111
	wmDestroy      = 0x0002

	// Клик мышью приходит в lParam сообщения от иконки.
	wmRbuttonUp     = 0x0205
	wmLbuttonDblclk = 0x0203

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

	// started — иконка показана. Повторный stop безопасен, как и start,
	// вызванный дважды: окно и иконка создаются один раз.
	started bool
}

var (
	trayMu      sync.Mutex
	trayActive  *trayIcon
	trayClassOK bool
	trayWndProc = syscall.NewCallback(trayWindowProc)
)

// trayWindowProc — обработка сообщений невидимого окна.
//
// Функция обязана быть свободной: указатель на неё передаётся системе, и
// система ничего не знает о методах и получателях. Какую именно иконку
// относится сообщение, определяется через trayActive.
func trayWindowProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	switch uint32(msg) {
	case wmTrayCallback:
		trayMu.Lock()
		cur := trayActive
		trayMu.Unlock()
		if cur == nil {
			break
		}
		switch uint32(lparam) {
		case wmLbuttonDblclk:
			cur.fire(cur.onOpen)
		case wmRbuttonUp:
			cur.fire(func() { cur.runMenu() })
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
	t.handle(trayAction(uint32(id)))
}

// start показывает иконку. Ошибка не фатальна: без иконки программа работает
// как прежде, просто закрытие окна означает выход.
func (t *trayIcon) start(title, iconPath string) error {
	t.once.Do(func() {
		if err := t.createWindow(); err != nil {
			return
		}
		t.hicon = loadTrayIcon(iconPath)
		if t.add(title) {
			t.started = true
			return
		}
		// Иконка не добавилась — окно без неё не нужно.
		procDestroyWindow.Call(uintptr(t.hwnd))
		t.hwnd = 0
	})
	if t.hwnd == 0 || !t.started {
		return syscall.EINVAL
	}
	go t.loop()
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

// loop крутит очередь сообщений окна. Ждёт на GetMessage, поэтому живёт в
// своей горутине: она не мешает ни окну программы, ни сторожу процессов.
func (t *trayIcon) loop() {
	var m trayMsg
	for {
		ret, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&m)), uintptr(t.hwnd), 0, 0)
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
	procDestroyWindow.Call(uintptr(t.hwnd))
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
func loadTrayIcon(path string) syscall.Handle {
	if path != "" {
		p, err := syscall.UTF16PtrFromString(path)
		if err == nil {
			h, _, _ := procLoadImage.Call(0, uintptr(unsafe.Pointer(p)), imageIcon, 0, 0, lrLoadFromFile)
			if h != 0 {
				return syscall.Handle(h)
			}
		}
	}
	h, _, _ := procLoadIcon.Call(0, idiApplication)
	return syscall.Handle(h)
}
