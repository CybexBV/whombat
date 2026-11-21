package proto

// Control levels (Whombat SI-06): what Whombat may do on a server, chosen
// when it is added and set on both sides at once: the hub's switches
// (remote_control) and the agent's own lock ([remote_control] in
// agent.toml). A level is exact: switches it does not name are off.
const (
	ControlWatch   = "watch"   // read-only checks (the agent's defaults)
	ControlOperate = "operate" // also consoles and guest power
	ControlFull    = "full"    // every switch
)

// ControlLevels are the levels, from least to most.
var ControlLevels = []string{ControlWatch, ControlOperate, ControlFull}

// ControlSwitches returns the six remote-control switches of a level
// (console, power, host_shell, host_power, manage, diagnose), false for an
// unknown level.
func ControlSwitches(level string) (map[string]bool, bool) {
	sw := map[string]bool{"console": false, "power": false, "host_shell": false, "host_power": false, "manage": false,
		"diagnose": true}
	switch level {
	case ControlWatch:
	case ControlOperate:
		sw["console"], sw["power"] = true, true
	case ControlFull:
		for k := range sw {
			sw[k] = true
		}
	default:
		return nil, false
	}
	return sw, true
}
