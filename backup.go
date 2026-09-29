package main

// Резервная копия состояния одним архивом — в духе портабельности.
//
// Портативная сборка держит всё рядом с собой: настройки, избранное, отметки
// просмотра. Перенести её на другую машину можно и копированием папки, но
// забрать с собой только состояние (без exe, кэша постеров и закачек) до сих
// пор было нечем — приходилось искать нужные файлы вручную.
//
// Папки кэша и постоянных данных могут быть разнесены по разным дискам, поэтому
// каждый файл берётся и кладётся по своему адресу (stateFilePath), а не из
// общего каталога программы.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// backupFiles — что попадает в архив. Порядок фиксирован: в архиве с одним и
// тем же состоянием файлы идут одинаково.
//
// subscriptions.json добавлен вместе с подписками: список набирается месяцами и
// восстановить его нечем, а архив без него на чужой машине оставил бы подписки
// пустыми без всякого объяснения.
var backupFiles = []string{"torrclient.json", "userdata.json", "viewed.json", "subscriptions.json"}

// backupSecrets — поля настроек, которых в архиве быть не должно.
//
// Архив отдают другому человеку или прикладывают к сообщению о проблеме, а в
// torrclient.json ключи метаданных лежат открытым текстом: вместе с архивом
// уехал бы и ключ. Сами настройки на диске не трогаются — ключ остаётся у
// пользователя, вырезается только копия для архива.
var backupSecrets = []string{"tmdb_api_key", "tmdb_access_token"}

// stripBackupSecrets убирает ключи из копии настроек для архива.
//
// Разбор идёт в map[string]json.RawMessage, а не в значения: так остальные поля
// переносятся байт в байт, и настройка, которой мы не знаем, не потеряется.
// Неразобранные настройки в архив не кладутся вовсе — «на всякий случай как
// есть» означало бы «может быть, вместе с ключом».
func stripBackupSecrets(data []byte) ([]byte, bool) {
	var m map[string]json.RawMessage
	if json.Unmarshal(data, &m) != nil || m == nil {
		return nil, false
	}
	for _, k := range backupSecrets {
		delete(m, k)
	}
	stripProfilePasswords(m)
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, false
	}
	return out, true
}

// stripProfilePasswords убирает пароли серверов из копии настроек.
//
// Пароль лежит не на верхнем уровне, а внутри каждого профиля, и вырезание
// только верхних полей оставляло его в архиве: архив отдают другому человеку
// или прикладывают к сообщению о проблеме, а вместе с ним уезжал бы и пароль к
// чужому TorrServer. Разбор идёт по элементам профиля, поэтому остальные поля
// (адрес, имя, признак SSL) переносятся как есть.
func stripProfilePasswords(m map[string]json.RawMessage) {
	raw, ok := m["profiles"]
	if !ok {
		return
	}
	var arr []map[string]json.RawMessage
	if json.Unmarshal(raw, &arr) != nil {
		return
	}
	for _, p := range arr {
		delete(p, "pass")
	}
	if out, err := json.Marshal(arr); err == nil {
		m["profiles"] = out
	}
}

// keepLocalSecrets переносит ключи метаданных из текущих настроек в возвращаемые
// архивом.
//
// В архиве ключей нет (stripBackupSecrets), а ключ — вещь машинная, не часть
// переносимого состояния. Без этого переноса возврат архива на той же машине
// стёр бы рабочий ключ: «восстановлено», а постеры пропали. Ключ из самого
// архива (сделанного прежней сборкой) сохраняется как есть.
func keepLocalSecrets(incoming []byte) []byte {
	cur := curCfg()
	if cur == nil {
		return incoming
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(incoming, &m) != nil || m == nil {
		return incoming
	}
	for key, value := range map[string]string{
		"tmdb_api_key":      cur.TMDBApiKey,
		"tmdb_access_token": cur.TMDBAccessToken,
	} {
		if value == "" || len(m[key]) > 0 {
			continue
		}
		if b, err := json.Marshal(value); err == nil {
			m[key] = b
		}
	}
	keepProfilePasswords(m, cur)
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return incoming
	}
	return out
}

// keepProfilePasswords возвращает пароль профиля из текущих настроек, если в
// архиве его нет.
//
// Правило то же, что у ключа TMDB: пароль не ездит в архиве, но пропадать при
// возврате не должен — иначе «восстановлено», а сервер недоступен. Пароль
// подставляется по совпадению id: свой профиль с тем же id значит тот же
// сервер. Пароль из самого архива (сделанного прежней сборкой) не трогается —
// его выбрал не мы.
func keepProfilePasswords(m map[string]json.RawMessage, cur *Config) {
	if cur == nil {
		return
	}
	raw, ok := m["profiles"]
	if !ok {
		return
	}
	var arr []map[string]json.RawMessage
	if json.Unmarshal(raw, &arr) != nil {
		return
	}
	for _, p := range arr {
		if len(p["pass"]) > 0 {
			continue
		}
		id := ""
		if idRaw, ok := p["id"]; ok {
			_ = json.Unmarshal(idRaw, &id)
		}
		if id == "" {
			continue
		}
		for _, prof := range cur.Profiles {
			if prof == nil || prof.ID != id || prof.Pass == "" {
				continue
			}
			if b, err := json.Marshal(prof.Pass); err == nil {
				p["pass"] = b
			}
			break
		}
	}
	if out, err := json.Marshal(arr); err == nil {
		m["profiles"] = out
	}
}

// stateFilePath — где лежит файл состояния. Настройки остаются рядом с
// программой: в них указаны папки кэша и постоянных данных, и другого места,
// откуда их можно было бы прочитать, нет. Остальное состояние — отметки
// просмотра и склад избранного — лежит в папке постоянных данных.
func stateFilePath(name string) string {
	if name == "torrclient.json" {
		return confPath()
	}
	return filepath.Join(dataDir(), name)
}

// apiBackup отдаёт архив с состоянием.
func (c *Comp) apiBackup(w http.ResponseWriter, r *http.Request) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	added := 0
	for _, name := range backupFiles {
		data, err := os.ReadFile(stateFilePath(name))
		if err != nil {
			// Файла может не быть — это не ошибка: пустое состояние тоже
			// состояние, и архив из одного файла лучше отказа.
			continue
		}
		if name == "torrclient.json" {
			clean, ok := stripBackupSecrets(data)
			if !ok {
				// Настройки не разобрались — ключ из них не вырезать, а архив
				// уходит наружу. Такой файл в архив не идёт.
				continue
			}
			data = clean
		}
		fw, err := zw.Create(name)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "архив не собран: "+err.Error())
			return
		}
		if _, err := fw.Write(data); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "архив не собран: "+err.Error())
			return
		}
		added++
	}
	if err := zw.Close(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "архив не собран: "+err.Error())
		return
	}

	name := "torrclient-backup-" + time.Now().Format("20060102-150405") + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("X-Backup-Files", fmt.Sprintf("%d", added))
	w.Write(buf.Bytes())
}

// restoreNames — как называть файлы состояния в сообщении об отказе: «файл
// userdata.json испорчен» пользователю ничего не говорит.
var restoreNames = map[string]string{
	"torrclient.json":    "настройки",
	"userdata.json":      "избранное и закладки",
	"viewed.json":        "отметки просмотра",
	"subscriptions.json": "подписки на сериалы",
}

// validateRestore разбирает файлы архива до первой записи.
//
// Архив приходит извне, и испорченный torrclient.json иначе затирал бы рабочие
// настройки — а выяснилось бы это только при чтении, когда вернуть уже нечего.
// «Восстановить» не должно означать «потерять то, что было»: при первой же
// ошибке отказываем целиком, не записав ничего.
//
// Все три файла — объекты JSON, поэтому проверка одна: верхний уровень обязан
// разбираться в объект. Схему здесь не сторожим — за неё отвечают те, кто эти
// файлы читает; ловится именно порча.
func validateRestore(got map[string][]byte) error {
	for _, name := range backupFiles {
		data, ok := got[name]
		if !ok {
			continue
		}
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(data, &obj); err != nil || obj == nil {
			return fmt.Errorf("в архиве испорчен файл %s (%s)", name, restoreNames[name])
		}
	}
	return nil
}

// apiRestore принимает архив и заменяет состояние.
//
// Имена внутри архива проверяются по списку: архив приходит извне, и запись по
// произвольному пути («../../») позволила бы положить файл куда угодно.
// Содержимое разбирается до первой записи (validateRestore): испорченный архив
// должен быть отвергнут целиком, а не наполовину применён.
//
// Файлы раскладываются по своим папкам, и настройки — первыми: в них указана
// папка постоянных данных, а отметки с избранным должны лечь уже по новому
// адресу. Иначе возврат архива с другим путём положил бы их в прежнюю папку, а
// читались бы они из новой — «восстановлено», а на экране пусто.
//
// Ключи метаданных в архиве не ездят (stripBackupSecrets), поэтому при возврате
// они берутся из текущих настроек (keepLocalSecrets) — иначе возврат архива на
// той же машине стёр бы рабочий ключ.
func (c *Comp) apiRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "возврат состояния принимается только POST'ом")
		return
	}
	raw, err := readRestoreBody(w, r)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "это не zip-архив: "+err.Error())
		return
	}

	allowed := map[string]bool{}
	for _, n := range backupFiles {
		allowed[n] = true
	}
	// Содержимое сначала читается целиком: порядок записи задаётся здесь, а не
	// тем, как файлы легли в архиве.
	got := map[string][]byte{}
	for _, f := range zr.File {
		name := filepath.Base(strings.TrimSpace(f.Name))
		if !allowed[name] {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "файл "+name+" не читается: "+err.Error())
			return
		}
		data, err := io.ReadAll(io.LimitReader(rc, 32<<20))
		rc.Close()
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "файл "+name+" не читается: "+err.Error())
			return
		}
		got[name] = data
	}
	if len(got) == 0 {
		writeJSONError(w, http.StatusBadRequest, "в архиве нет файлов состояния")
		return
	}
	if err := validateRestore(got); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	written := []string{}
	if data, ok := got["torrclient.json"]; ok {
		// Ключи метаданных в архив не кладутся, но и терять их при возврате
		// нельзя: ключ принадлежит машине, а не архиву.
		data = keepLocalSecrets(data)
		if err := writeFileAtomic(confPath(), data, 0o600); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "файл torrclient.json не сохранён: "+err.Error())
			return
		}
		written = append(written, "torrclient.json")
		// Папки из возвращённых настроек: отметки и избранное должны попасть
		// туда, куда теперь указывает конфиг, а не туда, где лежали прежде.
		reloadConfigPaths()
	}
	for _, name := range backupFiles {
		if name == "torrclient.json" {
			continue
		}
		data, ok := got[name]
		if !ok {
			continue
		}
		if err := writeFileAtomic(stateFilePath(name), data, 0o600); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "файл "+name+" не сохранён: "+err.Error())
			return
		}
		written = append(written, name)
	}

	// Состояние подхватывается сразу: иначе возврат из архива выглядел бы так —
	// «импортировано», а на экране прежние настройки до перезапуска.
	c.reloadState()
	jj(w, map[string]any{"ok": true, "files": written})
}

// readRestoreBody читает архив: либо как файл формы (поле file), либо как тело
// запроса целиком.
func readRestoreBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			return nil, fmt.Errorf("форма не разобрана: %w", err)
		}
		f, _, err := r.FormFile("file")
		if err != nil {
			return nil, fmt.Errorf("в форме нет поля file")
		}
		defer f.Close()
		return io.ReadAll(io.LimitReader(f, 32<<20))
	}
	return io.ReadAll(io.LimitReader(http.MaxBytesReader(w, r.Body, 32<<20), 32<<20))
}

// reloadState перечитывает состояние с диска: конфиг, избранное и отметки.
func (c *Comp) reloadState() {
	reloadConfigPaths()
	nc := curCfg()
	if c.dl != nil {
		c.dl.SetFolder(nc.DownloadFolder)
	}
	if c.watch != nil {
		c.watch.SetFolder(nc.WatchFolder)
	}
	loadUserDataStore()
	viewedMarks.load()
	// Профиль мог смениться: сторож раздач соберёт новый список сам, а вот
	// открытым окнам стоит сказать сразу.
	events.broadcast("state", map[string]any{"reloaded": true})
}
