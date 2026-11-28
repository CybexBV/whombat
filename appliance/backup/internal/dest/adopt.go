package dest

import (
	"context"
	"fmt"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
)

// Places a material's backups are joined from.
const (
	FromMain    = "main"
	FromOffsite = "offsite"
)

// AdoptRequest is the request that joins m's repository at the place from ("main" or "offsite"); nil when the material
// names no such place.
func AdoptRequest(m *kit.Material, from string) *Request {
	if from == FromOffsite {
		if m = m.FromOffsite(); m == nil {
			return nil
		}
	}
	return &Request{Repository: m.Repository, AdoptPassword: m.RepositoryPassword, AdoptManifestKey: m.ManifestKey,
		AdoptHead: m.Head, AdoptEarlier: m.Adopted, RESTUser: m.RESTUser, RESTPassword: m.RESTPassword,
		S3AccessKeyID: m.S3AccessKeyID, S3SecretAccessKey: m.S3SecretAccessKey, S3Region: m.S3Region, SFTPUser: m.SFTPUser,
		SFTPHostKey: m.SFTPHostKey, SFTPPrivateKey: m.SFTPPrivateKey}
}

// Adopt joins the material's backups. from "" tries the main place and, when that fails and the material names a
// second place, the copy there: a fire or a theft that took the NAS with the box leaves the copy. It answers the place
// it joined; edit changes the request first (the console's CA certificate and local paths).
func Adopt(ctx context.Context, c *state.Config, m *kit.Material, from string, edit func(*Request)) (string, *Result, error) {
	places := []string{FromMain, FromOffsite}
	switch from {
	case "":
	case FromMain, FromOffsite:
		places = []string{from}
	default:
		return "", nil, bad("from is main or offsite")
	}
	var errs []error
	for _, p := range places {
		req := AdoptRequest(m, p)
		if req == nil {
			if from == FromOffsite {
				return "", nil, bad("the recovery kit names no second place")
			}
			continue
		}
		if edit != nil {
			edit(req)
		}
		res, err := Configure(ctx, c, *req)
		if err == nil {
			return p, res, nil
		}
		if ctx.Err() != nil {
			return "", nil, err
		}
		errs = append(errs, err)
	}
	if len(errs) == 1 {
		return "", nil, errs[0]
	}
	// Both failed: neither error stands for the request alone, so the answer is the places' (never a 400).
	return "", nil, fmt.Errorf("the main place: %v; the copy: %v", errs[0], errs[1])
}
