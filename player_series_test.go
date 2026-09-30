package main

import (
	"context"
	"testing"
)

// Плейлист идёт по всей раздаче, и плеер сам переходит к следующей серии.
// Отметка должна уходить той серии, что играет, а не той, с которой начали.
func TestCurrentFileFollowsThePlaylist(t *testing.T) {
	s := &playerSession{fileID: 1, names: map[string]int{"Show.S01E02.mkv": 2}}
	if got := s.currentFile(playerReading{Path: "http://127.0.0.1:8090/ts/stream/Show.S01E03.mkv?link=abc&index=3&play"}); got != 3 {
		t.Errorf("по адресу mpv: файл %d, ожидался 3", got)
	}
	if got := s.currentFile(playerReading{Name: "Show.S01E02.mkv"}); got != 2 {
		t.Errorf("по имени VLC/MPC: файл %d, ожидался 2", got)
	}
	if got := s.currentFile(playerReading{Name: "неизвестный.mkv"}); got != 1 {
		t.Errorf("без сведений: файл %d, ожидался исходный 1", got)
	}
}

func TestParseVLCStatusReadsTheFileName(t *testing.T) {
	got, err := parseVLCStatus([]byte(`{"time":10,"length":2700,"state":"playing",` +
		`"information":{"category":{"meta":{"filename":"Show.S01E02.mkv"}}}}`))
	if err != nil {
		t.Fatalf("разбор ответа VLC: %v", err)
	}
	if got.Name != "Show.S01E02.mkv" {
		t.Errorf("имя = %q, ожидалось Show.S01E02.mkv", got.Name)
	}
}

func TestParseMPCVariablesReadsTheFileName(t *testing.T) {
	got, err := parseMPCVariables([]byte(`<p id="file">Show &amp; Co.S01E02.mkv</p><p id="position">5000</p><p id="duration">60000</p>`))
	if err != nil {
		t.Fatalf("разбор переменных MPC: %v", err)
	}
	if got.Name != "Show & Co.S01E02.mkv" {
		t.Errorf("имя = %q", got.Name)
	}
}

// Главная ошибка, ради которой всё затевалось: следующая серия начиналась с
// позиции прошлой. Теперь переход делается по отметке именно этой серии, один
// раз, а у не начатой серии не делается вовсе.
func TestResumeHereSeeksOnlyToThisEpisodesMark(t *testing.T) {
	saved := viewedMarks
	defer func() { viewedMarks = saved }()
	viewedMarks = &viewedStore{data: map[string]map[int]*viewedMark{}}
	viewedMarks.setMemory("h", 1, viewedMark{Pos: 1500, Duration: 2700})

	var seeks []float64
	s := &playerSession{hash: "h", fileID: 1, seeked: map[int]bool{},
		seek: func(_ context.Context, pos float64) error { seeks = append(seeks, pos); return nil }}
	ctx := context.Background()

	if !s.resumeHere(ctx, 1, playerReading{Position: 2}) {
		t.Fatal("начатая серия не переведена на сохранённую позицию")
	}
	if s.resumeHere(ctx, 1, playerReading{Position: 3}) {
		t.Error("переход повторён: пользователь не смог бы перемотать назад")
	}
	if s.resumeHere(ctx, 2, playerReading{Position: 1}) {
		t.Error("не начатая серия переведена куда-то: она должна идти с начала")
	}
	if len(seeks) != 1 || seeks[0] != 1500 {
		t.Errorf("переходы = %v, ожидался один на 1500", seeks)
	}
}
