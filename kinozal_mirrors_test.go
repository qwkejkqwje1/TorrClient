package main

import (
	"strings"
	"testing"
)

func TestKinozalOfficialFirstAndFakesDropped(t *testing.T) {
	got := kinozalOrder(nil, "", false)
	want := []string{"https://kinozal.tv", "https://kinozal.me", "https://kinozal.guru"}
	for i, w := range want {
		if got[i] != w {
			t.Fatalf("позиция %d: %s, ожидалось %s (весь список %v)", i, got[i], w, got)
		}
	}
	for _, b := range got {
		if strings.Contains(b, "jumpingcrab") || strings.Contains(b, "appspot") {
			t.Fatalf("в списке неофициальное зеркало, названное форумом поддельным: %s", b)
		}
	}
}

func TestKinozalOfficialOnlySkipsUnofficial(t *testing.T) {
	got := kinozalOrder([]string{"my.mirror"}, "https://kinozaltv.life", true)
	if len(got) != 4 || got[0] != "https://my.mirror" {
		t.Fatalf("только официальные + свои: %v", got)
	}
	for _, b := range got[1:] {
		if !kinozalIsOfficial(b) {
			t.Fatalf("неофициальное зеркало при запрете: %s", b)
		}
	}
}

func TestKinozalLastGoodGoesFirst(t *testing.T) {
	got := kinozalOrder(nil, "https://kinozaltv.life", false)
	if got[0] != "https://kinozaltv.life" {
		t.Fatalf("последнее рабочее зеркало должно быть первым: %v", got)
	}
	n := 0
	for _, b := range got {
		if b == "https://kinozaltv.life" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("зеркало повторяется %d раз", n)
	}
}

func TestKinozalReasonIsHuman(t *testing.T) {
	cases := map[string]string{
		`кинозал: ... (проверено адресов: 1; последняя причина: https://kinozal.bz: Get "x": dial tcp: lookup kinozal.bz: no such host)`: "домен не найден",
		`https://kinozal.me: код ответа 403`:                               "403: защита от ботов",
		`https://kinozal.tv: отдана не страница выдачи (защита от ботов?)`: "отдана не страница выдачи (защита от ботов?)",
	}
	for in, want := range cases {
		if got := kinozalReason(in); got != want {
			t.Errorf("%q → %q, ожидалось %q", in, got, want)
		}
	}
}
