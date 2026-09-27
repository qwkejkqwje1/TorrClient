package main

// Счёт неудачных перезапусков.
//
// Сторож поднимает упавший процесс заново, и без счёта он делал бы это без
// конца: сломанный или отсутствующий файл — это попытка каждые пять секунд,
// мелькание процессов, загрузка процессора и ни одного объяснения. Здесь
// попытки ограничены, а после исчерпания сторож замолкает на паузу — чтобы
// причина успела исчезнуть, а пользователь успел прочитать сообщение.

import "time"

// restartOutcome — чем закончилась попытка поднять процесс.
type restartOutcome int

const (
	// restartSkipped — попытки не было: процесс жив, уже поднимается, или
	// окно закрывается.
	restartSkipped restartOutcome = iota
	// restartOK — процесс отвечает.
	restartOK
	// restartFailed — пытались поднять и не получилось.
	restartFailed
)

// restartGuard считает неудачные попытки подряд и решает, когда замолчать.
type restartGuard struct {
	limit   int
	backoff time.Duration

	fails  int
	silent time.Time
}

// allowed отвечает, можно ли пробовать снова.
//
// Пауза кончилась — счёт начинается заново: иначе первая же неудача после
// паузы снова заглушила бы сторожа, и починенный файл не поднялся бы уже
// никогда, до перезапуска программы.
func (g *restartGuard) allowed(now time.Time) bool {
	if g.fails < g.limit {
		return true
	}
	if now.Before(g.silent) {
		return false
	}
	g.succeeded()
	return true
}

// note записывает исход попытки. Возвращает true, если попытки исчерпаны —
// это и есть момент, когда о беде нужно сказать пользователю.
//
// Пропущенная попытка не считается ни удачей, ни неудачей: счёт по ней не
// сбрасывался бы, но и не рос. Сбрасывать его здесь нельзя — иначе медленный
// запуск, который сторож каждый круг признаёт «ещё поднимается», обнулял бы
// счёт и прятал настоящую беду.
func (g *restartGuard) note(now time.Time, out restartOutcome) (gaveUp bool) {
	switch out {
	case restartOK:
		g.succeeded()
	case restartFailed:
		g.fails++
		if g.fails >= g.limit {
			g.silent = now.Add(g.backoff)
			return true
		}
	}
	return false
}

// succeeded сбрасывает счёт: процесс поднялся, и прежние падения не в счёт.
func (g *restartGuard) succeeded() {
	g.fails = 0
	g.silent = time.Time{}
}

// waiting отвечает, сколько ещё сторож будет молчать про этот процесс.
func (g *restartGuard) waiting(now time.Time) time.Duration {
	if g.fails < g.limit || !now.Before(g.silent) {
		return 0
	}
	return g.silent.Sub(now)
}
