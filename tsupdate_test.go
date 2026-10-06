package main

import "testing"

func TestTsNewer(t *testing.T) {
	if !tsNewer("MatriX.145.2", "MatriX.135") || tsNewer("MatriX.135", "MatriX.145.2") || tsNewer("MatriX.145.2", "MatriX.145.2") {
		t.Fatal("сравнение версий")
	}
	if !tsNewer("MatriX.145.2", "MatriX.145.1") {
		t.Fatal("младший номер")
	}
	if tsAssetName("windows", "amd64") != "TorrServer-windows-amd64.exe" {
		t.Fatal("имя файла")
	}
	if !isLocalURL("http://127.0.0.1:8090") || isLocalURL("http://192.168.1.5:8090") {
		t.Fatal("локальный адрес")
	}
	if !execHeader([]byte("MZ\x90\x00")) || execHeader([]byte("<htm")) {
		t.Fatal("заголовок")
	}
}
