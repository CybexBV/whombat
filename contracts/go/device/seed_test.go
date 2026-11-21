package device

import "crypto/sha256"

// devSeed mirrors deriveSeedKeypair(name, "whombat-contracts-vectors") in @whombat/core (development keys only).
func devSeed(name string) []byte {
	sum := sha256.Sum256([]byte("whombat/seed-key/v1\x00whombat-contracts-vectors\x00" + name))
	return sum[:]
}
