// Command whombat-tpm-policy maintains the inputs of the disk-unlock TPM2 policy (MA-21b, NX-12). Root only.
//
//	whombat-tpm-policy sign --esp /boot --profiles /nix/var/nix/profiles --key K.key:K.pub [--key N.key:N.pub]
//	                        --out F [--record R]
//	    sign the expected PCR 11 value (phase enter-initrd) of the ESP stubs that boot a generation of the
//	    system profile (never the recovery UKI or any other stub); record what each key signed
//	whombat-tpm-policy revoked --record R --profiles P --public-key K.pub
//	    print the systems signed with that key that left the profile (non-empty: rotate the key)
//	whombat-tpm-policy check FILE
//	    exit 0 if FILE is a valid PCR signature document (the initrd picks the primary or the fallback)
//	whombat-tpm-policy pcr15 [--log /run/log/systemd/tpm2-measure.log] [--volume whombat-root]
//	    print the PCR 15 value /persist is sealed to (after the root volume was opened)
//	whombat-tpm-policy sections STUB
//	    show what a boot stub measures into PCR 11 (diagnostics)
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/CybexBV/whombat/appliance/helper/pkg/tpmpolicy"
)

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "sign":
		err = sign(os.Args[2:])
	case "check":
		if len(os.Args) != 3 {
			usage()
		}
		b, rerr := os.ReadFile(os.Args[2])
		if rerr != nil || !tpmpolicy.ValidSignature(b) {
			os.Exit(1)
		}
	case "revoked":
		err = revoked(os.Args[2:])
	case "pcr15":
		err = pcr15(os.Args[2:])
	case "sections":
		err = sections(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-tpm-policy:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: whombat-tpm-policy sign|revoked|pcr15|sections ...")
	os.Exit(2)
}

func sign(args []string) error {
	fs := flag.NewFlagSet("sign", flag.ExitOnError)
	esp := fs.String("esp", "/boot", "mounted ESP")
	profiles := fs.String("profiles", "/nix/var/nix/profiles", "Nix profiles directory (system-*-link)")
	measure := fs.String("measure", "systemd-measure", "systemd-measure binary")
	out := fs.String("out", "", "signature JSON (the previous valid one is kept next to it)")
	record := fs.String("record", "", "record of the systems each key signed")
	var keys multi
	fs.Var(&keys, "key", "PRIVATE.pem:PUBLIC.pem (repeatable; the first is the current key)")
	_ = fs.Parse(args)
	if len(keys) == 0 || *out == "" {
		return fmt.Errorf("sign needs --key and --out")
	}
	var kps []tpmpolicy.KeyPair
	for _, k := range keys {
		priv, pub, ok := strings.Cut(k, ":")
		if !ok {
			return fmt.Errorf("--key %q: want PRIVATE:PUBLIC", k)
		}
		kps = append(kps, tpmpolicy.KeyPair{Private: priv, Public: pub})
	}
	tops, err := tpmpolicy.ProfileToplevels(*profiles)
	if err != nil {
		return err
	}
	// Record before signing: a crash after signing must never leave a signed system unrecorded.
	var rec *tpmpolicy.Record
	var fps []string
	if *record != "" {
		if rec, err = tpmpolicy.LoadRecord(*record); err != nil {
			return err
		}
		for _, k := range kps {
			fp, err := tpmpolicy.Fingerprint(k.Public)
			if err != nil {
				return err
			}
			fps = append(fps, fp)
		}
		for _, fp := range fps {
			rec.Add(fp, tops, fps...)
		}
		if err := rec.Save(*record); err != nil {
			return err
		}
	}
	res, err := tpmpolicy.Sign(tpmpolicy.SignOptions{ESP: *esp, Keys: kps, Toplevels: tops, Output: *out, Measure: *measure})
	if res != nil {
		for _, r := range res.Refused {
			fmt.Fprintln(os.Stderr, "not signed:", r)
		}
	}
	if err != nil {
		return err
	}
	fmt.Printf("signed the PCR 11 policy (enter-initrd) of %d generation(s) with %d key(s)\n", len(res.Signed), len(kps))
	return nil
}

func revoked(args []string) error {
	fs := flag.NewFlagSet("revoked", flag.ExitOnError)
	record := fs.String("record", "", "signing record")
	profiles := fs.String("profiles", "/nix/var/nix/profiles", "Nix profiles directory")
	pub := fs.String("public-key", "", "policy public key")
	_ = fs.Parse(args)
	rec, err := tpmpolicy.LoadRecord(*record)
	if err != nil {
		return err
	}
	fp, err := tpmpolicy.Fingerprint(*pub)
	if err != nil {
		return err
	}
	tops, err := tpmpolicy.ProfileToplevels(*profiles)
	if err != nil {
		return err
	}
	for _, s := range rec.Revoked(fp, tops) {
		fmt.Println(s)
	}
	return nil
}

func pcr15(args []string) error {
	fs := flag.NewFlagSet("pcr15", flag.ExitOnError)
	log := fs.String("log", "/run/log/systemd/tpm2-measure.log", "systemd userspace measurement log")
	vol := fs.String("volume", "whombat-root", "volume whose measurement /persist is bound to")
	_ = fs.Parse(args)
	f, err := os.Open(*log)
	if err != nil {
		return err
	}
	defer f.Close()
	v, err := tpmpolicy.PCR15FromLog(f, *vol)
	if err != nil {
		return err
	}
	fmt.Println(v)
	return nil
}

func sections(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("sections STUB")
	}
	st, err := tpmpolicy.ReadStub(args[0])
	if err != nil {
		return err
	}
	fmt.Printf("thin=%v\n", st.Thin)
	for name, d := range st.Sections {
		fmt.Printf("%-9s %d bytes\n", name, len(d))
	}
	return nil
}
