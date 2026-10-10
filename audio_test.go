package main

import (
	"path/filepath"
	"testing"
)

func TestDeezerPath(t *testing.T) {
	for _, ok := range []string{"search/album?q=daft%20punk&limit=5", "artist/27/related", "artist/27/top?limit=10", "chart/0/albums?limit=20", "album/302127", "genre"} {
		if !deezerPath.MatchString(ok) {
			t.Errorf("должно пропускать %q", ok)
		}
	}
	for _, bad := range []string{"../user/me", "search/album?q=x&access_token=1", "artist/27/../../oauth", "https://evil", "user/5/flow"} {
		if deezerPath.MatchString(bad) {
			t.Errorf("не должно пропускать %q", bad)
		}
	}
}

func TestAudioInside(t *testing.T) {
	root := filepath.FromSlash("/data/dl")
	if !audioInside(root, filepath.FromSlash("/data/dl/book/01.mp3")) {
		t.Fatal("файл внутри папки должен проходить")
	}
	for _, p := range []string{"/data/dl", "/data/dl2/x.mp3", "/data/x.mp3", "/etc/passwd"} {
		if audioInside(root, filepath.FromSlash(p)) {
			t.Errorf("не должно проходить: %s", p)
		}
	}
	if !isAudioExt("a.M4B") || isAudioExt("a.exe") {
		t.Fatal("расширения")
	}
	if !audioImgHost("cdn-images.dzcdn.net") || !audioImgHost("is1-ssl.mzstatic.com") || audioImgHost("evil.com") || audioImgHost("mzstatic.com.evil.com") {
		t.Fatal("хосты обложек")
	}
}
