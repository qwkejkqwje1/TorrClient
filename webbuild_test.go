package main

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// Интерфейс правится в web/src, а демон отдаёт web/app.js — склейку частей.
// Правка только одной из сторон ломала бы тихо: тест требует совпадения байт
// в байт (собрать: node tools/build-web.cjs).
func TestWebAppJSIsBuiltFromSrc(t *testing.T) {
	checkWebBuilt(t, filepath.Join("web", "src", "*.js"), filepath.Join("web", "app.js"), "node tools/build-web.cjs")
}

// Стили устроены так же: web/css/*.css склеиваются в web/style.css.
func TestWebStyleCSSIsBuiltFromParts(t *testing.T) {
	checkWebBuilt(t, filepath.Join("web", "css", "*.css"), filepath.Join("web", "style.css"), "node tools/build-web.cjs")
}

func checkWebBuilt(t *testing.T, glob, built, how string) {
	files, _ := filepath.Glob(glob)
	if len(files) == 0 {
		t.Skip(glob + ": частей нет")
	}
	sort.Strings(files)
	var all []byte
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, b...)
	}
	cur, err := os.ReadFile(built)
	if err != nil {
		t.Fatal(err)
	}
	if string(cur) != string(all) {
		t.Fatal(built + " не совпадает со склейкой " + glob + " — запустите: " + how)
	}
}
