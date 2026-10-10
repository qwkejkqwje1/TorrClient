package main

import "testing"

func TestDancerPath(t *testing.T) {
	ok := []string{"reze.vrm", "Резе (v2).vrm", "dance_01.vrma", "Hip Hop.fbx", "salsa.bvh"}
	for _, n := range ok {
		if _, err := dancerPath(n); err != nil {
			t.Errorf("%q: %v", n, err)
		}
	}
	bad := []string{"", "../x.vrm", "a/b.vrm", `a\b.vrm`, ".hidden.vrm", "x.exe", "model.vrm.txt", "x\x00.vrm"}
	for _, n := range bad {
		if _, err := dancerPath(n); err == nil {
			t.Errorf("%q должно быть отклонено", n)
		}
	}
	if dancerKind("a.VRM") != "model" || dancerKind("a.vrma") != "anim" || dancerKind("a.glb") != "" {
		t.Error("dancerKind")
	}
}
