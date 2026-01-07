// Entry point for the React application
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ClaimPage from './ClaimPage.tsx';
import './index.css';
import '@rainbow-me/rainbowkit/styles.css';

import { Buffer } from 'buffer';
import { WagmiProvider, http } from 'wagmi';
import { RainbowKitProvider, getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base, anvil } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

if (!(window as { Buffer?: typeof Buffer }).Buffer) {
  (window as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

const simulationMode =
  import.meta.env.VITE_SIMULATION_MODE === 'true' || import.meta.env.MODE === 'development';
const chains = simulationMode ? ([anvil] as const) : ([base] as const);
const transports: { [chainId: number]: ReturnType<typeof http> } = simulationMode
  ? { [anvil.id]: http() }
  : { [base.id]: http() };

const wagmiConfig = getDefaultConfig({
  appName: 'Lock & Bind',
  projectId: 'c6da298e8ee4e4b00ea32cd4c20c40af',
  chains,
  ssr: false,
  transports,
});

const queryClient = new QueryClient();

const renderClaimPage =
  typeof window !== 'undefined' && window.location.pathname.split('/').pop() === 'claim';

// Create root and render the app
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          initialChain={simulationMode ? anvil.id : base.id}
          modalSize="compact"
          showRecentTransactions
        >
          {renderClaimPage ? <ClaimPage /> : <App />}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
