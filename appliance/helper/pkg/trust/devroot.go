package trust

import (
	"errors"
	"fmt"

	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// ErrDevelopmentRoot: a production device was given (or rotated to) a TUF root that trusts a development
// key. Their private keys are committed to this repository (release-tools/fixtures/dev-keys), so such a
// root authorizes anything (W4-SEC part 2 L-4).
var ErrDevelopmentRoot = errors.New("TUF root trusts a development key (refused in prod)")

// DevelopmentKeyIDs are the TUF key ids of the committed development fixtures (root v1 and the rotated
// root v2 of release-tools/fixtures/dev). TestDevelopmentKeyIDsMatchFixtures keeps the list current when
// the fixtures are regenerated. The ids of fixtures generated before stay: their private keys remain in the
// repository's history (the fixtures before UP-X26, regenerated 2026-10-24).
var DevelopmentKeyIDs = map[string]bool{
	// The fixtures since 2026-10-24 (UP-X26: closure indexes only).
	"17518575ddccc7975f23f89c4cc5c685944534fedabd3614702bcd698d97d12c": true,
	"38c83335e17b56f720339eda82241fec095017ef1cf422af8791e47488c303cf": true,
	"5e159df5ea0f907d4ed22612391f071550972148cd3beebd637d37b2796ed7b0": true,
	"67c422701c9e558d9de89cfd8769404bbe9ac56e26e367dbce2dc72d75e06c69": true,
	"91fc28df3bf57b5b32d06a0c0b42bcbcc44d5f47ceadcc69b523b1e92f607eda": true,
	"a119978d2d93dabb98f06e16768c6393b37c7c8129c05a121b54e18614029522": true,
	"b2c0b6194381bfd16adcf257bcf8b6c3ff099930712fa05eb539786194ba35bf": true,
	"ee048e030626e119c324a069236345d5626eb1ed93fbf8988d49e3a84e084bca": true,
	// The community edition's test repository (release-tools/fixtures/community-test, 2026-10-24; Whombat HE-58,
	// UP-X27): its root is what community images pin while the edition has test keys only (HE-62).
	"0f999c276c4535302bb88b5e0e9f0528792f8e2fac5ce7b836dacc50029b57a0": true,
	"652b881617d17ccee004c9c9366698e1672463678141c5455e7821049d64f08d": true,
	"c3c061789f8c3a00329a05e816c95920d7b94269bc20e8dfb2d832a9c0386abe": true,
	"c52ee351cb2c3ae2d15c398f959ad7b723fe38df4471fe77533e496bd7ccafc2": true,
	// The fixtures before.
	"26ebf82771bb166b3b2948be1544b4a3136547f9990909013a81d4bfdd7f9fd0": true,
	"756711144d8882a0abc7225c7a3f34265c4a14f80a75a9358b4a558160a1a01b": true,
	"757e72655e83650427cb8823bcb486923ee25ae66c435ae7e06deb8e13211d9c": true,
	"79d5e2261e77680804f6288c0eec3d58ce2692a6f2ae5e273a1f75297bd9f0d1": true,
	"7acc38548abec32563e210160e649ee2585e592a253016a70121d2e1a8f39767": true,
	"9029ddd7848fdb4797387b1313df25e9296826aa1c3618d7c928f9fab40830dd": true,
	"b7452c3d52642cd49719ff8b684f4a41646e1b7faec90750ab1174f6a1e4690f": true,
	"d74e3b95decc3b54529a2b730e4930c5917d9e699fba55888c94d7b10561d6af": true,
}

// CheckProductionRoot refuses a root that trusts any development key.
func CheckProductionRoot(r *metadata.Metadata[metadata.RootType]) error {
	for id := range r.Signed.Keys {
		if DevelopmentKeyIDs[id] {
			return fmt.Errorf("%w: key %s", ErrDevelopmentRoot, id)
		}
	}
	return nil
}

func checkProductionRootBytes(b []byte) error {
	r, err := metadata.Root().FromBytes(b)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidMetadata, err)
	}
	return CheckProductionRoot(r)
}

// ErrSingleKeyRoot: a production device whose pinned root needs two root keys was given (or rotated to) a root that one
// key can replace (Whombat ONE-05, LNK-25: the root is offline, two of three keys sign it).
var ErrSingleKeyRoot = errors.New("TUF root one root key can replace (refused in prod once the pinned root needs two)")

// rootNeeds is how many root keys must sign r's successor: its root threshold (0 without a root role).
func rootNeeds(r *metadata.Metadata[metadata.RootType]) int {
	role := r.Signed.Roles[metadata.ROOT]
	if role == nil {
		return 0
	}
	return role.Threshold
}

// CheckRootThreshold refuses r when the pinned root needs at least two root keys and r needs fewer. A pinned root of one
// key (the interim root before the key ceremony, or an image older than it) checks nothing: the rule takes effect with
// the image that pins the ceremony's root, and never lets the chain fall back to an online key after it.
func CheckRootThreshold(pinned []byte, r *metadata.Metadata[metadata.RootType]) error {
	p, err := metadata.Root().FromBytes(pinned)
	if err != nil {
		return fmt.Errorf("%w: pinned root: %v", ErrInvalidMetadata, err)
	}
	if rootNeeds(p) < 2 {
		return nil
	}
	if n := rootNeeds(r); n < 2 || len(r.Signed.Roles[metadata.ROOT].KeyIDs) < n {
		return fmt.Errorf("%w: root %d needs %d", ErrSingleKeyRoot, r.Signed.Version, n)
	}
	return nil
}

func checkRootThresholdBytes(pinned, b []byte) error {
	r, err := metadata.Root().FromBytes(b)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidMetadata, err)
	}
	return CheckRootThreshold(pinned, r)
}
