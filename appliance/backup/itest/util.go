package itest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func mustJSON(t interface{ Fatal(...any) }, v any) []byte {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// FailedTry: the status records a failed attempt (the state says failing only from the second in a row, or when late).
func FailedTry(st *state.Status) bool {
	return st.LastAttemptOK != nil && !*st.LastAttemptOK && st.FailedAttempts >= 1
}
