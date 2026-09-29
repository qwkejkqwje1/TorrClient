package main

// Избранное и закладки: общий склад рядом с демоном.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// ---------- userdata (избранное/закладки, хранятся рядом с демоном) ----------

type UserData struct {
	Favorites []json.RawMessage `json:"favorites"`
	Bookmarks []json.RawMessage `json:"bookmarks"`
	// Collections — подборки: именованные списки раздач. Хранятся как есть,
	// как избранное и закладки: склад не разбирает чужие поля, а только
	// перевозит их между интерфейсом и диском.
	Collections []json.RawMessage `json:"collections"`
}

var (
	userDataMu   sync.Mutex
	userDataList *UserData
)

// userDataPath — склад избранного и закладок в папке постоянных данных: это
// состояние пользователя, и его потеря не восполняется ничем.
func userDataPath() string {
	return filepath.Join(dataDir(), "userdata.json")
}

func loadUserDataStore() {
	userDataList = &UserData{}
	// Файл без номера формата читается как прежде: номера в нём не было, пока
	// поле не появилось. Битый файл и файл чужого формата оставляют склад пустым,
	// но сам файл не трогают — иначе следующая запись стёрла бы то, что
	// разобрать не удалось, и восстановить было бы уже нечего.
	_ = readStateDoc(userDataPath(), userDataList)
	if userDataList.Favorites == nil {
		userDataList.Favorites = []json.RawMessage{}
	}
	if userDataList.Bookmarks == nil {
		userDataList.Bookmarks = []json.RawMessage{}
	}
	if userDataList.Collections == nil {
		userDataList.Collections = []json.RawMessage{}
	}
}

func saveUserDataStore() error {
	userDataMu.Lock()
	defer userDataMu.Unlock()
	return writeStateDoc(userDataPath(), userDataList)
}

func (c *Comp) apiUserData(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		userDataMu.Lock()
		fav := append([]json.RawMessage{}, userDataList.Favorites...)
		bm := append([]json.RawMessage{}, userDataList.Bookmarks...)
		colls := append([]json.RawMessage{}, userDataList.Collections...)
		userDataMu.Unlock()
		// stored отвечает, писал ли кто-нибудь в склад хоть раз. Без него
		// «пустой список» неотличим от «склада ещё нет», и свежая сборка
		// стирала бы избранное, накопленное в браузере до первого сохранения.
		_, statErr := os.Stat(userDataPath())
		jj(w, map[string]any{
			"favorites": fav, "bookmarks": bm, "collections": colls,
			"stored": statErr == nil,
		})
	case http.MethodPost:
		var in struct {
			Favorites   *[]json.RawMessage `json:"favorites"`
			Bookmarks   *[]json.RawMessage `json:"bookmarks"`
			Collections *[]json.RawMessage `json:"collections"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
			// Битый JSON не должен молча обнулить избранное и закладки.
			writeJSONError(w, http.StatusBadRequest, "неразборчивый запрос")
			return
		}
		userDataMu.Lock()
		if in.Favorites != nil {
			userDataList.Favorites = *in.Favorites
		}
		if in.Bookmarks != nil {
			userDataList.Bookmarks = *in.Bookmarks
		}
		// Пустой список подборок — не «стереть»: интерфейс шлёт склад целиком,
		// и пустой массив означает «подборок нет», а не «не трогать».
		// Отличать их по отсутствию ключа надёжнее, чем по длине.
		if in.Collections != nil {
			userDataList.Collections = *in.Collections
		}
		userDataMu.Unlock()
		saveUserDataStore()
		jj(w, map[string]any{"ok": true})
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}
