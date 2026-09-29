package main

import "testing"

func TestMergeNewItemsStage2(t *testing.T) {
	seen := map[string]bool{}
	first := mergeNewItems(seen, []rutorItem{
		{Title: "a", Hash: "AA", Seed: 1},
		{Title: "b", Hash: "bb", Seed: 5},
		{Title: "a-dup", Hash: "aa", Seed: 9},
	})
	if len(first) != 2 {
		t.Fatalf("ожидали 2 раздачи, получили %d", len(first))
	}
	if first[0].Title != "b" {
		t.Fatalf("ожидали сортировку по сидам, первая: %q", first[0].Title)
	}
	second := mergeNewItems(seen, []rutorItem{{Title: "c", Hash: "bb"}, {Title: "d", Magnet: "magnet:?x"}})
	if len(second) != 1 || second[0].Title != "d" {
		t.Fatalf("повтор по хешу должен отсеиваться: %+v", second)
	}
}

func TestRutorPopularPathStage2(t *testing.T) {
	got := rutorPopularPath(2, 1, "a b")
	want := "/search/2/1/000/2/a+b"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if rutorPopularPath(0, 0, "") != "/search/0/0/000/2/" {
		t.Fatalf("пустой запрос должен давать «всё в категории»")
	}
}
