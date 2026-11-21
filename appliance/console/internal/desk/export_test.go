package desk

import "time"

// NewForTest is New with every timeout set to d.
func NewForTest(socket string, peerUID int, d time.Duration) *Client {
	c := New(socket, peerUID, nil, nil)
	c.stateTimeout, c.callTimeout, c.talkTimeout, c.networkTimeout, c.wifiTimeout = d, d, d, d, d
	c.bluetoothStateTimeout, c.bluetoothTimeout, c.bluetoothConnectTimeout = d, d, d
	c.hearTimeout = func(float64) time.Duration { return d }
	return c
}
