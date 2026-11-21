/**
 * React node views: the title block (h1 + provenance line), the plan block and its step rows. Step rows show
 * the live Plan (markers as on the plan card: done, active, queued, gate, blocked, cancelled); their titles are editable text,
 * and editing them edits the Plan through the document (the server turns block edits into Plan changes).
 */

import { NodeViewContent, type NodeViewProps, NodeViewWrapper } from '@tiptap/react';
import { PlanStepState } from '@whombat/core/domain';
import { planStepMarker } from '../planMarker';
import styles from './CanvasEditor.module.css';
import { useCanvasView } from './context';

const STATES: readonly PlanStepState[] = PlanStepState.options;

function asState(value: unknown): PlanStepState {
  return STATES.includes(value as PlanStepState) ? (value as PlanStepState) : 'queued';
}

export function TitleView() {
  const { provenance } = useCanvasView();
  return (
    <NodeViewWrapper className={styles.titleBlock}>
      <NodeViewContent<'h1'> as="h1" className={styles.h1} />
      {provenance && (
        <span className={styles.provenance} contentEditable={false}>
          {provenance}
        </span>
      )}
    </NodeViewWrapper>
  );
}

export function PlanBlockView() {
  return (
    <NodeViewWrapper className={styles.steps} data-type="plan-block">
      <NodeViewContent className={styles.stepList} />
    </NodeViewWrapper>
  );
}

export function PlanStepView({ node }: NodeViewProps) {
  const { plan } = useCanvasView();
  const attrs = node.attrs as {
    stepId: string | null;
    state: unknown;
    stateLabel: unknown;
  };
  // The Plan is the truth for state and label; the block's attributes follow it (server sync). A step is the agent's own
  // work, so no owner shows (one-agent.md AP-4952).
  const live = attrs.stepId ? plan?.steps.find((s) => s.id === attrs.stepId) : undefined;
  const state = live?.state ?? asState(attrs.state);
  const label = live?.stateLabel ?? (typeof attrs.stateLabel === 'string' ? attrs.stateLabel : '');
  const marker = planStepMarker(state);
  return (
    <NodeViewWrapper className={styles.stepRow} data-state={state}>
      <span
        className={styles.stepMarker}
        contentEditable={false}
        aria-hidden="true"
        style={{
          borderRadius: marker.borderRadius,
          borderColor: marker.borderColor,
          background: marker.background,
          transform: marker.transform,
        }}
      />
      <NodeViewContent<'span'>
        as="span"
        className={styles.stepTitle}
        style={{ color: marker.titleColor, textDecoration: marker.titleDecoration }}
      />
      <span className={styles.stepMeta} contentEditable={false}>
        <span className={styles.stepState} style={{ color: marker.stateColor }}>
          {label}
        </span>
      </span>
    </NodeViewWrapper>
  );
}
