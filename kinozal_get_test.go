package main

import (
	"crypto/sha1"
	"encoding/hex"
	"testing"
)

func TestTorrentInfoHash(t *testing.T) {
	info := "d6:lengthi12345e4:name8:film.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae"
	tor := []byte("d8:announce14:http://t/annou7:comment2:hi4:info" + info + "e")
	sum := sha1.Sum([]byte(info))
	h, err := torrentInfoHash(tor)
	if err != nil || h != hex.EncodeToString(sum[:]) {
		t.Fatalf("хеш %q %v", h, err)
	}
	if _, err := torrentInfoHash([]byte("<html>вход</html>")); err == nil {
		t.Fatal("страница входа принята за .torrent")
	}
}

func TestPickSameRelease(t *testing.T) {
	items := []rutorItem{
		{Title: "Дюна / Dune (2021) WEB-DL 720p", Size: "4.1 GB", Seed: 90, Hash: "a"},
		{Title: "Дюна / Dune (2021) BDRip 1080p", Size: "14.32 GB", Seed: 10, Hash: "b"},
		{Title: "Дюна / Dune (1984) BDRip 1080p", Size: "14.3 GB", Seed: 50, Hash: "c"},
	}
	it, ok := pickSameRelease(items, "Дюна / Dune / 2021 / ПМ / BDRip (1080p)", "14.3 ГБ")
	if !ok || it.Hash != "b" {
		t.Fatalf("та же раздача: %+v %v", it, ok)
	}
	it, ok = pickSameRelease(items, "Дюна / Dune / 2021 / ПМ / BDRip (1080p)", "")
	if !ok || it.Hash != "a" {
		t.Fatalf("без размера — больше сидов: %+v %v", it, ok)
	}
}
