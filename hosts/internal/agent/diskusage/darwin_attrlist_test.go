package diskusage

import (
	"encoding/binary"
	"errors"
	"io/fs"
	"testing"
)

type testBulkRec struct {
	name         string
	errCode      uint32
	hasErr       bool
	dev          int32
	hasDev       bool
	fsid         [2]int32
	hasFSID      bool
	objType      uint32
	hasObjType   bool
	flags        uint32
	hasFlags     bool
	fileID       uint64
	hasFileID    bool
	mntStatus    uint32
	hasMntStatus bool
	nlink        uint32
	hasNlink     bool
	totalSize    int64
	hasTotalSize bool
	allocSize    int64
	hasAllocSize bool
}

// buildDarwinBulkBuffer encodes testBulkRec entries using XNU's exact
// getattrlistbulk(2) binary layout (bsd/vfs/vfs_attrlist.c).
func buildDarwinBulkBuffer(recs []testBulkRec) []byte {
	le := binary.LittleEndian
	var out []byte

	for _, r := range recs {
		var retCmn, retDir, retFile uint32
		retCmn = darwinAttrCmnReturnedAttrs
		fixedLen := 4 + 20 // recLen + attribute_set_t

		if r.hasErr {
			retCmn |= darwinAttrCmnError
			fixedLen += 4
		}
		retCmn |= darwinAttrCmnName
		nameRefPos := fixedLen
		fixedLen += 8
		if r.hasDev {
			retCmn |= darwinAttrCmnDevID
			fixedLen += 4
		}
		if r.hasFSID {
			retCmn |= darwinAttrCmnFSID
			fixedLen += 8
		}
		if r.hasObjType {
			retCmn |= darwinAttrCmnObjType
			fixedLen += 4
		}
		if r.hasFlags {
			retCmn |= darwinAttrCmnFlags
			fixedLen += 4
		}
		if r.hasFileID {
			retCmn |= darwinAttrCmnFileID
			fixedLen += 8
		}
		if r.hasMntStatus {
			retDir |= darwinAttrDirMountStatus
			fixedLen += 4
		}
		if r.hasNlink {
			retFile |= darwinAttrFileLinkCount
			fixedLen += 4
		}
		if r.hasTotalSize {
			retFile |= darwinAttrFileTotalSize
			fixedLen += 8
		}
		if r.hasAllocSize {
			retFile |= darwinAttrFileAllocSize
			fixedLen += 8
		}

		nameBytes := append([]byte(r.name), 0)
		varLen := (len(nameBytes) + 3) &^ 3
		recLen := (fixedLen + varLen + 7) &^ 7
		buf := make([]byte, recLen)

		le.PutUint32(buf[0:4], uint32(recLen))
		le.PutUint32(buf[4:8], retCmn)
		le.PutUint32(buf[12:16], retDir)
		le.PutUint32(buf[16:20], retFile)

		off := 24
		if r.hasErr {
			le.PutUint32(buf[off:off+4], r.errCode)
			off += 4
		}
		// ATTR_CMN_NAME attrreference_t
		le.PutUint32(buf[off:off+4], uint32(int32(fixedLen-nameRefPos)))
		le.PutUint32(buf[off+4:off+8], uint32(len(nameBytes)))
		copy(buf[fixedLen:], nameBytes)
		off += 8

		if r.hasDev {
			le.PutUint32(buf[off:off+4], uint32(r.dev))
			off += 4
		}
		if r.hasFSID {
			le.PutUint32(buf[off:off+4], uint32(r.fsid[0]))
			le.PutUint32(buf[off+4:off+8], uint32(r.fsid[1]))
			off += 8
		}
		if r.hasObjType {
			le.PutUint32(buf[off:off+4], r.objType)
			off += 4
		}
		if r.hasFlags {
			le.PutUint32(buf[off:off+4], r.flags)
			off += 4
		}
		if r.hasFileID {
			le.PutUint64(buf[off:off+8], r.fileID)
			off += 8
		}
		if r.hasMntStatus {
			le.PutUint32(buf[off:off+4], r.mntStatus)
			off += 4
		}
		if r.hasNlink {
			le.PutUint32(buf[off:off+4], r.nlink)
			off += 4
		}
		if r.hasTotalSize {
			le.PutUint64(buf[off:off+8], uint64(r.totalSize))
			off += 8
		}
		if r.hasAllocSize {
			le.PutUint64(buf[off:off+8], uint64(r.allocSize))
			off += 8
		}

		out = append(out, buf...)
	}
	return out
}

func buildDarwinIdentityBuffer(dev int32, hasDev bool, fsid [2]int32, hasFSID bool) []byte {
	le := binary.LittleEndian
	retCmn := uint32(darwinAttrCmnReturnedAttrs)
	size := 24
	if hasDev {
		retCmn |= darwinAttrCmnDevID
		size += 4
	}
	if hasFSID {
		retCmn |= darwinAttrCmnFSID
		size += 8
	}
	buf := make([]byte, size)
	le.PutUint32(buf[0:4], uint32(size))
	le.PutUint32(buf[4:8], retCmn)
	off := 24
	if hasDev {
		le.PutUint32(buf[off:off+4], uint32(dev))
		off += 4
	}
	if hasFSID {
		le.PutUint32(buf[off:off+4], uint32(fsid[0]))
		le.PutUint32(buf[off+4:off+8], uint32(fsid[1]))
	}
	return buf
}

func TestParseDarwinIdentityAttr(t *testing.T) {
	wantFSID := [2]int32{0x01000004, 0x1a}
	buf := buildDarwinIdentityBuffer(0x01000004, true, wantFSID, true)
	dev, hasDev, fsid, hasFSID, err := parseDarwinIdentityAttr(buf)
	if err != nil {
		t.Fatalf("parseDarwinIdentityAttr: %v", err)
	}
	if !hasDev || dev != uint64(int32(0x01000004)) {
		t.Errorf("dev = (%#x, %v), want (%#x, true)", dev, hasDev, uint64(int32(0x01000004)))
	}
	if !hasFSID || fsid != wantFSID {
		t.Errorf("fsid = (%v, %v), want (%v, true)", fsid, hasFSID, wantFSID)
	}

	if _, _, _, _, err := parseDarwinIdentityAttr(buf[:10]); err == nil {
		t.Fatal("expected error for truncated buffer")
	}
}

func TestParseDarwinAttrlistBulkFiltersMountsTriggersFirmlinksAndExtractsFileStats(t *testing.T) {
	const rootDevInt32 int32 = 0x01000004
	rootDev := uint64(rootDevInt32)
	rootFSID := [2]int32{rootDevInt32, 0x1a}
	otherFSID := [2]int32{0x01000009, 0x1a}

	recs := []testBulkRec{
		// "." and ".." are skipped.
		{name: ".", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: rootFSID, hasObjType: true, objType: darwinVDir, hasMntStatus: true},
		{name: "..", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: rootFSID, hasObjType: true, objType: darwinVDir, hasMntStatus: true},
		// Normal directory on target volume.
		{name: "app", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: rootFSID, hasObjType: true, objType: darwinVDir, hasFlags: true, flags: 0, hasFileID: true, fileID: 101, hasMntStatus: true, mntStatus: 0},
		// Mount point detected purely from parent via DIR_MNTSTATUS_MNTPOINT.
		{name: "mnt-nfs", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: rootFSID, hasObjType: true, objType: darwinVDir, hasFlags: true, hasFileID: true, fileID: 102, hasMntStatus: true, mntStatus: darwinDirMntStatusMntPoint},
		// Automount trigger detected purely from parent via DIR_MNTSTATUS_TRIGGER.
		{name: "auto-net", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: rootFSID, hasObjType: true, objType: darwinVDir, hasFlags: true, hasFileID: true, fileID: 103, hasMntStatus: true, mntStatus: darwinDirMntStatusTrigger},
		// APFS firmlink detected via SF_FIRMLINK.
		{name: "Users", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: rootFSID, hasObjType: true, objType: darwinVDir, hasFlags: true, flags: darwinSFFirmlink, hasFileID: true, fileID: 104, hasMntStatus: true, mntStatus: 0},
		// Directory without ATTR_DIR_MOUNTSTATUS fails closed.
		{name: "no-mntstatus", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: rootFSID, hasObjType: true, objType: darwinVDir, hasFileID: true, fileID: 105},
		// Foreign volume entry (different fsid).
		{name: "foreign", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: otherFSID, hasObjType: true, objType: darwinVDir, hasMntStatus: true, mntStatus: 0},
		// Regular file with allocated size + hardlink count.
		{name: "blob.bin", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: rootFSID, hasObjType: true, objType: darwinVReg, hasFileID: true, fileID: 201, hasNlink: true, nlink: 2, hasTotalSize: true, totalSize: 10000, hasAllocSize: true, allocSize: 16384},
		// Sparse file with reported alloc=0 must be counted as 0 allocated bytes, not totalSize.
		{name: "sparse.img", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: rootFSID, hasObjType: true, objType: darwinVReg, hasFileID: true, fileID: 202, hasTotalSize: true, totalSize: 100 << 30, hasAllocSize: true, allocSize: 0},
		// Regular file when filesystem omits ATTR_FILE_ALLOCSIZE falls back to totalSize.
		{name: "noalloc.txt", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: rootFSID, hasObjType: true, objType: darwinVReg, hasFileID: true, fileID: 204, hasTotalSize: true, totalSize: 512, hasAllocSize: false},
		// Symlink.
		{name: "sym", hasDev: true, dev: rootDevInt32, hasFSID: true, fsid: rootFSID, hasObjType: true, objType: darwinVLnk, hasFileID: true, fileID: 203},
		// Entry error: ENOENT maps to fs.ErrNotExist; EACCES (13) stays non-skip error.
		{name: "vanished", hasErr: true, errCode: darwinENOENT},
		{name: "denied", hasErr: true, errCode: 13},
	}

	buf := buildDarwinBulkBuffer(recs)
	got, err := parseDarwinAttrlistBulk(buf, len(recs), rootDev, true, rootFSID)
	if err != nil {
		t.Fatalf("parseDarwinAttrlistBulk: %v", err)
	}

	byName := map[string]darwinBulkEntry{}
	for _, e := range got {
		byName[e.info.Name] = e
	}
	if _, ok := byName["."]; ok {
		t.Error("'.' should not be emitted")
	}
	if _, ok := byName[".."]; ok {
		t.Error("'..' should not be emitted")
	}

	if e := byName["app"]; e.skippedMnt || e.info.Kind != entryDir || !e.info.HasStat {
		t.Errorf("app = %+v, want non-skipped entryDir with HasStat", e)
	}
	for _, skipName := range []string{"mnt-nfs", "auto-net", "Users", "no-mntstatus", "foreign"} {
		if e, ok := byName[skipName]; !ok || !e.skippedMnt {
			t.Errorf("%s = (%+v, ok=%v), want skippedMnt=true", skipName, e, ok)
		}
	}
	if !byName["no-mntstatus"].unsupported {
		t.Errorf("no-mntstatus expected unsupported=true")
	}

	blob := byName["blob.bin"]
	if blob.skippedMnt || blob.info.Kind != entryRegular || !blob.info.HasStat {
		t.Fatalf("blob.bin = %+v, want regular with inline stat", blob)
	}
	if blob.info.Stat.AllocBytes != 16384 || blob.info.Stat.Size != 10000 || blob.info.Stat.Ino != 201 || blob.info.Stat.Nlink != 2 || blob.info.Stat.FSID != rootFSID {
		t.Errorf("blob.bin stat = %+v", blob.info.Stat)
	}

	sparse := byName["sparse.img"]
	if sparse.info.Stat.AllocBytes != 0 || sparse.info.Stat.Size != 100<<30 || sparse.info.Stat.Nlink != 1 {
		t.Errorf("sparse.img stat = %+v, want AllocBytes=0 Size=100GiB Nlink=1", sparse.info.Stat)
	}

	noAlloc := byName["noalloc.txt"]
	if noAlloc.info.Stat.AllocBytes != 512 || noAlloc.info.Stat.Nlink != 1 {
		t.Errorf("noalloc.txt stat = %+v, want AllocBytes=512 Nlink=1", noAlloc.info.Stat)
	}

	if byName["sym"].info.Kind != entrySymlink {
		t.Errorf("sym = %+v, want entrySymlink", byName["sym"])
	}
	if !errors.Is(byName["vanished"].info.Err, fs.ErrNotExist) {
		t.Errorf("vanished err = %v, want fs.ErrNotExist", byName["vanished"].info.Err)
	}
	if byName["denied"].info.Err == nil || isSkipEntryErr(byName["denied"].info.Err) {
		t.Errorf("denied err = %v, want non-skip error", byName["denied"].info.Err)
	}
}
