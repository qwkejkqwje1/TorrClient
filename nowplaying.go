package main

// «Сейчас играет»: какие раздачи открыты во внешнем плеере прямо сейчас.
//
// Демон запускает плеер сам и знает, когда тот закрылся, но окну об этом не
// сообщал: понять, что идёт, можно было только по меняющейся позиции в
// «Продолжить просмотр». Теперь у каждого запуска есть запись, она живёт до
// выхода плеера, а изменение уходит в живую ленту событием nowplaying.

import (
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type nowItem struct {
	ID        int64   `json:"id"`
	Hash      string  `json:"hash"`
	FileIndex int     `json:"file_index"`
	Player    string  `json:"player"`
	Started   int64   `json:"started"`
	Pos       float64 `json:"pos,omitempty"`
	Duration  float64 `json:"duration,omitempty"`
}

var (
	nowMu  sync.Mutex
	nowMap = map[int64]*nowItem{}
	nowSeq atomic.Int64
)

// nowStart заводит запись о запущенном плеере и возвращает её номер.
func nowStart(hash string, fileID int, player string) int64 {
	id := nowSeq.Add(1)
	nowMu.Lock()
	nowMap[id] = &nowItem{ID: id, Hash: hash, FileIndex: fileID, Player: player, Started: time.Now().Unix()}
	nowMu.Unlock()
	nowNotify()
	return id
}

// nowStop убирает запись: плеер закрылся.
func nowStop(id int64) {
	nowMu.Lock()
	_, ok := nowMap[id]
	delete(nowMap, id)
	nowMu.Unlock()
	if ok {
		nowNotify()
	}
}

// nowTrack обновляет серию и позицию по замеру плеера. Событие уходит только
// при смене серии: позицию окно и так получает событием positions.
func nowTrack(hash string, fileID int, pos, dur float64) {
	changed := false
	nowMu.Lock()
	for _, it := range nowMap {
		if it.Hash != hash {
			continue
		}
		if fileID > 0 && it.FileIndex != fileID {
			it.FileIndex = fileID
			changed = true
		}
		it.Pos, it.Duration = pos, dur
	}
	nowMu.Unlock()
	if changed {
		nowNotify()
	}
}

func nowList() []nowItem {
	nowMu.Lock()
	out := make([]nowItem, 0, len(nowMap))
	for _, it := range nowMap {
		out = append(out, *it)
	}
	nowMu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Started > out[j].Started })
	return out
}

func nowNotify() { events.broadcast("nowplaying", map[string]any{"items": nowList()}) }

func (c *Comp) apiNowPlaying(w http.ResponseWriter, r *http.Request) {
	jj(w, map[string]any{"items": nowList()})
}
