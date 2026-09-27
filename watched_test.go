package main

// Отметка просмотра по прочитанному из потока.
//
// Сеть тесты не трогают: размер файла отдаёт подделанный TorrServer.

import (
	"errors"
	"os"
	"sync"
	"testing"
)

// deliveredWriter отдаёт клиенту не всё: передача может оборваться.
type deliveredWriter struct {
	accept int
	got    int
}

func (w *deliveredWriter) Write(b []byte) (int, error) {
	room := w.accept - w.got
	if room <= 0 {
		return 0, errors.New("передача оборвана")
	}
	if len(b) > room {
		w.got += room
		return room, errors.New("передача оборвана")
	}
	w.got += len(b)
	return len(b), nil
}

// Считать прочитанным то, что не доехало до клиента, нельзя: оборванная
// передача — это не просмотр.
func TestCountingWriterCountsOnlyWhatWasDelivered(t *testing.T) {
	dst := &deliveredWriter{accept: 3}
	cw := &countingWriter{w: dst}
	if _, err := cw.Write([]byte("abcdefgh")); err == nil {
		t.Fatal("обрыв передачи не замечен")
	}
	if cw.n != 3 {
		t.Errorf("считано %d байт, доставлено 3", cw.n)
	}
}

func TestReadThroughWantsAlmostTheWholeFile(t *testing.T) {
	cases := []struct {
		delivered, total int64
		want             bool
		label            string
	}{
		{1000, 1000, true, "файл прочитан целиком"},
		{900, 1000, true, "ровно на пороге"},
		{800, 1000, false, "восемь десятых — ещё не досмотр"},
		{0, 1000, false, "ничего не прочитано"},
		{1000, 0, false, "размер файла неизвестен"},
	}
	for _, c := range cases {
		if got := readThrough(c.delivered, c.total); got != c.want {
			t.Errorf("%s: readThrough(%d, %d) = %v, ожидалось %v",
				c.label, c.delivered, c.total, got, c.want)
		}
	}
}

// Плеер перематывает и запрашивает куски заново: прочитанное складывается из
// всех запросов, иначе полный просмотр никогда не наберёт размер файла.
func TestViewedReadsAddsUpRangeRequests(t *testing.T) {
	saved := viewedReads
	defer func() { viewedReads = saved }()
	viewedReads = &readStore{data: map[string]map[int]int64{}}

	viewedReads.add("abc123", 1, 300)
	viewedReads.add("abc123", 1, 500)
	if got := viewedReads.bytes("abc123", 1); got != 800 {
		t.Fatalf("прочитано %d, ожидалось 800", got)
	}
	if readThrough(viewedReads.bytes("abc123", 1), 1000) {
		t.Error("восемь десятых приняты за полный просмотр")
	}
	viewedReads.add("abc123", 1, 200)
	if !readThrough(viewedReads.bytes("abc123", 1), 1000) {
		t.Error("полный просмотр не набрался из кусков")
	}
}

func TestViewedReadsKeepFilesAndTorrentsApart(t *testing.T) {
	saved := viewedReads
	defer func() { viewedReads = saved }()
	viewedReads = &readStore{data: map[string]map[int]int64{}}

	viewedReads.add("abc123", 1, 100)
	viewedReads.add("abc123", 2, 200)
	viewedReads.add("def456", 1, 300)

	if got := viewedReads.bytes("abc123", 1); got != 100 {
		t.Errorf("первая серия: %d, ожидалось 100", got)
	}
	if got := viewedReads.bytes("abc123", 2); got != 200 {
		t.Errorf("вторая серия: %d, ожидалось 200", got)
	}
	if got := viewedReads.bytes("def456", 1); got != 300 {
		t.Errorf("другая раздача: %d, ожидалось 300", got)
	}
	if got := viewedReads.bytes("abc123", 3); got != 0 {
		t.Errorf("непрочитанный файл: %d, ожидался ноль", got)
	}
	// Номер файла и пустая раздача — не ключ: у отметки без них нет адреса.
	viewedReads.add("abc123", 0, 100)
	viewedReads.add("", 1, 100)
	if len(viewedReads.data) != 2 {
		t.Errorf("счёт заведён без раздачи или без номера файла: %v", viewedReads.data)
	}
}

// Отметка ставится по прочитанному: так серия отмечается и у плеера, который о
// позиции не сообщает, и при показе в браузере.
func TestMarkReadThroughSetsDoneOnlyForAReadFile(t *testing.T) {
	savedMarks := viewedMarks
	defer func() { viewedMarks = savedMarks }()
	viewedMarks = &viewedStore{data: map[string]map[int]*viewedMark{}}
	savedReads := viewedReads
	defer func() { viewedReads = savedReads }()
	viewedReads = &readStore{data: map[string]map[int]int64{}}
	t.Cleanup(func() { os.Remove(viewedPath()) })

	viewedReads.add("abc123", 1, 500)
	markReadThrough("abc123", 1, 1000)
	if _, ok := viewedMarks.get("abc123", 1); ok {
		t.Fatal("наполовину прочитанный файл отмечен просмотренным")
	}

	viewedReads.add("abc123", 1, 400)
	markReadThrough("abc123", 1, 1000)
	mark, ok := viewedMarks.get("abc123", 1)
	if !ok || !mark.Done {
		t.Fatalf("прочитанный файл не отмечен: %+v", mark)
	}
	// Досмотренная серия начинается заново — позиция у отметки обнулена.
	if mark.Pos != 0 {
		t.Errorf("у отметки осталась позиция %v", mark.Pos)
	}
	if got := resumeOf("abc123", 1); got != 0 {
		t.Errorf("досмотренный файл продолжается с %v, ожидался ноль", got)
	}
}

// Отметка не должна сниматься: раз поставленная, она остаётся, даже если счёт
// прочитанного почему-то оказался меньше размера файла.
func TestMarkReadThroughKeepsAnExistingDoneMark(t *testing.T) {
	savedMarks := viewedMarks
	defer func() { viewedMarks = savedMarks }()
	viewedMarks = &viewedStore{data: map[string]map[int]*viewedMark{}}
	savedReads := viewedReads
	defer func() { viewedReads = savedReads }()
	viewedReads = &readStore{data: map[string]map[int]int64{}}

	viewedMarks.set("abc123", 1, viewedMark{Done: true})
	markReadThrough("abc123", 1, 1000)
	mark, ok := viewedMarks.get("abc123", 1)
	if !ok || !mark.Done {
		t.Fatalf("отметка досмотра потеряна: %+v", mark)
	}
}

// Запрос состояния раздачи идёт по тому же пути, что и поток, но файла в нём
// нет: считать по нему нечего.
func TestReadTargetIgnoresTheStatusRequest(t *testing.T) {
	query := func(k string) string {
		return map[string]string{"link": "abc123", "index": "3"}[k]
	}
	if hash, id := readTarget("/stream/01. Серия 1.mkv", query); hash != "abc123" || id != 3 {
		t.Errorf("поток файла разобран как %q/%d", hash, id)
	}
	if hash, id := readTarget("/stream", query); hash != "" || id != 0 {
		t.Errorf("запрос состояния принят за поток: %q/%d", hash, id)
	}
	if hash, id := readTarget("/api/hello", query); hash != "" || id != 0 {
		t.Errorf("посторонний запрос принят за поток: %q/%d", hash, id)
	}
}

// Размер файла берётся у сервера: у плеера, о позиции не сообщающего, размера
// не узнать.
func TestFileLengthReadsTheSizeFromTheServer(t *testing.T) {
	savedCache := fileLengthCache
	fileLengthCache = &sync.Map{}
	t.Cleanup(func() { fileLengthCache = savedCache })

	srv := fakeTorrServer(t, torrentStatus{
		Hash:  "abc123",
		Files: episodeFiles(),
	})
	useFakeServer(t, srv)

	if got := fileLength("abc123", 2); got != 1000 {
		t.Errorf("размер второй серии = %d, ожидалось 1000", got)
	}
	if got := fileLength("abc123", 9); got != 0 {
		t.Errorf("размер несуществующего файла = %d, ожидался ноль", got)
	}
	if got := fileLength("", 2); got != 0 {
		t.Errorf("размер без раздачи = %d, ожидался ноль", got)
	}
}
