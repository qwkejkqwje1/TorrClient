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
	files, _ := filepath.Glob(filepath.Join("web", "src", "*.js"))
	if len(files) == 0 {
		t.Skip("web/src нет")
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
	cur, err := os.ReadFile(filepath.Join("web", "app.js"))
	if err != nil {
		t.Fatal(err)
	}
	if string(cur) != string(all) {
		t.Fatal("web/app.js не совпадает со склейкой web/src/*.js — запустите: node tools/build-web.cjs")
	}
}
