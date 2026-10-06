package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestVLCPlaylistGivesTheCurrentEpisode: серия плейлиста VLC узнаётся по
// адресу элемента, а не по имени, — иначе позиции следующих серий
// записывались на первую.
func TestVLCPlaylistGivesTheCurrentEpisode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/requests/status.json":
			w.Write([]byte(`{"state":"playing","time":120,"length":1300,"currentplid":7,"information":{"category":{"meta":{"filename":"Другое имя.mkv"}}}}`))
		case "/requests/playlist.json":
			w.Write([]byte(`{"id":"0","children":[{"id":"1","name":"Плейлист","children":[{"id":"6","uri":"http://127.0.0.1:8099/ts/stream/a.mkv?link=h&index=2&play"},{"id":"7","uri":"http://127.0.0.1:8099/ts/stream/b.mkv?link=h&index=3&play"}]}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	p := httpPoller{url: srv.URL + "/requests/status.json", password: "x", parse: parseVLCStatus}
	r, err := p.vlcPoll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s := &playerSession{hash: "h", fileID: 2, names: map[string]int{"a.mkv": 2, "b.mkv": 3}}
	if got := s.currentFile(r); got != 3 {
		t.Fatalf("текущая серия %d, ожидалась 3 (путь %q)", got, r.Path)
	}
}

func TestMatchFileNameIgnoresCaseAndEscapes(t *testing.T) {
	names := map[string]int{"Rick and Morty S01E02.mkv": 2}
	if id, ok := matchFileName(names, "rick%20and%20morty%20s01e02.mkv"); !ok || id != 2 {
		t.Fatalf("имя не узнано: %d %v", id, ok)
	}
}
