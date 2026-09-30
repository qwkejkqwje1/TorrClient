package main

import "testing"

func TestTranslitToCyr(t *testing.T) {
	for in, want := range map[string]string{
		"Trudno byt bogom": "трудно быт богом",
		"Slovo patsana":    "слово пацана",
		"Shchit i mech":    "щит и меч",
		"Zhizn":            "жизн",
		"Игра престолов":   "",
		"2012":             "",
	} {
		if got := translitToCyr(in); got != want {
			t.Errorf("translitToCyr(%q) = %q, want %q", in, got, want)
		}
	}
}
