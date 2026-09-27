package main

// Fuzz-проверки разборов: вход приходит извне — со страниц трекеров, из ответов
// плееров, из адресов. Регулярки разбора размечают чужой текст, и «на этой
// странице всё сошлось» не значит «на любой не упадёт».
//
// Обычный прогон (go test) выполняет семена: они взяты с живых страниц и из
// ответов настоящих плееров. Полный перебор включается явно:
//
//	go test -fuzz FuzzParseRutorRow -fuzztime 30s

import (
	"os"
	"strings"
	"testing"
)

// seedFromFile кладёт в корпус содержимое сохранённой страницы. extra — значения
// остальных аргументов цели: у корпуса их должно быть столько же, сколько у
// проверяемой функции.
func seedFromFile(f *testing.F, path string, extra ...any) {
	if b, err := os.ReadFile(path); err == nil {
		f.Add(append([]any{string(b)}, extra...)...)
	}
}

// Разбор строки выдачи rutor: обрезанный HTML не должен валить разбор.
func FuzzParseRutorRow(f *testing.F) {
	seedFromFile(f, "testdata/rutor_search.html")
	f.Add(`<tr class="gai"><td>09 Июл 26</td><td><a href="/torrent/123/x">Название</a>` +
		`<a href="magnet:?xt=urn:btih:abc">m</a></td><td align="right">265.94&nbsp;GB</td>` +
		`<td><span class="green">6&nbsp;</span></td><td><span class="red">3&nbsp;</span></td></tr>`)
	f.Add("")
	f.Add("<tr")
	f.Add(`<tr class="gai"><td><a href="magnet:?xt=urn:btih:"></a></tr>`)
	f.Add(strings.Repeat("<tr class=\"gai\">", 50))
	f.Fuzz(func(t *testing.T, row string) {
		it := parseRutorRow(row)
		// Кавычка в адресе сломала бы командную строку плеера: разбор обязан
		// отдать магнит без неё.
		if strings.ContainsAny(it.Magnet, "\"'") {
			t.Fatalf("магнит содержит кавычку: %q", it.Magnet)
		}
		if it.Seed < 0 || it.Peer < 0 {
			t.Fatalf("отрицательные сиды/пиры: %d/%d", it.Seed, it.Peer)
		}
	})
}

// Разбор всей выдачи: предел строк не должен нарушаться, а строки — теряться
// из-за одной поломанной.
func FuzzParseRutorRows(f *testing.F) {
	seedFromFile(f, "testdata/rutor_search.html", 100)
	seedFromFile(f, "testdata/rutor_top.html", 100)
	f.Add("", 0)
	f.Add("<tr class=\"gai\"></tr>", 1)
	f.Fuzz(func(t *testing.T, doc string, limit int) {
		if limit < 0 || limit > 1000 {
			limit = 100
		}
		items := parseRutorRows(doc, limit)
		if limit > 0 && len(items) > limit {
			t.Fatalf("строк %d при пределе %d", len(items), limit)
		}
	})
}

// Разбор строки Кинозала: адрес страницы раздачи собирается из базового хоста и
// найденного идентификатора — подстановка не должна ломаться на мусоре.
func FuzzParseKinozalRow(f *testing.F) {
	seedFromFile(f, "testdata/kinozal_search.html", "https://kinozal.tv")
	f.Add(`<tr class='first bg'><td><a href="/details.php?id=42" class="r0">Фильм</a>`+
		`<td>05.08.2026 в 21:08</td><td>1.5 ГБ</td><td class='sl_s'>10</td><td class='sl_p'>2</td></tr>`, "https://kinozal.tv")
	f.Add("", "")
	f.Add("<tr", "https://")
	f.Fuzz(func(t *testing.T, row, base string) {
		it := parseKinozalRow(row, base)
		if strings.ContainsAny(it.Magnet, "\"'") {
			t.Fatalf("магнит содержит кавычку: %q", it.Magnet)
		}
	})
}

// Ответ VLC: позиция и длительность не должны становиться отрицательными или
// невероятными — по ним решается, откуда продолжать показ.
func FuzzParseVLCStatus(f *testing.F) {
	f.Add([]byte(""))
	f.Add([]byte("<root><time>123</time><length>4560</length><state>playing</state></root>"))
	f.Add([]byte("<root><time>-5</time><length>-1</length></root>"))
	f.Add([]byte("<root><time>99999999999999999999</time></root>"))
	f.Fuzz(func(t *testing.T, body []byte) {
		r, err := parseVLCStatus(body)
		if err != nil {
			return
		}
		if r.Position < 0 || r.Duration < 0 {
			t.Fatalf("отрицательные значения: %v/%v", r.Position, r.Duration)
		}
	})
}

// Страница переменных MPC: разбор не должен падать и не должен отдавать
// отрицательную позицию.
func FuzzParseMPCVariables(f *testing.F) {
	f.Add([]byte(""))
	f.Add([]byte(`<html><body><p id="file">x</p><p id="position">12345</p><p id="duration">678900</p></body></html>`))
	f.Add([]byte(`<p id="position">-1</p>`))
	f.Fuzz(func(t *testing.T, body []byte) {
		r, err := parseMPCVariables(body)
		if err != nil {
			return
		}
		if r.Position < 0 || r.Duration < 0 {
			t.Fatalf("отрицательные значения: %v/%v", r.Position, r.Duration)
		}
	})
}

// Разбор командной строки плеера: кавычки задают границы аргументов, и
// незакрытая кавычка не должна приводить к бесконечному циклу или панике.
func FuzzSplitCmdline(f *testing.F) {
	f.Add(`"{url}" --play-and-exit`)
	f.Add(`"{path}" "{url}" --start-time=120`)
	f.Add(`"`)
	f.Add(`""`)
	f.Add(`  a  b  `)
	f.Fuzz(func(t *testing.T, s string) {
		args := splitCmdline(s)
		for _, a := range args {
			// Пустой аргумент из одних кавычек до плеера доходить не должен:
			// плеер считает его именем файла.
			if a == "" {
				t.Fatalf("пустой аргумент при разборе %q", s)
			}
		}
	})
}

// Проверка адреса: кавычка и перевод строки ломают разбор аргументов, а любой
// протокол кроме http(s) — превращает «открыть страницу» в «запустить что
// угодно».
func FuzzIsHTTPLink(f *testing.F) {
	f.Add("http://127.0.0.1:8099/ts/stream")
	f.Add("https://image.tmdb.org/t/p/w342/x.jpg")
	f.Add("file:///C:/Windows/System32/calc.exe")
	f.Add("http://x/\r\n")
	f.Add("\"http://x\"")
	f.Fuzz(func(t *testing.T, s string) {
		if !isHTTPLink(s) {
			return
		}
		if strings.ContainsAny(s, "\"'\r\n") {
			t.Fatalf("принят адрес с кавычкой или переводом строки: %q", s)
		}
		if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
			t.Fatalf("принят не http(s)-адрес: %q", s)
		}
	})
}

// Имя сохраняемого файла: из него строится путь на диске, и разделители в нём
// означали бы запись за пределы папки закачек.
func FuzzSanitizeName(f *testing.F) {
	f.Add("Фильм.mkv")
	f.Add("../../etc/passwd")
	f.Add("..\\..\\Windows\\System32\\x.dll")
	f.Add("")
	f.Add("a/b/c")
	f.Fuzz(func(t *testing.T, s string) {
		out := sanitizeName(s)
		if strings.ContainsAny(out, `/\`) {
			t.Fatalf("в имени остался разделитель пути: %q → %q", s, out)
		}
		if out == "." || out == ".." {
			t.Fatalf("имя осталось ссылкой на каталог: %q → %q", s, out)
		}
	})
}
