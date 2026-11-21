package model

import "rackoon/internal/proto"

// BackupPlace is a server's "backup_place" (server detail and list;
// docs/REST-API.md "Backup places"): whether it can keep Whombats'
// backups, its space and addresses, and the Whombats it keeps backups
// for. nil (JSON null) for an agent that doesn't report it.
type BackupPlace struct {
	Supported  bool                `json:"supported"`
	Reason     string              `json:"reason"`
	Platform   string              `json:"platform"`
	Root       string              `json:"root"`
	FreeBytes  *uint64             `json:"free_bytes"`
	TotalBytes *uint64             `json:"total_bytes"`
	Addresses  []string            `json:"addresses"`
	NFS        bool                `json:"nfs"`
	Clients    []BackupPlaceClient `json:"clients"`
	// Locations: where on the server the backups can live (empty from an
	// agent that can't move them).
	Locations []BackupPlaceLocation `json:"locations"`
}

// BackupPlaceLocation is a place on the server for backups: Unraid's
// dedicated share whombat-backups (is_new until it is made), another
// user share (its folder "whombat"), or a Linux server's
// /srv/whombat-backups ("srv").
type BackupPlaceLocation struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	FreeBytes *uint64 `json:"free_bytes"`
	IsNew     bool    `json:"is_new"`
	SMB       string  `json:"smb"`
	NFS       bool    `json:"nfs"`
	Primary   string  `json:"primary"`
	Path      string  `json:"path"`
}

// BackupPlaceClient is one Whombat's backups on the place.
type BackupPlaceClient struct {
	Client    string             `json:"client"`
	Location  string             `json:"location"`
	Port      int                `json:"port"`
	Running   bool               `json:"running"`
	Image     string             `json:"image"`
	UsedBytes *uint64            `json:"used_bytes"`
	Cleanup   BackupPlaceCleanup `json:"cleanup"`
	// Kit: its REST server has the kit user and /kit/; null from an agent
	// that doesn't give REST servers one (Whombat asks for an ensure again
	// once it is updated).
	Kit *bool `json:"kit"`
}

// BackupPlaceCleanup is the weekly cleanup of a Whombat's old backups.
type BackupPlaceCleanup struct {
	Set            bool    `json:"set"`
	Running        bool    `json:"running"`
	KeepWithinDays int     `json:"keep_within_days"`
	LastRunAt      *string `json:"last_run_at"`
	LastOK         *bool   `json:"last_ok"`
	LastError      string  `json:"last_error"`
	// Keep: "<all>,<daily>,<weekly days>,<monthly months>,<limit bytes>" ("" from before, HS-251).
	Keep      string `json:"keep"`
	OverLimit bool   `json:"over_limit"`
}

// BuildBackupPlace converts the report's place (nil stays nil).
func BuildBackupPlace(r *proto.Report) *BackupPlace {
	if r == nil || r.BackupPlace == nil {
		return nil
	}
	p := r.BackupPlace
	out := &BackupPlace{Supported: p.Supported, Reason: p.Reason, Platform: p.Platform, Root: p.Root,
		FreeBytes: p.FreeBytes, TotalBytes: p.TotalBytes, Addresses: append([]string{}, p.Addresses...), NFS: p.NFS,
		Clients: []BackupPlaceClient{}, Locations: []BackupPlaceLocation{}}
	if out.Supported {
		out.Reason = ""
	}
	for _, c := range p.Clients {
		bc := BackupPlaceClient{Client: c.Client, Location: c.Location, Port: c.Port, Running: c.Running, Image: c.Image, UsedBytes: c.UsedBytes,
			Kit: c.Kit,
			Cleanup: BackupPlaceCleanup{Set: c.Cleanup.Set, Running: c.Cleanup.Running, KeepWithinDays: c.Cleanup.KeepWithinDays,
				LastOK: c.Cleanup.LastOK, LastError: c.Cleanup.LastError, Keep: c.Cleanup.Keep, OverLimit: c.Cleanup.OverLimit}}
		if c.Cleanup.LastRunAt != nil {
			s := c.Cleanup.LastRunAt.UTC().Format("2006-01-02T15:04:05Z")
			bc.Cleanup.LastRunAt = &s
		}
		out.Clients = append(out.Clients, bc)
	}
	for _, l := range p.Locations {
		out.Locations = append(out.Locations, BackupPlaceLocation{ID: l.ID, Name: l.Name, FreeBytes: l.FreeBytes, IsNew: l.IsNew,
			SMB: l.SMB, NFS: l.NFS, Primary: l.Primary, Path: l.Path})
	}
	return out
}
