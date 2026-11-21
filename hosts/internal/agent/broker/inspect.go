package broker

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"rackoon/internal/agent/inspect"
	"rackoon/internal/agent/pkgs"
	"rackoon/internal/agent/services"
	"rackoon/internal/proto"
)

// Default and maximum rows of the host views (proto.InspectRequest.Limit).
const (
	defaultServices = 1000
	maxServices     = 5000
	defaultUpdates  = 2000
	maxUpdates      = 10000
)

// Inspect implements agent.Broker.
func (b *Broker) Inspect(ctx context.Context, req proto.InspectRequest) proto.InspectResponse {
	switch req.Kind {
	case proto.InspectProcesses, proto.InspectPorts, proto.InspectServices, proto.InspectUpdates:
		if req.Platform != proto.PlatformHost || req.GuestID != HostID {
			return proto.InspectResponse{Code: CodeInvalid, Message: `host views need platform "host" and guest "host"`}
		}
	case proto.InspectSnapshots:
		return b.inspectSnapshots(ctx, req)
	default:
		return proto.InspectResponse{Code: CodeUnsupported, Message: "unknown inspect kind"}
	}
	var resp proto.InspectResponse
	var err error
	switch req.Kind {
	case proto.InspectProcesses:
		resp.Processes, resp.Truncated, err = inspect.Processes(ctx, inspect.ProcOptions{
			Limit:     req.Limit,
			Container: b.containerNamer(ctx),
		})
	case proto.InspectPorts:
		resp.Ports, resp.Truncated, err = inspect.Ports(ctx, inspect.PortOptions{Limit: req.Limit})
	case proto.InspectServices:
		resp.Services, err = services.List(ctx)
		resp.Services, resp.Truncated = capRows(resp.Services, req.Limit, defaultServices, maxServices)
	case proto.InspectUpdates:
		_, resp.Updates, err = pkgs.List(ctx)
		resp.Updates, resp.Truncated = capRows(resp.Updates, req.Limit, defaultUpdates, maxUpdates)
	}
	if err != nil {
		switch {
		case errors.Is(err, services.ErrUnsupported), errors.Is(err, pkgs.ErrUnsupported):
			return proto.InspectResponse{Code: CodeUnsupported, Message: err.Error()}
		case ctx.Err() != nil:
			return proto.InspectResponse{Code: CodeTimeout, Message: "the view took too long"}
		}
		return proto.InspectResponse{Code: CodePlatformError, Message: err.Error()}
	}
	return resp
}

func capRows[T any](rows []T, limit, def, max int) ([]T, bool) {
	if limit <= 0 {
		limit = def
	}
	if limit > max {
		limit = max
	}
	if len(rows) > limit {
		return rows[:limit], true
	}
	return rows, false
}

// containerNamer names the guest of a process from its cgroup: Docker
// container ids become names (one Docker query per view, when needed),
// Incus "project_name" becomes the inventory's "project/name".
func (b *Broker) containerNamer(ctx context.Context) func(cgroup string) string {
	var inv *proto.Report
	if b.inv != nil {
		inv = b.inv()
	}
	var once sync.Once
	var dockerNames map[string]string
	return func(cgroup string) string {
		platform, id := inspect.ContainerOf(cgroup)
		switch platform {
		case "":
			return ""
		case "docker":
			once.Do(func() {
				dockerNames = map[string]string{}
				d, _ := b.drivers[proto.PlatformDocker].(*dockerDriver)
				if d == nil {
					return
				}
				dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
				defer cancel()
				list, err := d.containers(dctx)
				if err != nil {
					return
				}
				for _, c := range list {
					dockerNames[c.ID] = c.name()
				}
			})
			if n := dockerNames[id]; n != "" {
				return "docker:" + n
			}
			return "docker:" + id[:12]
		case "incus":
			if inv != nil && inv.FindGuest(proto.PlatformIncus, id) == nil {
				if p, n, ok := strings.Cut(id, "_"); ok && inv.FindGuest(proto.PlatformIncus, p+"/"+n) != nil {
					return "incus:" + p + "/" + n
				}
			}
		}
		return platform + ":" + id
	}
}
