package broker

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"regexp"
	"slices"
	"strings"

	"rackoon/internal/proto"
)

// storage.add (docs/MANAGE.md 2.10): an NFS folder of a backup place
// becomes a Proxmox VE storage for backups. Like backup jobs it runs
// `pvesh` as root (adding a storage needs Datastore.Allocate on /storage,
// which the manage token doesn't have, and it mounts the share under
// /mnt/pve). Adding the same storage again is fine; a name taken by
// another storage is refused.

// pveStorageContents are the contents storage.add offers.
var pveStorageContents = []string{"backup", "iso", "vztmpl", "snippets"}

// pveExportRe is an NFS export path.
var pveExportRe = regexp.MustCompile(`^/[A-Za-z0-9._/-]{1,250}$`)

// pveStorageConf is GET /storage/{storage} as pvesh prints it.
type pveStorageConf struct {
	Type    string `json:"type"`
	Server  string `json:"server"`
	Export  string `json:"export"`
	Content string `json:"content"`
}

func (r *pveReq) storageAdd(ctx context.Context) (proto.ManageResponse, error) {
	s := r.req.PVEStorage
	if s == nil {
		return proto.ManageResponse{}, codeErr(CodeInvalid, "the request has no storage")
	}
	switch {
	case !proto.PVEStorageIDRe.MatchString(s.Storage):
		return proto.ManageResponse{}, storageInvalid("storage", "A storage name is lower-case letters, digits, '-', '_' and '.', starting with a letter.")
	case s.Type != "nfs":
		return proto.ManageResponse{}, storageInvalid("type", "Whombat adds NFS storages only.")
	case net.ParseIP(s.Server) == nil || net.ParseIP(s.Server).To4() == nil:
		return proto.ManageResponse{}, storageInvalid("server", "Give the NFS server's IPv4 address.")
	case !pveExportRe.MatchString(s.Export) || strings.Contains(s.Export, ".."):
		return proto.ManageResponse{}, storageInvalid("export", "Give the exported folder (\"/mnt/user/whombat-pve-01\").")
	case len(s.Content) == 0:
		return proto.ManageResponse{}, storageInvalid("content", "Say what the storage holds (\"backup\").")
	}
	for _, c := range s.Content {
		if !slices.Contains(pveStorageContents, c) {
			return proto.ManageResponse{}, storageInvalid("content", "A storage holds backup, iso, vztmpl or snippets.")
		}
	}
	out, err := r.run(ctx, "pvesh", "get", "/storage/"+s.Storage, "--output-format", "json")
	if err == nil {
		var cur pveStorageConf
		if json.Unmarshal(out, &cur) != nil {
			return proto.ManageResponse{}, codeErr(CodePlatformError, "unexpected answer from pvesh")
		}
		if cur.Type == s.Type && cur.Server == s.Server && strings.TrimRight(cur.Export, "/") == strings.TrimRight(s.Export, "/") {
			return proto.ManageResponse{OK: true}, nil
		}
		return proto.ManageResponse{}, codeErr(proto.CodeExists, "Proxmox VE already has a storage called "+s.Storage+".")
	}
	var ce *cmdError
	if !errors.As(err, &ce) || !strings.Contains(strings.ToLower(ce.msg+ce.stderr), "does not exist") {
		return proto.ManageResponse{}, codeErr(CodePlatformError, err.Error())
	}
	if err := r.pvesh(ctx, "create", "/storage", "--storage="+s.Storage, "--type=nfs", "--server="+s.Server,
		"--export="+s.Export, "--content="+strings.Join(s.Content, ",")); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}

// storageInvalid is an invalid_value about one field.
func storageInvalid(field, msg string) error {
	return &fieldsError{code: proto.CodeInvalidValue, msg: msg, fields: map[string]string{field: msg}}
}
