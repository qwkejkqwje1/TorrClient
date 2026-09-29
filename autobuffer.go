package main

// Автонастройка буфера TorrServer: замер скорости интернета и подбор размера
// кэша, предзагрузки, чтения вперёд и числа соединений.
//
// Логика простая и проверяемая: чем медленнее канал, тем больше запас —
// предзагрузка сглаживает провалы скорости, которые при быстром канале
// догоняются сами. Число сидов влияет так же: на редкой раздаче скорость
// скачет, и запас нужен больше (seedHint — сиды раздачи, если известны).

import (
	"context"
	"io"
	"net/http"
	"time"
)

type bufferPlan struct {
	Mbps             float64 `json:"mbps"`
	CacheSize        int64   `json:"CacheSize"`
	PreloadCache     int     `json:"PreloadCache"`
	ReaderReadAHead  int     `json:"ReaderReadAHead"`
	ConnectionsLimit int     `json:"ConnectionsLimit"`
	Why              string  `json:"why"`
}

const mb = 1 << 20

func planBuffer(mbps float64, seedHint int) bufferPlan {
	p := bufferPlan{Mbps: mbps, ReaderReadAHead: 95}
	switch {
	case mbps >= 100:
		p.CacheSize, p.PreloadCache, p.ConnectionsLimit = 256*mb, 15, 50
		p.Why = "быстрый канал: хватает небольшого запаса, 4K идёт без ожидания"
	case mbps >= 40:
		p.CacheSize, p.PreloadCache, p.ConnectionsLimit = 256*mb, 25, 40
		p.Why = "хороший канал: 1080p без пауз, 4K — с короткой предзагрузкой"
	case mbps >= 15:
		p.CacheSize, p.PreloadCache, p.ConnectionsLimit = 512*mb, 40, 30
		p.Why = "средний канал: запас побольше, чтобы 1080p не прерывался"
	default:
		p.CacheSize, p.PreloadCache, p.ConnectionsLimit = 768*mb, 60, 25
		p.Why = "медленный канал: большой запас; 4K может не успевать — выбирайте 1080p и ниже"
	}
	if seedHint > 0 && seedHint < 5 {
		if p.PreloadCache < 60 {
			p.PreloadCache += 20
		}
		p.Why += "; мало сидов — предзагрузка увеличена"
	}
	return p
}

// speedTestURL — файл для замера. Cloudflare отдаёт заданное число байт без
// кэша и регистрации.
var speedTestURL = "https://speed.cloudflare.com/__down?bytes=25000000"

// measureMbps качает файл не дольше limit и считает скорость по принятому.
func measureMbps(ctx context.Context, url string, limit time.Duration) (float64, error) {
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	n, _ := io.Copy(io.Discard, resp.Body) // обрыв по таймауту — не ошибка: замер по принятому
	sec := time.Since(start).Seconds()
	if n < 256*1024 || sec <= 0 {
		return 0, io.ErrUnexpectedEOF
	}
	return float64(n) * 8 / sec / 1e6, nil
}

// apiAutoBuffer — POST {"seeds":N}: замер скорости и план настроек. Сами
// настройки применяет интерфейс поверх текущих (TorrServer обнуляет
// неприсланные поля).
func (c *Comp) apiAutoBuffer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "только POST")
		return
	}
	var in struct {
		Seeds int     `json:"seeds"`
		Mbps  float64 `json:"mbps"` // для проверки без сети
	}
	_ = decodeTorznabBody(w, r, &in)
	mbps := in.Mbps
	if mbps <= 0 {
		m, err := measureMbps(r.Context(), speedTestURL, 8*time.Second)
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "замер скорости не удался: "+err.Error())
			return
		}
		mbps = m
	}
	jj(w, planBuffer(mbps, in.Seeds))
}
