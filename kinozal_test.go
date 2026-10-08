package main

// Проверки списка зеркал Кинозала.
//
// Домены меняются быстро, и проверять их приходится перебором вживую — но сам
// перебор в сеть ходить не должен. Поэтому состав списка вынесен в чистые
// функции: их и проверяем здесь, а список зеркал перебирает tools/
// check-kinozal.js, который ходит наружу намеренно и в гейты не входит.

import "testing"

// Список из настроек не должен ломать перебор: мусор и повторы отсекаются,
// нормальный хост доезжает наравне со встроенным.
func TestKinozalBasesCleansTheHostList(t *testing.T) {
	cases := []struct {
		name  string
		in    []string
		want  []string
		dropN int
	}{
		{
			name: "обычный хост",
			in:   []string{"kinozal.tv"},
			want: []string{"https://kinozal.tv"},
		},
		{
			name: "регистр не важен",
			in:   []string{"KinoZal.TV"},
			want: []string{"https://kinozal.tv"},
		},
		{
			name: "схема отбрасывается",
			in:   []string{"https://kinozal.tv", "http://kinozal.me"},
			want: []string{"https://kinozal.tv", "https://kinozal.me"},
		},
		{
			name: "слеш на конце отбрасывается",
			in:   []string{"kinozal.tv/"},
			want: []string{"https://kinozal.tv"},
		},
		{
			name: "путь после хоста отбрасывается",
			in:   []string{"kinozal.tv/browse.php?g=0"},
			want: []string{"https://kinozal.tv"},
		},
		{
			// Повтор съедал бы время ожидания впустую: до второго запроса
			// доходит тот же ответ, что и до первого.
			name: "повторы убираются, порядок сохраняется",
			in:   []string{"kinozal.tv", "kinozal.me", "https://kinozal.tv", "KINOZAL.ME"},
			want: []string{"https://kinozal.tv", "https://kinozal.me"},
		},
		{
			name:  "пустые отбрасываются",
			in:    []string{"", "   ", "kinozal.tv"},
			want:  []string{"https://kinozal.tv"},
			dropN: 2,
		},
		{
			name:  "от адреса без хоста не остаётся",
			in:    []string{"https://", "//", "kinozal.tv"},
			want:  []string{"https://kinozal.tv"},
			dropN: 2,
		},
		{
			name: "пустой список даёт пустой перебор",
			in:   nil,
			want: []string{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := kinozalBases(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("получено %v, ожидалось %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("адрес %d: получено %q, ожидалось %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

// Встроенный список обязан быть непустым и не содержать мусора: иначе перебор
// не начнётся, а источник будет выглядеть отключённым при живом коде.
func TestKinozalHostsAreUsable(t *testing.T) {
	if len(kinozalHosts) == 0 {
		t.Fatal("список зеркал Кинозала пуст — перебор не начнётся")
	}
	bases := kinozalBases(kinozalHosts[:])
	if len(bases) != len(kinozalHosts) {
		t.Fatalf("после очистки %d адресов из %d — в списке мусор или повторы",
			len(bases), len(kinozalHosts))
	}
	for i, b := range bases {
		if b[:len("https://")] != "https://" {
			t.Errorf("адрес %d без схемы: %q", i, b)
		}
	}
	// Первым идёт официальный домен; время на мёртвые попытки экономит
	// kinozalLastGood — следующий поиск начинается с ответившего зеркала.
	if bases[0] != "https://kinozal.tv" {
		t.Errorf("перебор начинается с %q, а не с официального kinozal.tv", bases[0])
	}
}

// Размер берётся из ячейки таблицы, а не из названия: у музыки и сборников
// в названии бывают свои единицы, и первое совпадение по строке было чужим.
func TestKinozalSizeFromCell(t *testing.T) {
	row := `<td class='nam'><a href="/details.php?id=1" class="r1">Альбом / 2024 / MP3, 320 kbps / 1.2 GB в архиве</a></td>` +
		`<td class='s'>3</td><td class='s'>812,5 МБ</td><td class='s'>05.08.2026 в 21:08</td>`
	it := parseKinozalRow(row, "https://kinozal.tv")
	if it.Size != "812.5 МБ" {
		t.Fatalf("размер = %q, ждали «812.5 МБ» из ячейки", it.Size)
	}
}
