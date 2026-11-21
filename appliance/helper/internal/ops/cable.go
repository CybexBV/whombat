package ops

import (
	"context"
	"path/filepath"

	"github.com/CybexBV/whombat/appliance/helper/pkg/netconfig"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

// The cable operations: Wi-Fi only switches the wired interfaces off, the cable again gives them their usual
// configuration back. A guarded change records what the cable was before it in the helper's state and arms the
// dead-man before anything changes, then stays pending until cable-confirm (kept across restarts) or cable-revert (put
// back); the dead-man puts it back when neither came. An unguarded change (the box was offline anyway, or the cable
// taken back as the backup) is kept at once.

// CableChange is a cable change the helper made and may still undo.
type CableChange struct {
	ID  string `json:"id"`
	Use string `json:"use"`
	// WasOff: the cable was switched off before the change (what an undo puts back).
	WasOff bool `json:"wasOff,omitempty"`
	Armed  bool `json:"armed,omitempty"`
}

// CableEnded is the last change that ended: whether it was kept (a confirm repeated after it ended answers by it).
type CableEnded struct {
	ID   string `json:"id"`
	Kept bool   `json:"kept,omitempty"`
}

// cableDeadmanSlack: the dead-man fires this long after the manager's deadline (which starts once cable-set
// answered, and networkd's reconfiguration takes a few seconds): the manager reverts first when it is alive.
const cableDeadmanSlack = 60

// cableExtra is the interface of a committed wired candidate (it is switched off too), nil without one.
func (h *Helper) cableExtra(st *State) []string {
	if st.Network.Committed == "" || h.cfg.NetworkCandidatesDir == "" {
		return nil
	}
	data, err := readSmall(filepath.Join(h.cfg.NetworkCandidatesDir, st.Network.Committed+".json"), netconfig.MaxBytes)
	if err != nil {
		return nil
	}
	c, err := netconfig.Parse(data)
	if err != nil || c.ID != st.Network.Committed {
		return nil
	}
	return []string{c.Interface}
}

func (h *Helper) cableResult(ctx context.Context, st *State) (*proto.CableResult, *proto.Error) {
	live, committed, err := h.act.CableState(ctx)
	if err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	r := &proto.CableResult{Off: live, CommittedOff: committed}
	if st.Cable.Pending != nil {
		r.Pending = st.Cable.Pending.ID
	}
	return r, nil
}

// cableStatus answers cable-status (read-only, beside other operations: the state file is replaced atomically).
func (h *Helper) cableStatus(ctx context.Context) (*proto.Result, *proto.Error) {
	st, err := loadState(h.cfg.StateDir)
	if err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	r, perr := h.cableResult(ctx, st)
	if perr != nil {
		return nil, perr
	}
	return &proto.Result{Cable: r}, nil
}

// cableSet switches the cable off (use wifi) or on (use cable); guarded with deadlineSec > 0.
func (h *Helper) cableSet(ctx context.Context, st *State, req proto.Request) (*proto.Result, *proto.Error) {
	if p := st.Cable.Pending; p != nil {
		if p.ID != req.ChangeID {
			return nil, fail(proto.CodeCablePending, "cable change %s is still pending; confirm or revert it first", p.ID)
		}
		r, perr := h.cableResult(ctx, st)
		if perr != nil {
			return nil, perr
		}
		return &proto.Result{AlreadyDone: true, Cable: r}, nil
	}
	live, _, err := h.act.CableState(ctx)
	if err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	off := req.Use == proto.CableUseWifi
	extra := h.cableExtra(st)
	c := &CableChange{ID: req.ChangeID, Use: req.Use, WasOff: live}
	if req.DeadlineSec > 0 {
		// Armed and recorded before anything changes: whatever dies below, the cable comes back as it was.
		if err := h.act.ArmCableRevert(ctx, req.DeadlineSec+cableDeadmanSlack); err != nil {
			return nil, fail(proto.CodeActivationFailed, "arm the cable's dead-man: %v", err)
		}
		c.Armed = true
		st.Cable.Pending = c
		if err := saveState(h.cfg.StateDir, st); err != nil {
			_ = h.act.DisarmCableRevert(ctx)
			st.Cable.Pending = nil
			return nil, fail(proto.CodeInternal, "%v", err)
		}
	}
	if err := h.act.SetCable(ctx, off, extra); err != nil {
		h.undoCable(ctx, st, c)
		return nil, fail(proto.CodeActivationFailed, "switch the cable: %v", err)
	}
	if !c.Armed {
		if err := h.act.CommitCable(ctx, off, extra); err != nil {
			h.undoCable(ctx, st, c)
			return nil, fail(proto.CodeActivationFailed, "keep the cable's setting: %v", err)
		}
		st.Cable.Last = &CableEnded{ID: c.ID, Kept: true}
		if err := saveState(h.cfg.StateDir, st); err != nil {
			return nil, fail(proto.CodeInternal, "%v", err)
		}
	}
	r, perr := h.cableResult(ctx, st)
	if perr != nil {
		return nil, perr
	}
	return &proto.Result{Cable: r}, nil
}

// cableConfirm keeps a guarded change across restarts (the manager reached control with it).
func (h *Helper) cableConfirm(ctx context.Context, st *State, id string) (*proto.Result, *proto.Error) {
	p := st.Cable.Pending
	if p == nil {
		if l := st.Cable.Last; l != nil && l.ID == id && l.Kept {
			r, perr := h.cableResult(ctx, st)
			if perr != nil {
				return nil, perr
			}
			return &proto.Result{AlreadyDone: true, Cable: r}, nil
		}
		// Undone already (the dead-man, a revert) or never made: there is nothing of it to keep.
		return nil, fail(proto.CodeCableNotApplied, "cable change %s is not pending", id)
	}
	if p.ID != id {
		return nil, fail(proto.CodeCablePending, "cable change %s is pending, not %s", p.ID, id)
	}
	off := p.Use == proto.CableUseWifi
	live, _, err := h.act.CableState(ctx)
	if err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	if live != off {
		// The box restarted while the change waited: the kept setting came back at the start, and the manager reached
		// control on that one. Keep nothing; the change is over.
		_ = h.act.DisarmCableRevert(ctx)
		st.Cable.Pending, st.Cable.Last = nil, &CableEnded{ID: p.ID}
		_ = saveState(h.cfg.StateDir, st)
		return nil, fail(proto.CodeCableNotApplied, "the cable is not as change %s left it (a restart put it back)", id)
	}
	if err := h.act.CommitCable(ctx, off, h.cableExtra(st)); err != nil {
		return nil, fail(proto.CodeActivationFailed, "keep the cable's setting: %v", err)
	}
	_ = h.act.DisarmCableRevert(ctx)
	st.Cable.Pending, st.Cable.Last = nil, &CableEnded{ID: p.ID, Kept: true}
	if err := saveState(h.cfg.StateDir, st); err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	r, perr := h.cableResult(ctx, st)
	if perr != nil {
		return nil, perr
	}
	return &proto.Result{Cable: r}, nil
}

// cableRevert puts a pending change back (the manager couldn't reach control before the deadline).
func (h *Helper) cableRevert(ctx context.Context, st *State, id string) (*proto.Result, *proto.Error) {
	p := st.Cable.Pending
	if p != nil && p.ID != id {
		return nil, fail(proto.CodeCablePending, "cable change %s is pending, not %s", p.ID, id)
	}
	if p != nil {
		if err := h.putCableBack(ctx, st, p); err != nil {
			// Still pending, its dead-man still armed: the manager asks again.
			return nil, fail(proto.CodeActivationFailed, "put the cable back: %v", err)
		}
	}
	r, perr := h.cableResult(ctx, st)
	if perr != nil {
		return nil, perr
	}
	return &proto.Result{AlreadyDone: p == nil, Cable: r}, nil
}

// undoCable puts the cable back as it was before c when the switch itself failed (best effort; the setting kept across
// restarts was never touched by a guarded change), disarms the dead-man and drops the change.
func (h *Helper) undoCable(ctx context.Context, st *State, c *CableChange) {
	ctx = context.WithoutCancel(ctx)
	_ = h.act.SetCable(ctx, c.WasOff, h.cableExtra(st))
	h.dropCable(ctx, st, c)
}

// putCableBack undoes a pending change (a revert, the dead-man): the change is dropped only once the cable is back as
// it was, so a revert that fails leaves it pending to be tried again instead of saying the cable is back when it isn't.
func (h *Helper) putCableBack(ctx context.Context, st *State, c *CableChange) error {
	ctx = context.WithoutCancel(ctx)
	if err := h.act.SetCable(ctx, c.WasOff, h.cableExtra(st)); err != nil {
		return err
	}
	h.dropCable(ctx, st, c)
	return nil
}

// dropCable disarms c's dead-man and ends it.
func (h *Helper) dropCable(ctx context.Context, st *State, c *CableChange) {
	if c.Armed {
		_ = h.act.DisarmCableRevert(ctx)
	}
	if st.Cable.Pending != nil && st.Cable.Pending.ID == c.ID {
		st.Cable.Pending = nil
		st.Cable.Last = &CableEnded{ID: c.ID}
		_ = saveState(h.cfg.StateDir, st)
	}
}

// RevertCableDeadman is run by the cable's dead-man timer (root, no socket): it undoes the pending change.
func (h *Helper) RevertCableDeadman(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	st, err := loadState(h.cfg.StateDir)
	if err != nil {
		return err
	}
	if st.Cable.Pending == nil {
		return nil
	}
	return h.putCableBack(ctx, st, st.Cable.Pending)
}
