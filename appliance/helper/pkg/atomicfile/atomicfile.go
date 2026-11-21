// Package atomicfile writes files crash-safely: write a temporary file in the same directory, fsync
// it, rename it over the destination and fsync the directory. After a crash the destination holds
// either the complete old or the complete new content.
package atomicfile

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// FaultHook, when non-nil, is called at named points of a write ("after-temp-sync", "after-rename").
// Tests use it to simulate a crash between steps; returning an error aborts the write there.
var FaultHook func(point, path string) error

func fault(point, path string) error {
	if FaultHook != nil {
		return FaultHook(point, path)
	}
	return nil
}

// WriteFile atomically replaces path with data using the given permissions.
func WriteFile(path string, data []byte, perm os.FileMode) error {
	return Write(path, perm, func(w io.Writer) error {
		_, err := w.Write(data)
		return err
	})
}

// Write atomically replaces path with the content produced by fill.
func Write(path string, perm os.FileMode, fill func(io.Writer) error) (err error) {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			_ = os.Remove(tmp)
		}
	}()
	if err = f.Chmod(perm); err != nil {
		f.Close()
		return err
	}
	if err = fill(f); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("fsync %s: %w", tmp, err)
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = fault("after-temp-sync", path); err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	if ferr := fault("after-rename", path); ferr != nil {
		// The rename happened; do not remove anything, just report the simulated crash.
		return ferr
	}
	return SyncDir(dir)
}

// SyncDir fsyncs a directory so that renames and creations inside it are durable.
func SyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil && !errors.Is(err, os.ErrInvalid) {
		return fmt.Errorf("fsync dir %s: %w", dir, err)
	}
	return nil
}

// SyncFile fsyncs an existing file (used after third-party code wrote it without fsync).
func SyncFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

// CleanTemps removes leftover temporary files from interrupted writes in dir.
func CleanTemps(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		n := e.Name()
		if len(n) > 0 && n[0] == '.' && filepath.Ext(n) != "" && containsTmp(n) {
			_ = os.Remove(filepath.Join(dir, n))
		}
	}
}

func containsTmp(n string) bool {
	for i := 0; i+5 <= len(n); i++ {
		if n[i:i+5] == ".tmp-" {
			return true
		}
	}
	return false
}
