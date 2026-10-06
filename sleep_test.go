package main

import (
	"os/exec"
	"testing"
	"time"
)

func TestSleepAfterEpisode(t *testing.T) {
	fired := make(chan string, 1)
	old := sleepRun
	sleepRun = func(action string, _ []*exec.Cmd) { fired <- action }
	defer func() { sleepRun = old; cancelSleep() }()

	armSleep(0, "episode", "sleep")
	sleepNoteFile("h", 1)
	sleepNoteFile("h", 1)
	select {
	case a := <-fired:
		t.Fatalf("сработал до конца серии: %s", a)
	case <-time.After(50 * time.Millisecond):
	}
	sleepNoteFile("h", 2)
	select {
	case a := <-fired:
		if a != "sleep" {
			t.Fatalf("действие %q", a)
		}
	case <-time.After(time.Second):
		t.Fatal("не сработал на смене серии")
	}
	sleepMu.Lock()
	active := sleepCur.Active
	sleepMu.Unlock()
	if active {
		t.Fatal("таймер остался активным")
	}
}

func TestSleepCancel(t *testing.T) {
	armSleep(5, "time", "shutdown")
	cancelSleep()
	sleepMu.Lock()
	defer sleepMu.Unlock()
	if sleepCur.Active {
		t.Fatal("отмена не сработала")
	}
}
