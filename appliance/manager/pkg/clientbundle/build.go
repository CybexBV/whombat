package clientbundle

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"time"
)

// Entry is one member of an artifact the publisher builds.
type Entry struct {
	Name string // relative, clean
	Dir  bool
	Exec bool
	// Path is the file whose bytes become the member (unmodified); ignored for directories.
	Path string
}

// WriteTarGz writes a reproducible tar.gz (mtime 0, uid/gid 0, no owner names, fixed gzip header) of the entries
// in order: the wrapper the publisher puts around a bare executable (Claude Code's release is the binary itself).
// File contents are copied byte for byte.
func WriteTarGz(w io.Writer, entries []Entry) error {
	gz, err := gzip.NewWriterLevel(w, gzip.BestCompression)
	if err != nil {
		return err
	}
	gz.Header.ModTime = time.Time{}
	gz.Header.OS = 3 // Unix
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		if n, err := CleanName(e.Name); err != nil || n != e.Name || n == "" {
			return fmt.Errorf("bad entry name %q", e.Name)
		}
		h := &tar.Header{Name: e.Name, ModTime: time.Unix(0, 0), Format: tar.FormatPAX}
		if e.Dir {
			h.Typeflag, h.Name, h.Mode = tar.TypeDir, e.Name+"/", 0o755
			if err := tw.WriteHeader(h); err != nil {
				return err
			}
			continue
		}
		f, err := os.Open(e.Path)
		if err != nil {
			return err
		}
		st, err := f.Stat()
		if err != nil {
			f.Close()
			return err
		}
		h.Typeflag, h.Size, h.Mode = tar.TypeReg, st.Size(), 0o644
		if e.Exec {
			h.Mode = 0o755
		}
		if err := tw.WriteHeader(h); err != nil {
			f.Close()
			return err
		}
		_, err = io.Copy(tw, f)
		f.Close()
		if err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}
