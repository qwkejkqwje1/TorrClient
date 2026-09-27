package main

// Тесты разбора выдачи rutor. Фикстуры в testdata — это сохранённые страницы
// живого трекера (rutor.info), поэтому разметка в них настоящая: неразрывные
// пробелы, магнит прямо в строке выдачи, слаг в адресе раздачи.
//
// Сеть тесты не трогают: страницы берутся из файлов, а адреса трекера
// подменяются локальным сервером.

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func loadFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("не читается фикстура %s: %v", name, err)
	}
	return string(b)
}

func firstRutorRow(t *testing.T, doc string) string {
	t.Helper()
	rows := rutorRowRe.FindAllString(doc, -1)
	if len(rows) == 0 {
		t.Fatal("в фикстуре не найдено ни одной строки выдачи")
	}
	return rows[0]
}

func resetRutorCache() {
	rutorSearch.reset()
	kinozalSearch.reset()
}

// Разбор строки живой выдачи.
//
// Тест падал на прежнем коде: сиды читались числом пиров, потому что жадный
// «.*» в разборе зелёной ячейки дотягивался до соседней красной. На этой
// раздаче 6 сидов и 3 пира, и обе величины читались как 3.
func TestParseRutorRowReadsTheLiveTrackerPage(t *testing.T) {
	row := firstRutorRow(t, loadFixture(t, "rutor_search.html"))
	it := parseRutorRow(row)

	if it.Seed != 6 {
		t.Errorf("сиды = %d, ожидалось 6", it.Seed)
	}
	if it.Peer != 3 {
		t.Errorf("пиры = %d, ожидалось 3", it.Peer)
	}
	if it.Seed == it.Peer {
		t.Error("сиды и пиры совпали — разбор захватывает соседнюю ячейку")
	}
	if it.Size != "265.94 GB" {
		t.Errorf("размер = %q, ожидалось 265.94 GB", it.Size)
	}
	// В той же колонке перед размером стоит число комментариев (5), и раньше
	// размер мог читаться как оно.
	if it.Size == "5" {
		t.Error("в размер попало число комментариев, а не объём")
	}
	if it.Date != "09 Июл 26" {
		t.Errorf("дата = %q, ожидалось 09 Июл 26", it.Date)
	}
	if !strings.HasPrefix(it.Magnet, "magnet:?xt=urn:btih:") {
		t.Errorf("магнит не разобран: %q", it.Magnet)
	}
	if len(it.Hash) != 40 {
		t.Errorf("хеш = %q, ожидалось 40 шестнадцатеричных знаков", it.Hash)
	}
	if !strings.Contains(it.Link, "/torrent/1098254") {
		t.Errorf("адрес раздачи = %q", it.Link)
	}
	if !strings.Contains(it.Title, "Матрица") {
		t.Errorf("название = %q", it.Title)
	}
}

// Ни одна строка выдачи не должна теряться: у всех 100 строк фикстуры есть
// название, дата, размер и магнит.
func TestParseRutorRowsReadsEveryRowOfTheFixture(t *testing.T) {
	items := parseRutorRows(loadFixture(t, "rutor_search.html"), 0)
	if len(items) != 100 {
		t.Fatalf("разобрано строк: %d, ожидалось 100", len(items))
	}
	for i, it := range items {
		if it.Title == "" || it.Date == "" || it.Size == "" || it.Magnet == "" || it.Hash == "" {
			t.Errorf("строка %d разобрана неполно: %+v", i, it)
		}
	}
}

// Ограничение выдачи работает и не съедает саму выдачу.
func TestParseRutorRowsHonoursTheLimit(t *testing.T) {
	doc := loadFixture(t, "rutor_search.html")
	if got := len(parseRutorRows(doc, 10)); got != 10 {
		t.Errorf("при пределе 10 разобрано %d строк", got)
	}
	if got := len(parseRutorRows(doc, 0)); got != 100 {
		t.Errorf("без предела разобрано %d строк, ожидалось 100", got)
	}
}

// Поиск обязан просить первую страницу выдачи.
//
// Нумерация страниц у rutor начинается с нуля: search/0 — первая, search/1 —
// вторая. Прежний код просил search/1 и выбрасывал лучшие сто результатов; на
// живой странице вторая страница датирована 2018–2019 годами.
func TestRutorSearchAsksTheFirstPage(t *testing.T) {
	doc := loadFixture(t, "rutor_search.html")
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, doc)
	}))
	defer srv.Close()

	oldBase := rutorBaseURL
	rutorBaseURL = srv.URL
	defer func() { rutorBaseURL = oldBase }()
	resetRutorCache()

	c := &Comp{}
	items, err := c.rutorSearch("матрица", 0, 0)
	if err != nil {
		t.Fatalf("поиск вернул ошибку: %v", err)
	}
	if len(items) != 100 {
		t.Fatalf("раздач: %d, ожидалось 100", len(items))
	}
	if !strings.HasPrefix(gotPath, "/search/0/") {
		t.Errorf("запрошен путь %q, ожидалась первая страница (/search/0/…)", gotPath)
	}

	// Явно запрошенная вторая страница должна уходить на search/1: номер
	// страницы, а не только первая, участвует в адресе.
	resetRutorCache()
	if _, err := c.rutorSearch("матрица", 1, 0); err != nil {
		t.Fatalf("вторая страница вернула ошибку: %v", err)
	}
	if !strings.HasPrefix(gotPath, "/search/1/") {
		t.Errorf("запрошен путь %q, ожидалась вторая страница (/search/1/…)", gotPath)
	}
}

// Категория — это поле адреса, а не слово запроса.
//
// Прежде интерфейс приписывал выбранную категорию к строке запроса: «фильм
// 2024» искало раздачи, в названии которых есть слово «фильм», и выдача
// сужалась до пустоты. У rutor категория задаётся вторым числом пути.
func TestRutorSearchPassesTheCategoryInThePath(t *testing.T) {
	doc := loadFixture(t, "rutor_search.html")
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, doc)
	}))
	defer srv.Close()

	oldBase := rutorBaseURL
	rutorBaseURL = srv.URL
	defer func() { rutorBaseURL = oldBase }()

	c := &Comp{}
	for _, tc := range []struct {
		cat  int
		want string
	}{
		{0, "/search/0/0/000/0/"},   // любая категория
		{8, "/search/0/8/000/0/"},   // игры
		{11, "/search/0/11/000/0/"}, // книги
		// Неизвестный код не подставляется в адрес: иначе трекер ответит
		// выдачей чужой категории.
		{99, "/search/0/0/000/0/"},
		{-1, "/search/0/0/000/0/"},
	} {
		resetRutorCache()
		if _, err := c.rutorSearch("матрица", 0, tc.cat); err != nil {
			t.Fatalf("категория %d: поиск вернул ошибку: %v", tc.cat, err)
		}
		if !strings.HasPrefix(gotPath, tc.want) {
			t.Errorf("категория %d: запрошен путь %q, ожидалось начало %q", tc.cat, gotPath, tc.want)
		}
	}
}

// Карта категорий снята с формы самого трекера — в ней ровно те коды, которые
// трекер понимает.
func TestRutorCategoryCodesMatchTheTracker(t *testing.T) {
	want := map[int]string{
		0: "Любая категория", 1: "Зарубежные фильмы", 2: "Музыка", 3: "Другое",
		4: "Зарубежные сериалы", 5: "Наши фильмы", 6: "Телевизор",
		7: "Мультипликация", 8: "Игры", 9: "Софт", 10: "Аниме", 11: "Книги",
		12: "Научно-популярные фильмы", 13: "Спорт и Здоровье",
		14: "Хозяйство и Быт", 15: "Юмор", 16: "Наши сериалы",
		17: "Иностранные релизы",
	}
	if len(rutorCategories) != len(want) {
		t.Fatalf("категорий в карте: %d, ожидалось %d", len(rutorCategories), len(want))
	}
	for code, name := range want {
		if got, ok := rutorCategories[code]; !ok || got != name {
			t.Errorf("категория %d = %q (есть: %v), ожидалось %q", code, got, ok, name)
		}
	}
}

// Пустой запрос не должен ходить в сеть.
func TestRutorSearchIgnoresTheEmptyQuery(t *testing.T) {
	c := &Comp{}
	items, err := c.rutorSearch("   ", 0, 0)
	if err != nil {
		t.Fatalf("ошибка на пустом запросе: %v", err)
	}
	if len(items) != 0 {
		t.Errorf("на пустом запросе получено %d раздач", len(items))
	}
}

// ТОП-24 обязан заканчиваться там, где начинается категорийный блок.
//
// Прежний код брал первые 40 строк страницы /top/1. Блок суток занимает ровно
// 30 строк, поэтому в ТОП-24 попадали «Самые популярные торренты в категории …»
// — частью месячной давности.
//
// Проверяется именно fetchRutorTop, а не повторённая в тесте обрезка: тест,
// который сам считает границу, не может упасть на прежнем коде.
func TestRutorTop24StopsAtTheCategoryBlock(t *testing.T) {
	doc := loadFixture(t, "rutor_top.html")
	if len(parseRutorRows(doc, 0)) <= 40 {
		t.Fatal("фикстура не воспроизводит дефект: строк на странице не больше 40")
	}
	if !strings.Contains(doc, rutorTopCategoryHeader) {
		t.Fatal("в фикстуре нет заголовка категорийного блока — проверка бесполезна")
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, doc)
	}))
	defer srv.Close()

	oldBase := rutorBaseURL
	rutorBaseURL = srv.URL
	defer func() { rutorBaseURL = oldBase }()

	c := &Comp{}
	items, err := c.fetchRutorTop()
	if err != nil {
		t.Fatalf("ТОП-24 вернул ошибку: %v", err)
	}
	if len(items) != rutorTop24Block {
		t.Errorf("строк в ТОП-24: %d, ожидалось %d (блок суток)", len(items), rutorTop24Block)
	}
	for _, it := range items {
		if strings.Contains(it.Date, "Авг") {
			t.Errorf("в ТОП-24 попала раздача из категорийного блока: %s (%s)", it.Title, it.Date)
		}
	}
}

// Запасной путь на случай, если заголовок категорийного блока в раскладке не
// найдётся: обрезка по числу строк блока суток.
func TestFirstRowsStopsAfterTheGivenRowCount(t *testing.T) {
	doc := loadFixture(t, "rutor_top.html")
	items := parseRutorRows(firstRows(doc, rutorTop24Block), 0)
	if len(items) != rutorTop24Block {
		t.Errorf("строк: %d, ожидалось %d", len(items), rutorTop24Block)
	}
}

// Неразрывный пробел — не пробел для регулярки. Без замены дата и размер не
// читаются, и раздача отбрасывается как «без даты».
func TestRutorSpacesReplacesTheNonBreakingSpace(t *testing.T) {
	if got := rutorSpaces.Replace("265.94&nbsp;GB 09&nbsp;Июл&nbsp;26"); got != "265.94 GB 09 Июл 26" {
		t.Fatalf("замена дала %q", got)
	}
	// Разбор строки обязан быть верным и без предварительной нормализации:
	// единица измерения отделена от числа неразрывным пробелом.
	row := `<tr class="gai"><td>09&nbsp;Июл&nbsp;26</td>` +
		`<td align="right">5<img src="//cdnbunny.org/i/com.gif" alt="C" /></td>` +
		`<td align="right">265.94&nbsp;GB</td>` +
		`<td align="center"><span class="green"> 6</span><span class="red"> 3</span></td></tr>`
	it := parseRutorRow(row)
	if it.Size != "265.94 GB" {
		t.Errorf("размер = %q, ожидалось 265.94 GB", it.Size)
	}
	if it.Date != "09 Июл 26" {
		t.Errorf("дата = %q, ожидалось 09 Июл 26", it.Date)
	}
	if it.Seed != 6 || it.Peer != 3 {
		t.Errorf("сиды/пиры = %d/%d, ожидалось 6/3", it.Seed, it.Peer)
	}
}

// Причина пустой выдачи обязана различаться: капча и недоступный трекер — не
// одно и то же, и «ничего не найдено» не должно скрывать поломку разбора.
func TestFetchRutorPageDistinguishesFailureFromEmptyResult(t *testing.T) {
	c := &Comp{}

	captcha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "<html><body>Проверка, что вы не робот</body></html>")
	}))
	defer captcha.Close()
	if _, err := c.fetchRutorPage(captcha.URL + "/search/0/0/000/0/x"); !errors.Is(err, errRutorMarkup) {
		t.Errorf("страница-капча: ошибка %v, ожидалась errRutorMarkup", err)
	}

	// Строка с названием, но без магнита: добавить её нельзя, и это тоже
	// признак неразобранной разметки, а не пустой выдачи.
	noMagnet := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `<html><body><table><tr class="gai"><td>09 Июл 26</td>`+
			`<td align="right">265.94 GB</td>`+
			`<td><a href="/torrent/1098254/matrica">Матрица</a></td></tr></table></body></html>`)
	}))
	defer noMagnet.Close()
	if _, err := c.fetchRutorPage(noMagnet.URL + "/search/0/0/000/0/x"); !errors.Is(err, errRutorMarkup) {
		t.Errorf("строка без магнита: ошибка %v, ожидалась errRutorMarkup", err)
	}

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "ой", http.StatusInternalServerError)
	}))
	defer broken.Close()
	if _, err := c.fetchRutorPage(broken.URL + "/search/0/0/000/0/x"); !errors.Is(err, errRutorNetwork) {
		t.Errorf("код 500: ошибка %v, ожидалась errRutorNetwork", err)
	}
}

// Мёртвое зеркало Кинозала обязано сообщать причину, а не отдавать пустую
// выдачу: иначе источник выглядит как плохой поиск.
func TestKinozalReportsWhyEveryMirrorFailed(t *testing.T) {
	blocked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer blocked.Close()
	verification := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "<html><body>Подтвердите, что вы человек</body></html>")
	}))
	defer verification.Close()

	c := &Comp{}
	items, err := c.fetchKinozalFrom("матрица", 0, []string{verification.URL, blocked.URL})
	if err == nil {
		t.Fatal("ожидалась ошибка: ни одно зеркало не отдало выдачу")
	}
	if items != nil {
		t.Errorf("вместе с ошибкой возвращена выдача: %d строк", len(items))
	}
	if !strings.Contains(err.Error(), "ни одно зеркало") {
		t.Errorf("сообщение не объясняет причину: %v", err)
	}
	if !strings.Contains(err.Error(), "проверено адресов: 2") {
		t.Errorf("сообщение не сообщает, сколько адресов проверено: %v", err)
	}
	if !strings.Contains(err.Error(), "403") {
		t.Errorf("сообщение не называет код последней попытки: %v", err)
	}
}

// Разбор живой страницы Кинозала.
//
// Фикстура сохранена как есть — в windows-1251. Прежний разбор ждал
// <tr id="torrent_N"> и ячейки class="sl_sl"/"sl_ll": в живой разметке нет ни
// того, ни другого, поэтому источник не отдавал ни одной строки.
func TestKinozalParsesTheLivePage(t *testing.T) {
	raw, err := os.ReadFile("testdata/kinozal_search.html")
	if err != nil {
		t.Fatalf("не читается фикстура: %v", err)
	}
	if utf8.Valid(raw) {
		t.Fatal("фикстура оказалась в UTF-8 — она не проверяет перевод из windows-1251")
	}

	var gotPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "text/html; charset=windows-1251")
		w.Write(raw)
	}))
	defer srv.Close()

	c := &Comp{}
	items, err := c.fetchKinozalFrom("матрица", 0, []string{srv.URL})
	if err != nil {
		t.Fatalf("поиск вернул ошибку: %v", err)
	}
	if gotPath != "/browse.php" {
		t.Errorf("запрошен путь %q, ожидался /browse.php", gotPath)
	}
	if !strings.Contains(gotQuery, "page=0") {
		t.Errorf("в адресе нет номера страницы: %q", gotQuery)
	}
	if len(items) == 0 {
		t.Fatal("не разобрано ни одной строки")
	}

	// Кодировка проверяется прежде числа строк: без перевода из windows-1251
	// кириллица приходит нечитаемыми байтами, и счёт разъезжается следом —
	// сообщение должно называть настоящую причину, а не «49 вместо 50».
	first := items[0]
	if !strings.Contains(first.Title, "Матрица") {
		t.Fatalf("название = %q — кириллица не переведена из windows-1251", first.Title)
	}
	if strings.ContainsRune(first.Title, '\uFFFD') {
		t.Errorf("название разобрано как мусор: %q", first.Title)
	}
	if len(items) != 50 {
		t.Errorf("раздач: %d, ожидалось 50", len(items))
	}

	if first.Size != "37.85 ГБ" {
		t.Errorf("размер = %q, ожидалось 37.85 ГБ", first.Size)
	}
	if first.Date != "05.08.2026" {
		t.Errorf("дата = %q, ожидалось 05.08.2026", first.Date)
	}
	if first.Seed != 1 || first.Peer != 0 {
		t.Errorf("сиды/пиры = %d/%d, ожидалось 1/0", first.Seed, first.Peer)
	}
	if !strings.Contains(first.Link, "details.php?id=2095997") {
		t.Errorf("адрес раздачи = %q", first.Link)
	}
	if !strings.HasSuffix(first.Get, "/get.php?id=2095997") {
		t.Errorf("адрес файла = %q, ожидался get.php по тому же номеру", first.Get)
	}
	// Магнита в выдаче Кинозала нет: раздача забирается файлом .torrent, и
	// ссылки magnet: в разметке не встречается.
	if first.Magnet != "" {
		t.Errorf("у Кинозала появился магнит: %q", first.Magnet)
	}

	for i, it := range items {
		if it.Title == "" || it.Size == "" || it.Date == "" || it.Link == "" || it.Get == "" {
			t.Errorf("строка %d разобрана неполно: %+v", i, it)
		}
	}
}

// Класс ссылки на раздачу у Кинозала разный — r0, r1, r2 (цветовая пометка
// трекера). Опираться на него нельзя: часть строк выдачи пропала бы.
func TestKinozalReadsRowsWithAnyTitleClass(t *testing.T) {
	row := func(class string) string {
		return `<tr class=bg><td class="bt"><img src="/pic/cat/13.gif"></td>` +
			`<td class="nam"><a href="/details.php?id=555" class="` + class + `">Матрица</a>` +
			`<td class='s'>3</td><td class='s'>37.85 ГБ</td>` +
			`<td class='sl_s'>7</td><td class='sl_p'>2</td>` +
			`<td class='s'>05.08.2026 в 21:08</td></tr>`
	}
	for _, class := range []string{"r0", "r1", "r2"} {
		it := parseKinozalRow(row(class), "https://kinozaltv.life")
		if it.Title != "Матрица" {
			t.Errorf("класс %s: название = %q", class, it.Title)
		}
		if it.Seed != 7 || it.Peer != 2 {
			t.Errorf("класс %s: сиды/пиры = %d/%d, ожидалось 7/2", class, it.Seed, it.Peer)
		}
		if it.Size != "37.85 ГБ" {
			t.Errorf("класс %s: размер = %q", class, it.Size)
		}
		if it.Date != "05.08.2026" {
			t.Errorf("класс %s: дата = %q", class, it.Date)
		}
	}
}

// Первое ответившее зеркало выигрывает, а мёртвое не мешает.
func TestKinozalUsesTheFirstWorkingMirror(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "ой", http.StatusBadGateway)
	}))
	defer dead.Close()
	alive := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `<html><body><table>`+
			`<tr class='first bg'><td class="bt"><img src="/pic/cat/13.gif"></td>`+
			`<td class="nam"><a href="/details.php?id=555" class="r1">Матрица</a>`+
			`<td class='s'>3</td><td class='s'>37.85 ГБ</td>`+
			`<td class='sl_s'>7</td><td class='sl_p'>2</td>`+
			`<td class='s'>05.08.2026 в 21:08</td></tr>`+
			`</table></body></html>`)
	}))
	defer alive.Close()

	c := &Comp{}
	items, err := c.fetchKinozalFrom("матрица", 0, []string{dead.URL, alive.URL})
	if err != nil {
		t.Fatalf("ошибка при живом зеркале: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("раздач: %d, ожидалась 1", len(items))
	}
	if items[0].Title != "Матрица" {
		t.Errorf("название = %q", items[0].Title)
	}
	if items[0].Seed != 7 || items[0].Peer != 2 {
		t.Errorf("сиды/пиры = %d/%d, ожидалось 7/2", items[0].Seed, items[0].Peer)
	}
}

// Номер страницы Кинозала входит в адрес: без него «Показать ещё» отдавало бы
// первую страницу заново.
func TestKinozalAsksTheGivenPage(t *testing.T) {
	doc := `<html><body><table>` +
		`<tr class=bg><td class="nam"><a href="/details.php?id=555" class="r1">Матрица</a>` +
		`<td class='s'>37.85 ГБ</td><td class='sl_s'>7</td><td class='sl_p'>2</td>` +
		`<td class='s'>05.08.2026 в 21:08</td></tr></table></body></html>`
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		io.WriteString(w, doc)
	}))
	defer srv.Close()

	c := &Comp{}
	if _, err := c.fetchKinozalFrom("матрица", 3, []string{srv.URL}); err != nil {
		t.Fatalf("поиск вернул ошибку: %v", err)
	}
	if !strings.Contains(gotQuery, "page=3") {
		t.Errorf("в адресе нет запрошенной страницы: %q", gotQuery)
	}
	if !strings.Contains(gotQuery, "g=0") {
		t.Errorf("в адресе нет раздела: %q", gotQuery)
	}
}

// Таблица windows-1251 переводит кириллицу так же, как это делают браузеры.
func TestDecodeCP1251ReadsRussianText(t *testing.T) {
	// «Матрица» в windows-1251.
	if got := decodeCP1251([]byte{0xCC, 0xE0, 0xF2, 0xF0, 0xE8, 0xF6, 0xE0}); got != "Матрица" {
		t.Errorf("получено %q, ожидалось «Матрица»", got)
	}
	if got := decodeCP1251([]byte("plain ASCII")); got != "plain ASCII" {
		t.Errorf("ASCII испорчен: %q", got)
	}
	if got := decodeCP1251(nil); got != "" {
		t.Errorf("пустой вход дал %q", got)
	}
	// Знаки, которых нет в ASCII и которые встречаются в названиях раздач:
	// «ё» (0xB8), «Ё» (0xA8), «№» (0xB9), «—» (0x97).
	if got := decodeCP1251([]byte{0xB8, 0xA8, 0xB9, 0x97}); got != "ёЁ№—" {
		t.Errorf("получено %q, ожидалось «ёЁ№—»", got)
	}
}

// Кодировка определяется и по заголовку, и по <meta>: зеркала объявляют её
// по-разному, а Rutor отдаёт UTF-8 и перекодировке не подлежит.
func TestIsCP1251DetectsBothDeclarations(t *testing.T) {
	if !isCP1251("text/html; charset=windows-1251", nil) {
		t.Error("кодировка из заголовка не распознана")
	}
	if !isCP1251("", []byte(`<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">`)) {
		t.Error("кодировка из <meta> не распознана")
	}
	if isCP1251("text/html; charset=utf-8", []byte(`<meta charset="utf-8">`)) {
		t.Error("UTF-8 принят за windows-1251")
	}
	if isCP1251("", nil) {
		t.Error("отсутствие объявления принято за windows-1251")
	}
	// Живая страница Rutor — UTF-8, и принимать её за windows-1251 нельзя:
	// кириллица превратилась бы в мусор.
	rutorDoc := loadFixture(t, "rutor_search.html")
	if isCP1251("", []byte(rutorDoc)) {
		t.Error("страница rutor принята за windows-1251")
	}
	if got := decodeBody([]byte("Матрица"), "text/html; charset=utf-8"); got != "Матрица" {
		t.Errorf("UTF-8 испорчен: %q", got)
	}
}

// Повторы в выдаче убираются: одна и та же раздача стоит дважды, когда попадает
// и в блок суток, и в категорийный топ на /top/1.
func TestDedupeItemsRemovesRepeats(t *testing.T) {
	hash := strings.Repeat("a", 40)
	items := []rutorItem{
		{Title: "Матрица", Hash: hash, Size: "1 ГБ"},
		{Title: "Матрица: Перезагрузка", Hash: hash, Size: "2 ГБ"}, // тот же хеш
		{Title: "Начало", Size: "3 ГБ"},                            // без хеша
		{Title: "Начало", Size: "3 ГБ"},                            // повтор
		{Title: "Начало", Size: "4 ГБ"},                            // другое издание
	}
	out := dedupeItems(items)
	if len(out) != 3 {
		t.Fatalf("осталось строк: %d, ожидалось 3: %+v", len(out), out)
	}
	if out[0].Title != "Матрица" || out[1].Title != "Начало" || out[2].Size != "4 ГБ" {
		t.Errorf("порядок или состав выдачи изменились: %+v", out)
	}
	if len(items) != 5 {
		t.Errorf("исходная выдача испорчена: %d строк", len(items))
	}
}

// Повтор в выдаче — не выдумка: на живой странице /top/1 из 285 строк 9
// повторяют уже показанные.
func TestParseRutorRowsRemovesTheRepeatsOfTheLivePage(t *testing.T) {
	items := parseRutorRows(loadFixture(t, "rutor_top.html"), 0)
	if len(items) != 276 {
		t.Errorf("разобрано строк: %d, ожидалось 276 (285 строк выдачи, 9 повторов)", len(items))
	}
	seen := map[string]bool{}
	for _, it := range items {
		if seen[it.Hash] {
			t.Errorf("повтор в выдаче: %s", it.Title)
		}
		seen[it.Hash] = true
	}
}

// Кэш держит несколько страниц: переход на вторую не должен вытеснять первую.
//
// Прежде хранилась одна запись на весь поиск, и возврат на предыдущую страницу
// снова шёл в сеть — а rutor отвечает капчей на частые запросы.
func TestSearchCacheKeepsSeveralEntries(t *testing.T) {
	doc := loadFixture(t, "rutor_search.html")
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, doc)
	}))
	defer srv.Close()

	oldBase := rutorBaseURL
	rutorBaseURL = srv.URL
	defer func() { rutorBaseURL = oldBase }()
	resetRutorCache()

	c := &Comp{}
	for _, page := range []int{0, 1} {
		if _, err := c.rutorSearch("матрица", page, 0); err != nil {
			t.Fatalf("страница %d: %v", page, err)
		}
	}
	if hits != 2 {
		t.Fatalf("обращений к сети: %d, ожидалось 2", hits)
	}

	// Обе страницы обязаны остаться в кэше: повторный запрос в сеть не идёт.
	for _, page := range []int{0, 1} {
		if _, err := c.rutorSearch("матрица", page, 0); err != nil {
			t.Fatalf("страница %d из кэша: %v", page, err)
		}
	}
	if hits != 2 {
		t.Errorf("после повторных запросов обращений к сети: %d, ожидалось 2 — кэш держит не больше одной записи", hits)
	}

	// Категория входит в ключ кэша: иначе выдача одной категории выдавалась бы
	// за другую.
	resetRutorCache()
	hits = 0
	if _, err := c.rutorSearch("матрица", 0, 0); err != nil {
		t.Fatalf("категория 0: %v", err)
	}
	if _, err := c.rutorSearch("матрица", 0, 8); err != nil {
		t.Fatalf("категория 8: %v", err)
	}
	if hits != 2 {
		t.Errorf("обращений к сети: %d, ожидалось 2 — категория не участвует в ключе кэша", hits)
	}
}

// Кадр серии приходит из TMDB только путём, и без достроенного адреса картинка
// не загрузится вовсе. Готовый адрес трогать нельзя: он может вести на другой
// узел.
func TestTmdbImageBuildsAnAddressFromAPath(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"/abc123.jpg", "https://image.tmdb.org/t/p/w300/abc123.jpg"},
		{"", ""},
		{"   ", ""},
		{"https://example.org/p.jpg", "https://example.org/p.jpg"},
	}
	for _, c := range cases {
		if got := tmdbImage(c.in, "w300"); got != c.want {
			t.Errorf("tmdbImage(%q) = %q, ожидалось %q", c.in, got, c.want)
		}
	}
}

// Сведения о серии нужны целиком: без даты, длительности, описания и кадра окно
// выбора серии остаётся списком одних номеров.
func TestTvmdbSeasonEpsReadsEpisodeDetails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/season/1") {
			io.WriteString(w, `{"name":"Сезон 1","air_date":"2019-09-01","overview":"Первый сезон","poster_path":"/s1.jpg","episodes":[`+
				`{"episode_number":1,"name":"Пилот","overview":"Начало.","air_date":"2019-09-01","runtime":52,"still_path":"/e1.jpg","vote_average":8.4},`+
				`{"episode_number":2,"name":"Второй","overview":"","air_date":"2019-09-08","runtime":50,"still_path":"","vote_average":7.9}]}`)
			return
		}
		io.WriteString(w, `{"episodes":[]}`)
	}))
	defer srv.Close()

	// cfg читается внутри разбора: в тестах он не загружен и без этого пуст.
	savedCfg := curCfg()
	setCfg(&Config{})
	defer func() { cfg.Store(savedCfg) }()

	dst := map[int]map[int]string{}
	seasons, names, ok := (&Comp{}).tvmdbSeasonEps(srv.Client(), srv.URL+"/tv/1/season/", dst)
	if !ok || len(seasons) != 1 {
		t.Fatalf("сезонов: %d, ok=%v", len(seasons), ok)
	}
	s := seasons[0]
	if s.Number != 1 || s.Name != "Сезон 1" || len(s.Episodes) != 2 {
		t.Fatalf("сезон разобран неверно: %+v", s)
	}
	if s.Poster != "https://image.tmdb.org/t/p/w300/s1.jpg" {
		t.Errorf("постер сезона: %q", s.Poster)
	}
	ep := s.Episodes[0]
	if ep.Number != 1 || ep.Name != "Пилот" || ep.AirDate != "2019-09-01" || ep.Runtime != 52 || ep.Overview != "Начало." {
		t.Errorf("серия разобрана неверно: %+v", ep)
	}
	if ep.Still != "https://image.tmdb.org/t/p/w300/e1.jpg" {
		t.Errorf("кадр серии: %q", ep.Still)
	}
	if ep.Rating != 8.4 {
		t.Errorf("оценка серии: %v", ep.Rating)
	}
	// Прежний разбор обязан остаться: его читает список серий в карточке.
	if names[1][1] != "Пилот" || names[1][2] != "Второй" {
		t.Errorf("названия по номерам: %+v", names[1])
	}
}

// Недопустимый адрес не должен ронять демон: разбор пропускает сезон и отдаёт
// пустой ответ. Прежде заголовок запроса ставился до проверки ошибки, и на
// пустом запросе это было обращение по нулевому указателю.
func TestTvmdbSeasonEpsSurvivesABadAddress(t *testing.T) {
	savedCfg := curCfg()
	setCfg(&Config{})
	defer func() { cfg.Store(savedCfg) }()

	dst := map[int]map[int]string{}
	seasons, _, ok := (&Comp{}).tvmdbSeasonEps(&http.Client{}, "http://[неверный", dst)
	if ok {
		t.Errorf("разбор сообщил об успехе на недопустимом адресе")
	}
	if len(seasons) != 0 {
		t.Errorf("сезонов разобрано: %d, ожидалось 0", len(seasons))
	}
}

// Зеркало обязано подхватывать поиск, если основной адрес отдаёт капчу: один
// неразбираемый домен не должен останавливать выдачу целиком.
func TestRutorSearchFallsBackToAMirror(t *testing.T) {
	doc := loadFixture(t, "rutor_search.html")
	captcha := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "<html><body>Проверка, что вы не робот</body></html>")
	}))
	defer captcha.Close()
	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, doc)
	}))
	defer mirror.Close()

	oldBase := rutorBaseURL
	oldMirrors := rutorMirrorURLs
	rutorBaseURL = captcha.URL
	rutorMirrorURLs = []string{mirror.URL}
	defer func() {
		rutorBaseURL = oldBase
		rutorMirrorURLs = oldMirrors
	}()
	resetRutorCache()

	c := &Comp{}
	items, err := c.rutorSearch("матрица", 0, 0)
	if err != nil {
		t.Fatalf("поиск не перешёл на зеркало: %v", err)
	}
	if len(items) != 100 {
		t.Errorf("раздач через зеркало: %d, ожидалось 100", len(items))
	}
}

// ТОП-24, как и поиск, обязан переходить на зеркало, когда основной адрес не
// отдал разбираемую страницу.
func TestRutorTop24FallsBackToAMirror(t *testing.T) {
	doc := loadFixture(t, "rutor_top.html")
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "ои", http.StatusInternalServerError)
	}))
	defer broken.Close()
	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, doc)
	}))
	defer mirror.Close()

	oldBase := rutorBaseURL
	oldMirrors := rutorMirrorURLs
	rutorBaseURL = broken.URL
	rutorMirrorURLs = []string{mirror.URL}
	defer func() {
		rutorBaseURL = oldBase
		rutorMirrorURLs = oldMirrors
	}()

	c := &Comp{}
	items, err := c.fetchRutorTop()
	if err != nil {
		t.Fatalf("ТОП-24 не перешёл на зеркало: %v", err)
	}
	if len(items) != rutorTop24Block {
		t.Errorf("строк в ТОП-24 через зеркало: %d, ожидалось %d", len(items), rutorTop24Block)
	}
}
