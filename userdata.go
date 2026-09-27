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
	b, err := os.ReadFile(userDataPath())
	if err != nil {
		return
	}
	var d UserData
	if json.Unmarshal(b, &d) == nil {
		if d.Favorites == nil {
			d.Favorites = []json.RawMessage{}
		}
		if d.Bookmarks == nil {
			d.Bookmarks = []json.RawMessage{}
		}
		userDataList = &d
	}
}

func saveUserDataStore() error {
	userDataMu.Lock()
	defer userDataMu.Unlock()
	b, _ := json.MarshalIndent(userDataList, "", "  ")
	return writeFileAtomic(userDataPath(), b, 0o600)
}

func (c *Comp) apiUserData(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		userDataMu.Lock()
		fav := append([]json.RawMessage{}, userDataList.Favorites...)
		bm := append([]json.RawMessage{}, userDataList.Bookmarks...)
		userDataMu.Unlock()
		jj(w, map[string]any{"favorites": fav, "bookmarks": bm})
	case http.MethodPost:
		var in struct {
			Favorites *[]json.RawMessage `json:"favorites"`
			Bookmarks *[]json.RawMessage `json:"bookmarks"`
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
		userDataMu.Unlock()
		saveUserDataStore()
		jj(w, map[string]any{"ok": true})
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}
