package broker

import (
	"net/http"
	"sort"
	"time"

	"github.com/lxc/incus/v6/shared/api"

	"rackoon/internal/proto"
)

// Incus tasks (docs/MANAGE.md 2.5): task.list shows the operations Incus
// runs now (class task: exec and console sessions are not tasks), the
// ones the agent started and keeps for 48 hours (Incus forgets an
// operation 5 s after it ends), and the failed operations of the last 48
// hours the collector reports. task.stop cancels an operation that says
// it may be cancelled.

// taskList lists the host's Incus tasks, or one guest's, newest first.
func (d *incusDriver) taskList(g *proto.Guest) proto.ManageResponse {
	c, err := d.server()
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	ops, err := c.GetOperationsAllProjects()
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	byID := map[string]proto.TaskStatus{}
	cutoff := time.Now().Add(-incusTaskKeep)
	for _, st := range d.tasks.all() {
		byID[st.ID] = st
	}
	if d.inv != nil {
		if r := d.inv(); r != nil && r.Incus != nil {
			for _, t := range r.Incus.Tasks {
				id := "incus:" + t.UPID
				if _, ok := byID[id]; ok || (t.End != nil && t.End.Before(cutoff)) {
					continue
				}
				byID[id] = proto.TaskStatus{ID: id, Type: t.Type, GuestID: t.ID, Started: t.Start, Ended: t.End,
					Status: "error", Message: t.Status}
			}
		}
	}
	for _, op := range ops {
		if op.Class != "task" {
			continue
		}
		st := incusTaskStatus(op)
		if known, ok := byID[st.ID]; ok && known.GuestID != "" && st.GuestID == "" {
			st.GuestID = known.GuestID
		}
		byID[st.ID] = st
	}
	out := []proto.TaskStatus{}
	for _, st := range byID {
		if g != nil && st.GuestID != g.ID {
			continue
		}
		if st.Ended != nil && st.Ended.Before(cutoff) {
			continue
		}
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Started.Equal(out[j].Started) {
			return out[i].Started.After(out[j].Started)
		}
		return out[i].ID < out[j].ID
	})
	return proto.ManageResponse{OK: true, Tasks: out}
}

// taskStop cancels a running operation that may be cancelled.
func (d *incusDriver) taskStop(req proto.ManageRequest) proto.ManageResponse {
	m := incusTaskRE.FindStringSubmatch(req.Task)
	if m == nil {
		return incusFieldError(proto.CodeInvalidValue, "task", "not an Incus task id (incus:<operation uuid>)")
	}
	c, err := d.server()
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	op, _, err := c.GetOperation(m[1])
	if err != nil {
		if api.StatusErrorCheck(err, http.StatusNotFound) {
			if st, ok := d.tasks.get(req.Task); ok && st.Status != "running" {
				return proto.ManageResponse{OK: true} // already over
			}
			return proto.ManageResponse{Code: proto.CodeNotFound, Message: "Incus has no running task " + m[1]}
		}
		return incusFail(err, proto.CodeNotFound)
	}
	if op.StatusCode.IsFinal() {
		return proto.ManageResponse{OK: true}
	}
	if !op.MayCancel {
		return proto.ManageResponse{Code: proto.CodeNotAllowed, Message: "Incus cannot stop this task while it runs"}
	}
	if err := c.DeleteOperation(m[1]); err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	d.tasks.lost(req.Task, "stopped")
	return proto.ManageResponse{OK: true}
}
