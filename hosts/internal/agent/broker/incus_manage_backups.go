package broker

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	incus "github.com/lxc/incus/v6/client"
	"github.com/lxc/incus/v6/shared/api"
	"github.com/lxc/incus/v6/shared/ioprogress"

	"rackoon/internal/proto"
)

// Incus backups (docs/MANAGE.md 2.5). Backups stay on the host, in Incus'
// own backup store: they are listed, made (with an expiry), deleted and
// restored, always as a new instance: the agent streams the backup's
// export straight into an import (POST /1.0/instances with the tarball),
// both over the local socket, so nothing is written elsewhere and no
// existing instance is overwritten.

const (
	// incusBackupExpiry is how long a backup made without an expiry
	// lives.
	incusBackupExpiry = 7 * 24 * time.Hour
	// incusBackupStore: OpBackupList gives Volume (backup name), Storage
	// "incus" and the format optimized | tar.
	incusBackupStore = "incus"
)

// incusBackupsDir is where Incus keeps instance backups (the size comes
// from the file; a host with storage.backups_volume reports none).
var incusBackupsDir = "/var/lib/incus/backups/instances"

// incusBackupName is the default name of a backup made now.
func incusBackupName(now time.Time) string { return "whombat-" + now.UTC().Format("20060102-1504") }

func (d *incusDriver) backupList(g *proto.Guest) proto.ManageResponse {
	c, name, err := d.connect(g.ID)
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	bks, err := c.GetInstanceBackups(name)
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	project, _ := splitIncusID(g.ID)
	dir := filepath.Join(incusBackupsDir, incusStorageName(project, name))
	out := make([]proto.BackupVolume, 0, len(bks))
	for _, b := range bks {
		bv := proto.BackupVolume{Volume: b.Name, Storage: incusBackupStore, GuestID: g.ID, Kind: g.Kind, Format: "tar"}
		if b.OptimizedStorage {
			bv.Format = "optimized"
		}
		if t := incusTimeOf(b.CreatedAt); t != nil {
			bv.Created = *t
		}
		if t := incusTimeOf(b.ExpiresAt); t != nil {
			bv.ExpiresAt = t
			bv.Notes = "expires " + t.Format(time.RFC3339)
		}
		if st, err := os.Stat(filepath.Join(dir, b.Name)); err == nil && st.Mode().IsRegular() {
			bv.SizeBytes = uint64(st.Size())
		}
		out = append(out, bv)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return proto.ManageResponse{OK: true, Backups: out}
}

// incusStorageName is an instance's directory name ("lab_db" outside the
// default project).
func incusStorageName(project, name string) string {
	if project != "" && project != "default" {
		return project + "_" + name
	}
	return name
}

// incusTimeOf is a time Incus reported, nil for its "never" values.
func incusTimeOf(t time.Time) *time.Time {
	if t.IsZero() || t.Year() <= 1970 {
		return nil
	}
	u := t.UTC()
	return &u
}

func (d *incusDriver) backupCreate(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	now := time.Now()
	name := req.Name
	if name == "" {
		name = incusBackupName(now)
	}
	if !incusVolumeRE.MatchString(name) {
		return incusFieldError(proto.CodeInvalidValue, "name", "letters, digits, '.', '_' and '-'")
	}
	expires := now.Add(incusBackupExpiry)
	if req.ExpiresAt != nil {
		if !req.ExpiresAt.After(now.Add(time.Minute)) {
			return incusFieldError(proto.CodeInvalidValue, "expires_at", "the expiry must be in the future")
		}
		expires = *req.ExpiresAt
	}
	comp := req.Compression
	if comp == "" {
		comp = req.Compress
	}
	switch comp {
	case "":
		comp = "zstd"
	case "zstd", "gzip", "none":
	default:
		return incusFieldError(proto.CodeInvalidValue, "compression", "zstd, gzip or none")
	}
	c, iname, err := d.connect(g.ID)
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	if _, _, err := c.GetInstanceBackup(iname, name); err == nil {
		return incusFieldError(proto.CodeExists, "name", "the guest has a backup named "+name)
	}
	op, err := c.CreateInstanceBackup(iname, api.InstanceBackupsPost{Name: name, ExpiresAt: expires.UTC(), InstanceOnly: req.InstanceOnly,
		OptimizedStorage: req.Optimized, CompressionAlgorithm: comp})
	if err != nil {
		if api.StatusErrorCheck(err, http.StatusConflict) {
			return incusFieldError(proto.CodeExists, "name", incusMsg(err.Error()))
		}
		return incusFail(err, CodeUnknownGuest)
	}
	return d.opResult(ctx, c, op.Get(), g.ID, 0)
}

func (d *incusDriver) backupDelete(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if g == nil {
		return incusFieldError(proto.CodeInvalidValue, "guest", "name the guest whose backup this is")
	}
	if !incusVolumeRE.MatchString(req.Volume) {
		return incusFieldError(proto.CodeInvalidValue, "volume", "not a backup name")
	}
	c, name, err := d.connect(g.ID)
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	op, err := c.DeleteInstanceBackup(name, req.Volume)
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	return d.opResult(ctx, c, op.Get(), g.ID, incusConfigWait)
}

// backupRestore makes a new instance from a backup of g (Name, default
// "<name>-restored", in g's project, on Storage when given). It answers
// with an agent task at once; the copy runs in the background.
func (d *incusDriver) backupRestore(g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if g == nil {
		return incusFieldError(proto.CodeInvalidValue, "guest", "name the guest whose backup to restore")
	}
	if !incusVolumeRE.MatchString(req.Volume) {
		return incusFieldError(proto.CodeInvalidValue, "volume", "not a backup name")
	}
	project, srcName := splitIncusID(g.ID)
	name := req.Name
	if name == "" {
		name = srcName + "-restored"
		if len(name) > 63 {
			name = name[len(name)-63:]
		}
	}
	if msg := incusNameProblem(name); msg != "" {
		return incusFieldError(proto.CodeInvalidValue, "name", msg)
	}
	c, iname, err := d.connect(g.ID)
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	if _, _, err := c.GetInstanceBackup(iname, req.Volume); err != nil {
		if api.StatusErrorCheck(err, http.StatusNotFound) {
			return incusFieldError(proto.CodeNotFound, "volume", "the guest has no backup "+req.Volume)
		}
		return incusFail(err, proto.CodeNotFound)
	}
	if _, _, err := c.GetInstance(name); err == nil {
		return incusFieldError(proto.CodeExists, "name", "an instance named "+name+" exists")
	}
	if req.Storage != "" {
		if !incusVolumeRE.MatchString(req.Storage) {
			return incusFieldError(proto.CodeInvalidValue, "storage", "not a valid pool name")
		}
		if _, _, err := c.GetStoragePool(req.Storage); err != nil {
			if api.StatusErrorCheck(err, http.StatusNotFound) {
				return incusFieldError(proto.CodeInvalidValue, "storage", "there is no storage pool "+req.Storage)
			}
			return incusFail(err, proto.CodeNotFound)
		}
	}
	newID := incusID(project, name)
	st := proto.TaskStatus{ID: "incus:" + newUUID(), Type: "Restoring a backup", GuestID: newID, Started: time.Now().UTC(),
		Status: "running", Message: "Copying the backup"}
	d.tasks.put(st)
	go d.restoreRun(st, g.ID, req.Volume, name, req.Storage, req.Start)
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: st.ID}, NewID: newID}
}

// pipeSeeker hands an io.PipeWriter to GetInstanceBackupFile, which only
// copies into it.
type pipeSeeker struct{ *io.PipeWriter }

func (pipeSeeker) Seek(int64, int) (int64, error) { return 0, errors.New("not seekable") }

// restoreRun streams the export into an import and follows the import's
// operation, recording progress in the agent task st.
func (d *incusDriver) restoreRun(st proto.TaskStatus, srcID, backup, name, pool string, start bool) {
	set := func(status, msg string) {
		cur, _ := d.tasks.get(st.ID)
		if cur.ID == "" {
			cur = st
		}
		cur.Status, cur.Message = status, incusMsg(msg)
		if status != "running" {
			now := time.Now().UTC()
			cur.Ended = &now
			if status == "ok" {
				cur.NewID = cur.GuestID
			}
		}
		d.tasks.put(cur)
	}
	src, iname, err := d.connect(srcID)
	if err != nil {
		set("error", err.Error())
		return
	}
	defer src.Disconnect()
	project, _ := splitIncusID(srcID)
	dst, fail := d.projectServer(project)
	if fail != nil {
		set("error", fail.Message)
		return
	}
	defer dst.Disconnect()

	pr, pw := io.Pipe()
	exported := make(chan error, 1)
	go func() {
		_, err := src.GetInstanceBackupFile(iname, backup, &incus.BackupFileRequest{
			BackupFile: pipeSeeker{pw},
			ProgressHandler: func(p ioprogress.ProgressData) {
				set("running", "Copying the backup: "+p.Text)
			},
		})
		pw.CloseWithError(err) // nil: EOF
		exported <- err
	}()
	op, err := dst.CreateInstanceFromBackup(incus.InstanceBackupArgs{BackupFile: pr, PoolName: pool, Name: name})
	pr.CloseWithError(errors.New("the import stopped reading"))
	if eerr := <-exported; eerr != nil && err != nil {
		err = fmt.Errorf("reading the backup: %w", eerr)
	}
	if err != nil {
		set("error", err.Error())
		return
	}
	set("running", "Unpacking the backup")
	ctx, cancel := context.WithTimeout(context.Background(), incusTaskMax)
	defer cancel()
	final := incusWait(ctx, dst, op.Get(), incusTaskMax)
	if final.StatusCode != api.Success {
		msg := final.Err
		if msg == "" {
			msg = "the restore did not finish"
		}
		set("error", msg)
		return
	}
	if start {
		set("running", "Starting "+name)
		sop, err := dst.UpdateInstanceState(name, api.InstanceStatePut{Action: "start", Timeout: -1}, "")
		if err == nil {
			err = sop.WaitContext(ctx)
		}
		if err != nil {
			set("error", "restored, but it did not start: "+err.Error())
			return
		}
	}
	set("ok", "OK")
}

// newUUID is a random (version 4) UUID.
func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
