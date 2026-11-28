package main

import "path/filepath"

// programAside is where `uninstall` tries to move the running agent (a
// file named name) so that its program folder can go: Windows' own
// temporary folder, then, because a rename can't cross drives and Program
// Files may be on another one than Windows, beside the program folder,
// on the program's own drive (and as admin-only as the folder was).
// Either is deleted when Windows restarts.
func programAside(exe, systemRoot, name string) []string {
	var to []string
	if systemRoot != "" {
		to = append(to, filepath.Join(systemRoot, "Temp", name))
	}
	return append(to, filepath.Join(filepath.Dir(filepath.Dir(exe)), name))
}
