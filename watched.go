package main

// Отметка просмотра без участия плеера.
//
// Позицию сообщают не все плееры: PotPlayer и KMPlayer молчат всегда, MPC — пока
// в нём не включён веб-интерфейс, браузер — вообще не плеер. Из-за этого серия,
// просмотренная таким плеером, не отмечалась никогда: закладку приходилось
// ставить руками.
//
// Но поток идёт через демон, и демон видит, сколько байт из файла вычитал
// клиент. Этого достаточно для отметки досмотра: файл, прочитанный до конца,
// просмотрен — каким бы плеером его ни смотрели. Так отметка появляется и у
// плеера, о позиции не сообщающего, и при показе в браузере.

import (
	"io"
	"strconv"
	"strings"
	"sync"
)

// readThroughPercent — какую долю файла должен получить клиент, чтобы файл
// считался просмотренным.
//
// Строже, чем порог по позиции (watchedShare, восемь десятых): плеер читает
// поток с опережением, и прочитанное обгоняет показанное. Ровно тот же порог
// означал бы, что серия отмечается досмотренной раньше, чем досмотрена.
//
// Порог — целое число процентов, а не доля: сравнение целых не зависит от того,
// как ляжет в двоичную дробь 0,9, и на границе не даёт случайного ответа.
const readThroughPercent = 90

// readStore считает, сколько байт каждого файла ушло клиенту.
//
// Сумма, а не последний ответ: плеер перематывает и запрашивает куски заново,
// поэтому «сколько прочитано» — это всё, что ушло по всем запросам вместе.
type readStore struct {
	mu   sync.Mutex
	data map[string]map[int]int64
}

var viewedReads = &readStore{data: map[string]map[int]int64{}}

func (s *readStore) add(hash string, fileID int, n int64) {
	if hash == "" || fileID <= 0 || n <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	files := s.data[hash]
	if files == nil {
		files = map[int]int64{}
		s.data[hash] = files
	}
	files[fileID] += n
}

func (s *readStore) bytes(hash string, fileID int) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data[hash][fileID]
}

// readThrough отвечает, прочитан ли файл.
//
// Неизвестный размер — это «нет», а не «да»: у раздачи без сведений о файле
// отметка досмотра была бы выдумкой.
func readThrough(delivered, total int64) bool {
	if total <= 0 || delivered <= 0 {
		return false
	}
	return delivered*100 >= total*readThroughPercent
}

// countingWriter считает байты, дошедшие до клиента. Считается записанное, а не
// прочитанное из сервера: оборванная передача — это не просмотр.
type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(b []byte) (int, error) {
	n, err := c.w.Write(b)
	c.n += int64(n)
	return n, err
}

// readTarget разбирает адрес потока: из какого файла читает клиент.
//
// Запрос состояния раздачи идёт по тому же пути (/stream?link=…&stat), но файла
// в нём нет — по нему ничего не читают, и считать там нечего.
func readTarget(path string, query func(string) string) (hash string, fileID int) {
	if !strings.HasPrefix(path, "/stream/") {
		return "", 0
	}
	return strings.TrimSpace(query("link")), atoiSafe(query("index"))
}

// fileLengthCache — размеры файлов раздач. Размер не меняется, а спрашивать его
// у сервера на каждый запрос потока незачем. Указатель, а не значение: копия
// sync.Map копировала бы вместе с ней и замок.
var fileLengthCache = &sync.Map{}

// fileLength — размер файла раздачи. У плеера, о позиции не сообщающего, размера
// не узнать, поэтому он спрашивается у сервера.
func fileLength(hash string, fileID int) int64 {
	if hash == "" || fileID <= 0 {
		return 0
	}
	key := hash + "/" + strconv.Itoa(fileID)
	if v, ok := fileLengthCache.Load(key); ok {
		return v.(int64)
	}
	st, err := fetchTorrentStatus(hash)
	if err != nil {
		return 0
	}
	var n int64
	for _, f := range st.Files {
		if f != nil && f.ID == fileID {
			n = f.Length
			break
		}
	}
	if n > 0 {
		fileLengthCache.Store(key, n)
	}
	return n
}

// markReadThrough ставит досмотр, если файл прочитан до конца.
//
// Досмотренная серия начинается заново — так же, как при отметке по позиции:
// позиция обнуляется, остаётся признак «просмотрено».
func markReadThrough(hash string, fileID int, total int64) {
	if hash == "" || fileID <= 0 {
		return
	}
	if prev, ok := viewedMarks.get(hash, fileID); ok && prev.Done {
		return
	}
	if !readThrough(viewedReads.bytes(hash, fileID), total) {
		return
	}
	viewedMarks.set(hash, fileID, viewedMark{Done: true})
}
