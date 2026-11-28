package winpc

import (
	"slices"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"rackoon/internal/proto"
)

// services lists Windows' services: running or not, and how each starts.
// Load is "loaded" for every service; Active and Sub read as systemd's
// (active running, inactive dead, activating start-pending), and Enabled
// is the start type (automatic, delayed, manual, disabled).
func services() ([]proto.Service, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, err
	}
	defer m.Disconnect()
	names, err := m.ListServices()
	if err != nil {
		return nil, err
	}
	var rows []proto.Service
	for _, n := range names {
		h, err := windows.OpenService(m.Handle, windows.StringToUTF16Ptr(n), windows.SERVICE_QUERY_STATUS|windows.SERVICE_QUERY_CONFIG)
		if err != nil {
			continue
		}
		s := &mgr.Service{Name: n, Handle: h}
		st, err := s.Query()
		if err != nil {
			s.Close()
			continue
		}
		row := proto.Service{Name: n, Load: "loaded"}
		row.Active, row.Sub = serviceState(st.State)
		if cfg, err := s.Config(); err == nil {
			row.Description = clip(cfg.DisplayName, 200)
			row.Enabled = startType(cfg.StartType, cfg.DelayedAutoStart)
		}
		s.Close()
		rows = append(rows, row)
	}
	slices.SortFunc(rows, func(a, b proto.Service) int { return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)) })
	return rows, nil
}

func serviceState(s svc.State) (active, sub string) {
	switch s {
	case svc.Running:
		return "active", "running"
	case svc.StartPending, svc.ContinuePending:
		return "activating", "start"
	case svc.StopPending:
		return "deactivating", "stop"
	case svc.Paused, svc.PausePending:
		return "active", "paused"
	}
	return "inactive", "dead"
}

func startType(t uint32, delayed bool) string {
	switch t {
	case mgr.StartAutomatic:
		if delayed {
			return "delayed"
		}
		return "automatic"
	case mgr.StartManual:
		return "manual"
	case mgr.StartDisabled:
		return "disabled"
	}
	return "system"
}
