package main

import (
	"regexp"
	"strings"
	"testing"
)

func TestAppVersionComesFromFile(t *testing.T) {
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(appVersion()) {
		t.Fatalf("VERSION должен быть вида 1.2.3, а не %q", appVersion())
	}
	if !strings.Contains(version, appVersion()) && !strings.HasPrefix(version, "TorrClient ") {
		t.Fatalf("строка версии %q не содержит номер %q", version, appVersion())
	}
}
