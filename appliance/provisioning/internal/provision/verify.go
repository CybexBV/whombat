package provision

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/CybexBV/whombat/appliance/internal/recoverykey"
	"github.com/CybexBV/whombat/appliance/provisioning/internal/ident"
)

// Verify checks a provisioned identity: every file present with its owner and mode, the private keys
// match the published public halves, the claim reference names this device. Used by factory QA, the
// VM tests and `whombat-provision verify`.
func Verify(persistDir string, managerUID int) (*Record, error) {
	return VerifyOwned(persistDir, managerUID, 0)
}

// VerifyOwned is Verify with an explicit owner for the files that are root-owned on a device
// (development and harness runs as an ordinary user).
func VerifyOwned(persistDir string, managerUID, rootUID int) (*Record, error) {
	idDir := filepath.Join(persistDir, "identity")
	var problems []string
	check := func(name string, mode os.FileMode, uid int) []byte {
		p := filepath.Join(idDir, name)
		if name == "master.key" || name == RunnerToken {
			p = filepath.Join(persistDir, "secrets", name)
		}
		if name == recoverykey.HashFile {
			p = filepath.Join(persistDir, name)
		}
		st, err := os.Lstat(p)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", name, err))
			return nil
		}
		if !st.Mode().IsRegular() {
			problems = append(problems, name+": not a regular file")
			return nil
		}
		if st.Mode().Perm() != mode {
			problems = append(problems, fmt.Sprintf("%s: mode %v, want %v", name, st.Mode().Perm(), mode))
		}
		if s, ok := st.Sys().(*syscall.Stat_t); ok && int(s.Uid) != uid {
			problems = append(problems, fmt.Sprintf("%s: owner %d, want %d", name, s.Uid, uid))
		}
		b, err := os.ReadFile(p)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", name, err))
		}
		return b
	}
	devB := check(DeviceFile, 0o644, rootUID)
	mkB := check(ManagementKey, 0o600, managerUID)
	mpB := check(ManagementPub, 0o644, rootUID)
	ckB := check(ContentKey, 0o600, rootUID)
	cpB := check(ContentPeerID, 0o644, rootUID)
	clB := check(ClaimSecretRef, 0o600, rootUID)
	msB := check("master.key", 0o600, rootUID)
	rtB := check(RunnerToken, 0o600, rootUID)
	if len(problems) > 0 {
		return nil, errors.New(strings.Join(problems, "; "))
	}
	var rec Record
	if err := json.Unmarshal(devB, &rec); err != nil {
		return nil, fmt.Errorf("device.json: %w", err)
	}
	if rec.DeviceID == "" || rec.V != 1 {
		problems = append(problems, "device.json: missing deviceId or unknown version")
	}
	if mk, err := ident.ParsePKCS8PEM(mkB); err != nil {
		problems = append(problems, "management.key: "+err.Error())
	} else if mk.PublicHex() != strings.TrimSpace(string(mpB)) || mk.PublicHex() != rec.ManagementPublicKey {
		problems = append(problems, "management.key does not match management.pub/device.json")
	}
	ck, err := ident.ParseLibp2pPrivateKey(ckB)
	if err != nil {
		problems = append(problems, "content.key: "+err.Error())
	} else if pid := ck.PeerID(); pid != strings.TrimSpace(string(cpB)) || pid != rec.ContentPeerID || ck.PublicHex() != rec.ContentPublicKey {
		problems = append(problems, "content.key does not match content.peerid/device.json")
	} else if fp, _ := ident.Fingerprint(pid); rec.Fingerprint != fp {
		problems = append(problems, "device.json: fingerprint mismatch")
	} else if rec.ManagementPublicKey == rec.ContentPublicKey {
		problems = append(problems, "management key equals the content identity")
	}
	var cf ClaimFile
	if err := json.Unmarshal(clB, &cf); err != nil || cf.DeviceID != rec.DeviceID || cf.V != 1 || cf.Algorithm != ClaimAlgorithm {
		problems = append(problems, "claim.json invalid or for another device")
	} else if rec.Model == SelfInstalledModel {
		// A self-installed appliance has no card secret (CC-10): only the console code claims it.
		if cf.SecretHash != nil {
			problems = append(problems, "claim.json: a self-installed appliance has no card secret")
		}
		// It has no disk recovery key (PI-19); a hash an earlier image stored (PI-04) must still be sound, since
		// the recovery menu checks keys against it.
		if _, err := os.Lstat(filepath.Join(persistDir, recoverykey.HashFile)); err == nil {
			if h := check(recoverykey.HashFile, 0o600, rootUID); h != nil {
				if _, _, _, err := recoverykey.ParseHash(string(h)); err != nil {
					problems = append(problems, recoverykey.HashFile+": "+err.Error())
				}
			}
		}
	} else if cf.SecretHash == nil || len(*cf.SecretHash) != 43 {
		problems = append(problems, "claim.json: no claim secret hash")
	}
	if mk, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(msB))); err != nil || len(mk) != 32 {
		problems = append(problems, "secrets/master.key is not 32 bytes base64")
	}
	if len(strings.TrimSpace(string(rtB))) < 32 {
		problems = append(problems, "secrets/runner-token is shorter than 32 characters")
	}
	if len(problems) > 0 {
		return nil, errors.New(strings.Join(problems, "; "))
	}
	return &rec, nil
}

// verifyAs is VerifyOwned for tests that run unprivileged.
func verifyAs(persistDir string, uid int) (*Record, error) { return VerifyOwned(persistDir, uid, uid) }
