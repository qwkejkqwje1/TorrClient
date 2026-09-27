package main

// Проверки счёта неудачных перезапусков.
//
// Сторож поднимает упавший процесс заново, и без счёта делал бы это без конца:
// отсутствующий или сломанный файл — это попытка каждые пять секунд, мелькание
// процессов и ни одного объяснения пользователю. Здесь проверяется, что попытки
// ограничены, что после исчерпания сторож молчит паузу и говорит об этом, и что
// счёт не сбрасывается на ровном месте — иначе настоящая беда осталась бы
// незамеченной.

import (
	"testing"
	"time"
)

// Три неудачи подряд — предел; дальше сторож молчит.
func TestRestartGuardGivesTheLimitAndThenGoesQuiet(t *testing.T) {
	g := restartGuard{limit: restartLimit, backoff: restartBackoff}
	now := time.Now()

	for i := 1; i <= restartLimit; i++ {
		if !g.allowed(now) {
			t.Fatalf("попытка %d не разрешена, хотя предел ещё не исчерпан", i)
		}
		gaveUp := g.note(now, restartFailed)
		wantGaveUp := i == restartLimit
		if gaveUp != wantGaveUp {
			t.Errorf("на неудаче %d исчерпание=%v, ожидалось %v", i, gaveUp, wantGaveUp)
		}
	}
	if g.allowed(now.Add(healthEvery)) {
		t.Error("попытки исчерпаны, а сторож продолжает запускать")
	}
}

// Один раз о беде говорится — в момент исчерпания, а не каждым кругом: иначе
// сообщение превратилось бы в поток, и пользователь перестал бы его читать.
func TestRestartGuardSpeaksUpOnceAndNotEveryRound(t *testing.T) {
	g := restartGuard{limit: restartLimit, backoff: restartBackoff}
	now := time.Now()

	said := 0
	for i := 0; i < restartLimit; i++ {
		if g.note(now, restartFailed) {
			said++
		}
	}
	if said != 1 {
		t.Fatalf("о беде сказано %d раз, ожидался один", said)
	}
	// Пауза: попытки не делаются, значит и говорить не о чем.
	for _, d := range []time.Duration{healthEvery, time.Minute} {
		if g.note(now.Add(d), restartSkipped) {
			t.Error("о беде сказано повторно")
		}
	}
}

// Пауза кончилась — сторож снова пробует, и счёт начинается заново. Иначе
// починенный файл не поднялся бы уже никогда.
func TestRestartGuardWakesUpAfterTheBackoff(t *testing.T) {
	g := restartGuard{limit: restartLimit, backoff: restartBackoff}
	now := time.Now()
	for i := 0; i < restartLimit; i++ {
		g.note(now, restartFailed)
	}

	if g.allowed(now.Add(restartBackoff - time.Second)) {
		t.Error("сторож проснулся раньше паузы")
	}
	if !g.allowed(now.Add(restartBackoff)) {
		t.Fatal("пауза вышла, а попыток больше не будет")
	}
	if gaveUp := g.note(now.Add(restartBackoff), restartFailed); gaveUp {
		t.Error("после паузы первая же неудача снова заглушила сторожа — счёт не сброшен")
	}
}

// Поднявшийся процесс обнуляет счёт: редкие падения не должны копиться до
// предела и глушить сторожа.
func TestRestartGuardForgetsFailuresAfterASuccess(t *testing.T) {
	g := restartGuard{limit: restartLimit, backoff: restartBackoff}
	now := time.Now()

	for round := 0; round < 5; round++ {
		for i := 0; i < restartLimit-1; i++ {
			g.note(now, restartFailed)
		}
		if gaveUp := g.note(now, restartOK); gaveUp {
			t.Fatal("поднявшийся процесс признан исчерпанием попыток")
		}
	}
	if !g.allowed(now) {
		t.Error("сторож заглушен накопленными падениями, хотя процесс поднимался")
	}
}

// Медленный запуск, который сторож каждый круг признаёт «ещё поднимается», не
// должен обнулять счёт: иначе настоящая беда пряталась бы за пропущенными
// кругами и о ней никогда не сообщалось бы.
func TestRestartGuardKeepsTheCountAcrossSkippedRounds(t *testing.T) {
	g := restartGuard{limit: restartLimit, backoff: restartBackoff}
	now := time.Now()

	g.note(now, restartFailed)
	g.note(now, restartFailed)
	for i := 0; i < 5; i++ {
		if g.note(now, restartSkipped) {
			t.Fatal("пропущенный круг признан исчерпанием попыток")
		}
	}
	if gaveUp := g.note(now, restartFailed); !gaveUp {
		t.Error("третья неудача не признана исчерпанием попыток — счёт потерян")
	}
}

// Оставшаяся пауза называется числом: она идёт в сообщение пользователю.
func TestRestartGuardReportsTheRemainingPause(t *testing.T) {
	g := restartGuard{limit: restartLimit, backoff: restartBackoff}
	now := time.Now()

	if got := g.waiting(now); got != 0 {
		t.Errorf("до исчерпания пауза %v, ожидался ноль", got)
	}
	for i := 0; i < restartLimit; i++ {
		g.note(now, restartFailed)
	}
	if got := g.waiting(now); got != restartBackoff {
		t.Errorf("пауза %v, ожидалась %v", got, restartBackoff)
	}
	if got := g.waiting(now.Add(restartBackoff)); got != 0 {
		t.Errorf("пауза вышла, а сообщается %v", got)
	}
}

// Круг сторожа обязан быть заметно короче паузы: иначе пауза ничего не значит,
// и о беде сообщалось бы почти сразу после первой же неудачи.
func TestRestartBackoffOutlastsTheHealthLoop(t *testing.T) {
	if restartBackoff <= healthEvery {
		t.Fatalf("пауза %v не больше круга сторожа %v", restartBackoff, healthEvery)
	}
	if restartLimit < 2 {
		t.Fatalf("предел попыток %d — счёт из одной попытки ничего не ограничивает", restartLimit)
	}
}

// Круг сторожа целиком: сломанный процесс пробуют поднять ровно столько раз,
// сколько разрешено, дальше запусков нет до конца паузы — и после неё сторож
// снова берётся за дело.
func TestWatchOneStopsStartingAfterTheLimit(t *testing.T) {
	a := NewApp()
	now := time.Now()
	calls := 0
	start := func() (restartOutcome, string) {
		calls++
		return restartFailed, "файл не найден"
	}

	for i := 0; i < restartLimit; i++ {
		a.watchOne("TorrServer", &a.tsGuard, start, now)
	}
	if calls != restartLimit {
		t.Fatalf("попыток %d, ожидалось %d", calls, restartLimit)
	}

	// В паузе не запускается ничего: сломанный файл не должен подниматься
	// каждые пять секунд.
	for _, d := range []time.Duration{healthEvery, time.Minute} {
		a.watchOne("TorrServer", &a.tsGuard, start, now.Add(d))
	}
	if calls != restartLimit {
		t.Errorf("в паузе сделано ещё %d попыток", calls-restartLimit)
	}

	a.watchOne("TorrServer", &a.tsGuard, start, now.Add(restartBackoff+time.Second))
	if calls != restartLimit+1 {
		t.Errorf("после паузы попыток %d, ожидалась %d", calls, restartLimit+1)
	}
}

// Живой процесс не считается неудачей и обнуляет счёт.
func TestWatchOneTreatsARunningProcessAsSuccess(t *testing.T) {
	a := NewApp()
	now := time.Now()

	for i := 0; i < restartLimit-1; i++ {
		a.watchOne("демон", &a.daemonGuard, func() (restartOutcome, string) {
			return restartFailed, "не открыл порт"
		}, now)
	}
	a.watchOne("демон", &a.daemonGuard, func() (restartOutcome, string) {
		return restartOK, ""
	}, now)

	// Процесс поднялся, значит прежние падения не в счёт: следующие две
	// неудачи не должны заглушить сторожа.
	calls := 0
	a.watchOne("демон", &a.daemonGuard, func() (restartOutcome, string) {
		calls++
		return restartFailed, "упал"
	}, now)
	a.watchOne("демон", &a.daemonGuard, func() (restartOutcome, string) {
		calls++
		return restartFailed, "упал"
	}, now)
	if calls != 2 {
		t.Fatalf("попыток %d, ожидалось 2 — счёт не сброшен поднявшимся процессом", calls)
	}
}
