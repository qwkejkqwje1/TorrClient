package main

// Кэш метаданных: постеры, оценки и списки серий переживают перезапуск демона.
//
// Сеть тесты не трогают: кэш ложится на диск рядом с программой, и проверка
// читает его оттуда же.

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"
)

// useTempTmdbCache подменяет кэш метаданных пустым и убирает за собой файл.
func useTempTmdbCache(t *testing.T) {
	t.Helper()
	saved := tmdbCache
	savedDirty := tmdbDirty
	tmdbCache = map[string]tmdbItem{}
	tmdbDirty = false

	path := tmdbCachePath()
	backup, err := os.ReadFile(path)
	hadBackup := err == nil
	t.Cleanup(func() {
		tmdbCache = saved
		tmdbDirty = savedDirty
		if hadBackup {
			os.WriteFile(path, backup, 0o600)
			return
		}
		os.Remove(path)
	})
}

// Постеры и списки серий не должны спрашиваться заново после каждого запуска:
// именно на это уходит время при первом показе библиотеки.
func TestTmdbCacheKeepsEntriesOnDisk(t *testing.T) {
	useTempTmdbCache(t)

	tmdbPut("rat|доктор хаус|2004|", tmdbItem{res: TMDBRes{
		OK: true, Title: "Доктор Хаус", Poster: "https://image.tmdb.org/t/p/w300/x.jpg", Rating: 8.6,
	}})
	tmdbPut("tv|доктор хаус", tmdbItem{eps: TVEpsRes{
		OK: true, TVID: 1408,
		Seasons: []TMSeason{{Number: 1, Episodes: []TMEpisode{{Number: 1, Name: "Пилот"}}}},
	}})
	if err := saveTmdbCache(); err != nil {
		t.Fatalf("кэш не сохранён: %v", err)
	}

	// Перезапуск: кэш в памяти пуст, читается только файл.
	tmdbCache = map[string]tmdbItem{}
	loadTmdbCache()

	it, ok := tmdbGet("rat|доктор хаус|2004|")
	if !ok {
		t.Fatal("оценка не пережила перезапуск")
	}
	if it.res.Poster != "https://image.tmdb.org/t/p/w300/x.jpg" || it.res.Rating != 8.6 {
		t.Errorf("постер/оценка = %q/%v", it.res.Poster, it.res.Rating)
	}
	ep, ok := tmdbGet("tv|доктор хаус")
	if !ok {
		t.Fatal("список серий не пережил перезапуск")
	}
	if len(ep.eps.Seasons) != 1 || len(ep.eps.Seasons[0].Episodes) != 1 {
		t.Fatalf("сезоны не пережили перезапуск: %+v", ep.eps.Seasons)
	}
	if ep.eps.Seasons[0].Episodes[0].Name != "Пилот" {
		t.Errorf("название серии = %q", ep.eps.Seasons[0].Episodes[0].Name)
	}
}

// Просроченная запись — это «спросить заново», а не «показать вчерашнее».
func TestTmdbCacheDropsStaleEntries(t *testing.T) {
	useTempTmdbCache(t)

	stale := []diskItem{
		{Key: "старое", At: time.Now().Add(-25 * time.Hour), Res: &TMDBRes{OK: true, Title: "Старое"}},
		{Key: "свежее", At: time.Now(), Res: &TMDBRes{OK: true, Title: "Свежее"}},
	}
	b, err := json.Marshal(stale)
	if err != nil {
		t.Fatalf("не собрать файл кэша: %v", err)
	}
	if err := os.WriteFile(tmdbCachePath(), b, 0o600); err != nil {
		t.Fatalf("не записать файл кэша: %v", err)
	}

	loadTmdbCache()

	if _, ok := tmdbGet("старое"); ok {
		t.Error("просроченная запись загружена с диска")
	}
	if _, ok := tmdbGet("свежее"); !ok {
		t.Error("свежая запись не загружена с диска")
	}
}

func TestTmdbGetIgnoresAStaleEntry(t *testing.T) {
	useTempTmdbCache(t)

	tmdbPut("к", tmdbItem{res: TMDBRes{OK: true}})
	if _, ok := tmdbGet("к"); !ok {
		t.Fatal("только что положенная запись не найдена")
	}

	tmdbCache["к"] = tmdbItem{res: TMDBRes{OK: true}, t: time.Now().Add(-25 * time.Hour)}
	if _, ok := tmdbGet("к"); ok {
		t.Error("просроченная запись отдана как свежая")
	}
	if _, ok := tmdbGet("нет такой"); ok {
		t.Error("найден ключ, которого в кэше нет")
	}
}

// Пустой ответ — это «не нашли», и сохранять его незачем: места он занимает
// столько же, а спросить придётся заново всё равно.
func TestTmdbSaveSkipsEmptyEntries(t *testing.T) {
	useTempTmdbCache(t)

	tmdbPut("пустое", tmdbItem{})
	tmdbPut("полное", tmdbItem{res: TMDBRes{OK: true, Title: "Есть"}})
	if err := saveTmdbCache(); err != nil {
		t.Fatalf("кэш не сохранён: %v", err)
	}

	tmdbCache = map[string]tmdbItem{}
	loadTmdbCache()

	if _, ok := tmdbGet("пустое"); ok {
		t.Error("пустая запись сохранена на диск")
	}
	if _, ok := tmdbGet("полное"); !ok {
		t.Error("полная запись не сохранена")
	}
}

// Файл пишется по таймеру и только когда кэш изменился: иначе он переписывался
// бы каждые полминуты впустую.
func TestTmdbPutAsksForASave(t *testing.T) {
	useTempTmdbCache(t)

	if tmdbDirty {
		t.Fatal("пустой кэш считается изменённым")
	}
	tmdbPut("к", tmdbItem{res: TMDBRes{OK: true}})
	if !tmdbDirty {
		t.Error("после записи в кэш сохранение не запрошено")
	}
	if err := saveTmdbCache(); err != nil {
		t.Fatalf("кэш не сохранён: %v", err)
	}
	if tmdbDirty {
		t.Error("после сохранения кэш всё ещё считается изменённым")
	}
}

// Ответ «не найдено» живёт меньше обычной записи (tmdbNegTTL), а протухшая
// запись выбрасывается из памяти сразу, не дожидаясь перезапуска.
func TestTmdbNegativeEntryExpiresSooner(t *testing.T) {
	useTempTmdbCache(t)

	tmdbPut("нет", tmdbItem{neg: true})
	if _, ok := tmdbGet("нет"); !ok {
		t.Fatal("свежая отрицательная запись не найдена")
	}

	// Час больше срока отрицательной записи, но меньше срока обычной.
	tmdbCache["нет"] = tmdbItem{neg: true, t: time.Now().Add(-time.Hour)}
	if _, ok := tmdbGet("нет"); ok {
		t.Error("отрицательная запись прожила дольше своего срока")
	}
	if _, ok := tmdbCache["нет"]; ok {
		t.Error("протухшая запись не выброшена из памяти")
	}
}

// Кэш не растёт вечно: за потолком выбрасывается самая старая запись.
func TestTmdbPutEvictsTheOldestEntry(t *testing.T) {
	useTempTmdbCache(t)

	tmdbCache["старая"] = tmdbItem{res: TMDBRes{OK: true}, t: time.Now().Add(-20 * time.Hour)}
	for i := 0; i < tmdbCacheMax; i++ {
		tmdbPut(strconv.Itoa(i), tmdbItem{neg: true})
	}
	if len(tmdbCache) > tmdbCacheMax {
		t.Fatalf("кэш переполнен: %d записей", len(tmdbCache))
	}
	if _, ok := tmdbCache["старая"]; ok {
		t.Error("самая старая запись не выброшена за потолком")
	}
}
