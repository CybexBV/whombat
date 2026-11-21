package collect

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// objsetIndex maps ZFS dataset names to their per-dataset I/O kstat files
// (/proc/spl/kstat/zfs/<pool>/objset-0x...). These count reads and writes
// to a dataset or zvol, which is how guest disk I/O is measured for Incus
// instances on ZFS (Incus' API has no disk I/O counters, and ZFS writes are
// issued by kernel threads, so cgroup io.stat misses them).
type objsetIndex struct {
	root fsRoot

	mu       sync.Mutex
	built    time.Time
	lastMiss time.Time
	byName   map[string]string
}

func newObjsetIndex(root fsRoot) *objsetIndex { return &objsetIndex{root: root} }

func (x *objsetIndex) rebuild() {
	idx := map[string]string{}
	pools, _ := os.ReadDir(x.root.path("/proc/spl/kstat/zfs"))
	for _, p := range pools {
		if !p.IsDir() {
			continue
		}
		dir := filepath.Join(x.root.path("/proc/spl/kstat/zfs"), p.Name())
		files, _ := os.ReadDir(dir)
		for _, f := range files {
			if !strings.HasPrefix(f.Name(), "objset-") {
				continue
			}
			path := filepath.Join(dir, f.Name())
			if name := objsetDatasetName(path); name != "" {
				idx[name] = path
			}
		}
	}
	x.byName = idx
	x.built = time.Now()
}

func objsetDatasetName(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	name := ""
	scanLines(b, func(line string) {
		if name != "" {
			return
		}
		f := strings.Fields(line)
		if len(f) == 3 && f[0] == "dataset_name" {
			name = f[2]
		}
	})
	return name
}

// find returns the kstat file of the dataset whose name ends with suffix.
func (x *objsetIndex) find(suffix string) string {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.byName == nil || time.Since(x.built) > time.Minute {
		x.rebuild()
	}
	if p := x.lookup(suffix); p != "" {
		return p
	}
	// New dataset (instance just created/started): rebuild at most every 10 s.
	if time.Since(x.lastMiss) > 10*time.Second && time.Since(x.built) > 10*time.Second {
		x.lastMiss = time.Now()
		x.rebuild()
		return x.lookup(suffix)
	}
	return ""
}

func (x *objsetIndex) lookup(suffix string) string {
	for name, p := range x.byName {
		if strings.HasSuffix(name, suffix) {
			return p
		}
	}
	return ""
}

// readObjsetIO returns the bytes read and written of a dataset.
func readObjsetIO(path string) (rd, wr uint64, ok bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, false
	}
	return parseObjsetIO(b)
}

func parseObjsetIO(b []byte) (rd, wr uint64, ok bool) {
	var haveR, haveW bool
	scanLines(b, func(line string) {
		f := strings.Fields(line)
		if len(f) != 3 {
			return
		}
		switch f[0] {
		case "nread":
			rd, _ = strconv.ParseUint(f[2], 10, 64)
			haveR = true
		case "nwritten":
			wr, _ = strconv.ParseUint(f[2], 10, 64)
			haveW = true
		}
	})
	return rd, wr, haveR && haveW
}

// readProcIO returns read_bytes / write_bytes of /proc/<pid>/io.
func readProcIO(root fsRoot, pid int64) (rd, wr uint64, ok bool) {
	b, err := root.read("/proc/" + strconv.FormatInt(pid, 10) + "/io")
	if err != nil {
		return 0, 0, false
	}
	var haveR, haveW bool
	scanLines(b, func(line string) {
		k, v, found := strings.Cut(line, ":")
		if !found {
			return
		}
		n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
		if err != nil {
			return
		}
		switch k {
		case "read_bytes":
			rd, haveR = n, true
		case "write_bytes":
			wr, haveW = n, true
		}
	})
	return rd, wr, haveR && haveW
}

// parseCgroupIOStat sums rbytes / wbytes over all devices of a cgroup v2
// io.stat file.
func parseCgroupIOStat(b []byte) (rd, wr uint64, ok bool) {
	scanLines(b, func(line string) {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return
		}
		for _, f := range fields[1:] {
			k, v, found := strings.Cut(f, "=")
			if !found {
				continue
			}
			n, err := strconv.ParseUint(v, 10, 64)
			if err != nil {
				continue
			}
			switch k {
			case "rbytes":
				rd += n
				ok = true
			case "wbytes":
				wr += n
				ok = true
			}
		}
	})
	return
}
