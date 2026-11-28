package winpc

import (
	"os"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SecureDataDir creates top (%ProgramData%\Whombat) as the agent's own, or
// takes it over with everything in it (datadir.go says why and how). It
// runs as an administrator or as the service (LocalSystem).
func SecureDataDir(top string) error {
	// Backup and restore let the agent open, read and change what someone
	// else owns and shut it out of; take-ownership lets it become the owner.
	// Administrators and SYSTEM hold them, switched off until asked for.
	return withPrivileges([]string{"SeBackupPrivilege", "SeRestorePrivilege", "SeTakeOwnershipPrivilege"}, func() error {
		return secureTree(winTree{}, top)
	})
}

// The agent's access lists: SYSTEM and the administrators, full control,
// protected from what the folder above would pass down. A folder passes
// its list on to what is made inside it.
const (
	dirSDDL  = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	fileSDDL = "D:P(A;;FA;;;SY)(A;;FA;;;BA)"
)

// withPrivileges runs fn with the named privileges switched on for this
// thread alone (the agent impersonating itself), so the rest of the
// process never has them. The goroutine stays on its thread, which ends
// with it, so a privileged thread never goes back to Go's pool. A
// privilege the account lacks stays off; what fn sets is checked anyway.
func withPrivileges(names []string, fn func() error) error {
	done := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		if err := windows.ImpersonateSelf(windows.SecurityImpersonation); err != nil {
			done <- err
			return
		}
		defer windows.RevertToSelf()
		var tok windows.Token
		if err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, false, &tok); err != nil {
			done <- err
			return
		}
		for _, n := range names {
			var luid windows.LUID
			if err := windows.LookupPrivilegeValue(nil, windows.StringToUTF16Ptr(n), &luid); err != nil {
				continue
			}
			tp := windows.Tokenprivileges{PrivilegeCount: 1}
			tp.Privileges[0] = windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}
			_ = windows.AdjustTokenPrivileges(tok, false, &tp, 0, nil, nil)
		}
		tok.Close()
		done <- fn()
	}()
	return <-done
}

// winTree is the agent's tree on Windows' file system.
type winTree struct{}

func (winTree) MkdirSecure(path string) error {
	sd, err := windows.SecurityDescriptorFromString(dirSDDL)
	if err != nil {
		return err
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	// ERROR_ALREADY_EXISTS is fs.ErrExist.
	return windows.CreateDirectory(p, &sa)
}

// Open opens the file or folder itself, never what a link points to, with
// just the rights to read and change its security (no data access, so
// what others have open doesn't stand in the way).
func (winTree) Open(path string) (treeObject, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p,
		windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	return winObject(h), nil
}

func (winTree) List(dir string) ([]string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, len(ents))
	for i, e := range ents {
		names[i] = e.Name()
	}
	return names, nil
}

type winObject windows.Handle

func (o winObject) Close() error { return windows.CloseHandle(windows.Handle(o)) }

func (o winObject) Info() (objectInfo, error) {
	var fi windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(o), &fi); err != nil {
		return objectInfo{}, err
	}
	info := objectInfo{
		Dir:   fi.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0,
		Link:  fi.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0,
		Names: fi.NumberOfLinks,
	}
	sd, err := windows.GetSecurityInfo(windows.Handle(o), windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return info, err
	}
	info.Security = readSecurity(sd)
	return info, nil
}

// accessAllowedCallbackACE is ACCESS_ALLOWED_CALLBACK_ACE_TYPE: an allowing
// entry with a condition, laid out as a plain one up to its SID.
const accessAllowedCallbackACE = 9

// readSecurity reads the owner and who the access list lets in. An entry
// of a kind the agent doesn't read counts as letting someone unknown in,
// so the object is taken over.
func readSecurity(sd *windows.SECURITY_DESCRIPTOR) objectSecurity {
	var s objectSecurity
	if owner, _, err := sd.Owner(); err == nil && owner != nil {
		s.Owner = owner.String()
	}
	if ctl, _, err := sd.Control(); err == nil {
		s.Protected = ctl&windows.SE_DACL_PROTECTED != 0
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		return s // none, or a NULL list that lets everyone in
	}
	s.DACL = true
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			s.Grants = append(s.Grants, "")
			continue
		}
		switch ace.Header.AceType {
		case windows.ACCESS_DENIED_ACE_TYPE:
			// Takes rights away: never a way in.
		case windows.ACCESS_ALLOWED_ACE_TYPE, accessAllowedCallbackACE:
			s.Grants = append(s.Grants, (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String())
		default:
			s.Grants = append(s.Grants, "")
		}
	}
	return s
}

func (o winObject) Secure(dir bool) error {
	sddl := fileSDDL
	if dir {
		sddl = dirSDDL
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return err
	}
	return windows.SetSecurityInfo(windows.Handle(o), windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		admins, nil, dacl, nil)
}
