package activator

import (
	"encoding/json"
	"fmt"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

// schemaCheckJSON is the subset of whombat.schema-check/1 the helper reports.
type schemaCheckJSON struct {
	Format  string `json:"format"`
	Verdict string `json:"verdict"`
	Access  string `json:"access"`
	Binary  struct {
		Version int `json:"version"`
	} `json:"binary"`
	Database struct {
		Version int `json:"version"`
	} `json:"database"`
	Pending         []string `json:"pending"`
	NeedsCheckpoint []string `json:"needsCheckpoint"`
	// Target: since Whombat MD-12; absent or null before.
	Target *struct {
		Version *int `json:"version"`
		Readers *int `json:"readers"`
		Writers *int `json:"writers"`
	} `json:"target"`
	Reason string `json:"reason"`
	Action string `json:"action"`
	Error  *struct {
		Kind       string   `json:"kind"`
		Message    string   `json:"message"`
		Migrations []string `json:"migrations"`
	} `json:"error"`
}

type migrateJSON struct {
	Format  string           `json:"format"`
	OK      bool             `json:"ok"`
	Applied []string         `json:"applied"`
	Check   *schemaCheckJSON `json:"check"`
	Error   *struct {
		Kind       string   `json:"kind"`
		Message    string   `json:"message"`
		Migrations []string `json:"migrations"`
	} `json:"error"`
}

func fromCheck(c *schemaCheckJSON, s *proto.Schema) {
	s.Verdict, s.Access, s.Reason, s.Action = c.Verdict, c.Access, c.Reason, c.Action
	s.DatabaseVersion, s.BinaryVersion = c.Database.Version, c.Binary.Version
	s.Pending, s.NeedsCheckpoint = c.Pending, c.NeedsCheckpoint
	s.Target = nil
	// Only a complete and consistent target is passed on (floors never above the schema, readers never above
	// writers); anything else counts as not reported, which keeps the manager's tuple-only check.
	if t := c.Target; t != nil && t.Version != nil && t.Readers != nil && t.Writers != nil &&
		0 <= *t.Readers && *t.Readers <= *t.Writers && *t.Writers <= *t.Version {
		s.Target = &proto.SchemaTarget{Version: *t.Version, Readers: *t.Readers, Writers: *t.Writers}
	}
}

// ParseSchemaCheck converts CLI output + exit code into the typed answer.
func ParseSchemaCheck(stdout []byte, exit int) (*proto.Schema, error) {
	var c schemaCheckJSON
	if err := json.Unmarshal(stdout, &c); err != nil || c.Format != "whombat.schema-check/1" {
		return nil, fmt.Errorf("unexpected schema-check output (exit %d): %v", exit, err)
	}
	s := &proto.Schema{Exit: exit, OK: exit == proto.SchemaExitOK}
	if c.Error != nil {
		s.ErrorKind, s.Reason = c.Error.Kind, c.Error.Message
		return s, nil
	}
	fromCheck(&c, s)
	return s, nil
}

// ParseMigrate converts `whombat migrate --json` output + exit code into the typed answer.
func ParseMigrate(stdout []byte, exit int) (*proto.Schema, error) {
	var m migrateJSON
	if err := json.Unmarshal(stdout, &m); err != nil || m.Format != "whombat.migrate/1" {
		return nil, fmt.Errorf("unexpected migrate output (exit %d): %v", exit, err)
	}
	s := &proto.Schema{Exit: exit, OK: m.OK && exit == proto.SchemaExitOK, Applied: m.Applied}
	if m.Check != nil {
		fromCheck(m.Check, s)
	}
	if m.Error != nil {
		s.ErrorKind, s.Reason = m.Error.Kind, m.Error.Message
		if len(m.Error.Migrations) > 0 {
			s.NeedsCheckpoint = m.Error.Migrations
		}
	}
	return s, nil
}
