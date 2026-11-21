package restic

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRestic records its argv and environment and fails with the given stderr.
func fakeRestic(t *testing.T, stderr string, code int) (bin, argvFile, envFile string) {
	t.Helper()
	dir := t.TempDir()
	argvFile, envFile = filepath.Join(dir, "argv"), filepath.Join(dir, "env")
	bin = filepath.Join(dir, "restic")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + argvFile + "\nenv > " + envFile + "\n"
	if code != 0 {
		script += "printf '%s' '" + stderr + "' >&2\nexit " + string(rune('0'+code)) + "\n"
	} else {
		script += "echo '{\"version\":2,\"id\":\"abc\"}'\n"
	}
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, argvFile, envFile
}

func read(t *testing.T, p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// S3 and REST credentials reach restic only through its environment; the SFTP command line names files,
// never a secret; nothing of the caller's environment leaks in.
func TestSecretsNeverInArgv(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "CALLER-KEY")
	t.Setenv("SSH_AUTH_SOCK", "/tmp/agent.sock")
	bin, argvFile, envFile := fakeRestic(t, "", 0)
	r := Repo{Binary: bin, Repository: "s3:https://s3.example.com/bucket/box", PasswordFile: "/pw",
		S3AccessKeyID: "AKIDEXAMPLE", S3SecretAccessKey: "s3-secret-value-xyz", S3Region: "eu-central-1",
		RESTUser: "u", RESTPassword: "rest-secret-value-xyz"}
	if _, err := r.Config(context.Background()); err != nil {
		t.Fatal(err)
	}
	argv, env := read(t, argvFile), read(t, envFile)
	for _, secret := range []string{"s3-secret-value-xyz", "rest-secret-value-xyz", "AKIDEXAMPLE"} {
		if strings.Contains(argv, secret) {
			t.Fatalf("%s on the command line: %s", secret, argv)
		}
	}
	for _, want := range []string{"AWS_ACCESS_KEY_ID=AKIDEXAMPLE", "AWS_SECRET_ACCESS_KEY=s3-secret-value-xyz",
		"AWS_DEFAULT_REGION=eu-central-1", "RESTIC_PASSWORD_FILE=/pw", "AWS_SHARED_CREDENTIALS_FILE=/dev/null"} {
		if !strings.Contains(env, want) {
			t.Fatalf("env lacks %s:\n%s", want, env)
		}
	}
	if strings.Contains(env, "CALLER-KEY") || strings.Contains(env, "SSH_AUTH_SOCK") {
		t.Fatalf("the caller's environment leaked into restic's:\n%s", env)
	}

	r = Repo{Binary: bin, Repository: "sftp:nas.local:/backups/box", PasswordFile: "/pw",
		SFTP: &SFTP{SSH: "/nix/store/x-openssh/bin/ssh", Host: "nas.local", Port: 2222, User: "whombat",
			KeyFile: "/run/credentials/whombat-backup.service/ssh-key", KnownHostsFile: "/persist/backup/known_hosts",
			HostKeyAlgorithms: "ssh-ed25519"}}
	if _, err := r.Config(context.Background()); err != nil {
		t.Fatal(err)
	}
	argv = read(t, argvFile)
	if !strings.Contains(argv, "sftp.command=/nix/store/x-openssh/bin/ssh -F none") {
		t.Fatalf("no hardened sftp.command: %s", argv)
	}
	for _, want := range []string{"StrictHostKeyChecking=yes", "IdentityAgent=none", "BatchMode=yes",
		"UserKnownHostsFile=/persist/backup/known_hosts", "GlobalKnownHostsFile=none", "HostKeyAlgorithms=ssh-ed25519",
		"ProxyCommand=none", "ControlMaster=no", "PermitLocalCommand=no", "-p 2222 -l whombat -s -- nas.local sftp"} {
		if !strings.Contains(argv, want) {
			t.Fatalf("sftp.command lacks %q: %s", want, argv)
		}
	}
	if env := read(t, envFile); strings.Contains(env, "AWS_") || strings.Contains(env, "RESTIC_REST") {
		t.Fatalf("credentials of another kind in the environment:\n%s", env)
	}
}

// restic's error output never carries a secret into an error message (status, logs, API answers).
func TestErrorsAreRedacted(t *testing.T) {
	bin, _, _ := fakeRestic(t, "Fatal: auth failed for s3-secret-value-xyz with key AKIDEXAMPLE and rest-secret-value-xyz", 1)
	r := Repo{Binary: bin, Repository: "s3:https://s3.example.com/b/p", PasswordFile: "/pw",
		S3AccessKeyID: "AKIDEXAMPLE", S3SecretAccessKey: "s3-secret-value-xyz", RESTPassword: "rest-secret-value-xyz"}
	_, err := r.Config(context.Background())
	var re *Error
	if !errors.As(err, &re) {
		t.Fatalf("%v", err)
	}
	msg := err.Error()
	for _, secret := range []string{"s3-secret-value-xyz", "AKIDEXAMPLE", "rest-secret-value-xyz"} {
		if strings.Contains(msg, secret) {
			t.Fatalf("secret in the error: %s", msg)
		}
	}
	if !strings.Contains(msg, "[redacted]") {
		t.Fatalf("expected a redaction: %s", msg)
	}
}

func TestParseSFTP(t *testing.T) {
	for in, want := range map[string]SFTPLocation{
		"sftp:nas.local:/volume1/whombat":   {Host: "nas.local", Path: "/volume1/whombat"},
		"sftp:10.0.0.5:backups":             {Host: "10.0.0.5", Path: "backups"},
		"sftp://nas.local:2222//srv/restic": {Host: "nas.local", Port: 2222, Path: "/srv/restic"},
		"sftp://[fd00::5]:22/rel":           {Host: "fd00::5", Port: 22, Path: "rel"},
		"sftp://nas/abs":                    {Host: "nas", Path: "abs"},
	} {
		got, err := ParseSFTP(in)
		if err != nil || got != want {
			t.Fatalf("%s: %+v %v, want %+v", in, got, err, want)
		}
	}
	for _, bad := range []string{"sftp:user@nas:/p", "sftp:nas", "sftp:nas:", "sftp:nas:/", "sftp:-oProxyCommand=x:/p",
		"sftp://nas:99999//p", "sftp://nas", "rest:https://x/", "sftp:na s:/p"} {
		if _, err := ParseSFTP(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}

func TestSFTPValidate(t *testing.T) {
	ok := SFTP{Host: "nas", User: "backup.user", KeyFile: "/k", KnownHostsFile: "/h"}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, s := range []SFTP{
		{Host: "nas", User: "a b", KeyFile: "/k", KnownHostsFile: "/h"},
		{Host: "nas", User: "-oProxyCommand", KeyFile: "/k", KnownHostsFile: "/h"},
		{Host: "-nas", User: "u", KeyFile: "/k", KnownHostsFile: "/h"},
		{Host: "nas", User: "u", KeyFile: "/k k", KnownHostsFile: "/h"},
		{Host: "nas", User: "u", KeyFile: `/k"`, KnownHostsFile: "/h"},
		{Host: "nas", User: "u", KnownHostsFile: "/h"},
	} {
		if err := s.Validate(); err == nil {
			t.Fatalf("%+v accepted", s)
		}
	}
}

// The tuning flags reach restic through the global argument builder and BackupOptions.
func TestTuningFlags(t *testing.T) {
	bin, argvFile, _ := fakeRestic(t, "", 0)
	r := Repo{Binary: bin, Repository: "rest:http://10.0.0.2:8000/b/", PasswordFile: "/pw", PackSizeMB: 32}
	if _, err := r.Config(context.Background()); err != nil {
		t.Fatal(err)
	}
	if argv := read(t, argvFile); !strings.Contains(argv, "--pack-size\n32\n") {
		t.Fatalf("no pack size: %s", argv)
	}
	_, _ = r.Backup(context.Background(), BackupOptions{Dir: t.TempDir(), Paths: []string{"db"}, ReadConcurrency: 4,
		IgnoreInode: true, IgnoreCtime: true})
	argv := read(t, argvFile)
	for _, want := range []string{"--read-concurrency\n4\n", "--ignore-inode\n", "--ignore-ctime\n", "--pack-size\n32\n"} {
		if !strings.Contains(argv, want) {
			t.Fatalf("backup lacks %q: %s", want, argv)
		}
	}
	_, _ = Repo{Binary: bin, Repository: "/r", PasswordFile: "/pw"}.Backup(context.Background(), BackupOptions{Dir: t.TempDir(), Paths: []string{"db"}})
	if argv := read(t, argvFile); strings.Contains(argv, "--ignore-inode") || strings.Contains(argv, "--pack-size") || strings.Contains(argv, "--read-concurrency") {
		t.Fatalf("flags nobody asked for: %s", argv)
	}
}
