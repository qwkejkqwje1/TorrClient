"""Доказательство: каждый новый тест обязан падать на прежнем поведении.

Пошаговый откат одного поведения за раз. Файл возвращается в исходное состояние
сразу после прогона, поэтому шаги не влияют друг на друга.

Запуск из корня проекта:

    python tools/prove-fix.py

Печатает по строке на шаг: «доказано: …» либо «НЕ ДОКАЗАНО: …», и завершается
кодом 1, если хоть один шаг не доказан.

Смысл: «тест зелёный» ничего не доказывает — он мог быть зелёным и раньше.
Доказательство — падение теста без правки.

ВНИМАНИЕ: прогон правит файлы проекта по одному и возвращает их на место сразу
после шага. Прерванный посреди шага прогон оставляет файл в откаченном виде —
то есть в проекте остаётся ровно тот дефект, который доказывался. Признак
однозначный: `go test ./...` падает, а `git diff` (если каталог под git) пуст.

От прерывания прогон защищается сам: исходный текст каждого файла держится в
памяти, и по сигналу (Ctrl+C, снятие по сроку) или при любом завершении файлы
возвращаются на место. Это не теория — прогон, снятый по сроку, уже оставлял в
backup.go чтение мимо папки постоянных данных, и набор проверок падал.

По этой же причине во время прогона не стоит править файлы проекта: возврат на
место пишет ту версию, которую шаг прочитал при своём начале.

Разбор сезонов и панель подгрузки живут в интерфейсе, поэтому их проверяет
tools/check-series.js — он не ходит ни в сеть, ни в демон, и отказ в нём
указывает ровно на откаченное поведение. Живая проверка интерфейса для
доказательства не годится: без демона она падает по любой причине.

Отбор по названию: `python tools/prove-fix.py "имя события"` прогонит только
шаги, в названии которых встречается эта подстрока.
"""

import atexit
import json
import os
import shutil
import signal
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Путь по умолчанию прежде вёл на чужую машину, и прогон молча останавливался на
# «не найден go». Теперь берётся go из PATH, а портативная сборка — запасной путь.
GO = os.environ.get("TC_GO") or shutil.which("go") or r"C:\Users\1\.workbuddy-ai\binaries\go\go\bin\go.exe"
NODE = os.environ.get("TC_NODE", "node")
# Кэш компиляции — на локальном диске и там же, где его держит build_daemon.bat:
# на общей папке VirtualBox сборка медленная, а в каталоге проекта кэш раздувал
# портативную папку на сотни мегабайт. Перекрывается переменной GOCACHE.
GO_CACHE = os.environ.get(
    "GOCACHE",
    os.path.join(os.environ.get("LOCALAPPDATA", "C:/tmp"), "TorrClient", "gocache"),
)
ENV = dict(os.environ, GOCACHE=GO_CACHE)

# (что доказываем, файл, прежний текст, новый текст, тест)
STEPS = [
    ("плееру уходит ссылка на один файл, а не плейлист", "playlist.go",
     '''	if hash == "" {
		return url, "file"
	}
	st, err := fetchTorrentStatus(hash)
	if err != nil || len(playableFiles(st.Files)) == 0 {
		return url, "file"
	}
	return playlistURL(m3uBase(r), hash, title, index), "playlist"''',
     '''	return url, "file"''',
     "TestLaunchURLHandsThePlayerAPlaylist"),

    ("плейлист не показывает список целиком, когда выбранного файла нет", "playlist.go",
     '''	if from > 0 && !hasFile(files, from) {
		from = 0
	}
	var b strings.Builder''',
     '''	var b strings.Builder''',
     "TestBuildPlaylistShowsEverythingWhenTheChosenFileIsGone"),

    ("остановленный VLC считается позицией ноль", "player.go",
     '''	if *status.State == "stopped" {
		return playerReading{}, errors.New("VLC остановлен")
	}''',
     '''	if *status.State == "stopped" {
		return playerReading{}, nil
	}''',
     "TestParseVLCStatusDoesNotReportStoppedAsZero"),

    ("досмотренный файл продолжается с конца, а не начинается заново", "player.go",
     '''	if !ok || m.Done || m.Pos <= 0 {
		return 0
	}''',
     '''	if !ok || m.Pos <= 0 {
		return 0
	}''',
     "TestResumeOfIgnoresAFinishedFile"),

    ("порог досмотра сдвинут с восьми десятых на девять", "player.go",
     '''	watchedShare = 0.8''',
     '''	watchedShare = 0.9''',
     "TestMarkAfterReadingUsesTheWatchedShare"),

    ("отметка досмотра теряется, когда плеер открыл серию заново", "player.go",
     '''	if hasPrev && prev.Done {
		mark.Done = true
	}''',
     '''	_ = hasPrev''',
     "TestMarkAfterReadingKeepsTheDoneFlag"),

    ("список отметок не сообщает время отметки", "player.go",
     '''Done: m.Done, Updated: m.Updated}''',
     '''Done: m.Done}''',
     "TestApiPositionsReportsWhenTheMarkWasWritten"),

    ("плеер, распакованный в папку, не ищется по имени файла", "players.go",
     '''				if p := filepath.Join(r, n); findExe(p) {''',
     '''				if p := filepath.Join(r, n); false && findExe(p) {''',
     "TestDetectPlayersFindsAPlayerUnpackedIntoAFolder"),

    ("папка самой программы не попадает в поиск плееров", "players.go",
     '''		d := filepath.Dir(exe)
		add(d)
		add(filepath.Join(d, "tools"))''',
     '''		d := filepath.Dir(exe)
		add(filepath.Join(d, "tools"))''',
     "TestPlayerRootsLooksNextToTheProgram"),

    ("в реестре вместо пути берётся первое значение ключа", "players.go",
     '''		if val == "" && !looksLikePath(v) {
			continue
		}''',
     '''		if false {
			continue
		}''',
     "TestParseRegQuerySkipsNumbersWhenTheValueNameIsUnknown"),

    # Прочие методы проваливались мимо switch: обработчик ничего не писал, и
    # net/http отвечал 200 с пустым телом — «получилось», хотя не делалось ничего.
    ("неподдерживаемый метод ручки профилей отвечает успехом", "profiles.go",
     '''		writeJSONError(w, http.StatusMethodNotAllowed, "метод не поддерживается")
	}
}''',
     '''	}
}''',
     "TestProfilesRejectsUnsupportedMethodsAndBadBodies"),

    # Мусор в теле назывался «unknown action»: причина была не той, и дефект
    # искали в разборе действий, а не в разборе запроса.
    ("мусор в теле запроса к профилям называется неизвестным действием", "profiles.go",
     '''		if err := json.Unmarshal(raw, &m); err != nil {
			writeJSONError(w, http.StatusBadRequest, "неразборчивый запрос: "+err.Error())
			return
		}''',
     '''		json.Unmarshal(raw, &m)''',
     "TestProfilesRejectsUnsupportedMethodsAndBadBodies"),

    ("переменные вида %ИМЯ% в пути из реестра не раскрываются", "players.go",
     '''		b := strings.Index(s[a+1:], "%")''',
     '''		b := -1''',
     "TestExpandWinEnvExpandsPercentNames"),

    ("прочитанное не складывается из кусков запросов", "watched.go",
     '''	files[fileID] += n''',
     '''	files[fileID] = n''',
     "TestViewedReadsAddsUpRangeRequests"),

    ("оборванная передача считается прочитанной", "watched.go",
     '''	c.n += int64(n)''',
     '''	c.n += int64(len(b))''',
     "TestCountingWriterCountsOnlyWhatWasDelivered"),

    ("неизвестный размер файла считается полным просмотром", "watched.go",
     '''	if total <= 0 || delivered <= 0 {''',
     '''	if delivered <= 0 {''',
     "TestReadThroughWantsAlmostTheWholeFile"),

    ("досмотр ставится без проверки прочитанного", "watched.go",
     '''	if !readThrough(viewedReads.bytes(hash, fileID), total) {
		return
	}
''',
     '',
     "TestMarkReadThroughSetsDoneOnlyForAReadFile"),

    ("запрос состояния раздачи считается потоком файла", "watched.go",
     '''	if !strings.HasPrefix(path, "/stream/") {''',
     '''	if path == "" {''',
     "TestReadTargetIgnoresTheStatusRequest"),

    ("наблюдатель молчит о недоступной папке", "watcher.go",
     '''				if err != nil {
					// Прежде ошибка чтения отбрасывалась целиком, и наблюдатель
					// молчал ровно одинаково при пустой папке и при папке,
					// которой нет. Теперь причина видна в журнале наблюдения —
					// там, где её и ищут: «торренты не добавляются».
					w.noteFolderError(f, err)
				} else {
					w.noteFolderOK()''',
     '''				if err != nil {
					_ = err
				} else {''',
     "TestWatcherReportsUnreadableFolder"),

    ("одна и та же ошибка папки засоряет журнал при каждом опросе", "watcher.go",
     '''	fresh := w.lastErr != msg''',
     '''	fresh := true''',
     "TestWatcherReportsTheSameErrorOnce"),

    ("о восстановлении папки не сообщается", "watcher.go",
     '''	w.mu.Lock()
	was := w.lastErr
	w.lastErr = ""
	w.mu.Unlock()
	if was != "" {
		w.addLog("Папка снова доступна")
	}''',
     '''	w.mu.Lock()
	w.lastErr = ""
	w.mu.Unlock()''',
     "TestWatcherReportsFolderRecovery"),

    ("строка журнала о папке не называет ни пути, ни причины", "folders.go",
     '''		out = append(out, "папка недоступна — "+where+": "+st.Reason)''',
     '''		out = append(out, "папка недоступна")''',
     "TestFolderProblemsNamesPathAndReason"),

    ("причина отказа сервиса метаданных не доходит до интерфейса", "tmdb.go",
     '''		if tr.OK {
			out = tr
			if imdb == "" && tr.ID != 0 {
				imdb = c.tmdbImdbID(tr.ID, tr.Type)
			}
		} else if tr.Error != "" {
			// Причина отказа сервиса доходит до интерфейса: «не найдено»,
			// «ключ отклонён» и «ключ не задан» — разные состояния, и
			// молчание вместо причины выглядит как пропавшие постеры.
			out.Error = tr.Error
		}''',
     '''		if tr.OK {
			out = tr
			if imdb == "" && tr.ID != 0 {
				imdb = c.tmdbImdbID(tr.ID, tr.Type)
			}
		}''',
     "TestRatingsReportARejectedKey"),

    ("отклонённый ключ выглядит как «сервис ничего не нашёл»", "tmdb.go",
     '''	if resp.StatusCode == http.StatusUnauthorized {
		// Отозванный или неверный ключ. Это не «фильм не найден»: постеры
		// пропадут у всех раздач сразу, и причина должна называться.
		return TMDBRes{OK: false, Error: errTMDBBadKey}
	}
''',
     '',
     "TestRatingsReportARejectedKey"),

    ("запомненный отказ переживает смену ключа TMDB", "tmdb.go",
     '''		// Запомненные отказы относились к прежнему ключу: с новым они неверны
		// и полчаса держали бы постеры пустыми.
		tmdbDropMisses()
		jj(w, map[string]any{"ok": true, "configured": key != "" || token != ""})''',
     '''		jj(w, map[string]any{"ok": true, "configured": key != "" || token != ""})''',
     "TestSavingTheKeyForgetsRememberedMisses"),

    # Кэш и постоянные данные: разведены по разным папкам, и обе берутся из
    # настройки. Кэш можно положить на диск, который очищается при перезагрузке,
    # отметки просмотра и избранное — нельзя.
    ("кэш метаданных пишется рядом с программой, а не в указанную папку кэша", "tmdb.go",
     '''	return filepath.Join(cacheDir(), "tmdb-cache.json")''',
     '''	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "tmdb-cache.json")''',
     "TestCacheFilesFollowTheSetting"),

    ("журнал пишется мимо папки кэша", "log.go",
     '''func logPath() string { return filepath.Join(cacheDir(), "torrclient.log") }''',
     '''func logPath() string { return filepath.Join(exeDir(), "torrclient.log") }''',
     "TestCacheFilesFollowTheSetting"),

    ("отметки просмотра лежат в кэше, а не в постоянных данных", "player.go",
     '''	return filepath.Join(dataDir(), "viewed.json")''',
     '''	return filepath.Join(cacheDir(), "viewed.json")''',
     "TestStateFilesFollowTheSetting"),

    ("избранное уезжает на очищаемый диск", "userdata.go",
     '''	return filepath.Join(dataDir(), "userdata.json")''',
     '''	return filepath.Join(cacheDir(), "userdata.json")''',
     "TestStateFilesFollowTheSetting"),

    ("пустая настройка папки не откатывается к каталогу программы", "config.go",
     '''	if c := curCfg(); c != nil {
		if p := strings.TrimSpace(pick(c)); p != "" {
			return absToExe(p)
		}
	}''',
     '''	if c := curCfg(); c != nil {
		return absToExe(strings.TrimSpace(pick(c)))
	}''',
     "TestStorageFallsBackToTheProgramFolder"),

    ("перенос склада затирает то, что уже лежит в новой папке", "config.go",
     '''		if _, err := os.Stat(dst); err == nil {
			continue
		}
''',
     '',
     "TestMoveStateFilesKeepsWhatIsAlreadyThere"),

    ("смена папки постоянных данных не переносит накопленное", "profiles.go",
     '''			before := curCfg().DataFolder''',
     '''			before := ""''',
     "TestDirsActionStoresStorageFoldersAndMovesTheStore"),

    ("архив собирается мимо папки постоянных данных", "backup.go",
     '''		data, err := os.ReadFile(stateFilePath(name))''',
     '''		data, err := os.ReadFile(filepath.Join(exeDir(), name))''',
     "TestBackupTakesStateFilesFromTheirFolders"),

    ("возврат архива кладёт отметки по прежнему адресу", "backup.go",
     '''		if err := writeFileAtomic(stateFilePath(name), data, 0o600); err != nil {''',
     '''		if err := writeFileAtomic(filepath.Join(exeDir(), name), data, 0o600); err != nil {''',
     "TestRestorePutsStateFilesWhereTheConfigPoints"),

    ("возврат архива раскладывает файлы по прежним папкам, а не по возвращённым настройкам", "backup.go",
     '''		reloadConfigPaths()
''',
     '',
     "TestRestorePutsStateFilesWhereTheConfigPoints"),
]

# Правки интерфейса: проверка tools/check-series.js, отказ — ненулевой код возврата.
JS_STEPS = [
    ("число сезона перед словом не читается", "web/app.js",
     '''  // «5 сезон» — число перед словом.
  m = s.match(/(?:^|[^\\p{L}\\p{N}])(\\d{1,2})\\s+сезон/iu);
  if (m) return parseInt(m[1], 10);
''',
     '',
     "check-series"),

    ("разрешение после слова «сезон» читается как номер сезона", "web/app.js",
     '''  m = s.match(/сезон[ыа]?[ ._-]*(\\d{1,2})(?:$|[^\\p{L}\\p{N}])/iu);''',
     '''  m = s.match(/сезон[ыа]?[ ._-]*(\\d{1,2})(?:\\s*[-–—]\\s*(\\d{1,2}))?/iu);''',
     "check-series"),

    ("новая панель подгрузки не закрывает прежнюю", "web/app.js",
     '''  activePanel = panel;
''',
     '',
     "check-series"),

    ("в «продолжить просмотр» попадает и досмотренное", "web/app.js",
     '''    .filter(v => v && !v.done && v.timecode > 0 && lib[v.hash])''',
     '''    .filter(v => v && lib[v.hash])''',
     "check-series"),

    ("у карточки сериала нет места под постер", "web/app.js",
     '''    <div class="ser-poster">
      ${raw(PH_SVG.replace('class="ph"', head.poster ? 'class="ph hidden"' : 'class="ph"'))}
      ${raw(head.poster ? html`<img src="${head.poster}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
      <span class="chip rating" data-tmdb hidden></span>
    </div>
''',
     '',
     "check-series"),

    ("в таблице раздач не видно ни скорости, ни кэша", "web/app.js",
     '''    set('size', r.total ? fmtSize(r.total) : '—');
    set('dl', r.speed > 0 ? fmtSpeed(r.speed) : '—');
    set('ul', Number(r.t.upload_speed) > 0 ? fmtSpeed(Number(r.t.upload_speed)) : '—');
    set('peers', (Number(r.t.connected_seeders) || 0) + ' / ' + (Number(r.t.active_peers) || 0));
    set('pre', r.pre ? fmtSize(r.preB) + ' из ' + fmtSize(r.pre) : '—');
    set('read', Number(r.t.bytes_read) ? fmtSize(Number(r.t.bytes_read)) : '—');''',
     '''    set('size', r.total ? fmtSize(r.total) : '—');''',
     "check-series"),

    ("в строке серии нет ни кадра, ни даты, ни описания", "web/app.js",
     '''      <span class="ep-still"></span>
      <span class="ep-body">
        <span class="ep-line1"><span class="ep-label">${epLabel(f, t)}</span><span class="epname"></span></span>
        <span class="ep-meta"></span>
        <span class="ep-over"></span>
        <span class="ep-state">${stateText}</span>
      </span>
''',
     '''      <span class="ep-label">${epLabel(f, t)}</span>
      <span class="epname"></span>
      <span class="ep-state">${stateText}</span>
''',
     "check-series"),

    ("заголовок сезона не говорит ни о числе серий, ни о датах", "web/app.js",
     '''    + (bits.length ? html`<span class="ep-season-meta">${bits.join(' · ')}</span>` : '');''',
     '''    ;''',
     "check-series"),

    ("кнопка поиска плееров не говорит, где искала", "web/app.js",
     '''  const head = roots.slice(0, 8).join(' · ');
  const tail = roots.length > 8 ? ' и ещё ' + (roots.length - 8) : '';
  const found = (state.players || []).filter(p => p.found).length;
  box.textContent = 'Проверено папок: ' + roots.length + ' — ' + head + tail + '. Найдено плееров: ' + found + '.';''',
     '''  box.textContent = '';''',
     "check-series"),

    ("изменение отметки просмотра не замечается", "web/app.js",
     '''    .map(v => v.hash + ':' + v.file_index + ':' + Math.round(v.timecode || 0) + ':' + (v.done ? 1 : 0))''',
     '''    .map(v => v.hash + ':' + v.file_index)''',
     "check-series"),

    ("путь на несуществующем диске выглядит исправным: отказ папки не виден", "web/app.js",
     '''      ${raw(folderNoticeHTML('watch'))}
''',
     '',
     "check-series"),

    ("кнопка исправления переписывает и исправную соседнюю папку", "web/app.js",
     '''  const body = { action: 'dirs' };
  body[field] = def;
  return body;''',
     '''  return { action: 'dirs', watch_folder: folderDefault('watch'), download_folder: folderDefault('downloads') };''',
     "check-series"),

    ("выдача поиска показывается без отсева не-видео", "web/app.js",
     '''  const onlyVideo = videoOnlyOn();''',
     '''  const onlyVideo = false;''',
     "check-series"),

    ("признаки софта на кириллице не срабатывают: \\b не работает с русскими буквами", "web/app.js",
     '''  { kind: 'софт', re: /(активатор|кейген|кряк|взломанн\\w*|лекарство)/i },''',
     '''  { kind: 'софт', re: /\\b(активатор|кейген|кряк|взломанн\\w*|лекарство)\\b/i },''',
     "check-series"),

    ("выбрав «Игры», пользователь всё равно не видит игр", "web/app.js",
     '''  const c = el ? el.value : '';
  return !(c === 'игры' || c === 'софт' || c === 'книги' || c === 'музыка');''',
     '''  return true;''',
     "check-series"),

    ("MP3 считается книгой без разбора: старый DVDRip уходит из выдачи", "web/app.js",
     '''  if (/(?:^|[\\s|(])(?:MP3|МР3)\\b/.test(t) && !VIDEO_MARK.test(t)) return 'книга';''',
     '''  if (/(?:^|[\\s|(])(?:MP3|МР3)\\b/.test(t)) return 'книга';''',
     "check-series"),

    ("настройка «только видео» ни на что не влияет", "web/app.js",
     '''  if (!videoOnlyPref()) return false;\n''',
     '''''',
     "check-series"),

    ("слово-исключение уходит на трекер вместе с запросом", "web/app.js",
     '''    if (w.length > 1 && w[0] === '-') {
      const t = w.slice(1).toLowerCase();
      if (t) drop.push(t);
      continue;
    }
''',
     '',
     "check-series"),

    ("исключение ищется без приведения регистра: латиница в названии мимо", "web/app.js",
     '''function excludedBy(title, drop) {
  if (!drop || !drop.length) return '';
  const t = String(title || '').toLowerCase();''',
     '''function excludedBy(title, drop) {
  if (!drop || !drop.length) return '';
  const t = String(title || '');''',
     "check-series"),

    ("исключение из запроса не доходит до выдачи", "web/app.js",
     '''  const excl = (state.searchState && state.searchState.exclude) || [];''',
     '''  const excl = [];''',
     "check-series"),

    ("«показать всё» отменяет и исключение, которое пользователь написал сам", "web/app.js",
     '''  if (excl.length) {''',
     '''  if (excl.length && !state.searchState.showAll) {''',
     "check-series"),

    ("пустая выдача из-за исключения молчит, как будто ничего не нашлось", "web/app.js",
     '''    if (hiddenEx) why = 'Всё, что нашлось, подпадает под исключение ' + excl.map(w => '-' + w).join(' ') + '. Уберите его из запроса.';''',
     '''    if (hiddenEx) why = 'Нет результатов.';''',
     "check-series"),

    ("слово-исключение попадает в разметку как есть", "web/app.js",
     '''hiddenEx ? html`<span class="hint" style="margin:0">скрыто ${hiddenEx} по «${excl.map(w => '-' + w).join(' ')}»</span>` : ''',
     '''hiddenEx ? `<span class="hint" style="margin:0">скрыто ${hiddenEx} по «${excl.map(w => '-' + w).join(' ')}»</span>` : ''',
     "check-series"),

    ("незаданный ключ TMDB ничем не отличается от «ничего не найдено»", "web/app.js",
     '''const META_ERR_TEXT = {
  'tmdb key not configured': 'Постеры и оценки не загружаются: не задан ключ TMDB',
  'tmdb key rejected': 'Постеры и оценки не загружаются: ключ TMDB отклонён сервисом',
};''',
     '''const META_ERR_TEXT = {
  'tmdb key rejected': 'Постеры и оценки не загружаются: ключ TMDB отклонён сервисом',
};''',
     "check-series"),

    # Постер, пришедший от TMDB, некуда положить: он остаётся только в поле
    # плитки, а loadLibrary() заменяет state.lib новым массивом.
    ("постер плитки пропадает вместе с перезагруженным списком", "web/app.js",
     '''  posterStore.set(k, next);
  savePosterStoreSoon();
  return !same;
}''',
     '''  return !same;
}''',
     "check-series"),

    # Запомненный ответ не признаётся свежим: библиотека снова спрашивает сервис
    # по каждой плитке при каждом заходе.
    ("свежая запись не отменяет запрос к сервису", "web/app.js",
     '''  const rec = posterStore.get(posterKey(c));
  if (!rec || !rec.s) return null;
  return (Date.now() - rec.s) < META_TTL ? rec : null;''',
     '''  return null;''',
     "check-series"),

    # Оценка не возвращается из хранилища: она приходит только с ответом TMDB,
    # а тот спрашивается заново при каждом запуске окна.
    ("оценка не переживает перезапуск окна", "web/app.js",
     '''    if (rec.r > 0 || rec.i > 0) ratingStore.set(k, { ok: true, rating: rec.r || 0, imdb: rec.i || 0, imdb_id: rec.d || '', title: rec.t || '' });
''',
     '',
     "check-series"),

    # Свежий отказ сервиса гасит уже известную оценку.
    ("отказ TMDB гасит известную оценку плитки", "web/app.js",
     '''    const eff = (j && j.ok) ? j : (ratingStore.get(posterKey(task.c)) || j);''',
     '''    const eff = j;''',
     "check-series"),

    # Порядок вызовов: постеры спрашиваются раньше, чем загружен список, то есть
    # при пустом state.lib — запрос уходит в никуда.
    ("постеры библиотеки спрашиваются до загрузки списка", "web/app.js",
     '''  refreshLibrary();
}

// refreshLibrary — «перезагрузить список и подтянуть метаданные». Один порядок''',
     '''  libRatings();
  loadLibrary(true).then(paintLibrary);
}

// refreshLibrary — «перезагрузить список и подтянуть метаданные». Один порядок''',
     "check-series"),

    # Место карточки в разметке (data-ix) считается по полной выдаче, а постер
    # искал её по показанному списку: на отфильтрованной выдаче индексы расходятся.
    ("постер ищет карточку по месту в показанной выдаче", "web/app.js",
     '''  const base = all || visible;''',
     '''  const base = visible;''',
     "check-series"),

    # Оценка, поставленная прямо в разметку, пропадает при перерисовке плитки
    # после подгрузки постеров: чип остаётся скрытым до следующего ответа TMDB.
    ("оценка плитки пропадает при перерисовке после подгрузки постеров", "web/app.js",
     '''        <span class="chip rating" data-tmdb${rtTmdb ? '' : ' hidden'}>${rtTmdb}</span>
        <span class="chip rt-imdb" data-imdb${rtImdb ? '' : ' hidden'}>${rtImdb}</span>''',
     '''        <span class="chip rating" data-tmdb hidden></span>
        <span class="chip rt-imdb" data-imdb hidden></span>''',
     "check-series"),

    # «24» в названии кнопки читалось как число строк, и блок суток обрывался на
    # двадцать четвёртой раздаче. Откат возвращает обрезку — проверка это ловит.
    ("ТОП-24 обрывается на двадцать четвёртой раздаче", "web/app.js",
     '''  state.searchState.results = items;
  state.searchState.q = '';
  state.searchState.topLabel = '';''',
     '''  state.searchState.results = items.slice(0, 24);
  state.searchState.q = '';
  state.searchState.topLabel = '';''',
     "check-series"),
]


# Правки оболочки Wails: проверка `go test` в каталоге app, отказ — ненулевой код.
APP_STEPS = [
    ("на сетевом диске каталог данных окна остаётся рядом с программой", "app/main.go",
     '''	if localFixed && exeDir != "" {''',
     '''	if exeDir != "" {''',
     "TestChooseWebviewPathLeavesTheNetworkDrive"),

    ("перекрытие каталога данных окна переменной окружения не работает", "app/main.go",
     '''	if v := os.Getenv("TC_WEBVIEW_DATA"); v != "" {
		return v
	}
''',
     '',
     "TestWebviewDataPathHonoursTheOverride"),

    ("медленно поднимающийся TorrServer снимают и запускают заново", "app/app.go",
     '''	if prevRunning && prevAge < grace {
		return false
	}
''',
     '',
     "TestShouldSpawnTorrServerGivesASlowStartTime"),

    ("сломанный процесс поднимают каждые пять секунд без конца", "app/restart.go",
     '''	if g.fails < g.limit {
		return true
	}
	if now.Before(g.silent) {
		return false
	}
	g.succeeded()
	return true''',
     '''	return true''',
     "TestRestartGuardGivesTheLimitAndThenGoesQuiet"),

    ("медленный запуск обнуляет счёт неудач и прячет беду", "app/restart.go",
     '''	switch out {
	case restartOK:
		g.succeeded()''',
     '''	switch out {
	case restartSkipped:
		g.succeeded()''',
     "TestRestartGuardKeepsTheCountAcrossSkippedRounds"),

    ("сборка TorrServer без /echo признаётся мёртвой", "app/app.go",
     '''	if resp.StatusCode == http.StatusNotFound {
		return true, ""
	}
''',
     '',
     "TestTorrServerReadyAcceptsABuildWithoutEcho"),

    ("пустой ответ /echo признаётся готовностью сервера", "app/app.go",
     '''	return version != "", version''',
     '''	return true, version''',
     "TestTorrServerReadyRejectsAnEmptyBody"),

    ("ожидание не прекращается, когда запущенный процесс завершился", "app/app.go",
     '''		if !alive() {
			return false
		}
''',
     '',
     "TestWaitReadyGivesUpAsSoonAsTheProcessIsGone"),

    ("порт, занятый чужой программой, не отличается от нашего поднимающегося", "app/app.go",
     '''	return portOpen && !weStarted && !alive''',
     '''	return false''',
     "TestForeignHolderRecognisesAForeignProgram"),
]


# Страница-оболочка окна: проверка tools/check-shell.cjs.
SHELL_STEPS = [
    ("имя события разошлось между программой и страницей", "app/app.go",
     '''	problemEvent = "torrclient:problem"''',
     '''	problemEvent = "torrclient:problems"''',
     "check-shell"),

    ("страница молчит, когда демон не поднялся", "app/frontend/dist/index.html",
     '''            if (problem) {
                status.textContent = "TorrClient не удалось запустить";
                hint.textContent = problem;
                hint.hidden = false;
                return;
            }
            if (waited >= patientSeconds) {
                status.textContent = "Демон не отвечает — " + waited + " с";
                hint.textContent =
                    "Порт 8099 не отвечает. Проверьте, что torrclient.exe лежит " +
                    "рядом с программой и что порт не занят другой программой.";
                hint.hidden = false;
                return;
            }
''',
     '',
     "check-shell"),
]


def run_go(pattern):
    p = subprocess.run([GO, "test", "-run", pattern, "."], cwd=ROOT, env=ENV,
                       capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def run_app(pattern):
    p = subprocess.run([GO, "test", "-run", pattern, "./..."], cwd=os.path.join(ROOT, "app"),
                       env=ENV, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def run_js():
    p = subprocess.run([NODE, os.path.join("tools", "check-series.js")], cwd=ROOT, env=ENV,
                       capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def run_shell():
    p = subprocess.run([NODE, os.path.join("tools", "check-shell.cjs")], cwd=ROOT, env=ENV,
                       capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


# Незавершённые откаты: путь к файлу → его исходный текст. Пока шаг идёт, файл
# откачен, и вернуть его обязано что угодно, чем бы прогон ни закончился.
PENDING = {}

# Журнал на диске — на случай, когда обработчики не успевают: снятие прогона по
# сроку в этой среде убивает процесс насмерть, без сигнала, и вернуть файл из
# памяти уже некому. Тогда исходный текст остаётся в журнале, и следующий прогон
# возвращает файл на место ещё до первого шага.
#
# Файл именно переписывается, а не удаляется: на портативном диске удаление
# недоступно, а пустой журнал и отсутствующий равнозначны.
JOURNAL = os.path.join(ROOT, "tools", ".prove-journal.json")


def write_journal(entries):
    with open(JOURNAL, "w", encoding="utf-8", newline="") as f:
        json.dump(entries, f, ensure_ascii=False)


def recover_journal():
    """Возвращает на место файлы, оставшиеся откаченными после снятого прогона."""
    if not os.path.exists(JOURNAL):
        return
    try:
        with open(JOURNAL, encoding="utf-8") as f:
            entries = json.load(f)
    except (OSError, ValueError) as e:
        print("журнал прогона не прочитан (%s) — пропускаю возврат" % e)
        return
    for path, text in entries.items():
        try:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(text)
            print("возвращено на место после прерванного прогона: %s"
                  % os.path.relpath(path, ROOT))
        except OSError as e:
            print("НЕ УДАЛОСЬ ВОЗВРАЩАТЬ %s: %s" % (path, e))
    write_journal({})


def restore_pending():
    """Возвращает на место всё, что осталось откаченным в этом прогоне."""
    for path in list(PENDING):
        text = PENDING.pop(path)
        try:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(text)
            print("возвращено на место при завершении: %s" % os.path.relpath(path, ROOT))
        except OSError as e:
            print("НЕ УДАЛОСЬ ВОЗВРАЩАТЬ %s: %s" % (path, e))
    write_journal({})


def _on_signal(_signum, _frame):
    restore_pending()
    sys.exit(130)


atexit.register(restore_pending)
for _sig in (signal.SIGINT, signal.SIGTERM):
    try:
        signal.signal(_sig, _on_signal)
    except (ValueError, OSError):
        # Не главный поток или сигнал недоступен — остаётся журнал на диске.
        pass


def step(title, name, old, new, run):
    """Откатывает одну правку, гоняет проверку и возвращает файл на место."""
    path = os.path.join(ROOT, name)
    with open(path, encoding="utf-8") as f:
        text = f.read()
    found = text.count(old)
    if found != 1:
        # Молчаливая замена не того места дала бы доказательство, которого нет.
        print("ПРОПУСК: %s — шаблон найден %d раз" % (title, found))
        return False
    try:
        PENDING[path] = text
        write_journal({path: text})
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text.replace(old, new))
        code, out = run()
    finally:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        PENDING.pop(path, None)
        write_journal({})
    if code == 0:
        print("НЕ ДОКАЗАНО: %s — проверка прошла на прежнем поведении" % title)
        return False
    line = next((l.strip() for l in out.splitlines() if l.strip().startswith("ПЛОХО")), "")
    if not line:
        line = next((l.strip() for l in out.splitlines() if "FAIL" in l or "ПРОВАЛОВ" in l), "")
    print("доказано: %s\n    %s" % (title, line or out.strip().splitlines()[-1][:120]))
    return True


def main():
    if not os.path.exists(GO):
        print("не найден go: " + GO + " (укажите TC_GO)")
        return 1
    # Снятый прогон мог оставить файл откаченным: возвращаем до первого шага,
    # иначе первый же шаг читал бы уже испорченный файл.
    recover_journal()
    # Необязательные доводы — подстроки названий шагов. Полный прогон занимает
    # минуты, а после правки одного места нужен один шаг.
    only = sys.argv[1:]

    def want(title):
        return not only or any(s in title for s in only)

    ok = True
    for title, name, old, new, test in STEPS:
        if want(title) and not step(title, name, old, new, lambda t=test: run_go(t)):
            ok = False
    for title, name, old, new, kind in JS_STEPS:
        if want(title) and not step(title, name, old, new, run_js):
            ok = False
    for title, name, old, new, test in APP_STEPS:
        if want(title) and not step(title, name, old, new, lambda t=test: run_app(t)):
            ok = False
    for title, name, old, new, kind in SHELL_STEPS:
        if want(title) and not step(title, name, old, new, run_shell):
            ok = False
    print("\nитог: " + ("все шаги доказаны" if ok else "есть недоказанные шаги"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
