// Entry point for the React application
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
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

const wagmiConfig = getDefaultConfig({
  appName: 'Lock & Bind',
  projectId: 'c6da298e8ee4e4b00ea32cd4c20c40af',
  chains: [base, anvil],
  ssr: false,
  transports: {
    [base.id]: http(),
    [anvil.id]: http(),
  },
});

const queryClient = new QueryClient();

// Create root and render the app
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider initialChain={base.id} modalSize="compact" showRecentTransactions>
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
