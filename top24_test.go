package main

import (
	"testing"
	"time"
)

func TestFreshDayAndMergeTop(t *testing.T) {
	now := time.Date(2026, 10, 7, 15, 0, 0, 0, time.Local)
	for in, want := range map[string]bool{"07 Окт 26": true, "06\u00a0Окт\u00a026": true, "05 Окт 26": false, "мусор": false} {
		if got := freshDay(rutorItem{Date: in}, now); got != want {
			t.Errorf("freshDay(%q) = %v", in, got)
		}
	}
	got := mergeTop([]rutorItem{{Hash: "A", Seed: 5}, {Hash: "b", Seed: 50}}, []rutorItem{{Hash: "a", Seed: 9}, {Link: "x", Seed: 20}})
	if len(got) != 3 || got[0].Seed != 50 || got[1].Seed != 20 {
		t.Fatalf("сводка ТОПа: %+v", got)
	}
}
