package main

// Проверки того, что архив состояния не увозит ключи метаданных, и того, что
// испорченный архив не трогает рабочее состояние.
//
// Архив отдают другому человеку или прикладывают к сообщению о проблеме, а в
// torrclient.json ключи метаданных лежат открытым текстом. Правило взято у
// соседнего проекта: выгрузка не должна содержать секретов — и это проверяется,
// а не подразумевается.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// backupEntry снимает архив обработчиком и отдаёт один файл из него.
func backupEntry(t *testing.T, name string) string {
	t.Helper()
	comp := &Comp{}
	rr := httptest.NewRecorder()
	comp.apiBackup(rr, httptest.NewRequest(http.MethodGet, "/api/backup", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("код %d, ожидался 200: %s", rr.Code, rr.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(rr.Body.Bytes()), int64(rr.Body.Len()))
	if err != nil {
		t.Fatalf("ответ не разобран как архив: %v", err)
	}
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("файл %s в архиве не открылся: %v", name, err)
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("файл %s в архиве не прочитан: %v", name, err)
		}
		return string(b)
	}
	t.Fatalf("в архиве нет файла %s", name)
	return ""
}

// archiveOf собирает архив из перечисленных файлов — так же, как это делает
// пользователь, отдавая программе файл резервной копии.
func archiveOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		fw, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func restore(t *testing.T, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	comp := &Comp{}
	rr := httptest.NewRecorder()
	comp.apiRestore(rr, httptest.NewRequest(http.MethodPost, "/api/restore", bytes.NewReader(body)))
	return rr
}

func TestBackupLeavesTheMetadataKeysBehind(t *testing.T) {
	keepConfigFile(t)
	useStorageDirs(t)
	settings := `{"active_profile_id":"local","tmdb_api_key":"КЛЮЧ-СЕКРЕТ","tmdb_access_token":"ТОКЕН-СЕКРЕТ"}`
	if err := os.WriteFile(confPath(), []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}

	in := backupEntry(t, "torrclient.json")
	if strings.Contains(in, "СЕКРЕТ") {
		t.Errorf("секрет уехал в архиве: %s", in)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(in), &m); err != nil {
		t.Fatalf("настройки в архиве не разбираются: %v (%s)", err, in)
	}
	if _, ok := m["tmdb_api_key"]; ok {
		t.Error("в архиве осталось поле tmdb_api_key")
	}
	if _, ok := m["tmdb_access_token"]; ok {
		t.Error("в архиве осталось поле tmdb_access_token")
	}
	if _, ok := m["active_profile_id"]; !ok {
		t.Error("вместе с ключами из архива пропала обычная настройка")
	}

	// На диске ключ остаётся: вырезается копия для архива, а не рабочие настройки.
	onDisk, err := os.ReadFile(confPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "КЛЮЧ-СЕКРЕТ") {
		t.Errorf("ключ пропал из рабочих настроек: %s", onDisk)
	}
}

// Пароль к чужому серверу лежит внутри профиля, а не на верхнем уровне, и
// вырезание одних верхних полей оставляло его в архиве.
func TestBackupLeavesProfilePasswordsBehind(t *testing.T) {
	keepConfigFile(t)
	useStorageDirs(t)
	settings := `{"active_profile_id":"home","profiles":[{"id":"home","name":"Домашний",` +
		`"url":"http://192.168.1.5:8090","user":"vasya","pass":"ПАРОЛЬ-СЕКРЕТ"}]}`
	if err := os.WriteFile(confPath(), []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}

	in := backupEntry(t, "torrclient.json")
	if strings.Contains(in, "СЕКРЕТ") {
		t.Errorf("секрет уехал в архиве: %s", in)
	}
	var m struct {
		Profiles []map[string]any `json:"profiles"`
	}
	if err := json.Unmarshal([]byte(in), &m); err != nil {
		t.Fatalf("настройки в архиве не разбираются: %v (%s)", err, in)
	}
	if len(m.Profiles) != 1 {
		t.Fatalf("профилей в архиве: %d, ожидался 1 (%s)", len(m.Profiles), in)
	}
	if _, ok := m.Profiles[0]["pass"]; ok {
		t.Error("в архиве осталось поле pass у профиля")
	}
	// Вместе с паролем не должен пропасть сам сервер: адрес и имя — не секрет.
	if got, want := m.Profiles[0]["url"], "http://192.168.1.5:8090"; got != want {
		t.Errorf("адрес сервера в архиве: %v, ожидался %q", got, want)
	}
	if got, want := m.Profiles[0]["name"], "Домашний"; got != want {
		t.Errorf("имя профиля в архиве: %v, ожидалось %q", got, want)
	}

	// На диске пароль остаётся: вырезается копия для архива.
	onDisk, err := os.ReadFile(confPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "ПАРОЛЬ-СЕКРЕТ") {
		t.Errorf("пароль пропал из рабочих настроек: %s", onDisk)
	}
}

// Пароль, как и ключ, принадлежит машине: возврат архива не должен оставлять
// сервер без пароля — «восстановлено», а подключиться нельзя.
func TestRestoreKeepsThePasswordThatIsNotInTheArchive(t *testing.T) {
	keepConfigFile(t)
	cache, data := useStorageDirs(t)
	local, err := json.Marshal(map[string]any{
		"active_profile_id": "home",
		"cache_folder":      cache,
		"data_folder":       data,
		"profiles": []map[string]string{
			{"id": "home", "url": "http://192.168.1.5:8090", "pass": "СВОЙ-ПАРОЛЬ"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(confPath(), local, 0o600); err != nil {
		t.Fatal(err)
	}
	reloadConfigPaths()

	fromArchive, err := json.Marshal(map[string]any{
		"active_profile_id": "home",
		"cache_folder":      cache,
		"data_folder":       data,
		"profiles": []map[string]string{
			{"id": "home", "url": "http://192.168.1.5:8090"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	rr := restore(t, archiveOf(t, map[string]string{"torrclient.json": string(fromArchive)}))
	if rr.Code != http.StatusOK {
		t.Fatalf("код %d, ожидался 200: %s", rr.Code, rr.Body.String())
	}

	onDisk, err := os.ReadFile(confPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "СВОЙ-ПАРОЛЬ") {
		t.Errorf("возврат архива стёр рабочий пароль: %s", onDisk)
	}
}

// Ключ принадлежит машине, а не архиву: возврат архива на той же машине не
// должен его стирать — иначе «восстановлено», а постеры пропали.
func TestRestoreKeepsTheKeyThatIsNotInTheArchive(t *testing.T) {
	keepConfigFile(t)
	cache, data := useStorageDirs(t)
	local, err := json.Marshal(map[string]string{
		"active_profile_id": "local",
		"cache_folder":      cache,
		"data_folder":       data,
		"tmdb_api_key":      "СВОЙ-КЛЮЧ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(confPath(), local, 0o600); err != nil {
		t.Fatal(err)
	}
	reloadConfigPaths()

	fromArchive, err := json.Marshal(map[string]string{
		"active_profile_id": "local",
		"cache_folder":      cache,
		"data_folder":       data,
	})
	if err != nil {
		t.Fatal(err)
	}
	rr := restore(t, archiveOf(t, map[string]string{"torrclient.json": string(fromArchive)}))
	if rr.Code != http.StatusOK {
		t.Fatalf("код %d, ожидался 200: %s", rr.Code, rr.Body.String())
	}

	onDisk, err := os.ReadFile(confPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "СВОЙ-КЛЮЧ") {
		t.Errorf("возврат архива стёр рабочий ключ: %s", onDisk)
	}
}

// «Восстановить» не должно означать «потерять то, что было»: испорченный файл в
// архиве отвергает весь архив, а прежние настройки остаются нетронутыми.
func TestRestoreRefusesABrokenArchiveAndKeepsTheOldState(t *testing.T) {
	keepConfigFile(t)
	useStorageDirs(t)
	good := `{"active_profile_id":"local","tmdb_api_key":"СВОЙ-КЛЮЧ"}`
	if err := os.WriteFile(confPath(), []byte(good), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(confPath())
	if err != nil {
		t.Fatal(err)
	}

	// Обрыв внутри значения: разобрать такой файл нельзя.
	broken := archiveOf(t, map[string]string{"torrclient.json": `{"active_profile_id":`})
	rr := restore(t, broken)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("код %d, ожидался 400: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "испорчен") {
		t.Errorf("отказ не объясняет причину: %s", rr.Body.String())
	}

	after, err := os.ReadFile(confPath())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Errorf("испорченный архив тронул рабочие настройки:\nбыло:  %s\nстало: %s", before, after)
	}
}
