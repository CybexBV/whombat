package main

import (
	"strings"
	"sync"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

// Simulated backup places (docs/MANAGE.md 2.10): blackbox keeps Whombats'
// backups (a setup adds the client and its two containers on the next
// free port from 8747 in the location asked for, another location moves
// it there, a cleanup marks it set, removing takes both away) and shares
// folders over NFS; shale adds NFS storages. Everything is done at once,
// in memory.

type placeSimState struct {
	mu       sync.Mutex
	shares   map[string]map[string][]string // host -> share -> clients
	storages map[string]map[string]string   // host -> storage -> server|export
}

var placeSim = &placeSimState{shares: map[string]map[string][]string{}, storages: map[string]map[string]string{}}

// managePlace answers the backup place operations; ok is false for others.
func (a *simAgent) managePlace(req proto.ManageRequest) (proto.ManageResponse, bool) {
	h := a.host
	switch req.Op {
	case proto.OpPlaceEnsure, proto.OpPlaceCleanup, proto.OpPlaceRemove, proto.OpPlaceNFS:
	case proto.OpStorageAdd:
		if h.ID != simNode {
			return proto.ManageResponse{}, false
		}
		return placeSim.storageAdd(h.ID, req.PVEStorage), true
	default:
		return proto.ManageResponse{}, false
	}
	p := req.Place
	if p == nil {
		return fail("invalid_request", "the request has no backup place values"), true
	}
	if h.PlaceState() == nil {
		return proto.ManageResponse{Code: "unsupported", Message: "This server has no Docker, which the backup app needs.",
			Place: &proto.PlaceResult{Reason: proto.PlaceNoDocker}}, true
	}
	defer func() {
		select { // report the change soon
		case a.early <- struct{}{}:
		default:
		}
	}()
	addrs := h.PlaceState().Addresses
	switch req.Op {
	case proto.OpPlaceEnsure:
		if len(p.RestPassword) < proto.PlaceRestPasswordMin {
			return invalid("rest_password", "The password is 24 to 72 printable characters."), true
		}
		bp := h.PlaceState()
		locs := proto.PlaceLocations(bp, h.Unraid, func(string) bool { return true })
		pathOf := map[string]string{}
		for _, l := range locs {
			pathOf[l.ID] = l.Path
		}
		if p.Location != "" && pathOf[p.Location] == "" {
			return invalid("location", "That isn’t a place on this server."), true
		}
		res := proto.PlaceResult{Client: p.Client, Addresses: addrs, Kit: true}
		h.UpdatePlace(func(bp *proto.BackupPlace) {
			used := map[int]bool{}
			for i, c := range bp.Clients {
				if c.Client == p.Client {
					if p.Port > 0 {
						bp.Clients[i].Port = p.Port
					}
					if p.Location != "" && p.Location != c.Location {
						bp.Clients[i].Location, res.Moved = p.Location, true
					}
					kit := true
					bp.Clients[i].Kit = &kit
					res.Port, res.Location = bp.Clients[i].Port, bp.Clients[i].Location
					return
				}
				used[c.Port] = true
			}
			port := p.Port
			for q := proto.PlaceFirstPort; port == 0; q++ {
				if !used[q] {
					port = q
				}
			}
			loc := p.Location
			if loc == "" {
				loc = locs[0].ID
			}
			bp.Clients = append(bp.Clients, fakefleet.PlaceClientSpec(p.Client, port, loc))
			res.Port, res.Created, res.Location = port, true, loc
		})
		res.Path = pathOf[res.Location] + "/" + p.Client
		if res.Created {
			for _, g := range fakefleet.PlaceGuests(p.Client) {
				h.AddGuest(g)
			}
		}
		return proto.ManageResponse{OK: true, Place: &res}, true
	case proto.OpPlaceCleanup:
		found := false
		days := p.KeepWithinDays
		if days == 0 {
			days = proto.PlaceKeepDaysDefault
		}
		h.UpdatePlace(func(bp *proto.BackupPlace) {
			for i, c := range bp.Clients {
				if c.Client == p.Client {
					found = true
					bp.Clients[i].Cleanup.Set, bp.Clients[i].Cleanup.Running, bp.Clients[i].Cleanup.KeepWithinDays = true, true, days
				}
			}
		})
		if !found {
			return fail(proto.CodeNotFound, "This server doesn’t keep that Whombat’s backups yet: set the place up first."), true
		}
		return proto.ManageResponse{OK: true, Place: &proto.PlaceResult{Client: p.Client, Set: true}}, true
	case proto.OpPlaceRemove:
		h.UpdatePlace(func(bp *proto.BackupPlace) {
			out := bp.Clients[:0]
			for _, c := range bp.Clients {
				if c.Client != p.Client {
					out = append(out, c)
				}
			}
			bp.Clients = out
		})
		for _, g := range fakefleet.PlaceGuests(p.Client) {
			h.RemoveGuest(proto.PlatformDocker, g.ID)
		}
		return proto.ManageResponse{OK: true, Place: &proto.PlaceResult{Client: p.Client, Removed: true}}, true
	}
	// backup_place.nfs
	if h.Unraid == nil {
		return proto.ManageResponse{Code: "unsupported", Message: "Only Unraid servers share a folder for backups this way.",
			Place: &proto.PlaceResult{Reason: proto.PlaceNotUnraid}}, true
	}
	if !proto.PlaceShareRe.MatchString(p.Name) || p.Name == proto.PlaceShareName {
		return invalid("name", "The share is called whombat-… (lower-case letters, digits and dashes)."), true
	}
	placeSim.mu.Lock()
	defer placeSim.mu.Unlock()
	if placeSim.shares[h.ID] == nil {
		placeSim.shares[h.ID] = map[string][]string{}
	}
	have := placeSim.shares[h.ID][p.Name]
	for _, c := range p.Clients {
		if !strings.Contains(" "+strings.Join(have, " ")+" ", " "+c+" ") {
			have = append(have, c)
		}
	}
	placeSim.shares[h.ID][p.Name] = have
	return proto.ManageResponse{OK: true, Place: &proto.PlaceResult{Export: "/mnt/user/" + p.Name, Addresses: addrs}}, true
}

func (s *placeSimState) storageAdd(host string, st *proto.PVEStorageSpec) proto.ManageResponse {
	if st == nil || !proto.PVEStorageIDRe.MatchString(st.Storage) {
		return invalid("storage", "Not a storage name.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.storages[host] == nil {
		s.storages[host] = map[string]string{}
	}
	key := st.Server + "|" + strings.TrimRight(st.Export, "/")
	switch cur, ok := s.storages[host][st.Storage]; {
	case ok && cur != key:
		return fail(proto.CodeExists, "Proxmox VE already has a storage called "+st.Storage+".")
	case !ok:
		s.storages[host][st.Storage] = key
	}
	return proto.ManageResponse{OK: true}
}
