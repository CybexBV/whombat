//go:build !unix

package diskusage

import (
	"errors"
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

func (f *otherScanFS) OpenRoot(hostPath, logicalMount string) (scanDir, error) {
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

func (d *otherScanDir) ReadDir() ([]dirEntryInfo, error) {
	var raw []fs.DirEntry
	var err error
	if d.r.readDir != nil {
		raw, err = d.r.readDir(d.logicalPath)
	} else {
		raw, err = os.ReadDir(d.hostPath)
	}
	if err != nil {
		return nil, err
	}
	out := make([]dirEntryInfo, 0, len(raw))
	for _, e := range raw {
		out = append(out, dirEntryInfo{Name: e.Name(), Kind: dirEntryKind(e)})
	}
	return out, nil
}

func (d *otherScanDir) OpenDir(name, logicalPath string, _ bool) (scanDir, error) {
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
