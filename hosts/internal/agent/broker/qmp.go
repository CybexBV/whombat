package broker

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"time"
)

// qmpClient is a minimal QEMU Machine Protocol client for a QMP Unix
// socket (Proxmox VE: /var/run/qemu-server/<vmid>.qmp). QEMU accepts one
// QMP client per socket at a time, so connections are short-lived.
type qmpClient struct {
	c  net.Conn
	rd *bufio.Reader
}

func dialQMP(ctx context.Context, path string) (*qmpClient, error) {
	var d net.Dialer
	c, err := d.DialContext(ctx, "unix", path)
	if err != nil {
		return nil, err
	}
	dl, ok := ctx.Deadline()
	if !ok {
		dl = time.Now().Add(20 * time.Second)
	}
	c.SetDeadline(dl)
	q := &qmpClient{c: c, rd: bufio.NewReaderSize(c, 64<<10)}
	// Greeting.
	var greet map[string]json.RawMessage
	if err := q.readMsg(&greet); err != nil {
		c.Close()
		return nil, fmt.Errorf("qmp greeting: %w", err)
	}
	if _, ok := greet["QMP"]; !ok {
		c.Close()
		return nil, errors.New("qmp: unexpected greeting")
	}
	if _, err := q.run("qmp_capabilities", nil); err != nil {
		c.Close()
		return nil, err
	}
	return q, nil
}

func (q *qmpClient) Close() error { return q.c.Close() }

func (q *qmpClient) readMsg(v any) error {
	line, err := q.rd.ReadBytes('\n')
	if err != nil {
		return err
	}
	return json.Unmarshal(line, v)
}

// run executes a command and returns its "return" value. Asynchronous
// events are skipped.
func (q *qmpClient) run(cmd string, args any) (json.RawMessage, error) {
	req := map[string]any{"execute": cmd}
	if args != nil {
		req["arguments"] = args
	}
	b, _ := json.Marshal(req)
	if _, err := q.c.Write(append(b, '\n')); err != nil {
		return nil, err
	}
	for {
		var resp struct {
			Return json.RawMessage `json:"return"`
			Error  *struct {
				Class string `json:"class"`
				Desc  string `json:"desc"`
			} `json:"error"`
			Event string `json:"event"`
		}
		if err := q.readMsg(&resp); err != nil {
			return nil, fmt.Errorf("qmp %s: %w", cmd, err)
		}
		if resp.Event != "" {
			continue
		}
		if resp.Error != nil {
			return nil, fmt.Errorf("qmp %s: %s", cmd, resp.Error.Desc)
		}
		return resp.Return, nil
	}
}
