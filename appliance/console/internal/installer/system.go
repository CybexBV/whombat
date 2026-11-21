package installer

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Machine is the real System.
type Machine struct {
	SysClassNet string   // /sys/class/net (tests: a tree of their own)
	Lsblk       string   // lsblk
	InstallCmd  []string // whombat-install and any fixed arguments before --disk
	RebootCmd   []string // systemctl reboot
	Log         io.Writer
}

func (m Machine) UEFI() bool {
	st, err := os.Stat("/sys/firmware/efi")
	return err == nil && st.IsDir()
}

// CPUs are the CPUs this process may run on (the VM's vCPUs).
func (m Machine) CPUs() int { return runtime.NumCPU() }

// MemoryBytes is MemTotal of /proc/meminfo.
func (m Machine) MemoryBytes() (uint64, error) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	return ParseMemTotal(b)
}

// ParseMemTotal reads MemTotal (kB) from /proc/meminfo.
func ParseMemTotal(meminfo []byte) (uint64, error) {
	sc := bufio.NewScanner(bytes.NewReader(meminfo))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) >= 2 && f[0] == "MemTotal:" {
			kb, err := strconv.ParseUint(f[1], 10, 64)
			if err != nil {
				return 0, err
			}
			return kb * 1024, nil
		}
	}
	return 0, errors.New("no MemTotal")
}

func (m Machine) BlockDevices(ctx context.Context) ([]byte, error) {
	return exec.CommandContext(ctx, m.Lsblk, LsblkArgs...).Output()
}

// Address is the first global IPv4 address of an interface that is up, else the first global IPv6 one.
func (m Machine) Address() string {
	ifs, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var v6 string
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 || !m.physical(i.Name) {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			n, ok := a.(*net.IPNet)
			if !ok || !n.IP.IsGlobalUnicast() {
				continue
			}
			if n.IP.To4() != nil {
				return n.IP.String()
			}
			if v6 == "" {
				v6 = n.IP.String()
			}
		}
	}
	return v6
}

func (m Machine) physical(name string) bool {
	sys := m.SysClassNet
	if sys == "" {
		sys = "/sys/class/net"
	}
	_, err := os.Stat(filepath.Join(sys, name, "device"))
	return err == nil
}

// InterfaceAddress only accepts an address on the joined card, never another
// interface's address (a cable, container bridge or tunnel).
func InterfaceAddress(name string) string {
	iface, err := net.InterfaceByName(name)
	if err != nil || iface.Flags&net.FlagUp == 0 {
		return ""
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return ""
	}
	var v6 string
	for _, addr := range addrs {
		n, ok := addr.(*net.IPNet)
		if !ok || !n.IP.IsGlobalUnicast() {
			continue
		}
		if n.IP.To4() != nil {
			return n.IP.String()
		}
		if v6 == "" {
			v6 = n.IP.String()
		}
	}
	return v6
}

// WiredAddress is the first global address of a cable's interface that is up: a physical one (it has a device) that
// isn't Wi-Fi (no `wireless` or `phy80211`). A USB Ethernet adapter counts; bridges, tunnels and Wi-Fi don't.
func (m Machine) WiredAddress() string {
	ifs, err := net.Interfaces()
	if err != nil {
		return ""
	}
	sys := m.SysClassNet
	if sys == "" {
		sys = "/sys/class/net"
	}
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 || !Wired(sys, i.Name) {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && n.IP.IsGlobalUnicast() {
				return n.IP.String()
			}
		}
	}
	return ""
}

// Wired reports whether the interface name under sys (/sys/class/net) is a cable's: a device, not a Wi-Fi card.
func Wired(sys, name string) bool {
	exists := func(p string) bool { _, err := os.Stat(filepath.Join(sys, name, p)); return err == nil }
	return exists("device") && !exists("wireless") && !exists("phy80211")
}

// Reach completes a TLS handshake with host:443 (or the host:port given, an owner's own login server) against the
// system's CA certificates (the ISO's).
func (m Machine) Reach(ctx context.Context, host string) error {
	addr := net.JoinHostPort(host, "443")
	if h, _, err := net.SplitHostPort(host); err == nil {
		addr, host = host, h
	}
	d := tls.Dialer{NetDialer: &net.Dialer{Timeout: reachTimeout}, Config: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}}
	c, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	return c.Close()
}

// Install runs whombat-install --disk D --yes-erase-disk [--wifi-profile F] [--reach …] [--login-server U]
// with its output (stdout and stderr, one stream) line by line to line and to the journal.
func (m Machine) Install(ctx context.Context, job Job, line func(string)) error {
	if len(m.InstallCmd) == 0 {
		return errors.New("no install command")
	}
	args := InstallArgs(m.InstallCmd[1:], job)
	cmd := exec.CommandContext(ctx, m.InstallCmd[0], args...)
	pr, pw, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd.Stdin = nil
	cmd.Stdout, cmd.Stderr = pw, pw
	cmd.WaitDelay = 10 * time.Second
	if err := cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		return err
	}
	pw.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		ReadLines(pr, func(l string) {
			if m.Log != nil {
				fmt.Fprintln(m.Log, l)
			}
			line(l)
		})
		pr.Close()
	}()
	err = cmd.Wait()
	<-done
	if err != nil {
		return fmt.Errorf("whombat-install: %w", err)
	}
	return nil
}

// InstallArgs are whombat-install's arguments for a job, after the fixed ones.
func InstallArgs(fixed []string, job Job) []string {
	args := append(append([]string{}, fixed...), "--disk", job.Disk, "--yes-erase-disk")
	if job.WifiProfile != "" {
		args = append(args, "--wifi-profile", job.WifiProfile)
	}
	if c := job.Reach; c != nil && (c.Link || c.Tailscale) {
		way := "link"
		switch {
		case c.Link && c.Tailscale:
			way = "both"
		case c.Tailscale:
			way = "tailscale"
		}
		args = append(args, "--reach", way)
		if c.Tailscale && c.LoginServer != "" {
			args = append(args, "--login-server", c.LoginServer)
		}
	}
	return args
}

// ReadLines splits r into lines of any length (a line longer than 64 KiB is cut; the rest of it is dropped).
func ReadLines(r io.Reader, line func(string)) {
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		b, isPrefix, err := br.ReadLine()
		if len(b) > 0 || (err == nil && !isPrefix) {
			line(string(b))
		}
		for isPrefix && err == nil {
			_, isPrefix, err = br.ReadLine()
		}
		if err != nil {
			return
		}
	}
}

func (m Machine) Reboot() error {
	if len(m.RebootCmd) == 0 {
		return errors.New("no reboot command")
	}
	return exec.Command(m.RebootCmd[0], m.RebootCmd[1:]...).Run()
}
