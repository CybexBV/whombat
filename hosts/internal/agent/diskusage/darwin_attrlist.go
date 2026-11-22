package diskusage

import (
	"encoding/binary"
	"fmt"
	"io/fs"
)

// Constants from Apple XNU <sys/attr.h>, <sys/vnode.h> and <sys/stat.h>.
// Kept in a platform-independent file so the binary buffer parser for
// getattrlistbulk(2) and fgetattrlist(2) is unit-tested on Linux as well as
// macOS.
const (
	darwinAttrBitMapCount = 5

	darwinAttrCmnName          = 0x00000001
	darwinAttrCmnDevID         = 0x00000002
	darwinAttrCmnFSID          = 0x00000004
	darwinAttrCmnObjType       = 0x00000008
	darwinAttrCmnFlags         = 0x00040000
	darwinAttrCmnFileID        = 0x02000000
	darwinAttrCmnError         = 0x20000000
	darwinAttrCmnReturnedAttrs = 0x80000000

	darwinAttrDirMountStatus = 0x00000004

	darwinAttrFileLinkCount = 0x00000001
	darwinAttrFileTotalSize = 0x00000002
	darwinAttrFileAllocSize = 0x00000004

	darwinDirMntStatusMntPoint = 0x00000001
	darwinDirMntStatusTrigger  = 0x00000002

	darwinSFFirmlink = 0x00800000

	// enum vtype in XNU <sys/vnode.h>.
	darwinVReg  = 1
	darwinVDir  = 2
	darwinVBlk  = 3
	darwinVChr  = 4
	darwinVLnk  = 5
	darwinVSock = 6
	darwinVFIFO = 7

	// Darwin ENOENT errno value for ATTR_CMN_ERROR entries.
	darwinENOENT = 2
)

// darwinAttrList matches XNU's struct attrlist (24 bytes on arm64 and amd64).
type darwinAttrList struct {
	Bitmapcount uint16
	Reserved    uint16
	Commonattr  uint32
	Volattr     uint32
	Dirattr     uint32
	Fileattr    uint32
	Forkattr    uint32
}

func darwinBulkAttrList() darwinAttrList {
	return darwinAttrList{
		Bitmapcount: darwinAttrBitMapCount,
		Commonattr: darwinAttrCmnReturnedAttrs |
			darwinAttrCmnError |
			darwinAttrCmnName |
			darwinAttrCmnDevID |
			darwinAttrCmnFSID |
			darwinAttrCmnObjType |
			darwinAttrCmnFlags |
			darwinAttrCmnFileID,
		Dirattr:  darwinAttrDirMountStatus,
		Fileattr: darwinAttrFileLinkCount | darwinAttrFileTotalSize | darwinAttrFileAllocSize,
	}
}

func darwinIdentityAttrList() darwinAttrList {
	return darwinAttrList{
		Bitmapcount: darwinAttrBitMapCount,
		Commonattr:  darwinAttrCmnReturnedAttrs | darwinAttrCmnDevID | darwinAttrCmnFSID,
	}
}

// parseDarwinIdentityAttr parses a buffer filled by fgetattrlist(2) for
// darwinIdentityAttrList() (ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_DEVID |
// ATTR_CMN_FSID), returning dev and fsid from in-kernel mount metadata.
func parseDarwinIdentityAttr(buf []byte) (dev uint64, hasDev bool, fsid [2]int32, hasFSID bool, err error) {
	if len(buf) < 24 {
		return 0, false, [2]int32{}, false, fmt.Errorf("short fgetattrlist buffer: %d", len(buf))
	}
	le := binary.LittleEndian
	recLen := int(le.Uint32(buf[0:4]))
	if recLen < 24 || recLen > len(buf) {
		return 0, false, [2]int32{}, false, fmt.Errorf("invalid fgetattrlist record length: %d", recLen)
	}
	rec := buf[:recLen]
	retCmn := le.Uint32(rec[4:8])
	off := 24
	if retCmn&darwinAttrCmnDevID != 0 {
		if off+4 > len(rec) {
			return 0, false, [2]int32{}, false, fmt.Errorf("truncated fgetattrlist devid")
		}
		dev = uint64(int32(le.Uint32(rec[off : off+4])))
		hasDev = true
		off += 4
	}
	if retCmn&darwinAttrCmnFSID != 0 {
		if off+8 > len(rec) {
			return 0, false, [2]int32{}, false, fmt.Errorf("truncated fgetattrlist fsid")
		}
		fsid[0] = int32(le.Uint32(rec[off : off+4]))
		fsid[1] = int32(le.Uint32(rec[off+4 : off+8]))
		hasFSID = true
	}
	return dev, hasDev, fsid, hasFSID, nil
}

// darwinBulkEntry is one decoded entry from getattrlistbulk(2) before
// mount-boundary filtering, used by both directory iteration and targeted child
// lookups before openat.
type darwinBulkEntry struct {
	info        dirEntryInfo
	skippedMnt  bool // mount point, automount trigger, APFS firmlink, or foreign volume
	unsupported bool // directory entry lacked ATTR_DIR_MOUNTSTATUS
}

// parseDarwinAttrlistBulk decodes count packed entries returned by
// getattrlistbulk(2) with darwinBulkAttrList() and options=0 (without
// FSOPT_PACK_INVAL_ATTRS, so only attributes present in returned_attrs are
// packed in XNU's attr_pack_common -> attr_pack_dir -> attr_pack_file order).
func parseDarwinAttrlistBulk(buf []byte, count int, rootDev uint64, hasRootFSID bool, rootFSID [2]int32) ([]darwinBulkEntry, error) {
	le := binary.LittleEndian
	pos := 0
	out := make([]darwinBulkEntry, 0, count)

	for i := 0; i < count; i++ {
		if pos+24 > len(buf) {
			return out, fmt.Errorf("truncated getattrlistbulk buffer at entry %d", i)
		}
		recLen := int(le.Uint32(buf[pos : pos+4]))
		if recLen < 24 || pos+recLen > len(buf) {
			return out, fmt.Errorf("invalid getattrlistbulk entry %d length %d", i, recLen)
		}
		rec := buf[pos : pos+recLen]
		pos += recLen

		retCmn := le.Uint32(rec[4:8])
		retDir := le.Uint32(rec[12:16])
		retFile := le.Uint32(rec[16:20])
		off := 24

		var (
			entryErr     uint32
			hasEntryErr  bool
			name         string
			dev          uint64
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
			nlink        uint64
			hasNlink     bool
			totalSize    int64
			hasTotalSize bool
			allocSize    int64
			hasAllocSize bool
		)

		// XNU attr_pack_common / get_error_attributes packs ATTR_CMN_ERROR
		// right after ATTR_CMN_RETURNED_ATTRS and before ATTR_CMN_NAME.
		if retCmn&darwinAttrCmnError != 0 {
			if off+4 > len(rec) {
				return out, fmt.Errorf("truncated ATTR_CMN_ERROR")
			}
			entryErr = le.Uint32(rec[off : off+4])
			hasEntryErr = true
			off += 4
		}
		if retCmn&darwinAttrCmnName != 0 {
			if off+8 > len(rec) {
				return out, fmt.Errorf("truncated ATTR_CMN_NAME")
			}
			relOff := int(int32(le.Uint32(rec[off : off+4])))
			strLen := int(le.Uint32(rec[off+4 : off+8]))
			nameStart := off + relOff
			if relOff < 0 || nameStart < 0 || nameStart+strLen > len(rec) {
				return out, fmt.Errorf("out-of-bounds ATTR_CMN_NAME")
			}
			raw := rec[nameStart : nameStart+strLen]
			for len(raw) > 0 && raw[len(raw)-1] == 0 {
				raw = raw[:len(raw)-1]
			}
			name = string(raw)
			off += 8
		}
		if retCmn&darwinAttrCmnDevID != 0 {
			if off+4 > len(rec) {
				return out, fmt.Errorf("truncated ATTR_CMN_DEVID")
			}
			dev = uint64(int32(le.Uint32(rec[off : off+4])))
			hasDev = true
			off += 4
		}
		if retCmn&darwinAttrCmnFSID != 0 {
			if off+8 > len(rec) {
				return out, fmt.Errorf("truncated ATTR_CMN_FSID")
			}
			fsid[0] = int32(le.Uint32(rec[off : off+4]))
			fsid[1] = int32(le.Uint32(rec[off+4 : off+8]))
			hasFSID = true
			off += 8
		}
		if retCmn&darwinAttrCmnObjType != 0 {
			if off+4 > len(rec) {
				return out, fmt.Errorf("truncated ATTR_CMN_OBJTYPE")
			}
			objType = le.Uint32(rec[off : off+4])
			hasObjType = true
			off += 4
		}
		if retCmn&darwinAttrCmnFlags != 0 {
			if off+4 > len(rec) {
				return out, fmt.Errorf("truncated ATTR_CMN_FLAGS")
			}
			flags = le.Uint32(rec[off : off+4])
			hasFlags = true
			off += 4
		}
		if retCmn&darwinAttrCmnFileID != 0 {
			if off+8 > len(rec) {
				return out, fmt.Errorf("truncated ATTR_CMN_FILEID")
			}
			fileID = le.Uint64(rec[off : off+8])
			hasFileID = true
			off += 8
		}
		if retDir&darwinAttrDirMountStatus != 0 {
			if off+4 > len(rec) {
				return out, fmt.Errorf("truncated ATTR_DIR_MOUNTSTATUS")
			}
			mntStatus = le.Uint32(rec[off : off+4])
			hasMntStatus = true
			off += 4
		}
		if retFile&darwinAttrFileLinkCount != 0 {
			if off+4 > len(rec) {
				return out, fmt.Errorf("truncated ATTR_FILE_LINKCOUNT")
			}
			nlink = uint64(le.Uint32(rec[off : off+4]))
			hasNlink = true
			off += 4
		}
		if retFile&darwinAttrFileTotalSize != 0 {
			if off+8 > len(rec) {
				return out, fmt.Errorf("truncated ATTR_FILE_TOTALSIZE")
			}
			totalSize = int64(le.Uint64(rec[off : off+8]))
			hasTotalSize = true
			off += 8
		}
		if retFile&darwinAttrFileAllocSize != 0 {
			if off+8 > len(rec) {
				return out, fmt.Errorf("truncated ATTR_FILE_ALLOCSIZE")
			}
			allocSize = int64(le.Uint64(rec[off : off+8]))
			hasAllocSize = true
		}

		if name == "" || name == "." || name == ".." {
			continue
		}

		if hasEntryErr && entryErr != 0 {
			var err error
			if entryErr == darwinENOENT {
				err = fs.ErrNotExist
			} else {
				err = fmt.Errorf("getattrlistbulk entry errno %d", entryErr)
			}
			out = append(out, darwinBulkEntry{
				info: dirEntryInfo{Name: name, Kind: entryUnknown, Err: err},
			})
			continue
		}

		// Refuse entries belonging to a different volume before any openat.
		if hasDev && dev != rootDev {
			out = append(out, darwinBulkEntry{
				info:       dirEntryInfo{Name: name, Kind: entryOther},
				skippedMnt: true,
			})
			continue
		}
		if hasRootFSID && hasFSID && fsid != rootFSID {
			out = append(out, darwinBulkEntry{
				info:       dirEntryInfo{Name: name, Kind: entryOther},
				skippedMnt: true,
			})
			continue
		}

		if !hasObjType {
			out = append(out, darwinBulkEntry{
				info: dirEntryInfo{Name: name, Kind: entryUnknown, Err: fmt.Errorf("missing object type")},
			})
			continue
		}

		effectiveDev := dev
		if !hasDev {
			effectiveDev = rootDev
		}
		effectiveFSID := fsid
		effectiveHasFSID := hasFSID
		if !effectiveHasFSID && hasRootFSID {
			effectiveFSID = rootFSID
			effectiveHasFSID = true
		}

		switch objType {
		case darwinVLnk:
			out = append(out, darwinBulkEntry{
				info: dirEntryInfo{Name: name, Kind: entrySymlink},
			})

		case darwinVDir:
			if !hasMntStatus {
				// Fail closed if the filesystem did not report mount status.
				out = append(out, darwinBulkEntry{
					info:        dirEntryInfo{Name: name, Kind: entryDir},
					skippedMnt:  true,
					unsupported: true,
				})
				continue
			}
			if mntStatus&(darwinDirMntStatusMntPoint|darwinDirMntStatusTrigger) != 0 {
				out = append(out, darwinBulkEntry{
					info:       dirEntryInfo{Name: name, Kind: entryDir},
					skippedMnt: true,
				})
				continue
			}
			if hasFlags && flags&darwinSFFirmlink != 0 {
				out = append(out, darwinBulkEntry{
					info:       dirEntryInfo{Name: name, Kind: entryDir},
					skippedMnt: true,
				})
				continue
			}
			out = append(out, darwinBulkEntry{
				info: dirEntryInfo{
					Name:    name,
					Kind:    entryDir,
					HasStat: true,
					Stat: entryStat{
						Mode:     fs.ModeDir | 0o755,
						Dev:      effectiveDev,
						HasDev:   true,
						Ino:      fileID,
						Nlink:    2,
						HasInode: hasFileID,
						FSID:     effectiveFSID,
						HasFSID:  effectiveHasFSID,
					},
				},
			})

		case darwinVReg:
			var alloc uint64
			if hasAllocSize && allocSize > 0 {
				alloc = uint64(allocSize)
			} else if hasTotalSize && totalSize > 0 {
				alloc = uint64(totalSize)
			}
			if !hasNlink {
				nlink = 1
			}
			out = append(out, darwinBulkEntry{
				info: dirEntryInfo{
					Name:    name,
					Kind:    entryRegular,
					HasStat: true,
					Stat: entryStat{
						Mode:       0o644,
						Size:       totalSize,
						AllocBytes: alloc,
						Dev:        effectiveDev,
						HasDev:     true,
						Ino:        fileID,
						Nlink:      nlink,
						HasInode:   hasFileID,
						FSID:       effectiveFSID,
						HasFSID:    effectiveHasFSID,
					},
				},
			})

		default:
			out = append(out, darwinBulkEntry{
				info: dirEntryInfo{Name: name, Kind: entryOther},
			})
		}
	}

	return out, nil
}
