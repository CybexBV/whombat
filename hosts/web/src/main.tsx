import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/charts.css';
import './styles/shell.css';
import './styles/fleet.css';
import './styles/server.css';
import './styles/forms.css';
import './styles/console.css';
import './styles/admin.css';
import './styles/guests.css';
import './styles/accounts.css';
import './styles/lifecycle.css';
import './styles/assistant.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
