import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { Button } from '../Button';
import { useToast } from './Toast';

const meta = {
  title: 'Primitives/Toast',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function ExportButton() {
  const toast = useToast();
  return (
    <div style={{ padding: 40 }}>
      <Button variant="secondary" size="xl" onClick={() => toast.show('Exported 14 signed events as CSV.')}>
        Export CSV
      </Button>
    </div>
  );
}

/** Click to show; auto-dismisses after 2.6s. */
export const Triggered: Story = { render: () => <ExportButton /> };

function StickyToast() {
  const toast = useToast();
  useEffect(() => {
    toast.show('Exported 14 signed events as CSV.', { duration: null });
  }, [toast]);
  return <div style={{ height: '100vh' }} />;
}

/** Stays visible (for visual comparison with the reference). */
export const Visible: Story = { render: () => <StickyToast /> };
