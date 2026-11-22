//go:build !unix

package diskusage

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

type otherScanFS struct {
	r *Runner
}

func newDefaultScanFS(r *Runner) scanFS {
	return &otherScanFS{r: r}
}

func (f *otherScanFS) OpenRoot(hostPath, logicalMount string, _ mountInfo) (scanDir, error) {
	fi, err := os.Lstat(hostPath)
	if err != nil {
		return nil, err
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return nil, errors.New("symlink")
	}
	if !fi.IsDir() {
		return nil, errNotDir
	}
	return &otherScanDir{r: f.r, hostPath: hostPath, logicalPath: logicalMount}, nil
}

type otherScanDir struct {
	r           *Runner
	hostPath    string
	logicalPath string
	ents        []fs.DirEntry
	loaded      bool
	off         int
}

func (d *otherScanDir) Stat() (entryStat, error) {
	fi, err := os.Lstat(d.hostPath)
	if err != nil {
		return entryStat{}, err
	}
	return entryStatFromFileInfo(fi), nil
}

func (d *otherScanDir) Statfs() (fsStat, error) {
	return hostStatfs(d.hostPath)
}

func (d *otherScanDir) OpenSelf() (scanDir, error) {
	return &otherScanDir{r: d.r, hostPath: d.hostPath, logicalPath: d.logicalPath}, nil
}

func (d *otherScanDir) ReadDirBatch(maxEntries int) ([]dirEntryInfo, error) {
	limit := clampBatchSize(maxEntries)
	if !d.loaded {
		var err error
		if d.r.readDir != nil {
			d.ents, err = d.r.readDir(d.logicalPath)
		} else {
			d.ents, err = os.ReadDir(d.hostPath)
		}
		if err != nil {
			return nil, err
		}
		d.loaded = true
	}
	if d.off >= len(d.ents) {
		return nil, io.EOF
	}
	end := min(d.off+limit, len(d.ents))
	out := make([]dirEntryInfo, 0, end-d.off)
	for _, e := range d.ents[d.off:end] {
		out = append(out, dirEntryInfo{Name: e.Name(), Kind: dirEntryKind(e)})
	}
	d.off = end
	return out, nil
}

func (d *otherScanDir) OpenDir(name, logicalPath string, _, _ bool) (scanDir, error) {
	if !isSafeChildName(name) {
		return nil, errWrongMount
	}
	childHost := filepath.Join(d.hostPath, name)
	fi, err := os.Lstat(childHost)
	if err != nil {
		return nil, err
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return nil, errors.New("symlink")
	}
	if !fi.IsDir() {
		return nil, errNotDir
	}
	return &otherScanDir{r: d.r, hostPath: childHost, logicalPath: logicalPath}, nil
}

func (d *otherScanDir) StatEntry(name, _ string) (entryStat, error) {
	if !isSafeChildName(name) {
		return entryStat{}, errWrongMount
	}
	fi, err := os.Lstat(filepath.Join(d.hostPath, name))
	if err != nil {
		return entryStat{}, err
	}
	return entryStatFromFileInfo(fi), nil
}

func (d *otherScanDir) Close() error { return nil }

func entryStatFromFileInfo(fi fs.FileInfo) entryStat {
	var alloc uint64
	if fi.Size() > 0 {
		alloc = uint64(fi.Size())
	}
	return entryStat{
		Mode:       fi.Mode(),
		Size:       fi.Size(),
		AllocBytes: alloc,
	}
}
