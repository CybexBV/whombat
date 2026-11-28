package main

import (
	"path/filepath"
	"slices"
	"testing"
)

// Program Files on another drive than Windows: the agent still has a place
// on its own drive, outside the folder that goes.
func TestProgramAsideFallsBackToTheProgramsDrive(t *testing.T) {
	exe := filepath.Join("/d", "Program Files", "Whombat", "whombat-agent.exe")
	got := programAside(exe, filepath.Join("/c", "Windows"), "x.exe")
	want := []string{filepath.Join("/c", "Windows", "Temp", "x.exe"), filepath.Join("/d", "Program Files", "x.exe")}
	if !slices.Equal(got, want) {
		t.Errorf("programAside = %v, want %v", got, want)
	}
	if got := programAside(exe, "", "x.exe"); !slices.Equal(got, want[1:]) {
		t.Errorf("without SystemRoot: %v", got)
	}
}
