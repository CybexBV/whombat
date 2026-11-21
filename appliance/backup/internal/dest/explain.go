package dest

import (
	"context"
	"errors"
	"strings"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
)

// DestError is a destination failure told for the owner (BK-21): Reason is one or two plain sentences
// (printable ASCII: it goes into the status document), Err the technical cause (redacted of secrets by
// the restic wrapper).
type DestError struct {
	Reason string
	Err    error
}

func (e *DestError) Error() string {
	if e.Err == nil {
		return e.Reason
	}
	detail := strings.TrimSpace(e.Err.Error())
	if len(detail) > 240 {
		detail = detail[len(detail)-240:]
	}
	return e.Reason + " (" + detail + ")"
}

func (e *DestError) Unwrap() error { return e.Err }

// Owner-facing reasons, one per failure the owner can act on.
const (
	ReasonUnreachable   = "The backup destination can't be reached: check the address and that it is online."
	ReasonRESTAuth      = "The backup server refused the user name or password."
	ReasonS3Auth        = "The bucket refused the access key: check the access key ID and the secret access key, and that the key may read and write this bucket."
	ReasonS3NoBucket    = "The bucket doesn't exist: create it at your storage provider first, or check its name."
	ReasonS3Region      = "The bucket is in another region: set the bucket's region."
	ReasonSFTPAuth      = "The server refused this Whombat's key: add this Whombat's public key to the user's authorized_keys on the server."
	ReasonSFTPHostKey   = "The server's host key doesn't match the one pinned for it. If the server was reinstalled, set the destination again and compare the new fingerprint with the server's; otherwise someone may be intercepting the connection."
	ReasonSFTPNoPath    = "The folder doesn't exist on the server, or the user may not write to it."
	ReasonTLS           = "The destination's certificate isn't trusted: give its CA certificate, or use a certificate from a public CA."
	ReasonDiskAbsent    = "The backup disk (labelled WHOMBAT-BACKUP) isn't attached. Attach it and backups continue."
	ReasonDiskFull      = "The backup destination is full."
	ReasonWrongPassword = "The repository at the destination doesn't open with this Whombat's password."
	ReasonNoRepository  = "There is no backup repository at the destination any more: it was moved or deleted."
	ReasonPlainHTTP     = "Use https:// for this destination: over plain http its password and the backups' traffic would cross the network unprotected. Plain http is accepted only for a numeric address on your own network (such as 192.168.1.20)."
)

// Explain turns a failure to reach or open the destination into an owner-facing DestError.
func Explain(d *state.Destination, err error) error {
	if err == nil {
		return nil
	}
	var de *DestError
	if errors.As(err, &de) {
		return err
	}
	kind := ""
	if d != nil {
		kind = d.Kind
	}
	return &DestError{Reason: reason(kind, err), Err: err}
}

func reason(kind string, err error) string {
	msg := err.Error()
	low := strings.ToLower(msg)
	has := func(subs ...string) bool {
		for _, s := range subs {
			if strings.Contains(low, strings.ToLower(s)) {
				return true
			}
		}
		return false
	}
	switch {
	case kind == state.KindDisk && has("disk absent", "not attached"):
		return ReasonDiskAbsent
	case kind == state.KindSFTP && has("host key verification failed", "remote host identification has changed",
		"no matching host key type", "host key for", "host key mismatch"):
		return ReasonSFTPHostKey
	case kind == state.KindSFTP && has("permission denied (publickey", "too many authentication failures"):
		return ReasonSFTPAuth
	case has("no space left on device", "quotaexceeded", "disk quota exceeded", "insufficient storage", "entitytoolarge"):
		return ReasonDiskFull
	case errors.Is(err, restic.ErrWrongPassword):
		return ReasonWrongPassword
	case kind == state.KindS3 && has("nosuchbucket", "bucket does not exist", "specified bucket does not exist"):
		return ReasonS3NoBucket
	case kind == state.KindS3 && has("authorizationheadermalformed", "region is wrong", "wrong region", "permanentredirect", "invalidregion"):
		return ReasonS3Region
	case kind == state.KindS3 && has("invalidaccesskeyid", "signaturedoesnotmatch", "signature we calculated does not match",
		"access denied", "accessdenied", "forbidden", "403", "the access key id"):
		return ReasonS3Auth
	case kind == state.KindREST && has("401", "unauthorized"):
		return ReasonRESTAuth
	case has("x509:", "certificate signed by unknown authority", "certificate is not valid", "tls: failed to verify"):
		return ReasonTLS
	case errors.Is(err, context.DeadlineExceeded), has("connection refused", "no such host", "network is unreachable",
		"i/o timeout", "connection timed out", "no route to host", "connection reset", "could not resolve hostname",
		"temporary failure in name resolution", "connection closed by remote host", "unable to start the sftp session"):
		return ReasonUnreachable
	case kind == state.KindSFTP && has("no such file", "permission denied", "file does not exist"):
		return ReasonSFTPNoPath
	case errors.Is(err, restic.ErrNoRepository):
		return ReasonNoRepository
	}
	return "The backup destination can't be used."
}
