package update

import (
	"context"
	"errors"
	"fmt"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
)

// Delta downloads (UP-X14): every component is delivered as its closure index plus the blobs of the store paths the
// box lacks. The plan is derived again in every step that needs it (Assigned for the space check,
// Downloading for the downloads) from the staged index and the helper's answer, so it is idempotent across crashes
// and restarts: blobs already staged are skipped, paths the helper imported meanwhile are no longer missing.

// planError is a planning failure that is a verdict on the candidate (a failure with this code), not a transient one.
type planError struct {
	code string
	err  error
}

func (p *planError) Error() string { return p.err.Error() }
func (p *planError) Unwrap() error { return p.err }

// unitPlan is one component's part of the plan.
type unitPlan struct {
	index   trust.Artifact
	paths   int
	missing int
	bytes   int64 // blob bytes still to download
}

// plan returns the files the candidate needs in staging: per component its index and the blobs of the paths the store
// lacks. It downloads the (small) indexes it needs to read. Transient failures (network,
// helper unreachable) are returned as they are; a corrupt index as *planError.
func (e *Engine) plan(ctx context.Context, c *Candidate) ([]trust.Artifact, []unitPlan, error) {
	var arts []trust.Artifact
	var plans []unitPlan
	for _, ia := range c.Release.Indexes(c.Class == ClassHost) {
		arts = append(arts, ia)
		if !e.Staging.Present(ia) {
			if err := e.Staging.Download(ctx, ia); err != nil {
				if errors.Is(err, trust.ErrArtifact) {
					return nil, nil, &planError{code: "download_corrupt", err: err}
				}
				return nil, nil, err
			}
		}
		b, err := e.Staging.ReadStaged(ia)
		if err != nil {
			return nil, nil, err
		}
		ci, err := trust.ParseClosureIndex(b, ia)
		if err != nil {
			return nil, nil, &planError{code: "download_corrupt", err: err}
		}
		res, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpMissingPaths, StorePaths: ci.StorePaths()})
		if err != nil {
			return nil, nil, fmt.Errorf("missing-paths: %w", err)
		}
		missing := make(map[string]bool, len(res.Missing))
		for _, p := range res.Missing {
			missing[p] = true
		}
		up := unitPlan{index: ia, paths: len(ci.Paths)}
		for i, p := range ci.Paths {
			if !missing[p.StorePath] {
				continue
			}
			up.missing++
			blob := ci.Blob(i)
			arts = append(arts, blob)
			if !e.Staging.Present(blob) {
				up.bytes += blob.Length
			}
		}
		plans = append(plans, up)
	}
	return arts, plans, nil
}

// logPlan writes one line per component: what is left to download.
func (e *Engine) logPlan(c *Candidate, plans []unitPlan) {
	for _, p := range plans {
		e.log().Info("update component", "release", c.Tuple.ReleaseID, "component", p.index.Meta.StorePath,
			"paths", p.paths, "missing", p.missing, "bytes", p.bytes)
	}
}

// planFailure turns a planning error into the step's outcome: a failure for a verdict, a retry for the rest.
func (e *Engine) planFailure(st *State, stage Phase, err error) (bool, error) {
	var pe *planError
	switch {
	case errors.As(err, &pe):
		return true, e.fail(st, &Failure{Stage: stage, Code: pe.code, Message: pe.Error(), CountsAttempt: true})
	case errors.Is(err, errNoSpace):
		return true, e.fail(st, &Failure{Stage: stage, Code: "no_space", Message: err.Error(), NextRetry: e.now().Add(e.Policy.NoSpaceRetry)})
	}
	e.log().Warn("update plan failed; will retry", "err", err)
	return false, nil
}
