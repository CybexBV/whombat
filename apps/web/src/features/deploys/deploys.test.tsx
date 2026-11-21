import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/renderApp';
import { howText, previousText, versionText } from './deploysModel';

describe('Deploys (WE-17, AP-850)', () => {
  it('shows what runs where: the live version, a newer failed attempt and the previous one', async () => {
    renderApp('/deploys');
    expect(await screen.findByRole('heading', { name: 'Deploys', level: 1 })).toBeTruthy();
    const production = await screen.findByRole('region', { name: 'production' });
    const api = within(production).getByText('api').closest('[data-deploy-service]') as HTMLElement;
    expect(within(api).getByText('7be20f · main')).toBeTruthy();
    expect(within(api).getByText('FAILED')).toBeTruthy();
    expect(within(api).getByText(/The migration step timed out/)).toBeTruthy();
    expect(within(api).getByText('Previous 2a6e0c · main')).toBeTruthy();
    expect(within(api).getByRole('link', { name: /^Open/ }).getAttribute('href')).toBe(
      'https://api.lumio.example',
    );
    const web = within(production).getByText('web').closest('[data-deploy-service]') as HTMLElement;
    expect(within(web).getByText('DEPLOYED')).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'staging' })).toBeTruthy();
  });

  it('lists the history newest first, by environment', async () => {
    const user = userEvent.setup();
    renderApp('/deploys');
    const history = await screen.findByRole('region', { name: 'HISTORY' });
    await waitFor(() => expect(history.querySelectorAll('[data-deployment]')).toHaveLength(5));
    expect(within(history).getByText('Deploy of api to production failed · 9b1e4c')).toBeTruthy();
    await user.click(within(history).getByRole('button', { name: 'staging' }));
    await waitFor(() => expect(history.querySelectorAll('[data-deployment]')).toHaveLength(1));
    expect(within(history).getByText('Deployed api to staging · 7be20f')).toBeTruthy();
  });

  it('opens from its old address and the Work links the servers send (AP-851)', async () => {
    const app = renderApp('/work/deploys');
    await waitFor(() => expect(app.location()).toBe('/deploys'));
    expect(await screen.findByRole('heading', { name: 'Deploys', level: 1 })).toBeTruthy();
    const old = renderApp('/burrow-hq/work/deploys');
    await waitFor(() => expect(old.location()).toBe('/deploys'));
  });

  it('says versions, how and the previous version in the board’s words', () => {
    expect(versionText({ sha: '7be20f3a9c1d4e8b2f6a', ref: 'main' })).toBe('7be20f · main');
    expect(versionText({ sha: null, ref: null })).toBe('—');
    expect(howText({ how: 'ssh', ref: null })).toBe('SSH');
    expect(previousText(null)).toBeNull();
  });
});
