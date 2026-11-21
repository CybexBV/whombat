package checks

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"

	"rackoon/internal/proto"
)

const pingAttempts = 3

// ErrPingNotPermitted is returned when neither an unprivileged ICMP socket
// (net.ipv4.ping_group_range) nor a raw socket (CAP_NET_RAW) is available.
var ErrPingNotPermitted = errors.New("ICMP sockets are not permitted")

// listenICMP opens an ICMP socket: the unprivileged ping socket first
// ("udp4"/"udp6", allowed by net.ipv4.ping_group_range), then a raw socket
// (root / CAP_NET_RAW). raw reports which one.
func listenICMP(v6 bool) (c *icmp.PacketConn, raw bool, err error) {
	dgram, rawNet, addr := "udp4", "ip4:icmp", "0.0.0.0"
	if v6 {
		dgram, rawNet, addr = "udp6", "ip6:ipv6-icmp", "::"
	}
	c, err1 := icmp.ListenPacket(dgram, addr)
	if err1 == nil {
		return c, false, nil
	}
	c, err2 := icmp.ListenPacket(rawNet, addr)
	if err2 == nil {
		return c, true, nil
	}
	return nil, false, fmt.Errorf("%w (%v; %v)", ErrPingNotPermitted, err1, err2)
}

// resolveHost returns the target's address, IPv4 preferred.
func resolveHost(ctx context.Context, host string) (net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return ip, nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	for _, a := range addrs {
		if a.IP.To4() != nil {
			return a.IP, nil
		}
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("%s has no address", host)
	}
	return addrs[0].IP, nil
}

// runPing sends up to three echo requests and reports the round trip of
// the first reply.
func runPing(ctx context.Context, s proto.CheckSpec, res *proto.CheckResult) error {
	ip, err := resolveHost(ctx, s.Target)
	if err != nil {
		return err
	}
	v6 := ip.To4() == nil
	conn, raw, err := listenICMP(v6)
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.SetDeadline(time.Now()) })
	defer stop()

	var reqType, replyType icmp.Type = ipv4.ICMPTypeEcho, ipv4.ICMPTypeEchoReply
	protoNum := 1
	if v6 {
		reqType, replyType, protoNum = ipv6.ICMPTypeEchoRequest, ipv6.ICMPTypeEchoReply, 58
	} else {
		ip = ip.To4()
	}
	var dst net.Addr = &net.UDPAddr{IP: ip}
	if raw {
		dst = &net.IPAddr{IP: ip}
	}
	id := int(rand.N(uint32(0xffff))) + 1
	payload := []byte("whombat-check-ping")
	buf := make([]byte, 1500)
	deadline, _ := ctx.Deadline()
	if deadline.IsZero() {
		deadline = time.Now().Add(time.Duration(s.TimeoutS) * time.Second)
	}
	var lastErr error = errors.New("no reply")
	for attempt := 0; attempt < pingAttempts; attempt++ {
		if ctx.Err() != nil {
			break
		}
		seq := attempt + 1
		msg := icmp.Message{Type: reqType, Body: &icmp.Echo{ID: id, Seq: seq, Data: payload}}
		b, err := msg.Marshal(nil) // ICMPv6 checksums are filled in by the kernel
		if err != nil {
			return err
		}
		attemptEnd := time.Now().Add(time.Until(deadline) / time.Duration(pingAttempts-attempt))
		start := time.Now()
		if _, err := conn.WriteTo(b, dst); err != nil {
			lastErr = err
			waitUntil(ctx, attemptEnd)
			continue
		}
		conn.SetReadDeadline(attemptEnd)
		for {
			n, peer, err := conn.ReadFrom(buf)
			if err != nil {
				lastErr = errors.New("no reply")
				var ne net.Error
				if !errors.As(err, &ne) || !ne.Timeout() {
					lastErr = err
				}
				break
			}
			rm, err := icmp.ParseMessage(protoNum, buf[:n])
			if err != nil || rm.Type != replyType {
				continue
			}
			echo, ok := rm.Body.(*icmp.Echo)
			// Unprivileged sockets get only their own replies (the kernel
			// rewrites the id); raw sockets see every reply on the host.
			if !ok || echo.Seq != seq || (raw && echo.ID != id) || !sameIP(peer, ip) {
				continue
			}
			res.LatencyMs = ms(time.Since(start))
			return nil
		}
	}
	if ctx.Err() != nil {
		return context.DeadlineExceeded
	}
	return lastErr
}

func waitUntil(ctx context.Context, t time.Time) {
	select {
	case <-ctx.Done():
	case <-time.After(time.Until(t)):
	}
}

func sameIP(a net.Addr, ip net.IP) bool {
	switch v := a.(type) {
	case *net.UDPAddr:
		return v.IP.Equal(ip)
	case *net.IPAddr:
		return v.IP.Equal(ip)
	}
	return false
}
