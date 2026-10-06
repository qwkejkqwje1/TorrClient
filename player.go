package main

// Наблюдение за внешним плеером.
//
// Позицию просмотра раньше считали по времени с момента запуска: сколько прошло
// с открытия ссылки, столько и «просмотрено». Это неверно при паузе, перемотке и
// втором окне плеера, а серия отмечалась просмотренной только тогда, когда
// пользователь сам ставил закладку.
//
// Здесь позицию сообщает сам плеер: VLC — через свой http-интерфейс, mpv —
// через канал управления, MPC-BE и MPC-HC — через страницу переменных. Позиция
// сохраняется и подставляется при следующем запуске, поэтому серия продолжается
// с места остановки, а не начинается заново.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// Граница правдоподобия позиции: сутки заведомо больше любого фильма, а
	// всё, что дальше, — не позиция, а мусор в ответе.
	maxPositionSeconds = 24 * 60 * 60

	// Сколько ждём ответа плеера и сколько байт готовы прочитать.
	playerReadTimeout = 4 * time.Second
	maxPlayerBody     = 64 * 1024

	// Сколько строк ответа mpv читаем: ожидаются две, остальное — запас на
	// посторонний ответ, пришедший в тот же канал.
	mpvMaxReplies = 8

	// Доля просмотра, после которой серия считается просмотренной. Порог взят
	// у прежнего клиента: восемь десятых длительности.
	watchedShare = 0.8

	// Сколько ждём первого ответа плеера. VLC поднимает свой http-интерфейс не
	// мгновенно, но если он молчит минуту, значит канал связи не сложился.
	watchStartGrace = 60 * time.Second
)

// Шаги наблюдения за плеером. Переменные, а не константы: проверка подставляет
// свои, чтобы увидеть периодический сброс отметки, не ожидая получаса.
var (
	// Как часто спрашиваем плеер о позиции. Реже — теряется место остановки,
	// чаще — плеер дёргается без пользы.
	watchInterval = 5 * time.Second

	// viewedFlushInterval — через сколько отметка идёт на диск.
	//
	// Файл отметок переписывается целиком, и писать его на каждый замер позиции
	// незачем. Но и держать отметку в памяти до закрытия плеера нельзя:
	// аварийное завершение — перезагрузка, отключение диска, снятие процесса —
	// съедало бы позицию всего сеанса. Полминуты ограничивают потерю половиной
	// минуты, а записей за фильм выходит десятки, а не сотни.
	viewedFlushInterval = 30 * time.Second
)

// viewedFlushDue сообщает, пора ли записать отметки на диск.
//
// Отдельной функцией, а не двумя строками по месту: решение видно только на
// длинном сеансе, и проверять его запуском плеера пришлось бы минутами.
func viewedFlushDue(last, now time.Time) bool {
	return last.IsZero() || now.Sub(last) >= viewedFlushInterval
}

// playerReading — один замер у работающего плеера, в секундах.
type playerReading struct {
	Position float64
	Duration float64
	// Path — адрес текущего файла (mpv), Name — его имя (VLC, MPC). По ним
	// видно, какая серия плейлиста играет сейчас.
	Path string
	Name string
	// PlaylistID — номер текущего элемента плейлиста VLC (currentplid). По
	// нему из /requests/playlist.json берётся адрес элемента, а в адресе —
	// номер файла: по имени серия узнавалась не всегда, и позиции следующих
	// серий записывались на первую.
	PlaylistID int
}

// errNotThePlayer — на адресе связи отвечает не плеер.
//
// Порт для VLC выбирается за мгновение до запуска и удержать его нельзя: за
// секунды, пока VLC поднимается, порт может занять другая программа. Тогда мы
// разговариваем с ней и получаем бессмысленный ответ — этот случай надо назвать
// отдельно, иначе он выглядит как «плеер молчит».
var errNotThePlayer = errors.New("на адресе связи отвечает не плеер")

// ---------- разбор ответов плееров ----------

// parseVLCStatus читает документ, который VLC отдаёт по /requests/status.json.
//
// VLC сообщает целые секунды и обнуляет время, когда остановлен. Остановленный
// плеер — это «нет ответа», а не позиция ноль: записав ноль, мы стёрли бы
// отметку, на которую пользователь рассчитывал.
func parseVLCStatus(body []byte) (playerReading, error) {
	var status struct {
		Time        float64 `json:"time"`
		Length      float64 `json:"length"`
		State       *string `json:"state"`
		CurrentPlID int     `json:"currentplid"`
		Information struct {
			Category struct {
				Meta struct {
					Filename string `json:"filename"`
				} `json:"meta"`
			} `json:"category"`
		} `json:"information"`
	}
	if err := json.Unmarshal(body, &status); err != nil {
		return playerReading{}, fmt.Errorf("%w: VLC вернул неразборчивый ответ", errNotThePlayer)
	}
	// Указатель, а не строка: «состояния нет» и «состояние пустое» — разные
	// вещи. VLC всегда его присылает, и отсутствие означает, что отвечает не он.
	if status.State == nil {
		return playerReading{}, fmt.Errorf("%w: в ответе нет состояния плеера", errNotThePlayer)
	}
	if *status.State == "stopped" {
		return playerReading{}, errors.New("VLC остановлен")
	}
	return playerReading{Position: secondsOrZero(status.Time), Duration: secondsOrZero(status.Length),
		Name: status.Information.Category.Meta.Filename, PlaylistID: status.CurrentPlID}, nil
}

// vlcNode — элемент дерева /requests/playlist.json.
type vlcNode struct {
	ID       string    `json:"id"`
	URI      string    `json:"uri"`
	Children []vlcNode `json:"children"`
}

// vlcItemURI ищет в дереве плейлиста адрес элемента с номером id.
func vlcItemURI(n vlcNode, id string) string {
	if n.ID == id && n.URI != "" {
		return n.URI
	}
	for _, ch := range n.Children {
		if u := vlcItemURI(ch, id); u != "" {
			return u
		}
	}
	return ""
}

// vlcPlaylistURI спрашивает у VLC адрес текущего элемента плейлиста.
func (p httpPoller) vlcPlaylistURI(ctx context.Context, plid int) string {
	u := strings.TrimSuffix(p.url, "status.json") + "playlist.json"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return ""
	}
	if p.password != "" {
		req.SetBasicAuth("", p.password)
	}
	resp, err := playerClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var root vlcNode
	if json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&root) != nil {
		return ""
	}
	return vlcItemURI(root, strconv.Itoa(plid))
}

// vlcPoll — замер VLC вместе с адресом текущей серии плейлиста.
func (p httpPoller) vlcPoll(ctx context.Context) (playerReading, error) {
	r, err := p.poll(ctx)
	if err != nil || r.PlaylistID <= 0 {
		return r, err
	}
	if uri := p.vlcPlaylistURI(ctx, r.PlaylistID); uri != "" {
		r.Path = uri
	}
	return r, nil
}

// mpcValue — одна переменная из документа семейства MPC: пары вида
// <p id="имя">значение</p>.
var mpcValue = regexp.MustCompile(`id="([a-z]+)"\s*>\s*([0-9]+)`)

// mpcFile — имя текущего файла: <p id="file">имя</p>.
var mpcFile = regexp.MustCompile(`id="file"\s*>([^<]*)<`)

// Оба написания принимаются потому, что семейство MPC непостоянно: MPC-HC
// публикует position и duration, а сборка, сократившая их до pos и dur, — это
// одна ветка развития. Ставка на одно написание сломала бы весь канал на другом.
const (
	mpcPosition = "position"
	mpcShortPos = "pos"
	mpcDuration = "duration"
	mpcShortDur = "dur"
)

// parseMPCVariables читает /variables.html. Семейство MPC сообщает
// миллисекунды: его собственный интерфейс делит то же число на 1000, чтобы
// напечатать чч:мм:сс.
func parseMPCVariables(body []byte) (playerReading, error) {
	var reading playerReading
	var havePosition bool
	for _, match := range mpcValue.FindAllSubmatch(body, -1) {
		value, err := strconv.ParseFloat(string(match[2]), 64)
		if err != nil {
			continue
		}
		switch string(match[1]) {
		case mpcPosition, mpcShortPos:
			reading.Position, havePosition = millisecondsOrZero(value), true
		case mpcDuration, mpcShortDur:
			reading.Duration = millisecondsOrZero(value)
		}
	}
	if !havePosition {
		return playerReading{}, errors.New("MPC не сообщил позицию")
	}
	if m := mpcFile.FindSubmatch(body); m != nil {
		reading.Name = html.UnescapeString(strings.TrimSpace(string(m[1])))
	}
	return reading, nil
}

// mpvReply — один ответ mpv в канале управления.
type mpvReply struct {
	Data      json.RawMessage `json:"data"`
	Error     string          `json:"error"`
	RequestID int             `json:"request_id"`
}

// num читает числовое значение ответа.
func (r mpvReply) num() (float64, bool) {
	var v float64
	if r.Error != "success" || len(r.Data) == 0 || json.Unmarshal(r.Data, &v) != nil {
		return 0, false
	}
	return v, true
}

// mpvRequest спрашивает обе величины одной записью: mpv отвечает на каждую
// команду отдельной строкой с тем номером, который ей дали.
const mpvRequest = `{"command":["get_property","time-pos"],"request_id":1}` + "\n" +
	`{"command":["get_property","duration"],"request_id":2}` + "\n" +
	`{"command":["get_property","path"],"request_id":3}` + "\n"

// secondsOrZero отбрасывает всё, что не может быть позицией: отрицательное
// число, значение за границей и NaN с бесконечностью, которые может принести
// испорченный ответ.
func secondsOrZero(v float64) float64 {
	if !plausible(v, maxPositionSeconds) {
		return 0
	}
	return v
}

func millisecondsOrZero(v float64) float64 {
	if !plausible(v, maxPositionSeconds*1000) {
		return 0
	}
	return v / 1000
}

func plausible(v, limit float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v > 0 && v <= limit
}

// ---------- опрос плееров ----------

// httpPoller спрашивает плеер по http. VLC и MPC отдают состояние страницей.
type httpPoller struct {
	url      string
	password string
	parse    func([]byte) (playerReading, error)
}

func (p httpPoller) poll(ctx context.Context) (playerReading, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url, nil)
	if err != nil {
		return playerReading{}, err
	}
	// VLC хочет пароль с пустым именем пользователя.
	if p.password != "" {
		req.SetBasicAuth("", p.password)
	}
	resp, err := playerClient.Do(req)
	if err != nil {
		return playerReading{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return playerReading{}, fmt.Errorf("плеер ответил кодом %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxPlayerBody+1))
	if err != nil {
		return playerReading{}, err
	}
	if len(body) > maxPlayerBody {
		return playerReading{}, errors.New("ответ плеера слишком велик")
	}
	return p.parse(body)
}

var playerClient = &http.Client{Timeout: playerReadTimeout}

// vlcSeek переводит VLC на позицию текущего файла командой http-интерфейса.
func (p httpPoller) vlcSeek(ctx context.Context, pos float64) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url+"?command=seek&val="+strconv.Itoa(int(pos)), nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth("", p.password)
	resp, err := playerClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("VLC ответил кодом %d", resp.StatusCode)
	}
	return nil
}

// mpvPoller говорит с mpv через его канал управления.
type mpvPoller struct{ endpoint string }

func (p mpvPoller) poll(ctx context.Context) (playerReading, error) {
	conn, err := dialPlayer(p.endpoint)
	if err != nil {
		return playerReading{}, err
	}
	defer conn.Close()
	// Отмена опроса закрывает канал — это и разблокирует чтение, которое ждёт
	// плеер, переставший отвечать.
	release := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer release()

	// Сторож вместо срока на сокете: у именованного канала срока нет, и
	// единственный выход — закрыть описатель под читателем.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-time.After(playerReadTimeout):
			_ = conn.Close()
		case <-stop:
		}
	}()

	if _, err := io.WriteString(conn, mpvRequest); err != nil {
		return playerReading{}, err
	}
	var reading playerReading
	// answered отмечает номера, на которые mpv ответил, — с ошибкой или со
	// значением. Ждать двух удачных ответов нельзя: на свойстве, которого mpv
	// сообщить не может, ожидание станет вечным.
	var answeredPos, answeredDur, answeredPath, havePos bool
	reader := bufio.NewReader(io.LimitReader(conn, maxPlayerBody))
	for attempts := 0; attempts < mpvMaxReplies && !(answeredPos && answeredDur && answeredPath); attempts++ {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			break
		}
		var reply mpvReply
		if json.Unmarshal(bytes.TrimSpace(line), &reply) != nil {
			continue
		}
		switch reply.RequestID {
		case 1:
			answeredPos = true
			if v, ok := reply.num(); ok {
				reading.Position, havePos = secondsOrZero(v), true
			}
		case 2:
			answeredDur = true
			if v, ok := reply.num(); ok {
				reading.Duration = secondsOrZero(v)
			}
		case 3:
			answeredPath = true
			if reply.Error == "success" {
				_ = json.Unmarshal(reply.Data, &reading.Path)
			}
		}
	}
	if !havePos {
		return playerReading{}, errors.New("mpv не сообщил позицию")
	}
	return reading, nil
}

// seek переводит mpv на позицию текущего файла.
func (p mpvPoller) seek(ctx context.Context, pos float64) error {
	conn, err := dialPlayer(p.endpoint)
	if err != nil {
		return err
	}
	defer conn.Close()
	release := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer release()
	cmd := `{"command":["seek",` + strconv.FormatFloat(pos, 'f', 3, 64) + `,"absolute"],"request_id":9}` + "\n"
	if _, err := io.WriteString(conn, cmd); err != nil {
		return err
	}
	reader := bufio.NewReader(io.LimitReader(conn, maxPlayerBody))
	for i := 0; i < mpvMaxReplies; i++ {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return err
		}
		var reply mpvReply
		if json.Unmarshal(bytes.TrimSpace(line), &reply) == nil && reply.RequestID == 9 {
			if reply.Error != "success" {
				return errors.New("mpv: " + reply.Error)
			}
			return nil
		}
	}
	return errors.New("mpv не подтвердил переход")
}

// dialPlayer открывает канал управления mpv. Windows приходит к именованному
// каналу через пространство \\.\pipe\, которое os.OpenFile передаёт в CreateFile.
//
// Срок на открытие нужен потому, что CreateFile ждёт, когда канал существует,
// но свободных экземпляров нет, — он не отказывает. Без срока один занятый
// канал подвесил бы наблюдение.
func dialPlayer(endpoint string) (net.Conn, error) {
	if strings.HasPrefix(endpoint, `\\.\pipe\`) {
		type result struct {
			f   *os.File
			err error
		}
		ch := make(chan result, 1)
		go func() {
			f, err := os.OpenFile(endpoint, os.O_RDWR, 0)
			ch <- result{f, err}
		}()
		select {
		case r := <-ch:
			if r.err != nil {
				return nil, r.err
			}
			return pipeConn{r.f}, nil
		case <-time.After(playerReadTimeout):
			return nil, errors.New("канал управления плеера занят")
		}
	}
	return net.DialTimeout("unix", endpoint, playerReadTimeout)
}

// pipeConn приводит файл именованного канала к net.Conn: сроков у него нет,
// но чтение и закрытие нужны те же.
type pipeConn struct{ f *os.File }

func (c pipeConn) Read(b []byte) (int, error)       { return c.f.Read(b) }
func (c pipeConn) Write(b []byte) (int, error)      { return c.f.Write(b) }
func (c pipeConn) Close() error                     { return c.f.Close() }
func (c pipeConn) LocalAddr() net.Addr              { return pipeAddr{} }
func (c pipeConn) RemoteAddr() net.Addr             { return pipeAddr{} }
func (c pipeConn) SetDeadline(time.Time) error      { return nil }
func (c pipeConn) SetReadDeadline(time.Time) error  { return nil }
func (c pipeConn) SetWriteDeadline(time.Time) error { return nil }

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "pipe" }

// ---------- канал связи, который дописывается к запуску ----------

// playerChannel описывает, как следить за плеером и как передать ему позицию.
type playerChannel struct {
	// args дописываются к настроенным аргументам запуска.
	args []string
	// poll опрашивает плеер, или nil, если плеер о позиции не сообщает.
	poll func(ctx context.Context) (playerReading, error)
	// resumeArgs строит переход на сохранённую позицию в строке запуска.
	// Только для плееров, у которых позиция из строки запуска относится к
	// первому файлу: mpv и VLC применяют --start ко всем файлам плейлиста, и
	// следующая серия начиналась с места, где остановилась прошлая.
	resumeArgs func(pos float64) []string
	// seek переводит плеер на позицию текущего файла по каналу управления.
	seek func(ctx context.Context, pos float64) error
}

// channelFor готовит канал связи с плеером.
//
// Настроенные пользователем аргументы не трогаются: флаги наблюдения
// добавляются при запуске, поэтому своя строка запуска продолжает работать.
// Плеер, о позиции не сообщающий, получает пустой канал — запуск от этого не
// страдает, просто позиция останется ручной.
func channelFor(key string) playerChannel {
	switch key {
	case "vlc":
		port, err := freePort()
		if err != nil {
			return playerChannel{}
		}
		password := randomToken()
		// Разбор ответа берётся у значения, а не у литерала: у литерала метод
		// доступен только в скобках, а канал связи от этого не становится яснее.
		asker := httpPoller{
			url:      "http://127.0.0.1:" + strconv.Itoa(port) + "/requests/status.json",
			password: password,
			parse:    parseVLCStatus,
		}
		return playerChannel{
			args: []string{
				"--extraintf=http",
				"--http-port=" + strconv.Itoa(port),
				"--http-password=" + password,
			},
			poll: asker.vlcPoll,
			seek: asker.vlcSeek,
		}
	case "mpv":
		pipe := `\\.\pipe\torrclient-mpv-` + randomToken()
		asker := mpvPoller{endpoint: pipe}
		return playerChannel{
			args: []string{"--input-ipc-server=" + pipe},
			poll: asker.poll,
			seek: asker.seek,
		}
	case "mpc", "mpcbe":
		// Порт веб-интерфейса у семейства MPC постоянен, но сам интерфейс
		// включается настройкой плеера. Если он выключен, наблюдение просто не
		// сложится — запуск и воспроизведение от этого не зависят.
		asker := httpPoller{
			url:   "http://127.0.0.1:13579/variables.html",
			parse: parseMPCVariables,
		}
		return playerChannel{
			poll: asker.poll,
			// MPC-HC и MPC-BE: «/start <мс>» — начать с позиции.
			resumeArgs: func(pos float64) []string {
				return []string{"/start", strconv.Itoa(int(pos * 1000))}
			},
		}
	}
	return playerChannel{}
}

// freePort выбирает свободный порт на адресе замыкания на себя. Удержать его
// до запуска плеера нельзя — это делает только сам запуск.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// randomToken — непредсказуемое имя канала и пароль http-интерфейса: к ним
// может обратиться любая программа на машине, и знать их заранее она не должна.
func randomToken() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	const hex = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2] = hex[c>>4]
		out[i*2+1] = hex[c&0xf]
	}
	return string(out)
}

// ---------- отметки просмотра ----------

// viewedMark — отметка одного файла раздачи.
type viewedMark struct {
	Pos      float64 `json:"pos"`
	Duration float64 `json:"duration,omitempty"`
	Done     bool    `json:"done,omitempty"`
	Updated  int64   `json:"updated"`
}

// viewedStore хранит отметки просмотра рядом с демоном.
//
// Свой склад, а не /viewed самого TorrServer: тот отмечает файл просмотренным
// уже в момент начала потока и не различает «начал» и «досмотрел», а время
// сохраняет только то, которое в него положили. Здесь у отметки есть и позиция,
// и длительность, и признак «досмотрено».
type viewedStore struct {
	mu   sync.Mutex
	data map[string]map[int]*viewedMark
}

var viewedMarks = &viewedStore{data: map[string]map[int]*viewedMark{}}

// viewedPath — файл отметок просмотра в папке постоянных данных. Отметки — это
// состояние: по ним работает «продолжить просмотр», и собрать их заново нельзя.
func viewedPath() string {
	return filepath.Join(dataDir(), "viewed.json")
}

// viewedMaxAge — сколько отметка живёт без обращения. Файл отметок иначе растёт
// вечно: каждая просмотренная серия оставляет в нём запись навсегда, и через год
// в нём лежат серии, которых давно нет ни в библиотеке, ни на диске.
const viewedMaxAge = 90 * 24 * time.Hour

func (s *viewedStore) load() {
	s.mu.Lock()
	// Файл без номера формата (прежние сборки) читается как есть. Файл
	// записей новой версии и битый файл оставляют склад пустым, но не
	// стираются: следующая запись переписала бы то, что прочесть не удалось,
	// и вернуть было бы уже нечего.
	var data map[string]map[int]*viewedMark
	if readStateDoc(viewedPath(), &data) == nil && data != nil {
		s.data = data
	}
	s.mu.Unlock()
	// Обрезка при чтении: файл, оставшийся от прежних запусков, не должен ждать
	// суточного сторожа, чтобы избавиться от прошлогодних записей.
	if s.prune(viewedMaxAge) > 0 {
		_ = s.save()
	}
}

// prune выбрасывает отметки, к которым не обращались дольше maxAge, и отдаёт
// число выброшенных. Раздачи без оставшихся файлов уходят целиком.
func (s *viewedStore) prune(maxAge time.Duration) int {
	cutoff := time.Now().Add(-maxAge).Unix()
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for hash, files := range s.data {
		for id, m := range files {
			if m == nil || m.Updated < cutoff {
				delete(files, id)
				n++
			}
		}
		if len(files) == 0 {
			delete(s.data, hash)
		}
	}
	return n
}

// viewedJanitor раз в сутки обрезает отметки просмотра. Отметки, поставленные в
// долгом сеансе, попадают на диск с периодическим сбросом и при закрытии плеера;
// без сторожа прошлогодние записи оставались бы там, пока кто-нибудь не
// перезапустит демон.
func viewedJanitor() {
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for range t.C {
		if viewedMarks.prune(viewedMaxAge) > 0 {
			_ = viewedMarks.save()
		}
	}
}

func (s *viewedStore) save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return writeStateDoc(viewedPath(), s.data)
}

func (s *viewedStore) set(hash string, fileID int, mark viewedMark) {
	if !s.setMemory(hash, fileID, mark) {
		return
	}
	_ = s.save()
}

// setMemory обновляет отметку, не переписывая файл на диск.
//
// Отдельно от set потому, что замер позиции приходит каждые пять секунд: писать
// ради него файл так же часто незачем. На диск отметку кладёт периодический
// сброс (viewedFlushDue) и запись при выходе плеера.
func (s *viewedStore) setMemory(hash string, fileID int, mark viewedMark) bool {
	if hash == "" || fileID <= 0 {
		return false
	}
	mark.Updated = time.Now().Unix()
	s.mu.Lock()
	files := s.data[hash]
	if files == nil {
		files = map[int]*viewedMark{}
		s.data[hash] = files
	}
	files[fileID] = &mark
	s.mu.Unlock()
	// Отметку видит и открытое окно: без события ему пришлось бы переспрашивать
	// список каждые десять секунд, пока играет внешний плеер.
	notifyPositions(hash, fileID, mark)
	return true
}

func (s *viewedStore) get(hash string, fileID int) (viewedMark, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	files := s.data[hash]
	if files == nil {
		return viewedMark{}, false
	}
	m, ok := files[fileID]
	if !ok || m == nil {
		return viewedMark{}, false
	}
	return *m, true
}

// resumeOf отдаёт позицию, с которой продолжать файл.
//
// Продолжение возможно только флагом запуска плеера: TorrServer параметр pos в
// адресе потока не разбирает вовсе, поэтому ссылка с ним ничего не меняет.
// Досмотренный файл начинается заново — это и есть «следующая серия».
func resumeOf(hash string, fileID int) float64 {
	m, ok := viewedMarks.get(hash, fileID)
	if !ok || m.Done || m.Pos <= 0 {
		return 0
	}
	return m.Pos
}

// apiPositions отдаёт отметки просмотра интерфейсу.
//
// Форма ответа повторяет список /viewed у TorrServer: интерфейс уже умеет его
// читать, и замена источника не требует переписывать показ. Признак «досмотрено»
// добавлен отдельным полем — позиция и досмотр это разные вещи.
func (c *Comp) apiPositions(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var in struct {
			Hash      string   `json:"hash"`
			FileIndex int      `json:"file_index"`
			TimeCode  *float64 `json:"timecode"`
			Duration  float64  `json:"duration"`
			Done      *bool    `json:"done"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in) != nil || in.Hash == "" {
			writeJSONError(w, http.StatusBadRequest, "нужен hash")
			return
		}
		mark, _ := viewedMarks.get(in.Hash, in.FileIndex)
		if in.TimeCode != nil {
			mark.Pos = *in.TimeCode
		}
		if in.Duration > 0 {
			mark.Duration = in.Duration
		}
		if in.Done != nil {
			mark.Done = *in.Done
		}
		viewedMarks.set(in.Hash, in.FileIndex, mark)
		jj(w, map[string]any{"ok": true})
		return
	}
	type row struct {
		Hash      string  `json:"hash"`
		FileIndex int     `json:"file_index"`
		TimeCode  float64 `json:"timecode"`
		Duration  float64 `json:"duration,omitempty"`
		Done      bool    `json:"done,omitempty"`
		// Updated — время последней отметки: по нему интерфейс строит порядок
		// «продолжить просмотр», от свежего к старому.
		Updated int64 `json:"updated,omitempty"`
	}
	viewedMarks.mu.Lock()
	out := []row{}
	for hash, files := range viewedMarks.data {
		for id, m := range files {
			if m == nil {
				continue
			}
			out = append(out, row{Hash: hash, FileIndex: id, TimeCode: m.Pos, Duration: m.Duration, Done: m.Done, Updated: m.Updated})
		}
	}
	viewedMarks.mu.Unlock()
	jj(w, out)
}

// ---------- наблюдение за запущенным плеером ----------

// playerSession — запущенный плеер, за которым следит демон.
type playerSession struct {
	hash   string
	fileID int
	poll   func(ctx context.Context) (playerReading, error)
	// seek — переход на позицию текущего файла; nil — плеер не умеет.
	seek func(ctx context.Context, pos float64) error
	// names — имена файлов раздачи → номер: VLC и MPC сообщают имя, а не адрес.
	names map[string]int
	// fetchNames — повторный запрос имён, если при запуске их не было.
	fetchNames func() map[string]int
	namesAt    time.Time
	// seeked — файлы, которые уже переведены на сохранённую позицию.
	seeked map[int]bool
}

// streamIndex достаёт номер файла из адреса потока (…&index=N&…).
var streamIndex = regexp.MustCompile(`[?&]index=([0-9]+)`)

// currentFile — какая серия плейлиста играет сейчас. Плейлист идёт по всей
// раздаче, и без этого позиция следующей серии записывалась в отметку той, с
// которой начали.
func (s *playerSession) currentFile(r playerReading) int {
	if m := streamIndex.FindStringSubmatch(r.Path); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			return n
		}
	}
	if r.Name != "" {
		if id, ok := matchFileName(s.names, r.Name); ok {
			return id
		}
		// Имена раздачи могли не прийти при запуске (сервер ещё не отдал
		// список файлов) — спрашиваем снова, не чаще раза в полминуты.
		if s.fetchNames != nil && time.Since(s.namesAt) > 30*time.Second {
			s.namesAt = time.Now()
			if n := s.fetchNames(); len(n) > 0 {
				s.names = n
				if id, ok := matchFileName(s.names, r.Name); ok {
					return id
				}
			}
		}
	}
	return s.fileID
}

// matchFileName ищет файл по имени, которое сообщил плеер: дословно, затем
// без регистра и с раскодированным адресом («%20», «+»).
func matchFileName(names map[string]int, name string) (int, bool) {
	if len(names) == 0 {
		return 0, false
	}
	if id, ok := names[name]; ok {
		return id, true
	}
	norm := func(v string) string {
		if u, err := url.PathUnescape(v); err == nil {
			v = u
		}
		return strings.ToLower(strings.TrimSpace(v))
	}
	want := norm(name)
	for n, id := range names {
		if norm(n) == want {
			return id, true
		}
	}
	return 0, false
}

// resumeHere переводит только что открытую серию на её сохранённую позицию.
// Возвращает true, если замер надо пропустить: он снят до перехода, и его
// позиция (начало файла) затёрла бы сохранённую.
func (s *playerSession) resumeHere(ctx context.Context, id int, r playerReading) bool {
	if s.seek == nil || s.seeked[id] {
		return false
	}
	pos := resumeOf(s.hash, id)
	if pos < 5 || r.Position >= pos-5 {
		s.seeked[id] = true
		return false
	}
	if s.seek(ctx, pos) == nil {
		s.seeked[id] = true
	}
	return true
}

// markAfterReading считает отметку по замеру плеера.
//
// Досмотр ставится на доле длительности, а не по факту начала потока: сервер
// отмечает файл просмотренным уже при подключении. Досмотренная серия
// начинается заново — позиция обнуляется, остаётся только отметка.
//
// Отдельной функцией потому, что это правило, а не подробность опроса: его
// проверяют тестом без запуска плеера.
func markAfterReading(prev viewedMark, hasPrev bool, r playerReading) viewedMark {
	mark := viewedMark{Pos: r.Position, Duration: r.Duration}
	if hasPrev && prev.Done {
		mark.Done = true
	}
	if r.Duration > 0 && r.Position >= r.Duration*watchedShare {
		mark.Done = true
		mark.Pos = 0
	}
	return mark
}

// playersWatching — сколько внешних плееров сейчас показывают. Пока идёт
// просмотр, фоновые опросы сервера редеют: цифры раздач в это время никому не
// нужны, а каждый запрос отнимает у сервера время, нужное потоку.
var playersWatching atomic.Int32

// watchPlayer снимает позицию, пока плеер играет, и запоминает её.
//
// Наблюдение прекращается, когда плеер закрылся или так и не ответил ни разу:
// молчащий канал связи не должен опрашиваться вечно. Досмотр серии наблюдение
// не завершает — плейлист идёт дальше, и следующей серии тоже нужна отметка.

func (c *Comp) watchPlayer(ctx context.Context, s *playerSession, done <-chan struct{}) {
	go func() {
		playersWatching.Add(1)
		defer playersWatching.Add(-1)
		ticker := time.NewTicker(watchInterval)
		defer ticker.Stop()
		// Отметка живёт в памяти и раз в полминуты идёт на диск (viewedFlushDue):
		// писать файл на каждый замер незачем, но и ждать закрытия плеера нельзя.
		lastFlush := time.Now()
		wantSave := false
		defer func() {
			if wantSave {
				_ = viewedMarks.save()
			}
		}()
		deadline := time.Now().Add(watchStartGrace)
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				wantSave = true
				return
			case <-ticker.C:
			}
			r, err := s.poll(ctx)
			if err != nil {
				if time.Now().After(deadline) {
					wantSave = true
					return
				}
				continue
			}
			deadline = time.Now().Add(watchStartGrace)
			id := s.currentFile(r)
			sleepNoteFile(s.hash, id)
			if s.seeked == nil {
				s.seeked = map[int]bool{}
			}
			if s.resumeHere(ctx, id, r) {
				continue
			}
			prev, ok := viewedMarks.get(s.hash, id)
			mark := markAfterReading(prev, ok, r)
			viewedMarks.setMemory(s.hash, id, mark)
			wantSave = true
			if now := time.Now(); viewedFlushDue(lastFlush, now) {
				if viewedMarks.save() == nil {
					lastFlush = now
				}
			}
			// Досмотренная серия не конец наблюдения: плейлист идёт дальше, и
			// следующую серию тоже надо отмечать.
		}
	}()
}

// watchWithoutChannel следит за плеером, который о позиции не сообщает.
//
// Позиция здесь — оценка по времени работы плеера: точной её взять неоткуда, а
// без неё серия не попадёт в «продолжить просмотр». На отметку досмотра оценка
// не влияет: досмотр ставится по прочитанному из потока (markReadThrough), а не
// по времени, поэтому пауза или перемотка отмечают не больше, чем просмотрено.
func watchWithoutChannel(hash string, fileID int, done <-chan struct{}) {
	go func() {
		started := time.Now()
		ticker := time.NewTicker(watchInterval)
		defer ticker.Stop()
		// Оценка идёт на диск раз в полминуты, а не только при закрытии плеера:
		// аварийное завершение иначе уносило бы позицию всего сеанса.
		lastFlush := time.Now()
		for {
			select {
			case <-done:
				// Плеер закрылся — последняя оценка идёт на диск.
				_ = viewedMarks.save()
				return
			case <-ticker.C:
			}
			prev, ok := viewedMarks.get(hash, fileID)
			if ok && prev.Done {
				// Досмотр поставил счётчик прочитанного: время больше не нужно.
				return
			}
			prev.Pos = time.Since(started).Seconds()
			viewedMarks.setMemory(hash, fileID, prev)
			if now := time.Now(); viewedFlushDue(lastFlush, now) {
				if viewedMarks.save() == nil {
					lastFlush = now
				}
			}
		}
	}()
}

// startPlayer запускает плеер и, если он умеет сообщать позицию, ставит
// наблюдение. Возвращает признак того, что переход на сохранённую позицию был
// передан плееру: запуск с начала — не ошибка, но пользователь должен знать,
// сработало ли продолжение.
func (c *Comp) startPlayer(p *Player, args []string, hash string, fileID int, pos float64) (resumeApplied bool, watching bool, err error) {
	channel := channelFor(p.Key)
	if channel.poll != nil && pos > 0 && channel.resumeArgs != nil {
		args = append(args, channel.resumeArgs(pos)...)
		resumeApplied = true
	}
	if channel.poll != nil && pos > 0 && channel.seek != nil {
		resumeApplied = true
	}
	args = append(args, channel.args...)

	cmd := exec.Command(p.Path, args...)
	if err := cmd.Start(); err != nil {
		return false, false, err
	}
	// Процесс хоронится здесь, а не вызывающим: запуск, за результатом
	// которого никто не следит, не должен оставлять за собой зомби.
	done := make(chan struct{})
	trackPlayer(cmd)
	go func() {
		defer close(done)
		_ = cmd.Wait()
		untrackPlayer(cmd)
		sleepPlayerExited()
	}()
	if channel.poll == nil {
		// Плеер о позиции не сообщает, но наблюдение всё равно нужно: без него
		// серия не отметится никогда.
		watchWithoutChannel(hash, fileID, done)
		return resumeApplied, false, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-done
		cancel()
	}()
	c.watchPlayer(ctx, &playerSession{hash: hash, fileID: fileID, poll: channel.poll, seek: channel.seek, names: fileNames(hash), fetchNames: func() map[string]int { return fileNames(hash) }, namesAt: time.Now()}, done)
	return resumeApplied, true, nil
}

// fileNames — имена файлов раздачи и их номера, в том виде, в каком они стоят
// в плейлисте (#EXTINF): под этим именем файл показывают VLC и MPC.
func fileNames(hash string) map[string]int {
	st, err := fetchTorrentStatus(hash)
	if err != nil {
		return nil
	}
	out := map[string]int{}
	for _, f := range playableFiles(st.Files) {
		out[playlistEntryName(f)] = f.ID
	}
	return out
}
