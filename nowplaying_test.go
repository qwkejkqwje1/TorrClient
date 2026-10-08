package main

import "testing"

func TestNowPlayingLifecycle(t *testing.T) {
	id := nowStart("abc", 1, "mpv")
	defer nowStop(id)
	l := nowList()
	found := false
	for _, it := range l {
		if it.ID == id && it.Hash == "abc" && it.FileIndex == 1 && it.Player == "mpv" {
			found = true
		}
	}
	if !found {
		t.Fatalf("запуск не попал в список: %+v", l)
	}
	nowTrack("abc", 3, 42, 100)
	for _, it := range nowList() {
		if it.ID == id && (it.FileIndex != 3 || it.Pos != 42) {
			t.Fatalf("серия плейлиста не обновилась: %+v", it)
		}
	}
	nowStop(id)
	for _, it := range nowList() {
		if it.ID == id {
			t.Fatal("закрытый плеер остался в списке")
		}
	}
}
