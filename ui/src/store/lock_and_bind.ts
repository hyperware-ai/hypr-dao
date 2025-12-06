// Zustand store for Hyperapp Skeleton state management
import { create } from 'zustand';
import type { LockAndBindState, LockStatusPayload } from '../types/lock_and_bind';
import { getNodeId } from '../types/global';
import { HyprDao, parseResponse } from '#caller-utils';

// Some hosted environments serve the process under a path prefix, e.g. /hypr-dao:hypr-dao:ware.hypr.
const API_PREFIX =
  typeof window !== 'undefined' && window.location.pathname.includes('hypr-dao:hypr-dao:ware.hypr')
    ? '/hypr-dao:hypr-dao:ware.hypr'
    : '';

interface LockAndBindStore extends LockAndBindState {
  initialize: () => void;
  fetchLockStatus: (address: string) => Promise<void>;
  fetchBaseLockStatus: () => Promise<void>;
  refreshLockStatus: (address: string) => Promise<void>;
  resetWalletState: () => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  acknowledgeLockModal: () => Promise<void>;
}

// Create the Zustand store
export const useBindAndLockStore = create<LockAndBindStore>((set, get) => ({
  nodeId: null,
  isConnected: false,
  ownerAddress: null,
  chainId: null,
  minLockDurationSeconds: null,
  lockDetails: null,
  hyprOwned: null,
  hyprApproved: null,
  tokeregistryAllowance: null,
  hyprTokenAddress: null,
  availableToBind: null,
  bindings: [],
  lastError: null,
  isLoading: false,
  error: null,
  lockModalSeen: false,

  initialize: () => {
    const nodeId = getNodeId() ?? 'web';
    set({
      nodeId,
      isConnected: true,
    });
  },

  fetchLockStatus: async (address: string) => {
    set({ isLoading: true, error: null });
    try {
      const status = await getLockStatusFor(address);
      applyStatus(status, set);
    } catch (error) {
      set({
        error: getErrorMessage(error),
        isLoading: false,
      });
    }
  },

  fetchBaseLockStatus: async () => {
    try {
      const status = await getBaseLockStatus();
      set({
        minLockDurationSeconds: status.min_lock_duration_seconds,
        chainId: status.chain_id,
      });
    } catch (error) {
      // Non-critical: minLockDurationSeconds will fallback in App.tsx
      console.warn('Failed to fetch base lock status:', error);
    }
  },

  refreshLockStatus: async (address: string) => {
    // Keep refresh silent to avoid UI jitter on periodic polls
    set({ error: null });
    try {
      const status = await refreshLockStatusFor(address);
      applyStatus(status, set);
    } catch (error) {
      set({
        error: getErrorMessage(error),
      });
    }
  },

  resetWalletState: () => {
    set({
      ownerAddress: null,
      lockDetails: null,
      hyprOwned: null,
      hyprApproved: null,
      tokeregistryAllowance: null,
      hyprTokenAddress: null,
      availableToBind: null,
      bindings: [],
      lastError: null,
      error: null,
      isLoading: false,
    });
  },

  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  acknowledgeLockModal: async () => {
    try {
      await HyprDao.acknowledge_lock_modal();
      set({ lockModalSeen: true });
    } catch (error) {
      set({ error: getErrorMessage(error) });
    }
  },
}));

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown error occurred';
}

async function getBaseLockStatus(): Promise<LockStatusPayload> {
  const response = await fetch(`${API_PREFIX}/api/get-lock-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ GetLockStatus: null }),
  });
  if (!response.ok) {
    throw new Error(`Failed to get base lock status (status ${response.status})`);
  }
  const json = await response.json();
  return parseResponse<LockStatusPayload>(json);
}

async function getLockStatusFor(address: string): Promise<LockStatusPayload> {
  const response = await fetch(`${API_PREFIX}/api/get-lock-status-for`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ GetLockStatusFor: address }),
  });
  if (!response.ok) {
    throw new Error(`Failed to get lock status (status ${response.status})`);
  }
  const json = await response.json();
  return parseResponse<LockStatusPayload>(json);
}

async function refreshLockStatusFor(address: string): Promise<LockStatusPayload> {
  const response = await fetch(`${API_PREFIX}/api/refresh-lock-status-for`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ RefreshLockStatusFor: address }),
  });
  if (!response.ok) {
    throw new Error(`Failed to refresh lock status (status ${response.status})`);
  }
  const json = await response.json();
  return parseResponse<LockStatusPayload>(json);
}

function applyStatus(status: LockStatusPayload, set: (updater: Partial<LockAndBindState>) => void) {
  set({
    nodeId: status.node_id || 'web',
    ownerAddress: status.owner_address,
    lockDetails: status.lock_details,
    hyprOwned: status.hypr_owned,
    hyprApproved: status.hypr_approved,
    tokeregistryAllowance: status.tokeregistry_allowance,
    hyprTokenAddress: status.hypr_token_address,
    availableToBind: status.available_to_bind,
    bindings: status.bindings ?? [],
    lastError: status.error,
    isLoading: false,
    lockModalSeen: status.lock_modal_seen,
    chainId: status.chain_id,
    minLockDurationSeconds: status.min_lock_duration_seconds,
  });
}

export const useNodeId = () => useBindAndLockStore((state) => state.nodeId);
export const useIsConnected = () => useBindAndLockStore((state) => state.isConnected);
export const useOwnerAddress = () => useBindAndLockStore((state) => state.ownerAddress);
export const useLockDetails = () => useBindAndLockStore((state) => state.lockDetails);
export const useHyprOwned = () => useBindAndLockStore((state) => state.hyprOwned);
export const useHyprApproved = () => useBindAndLockStore((state) => state.hyprApproved);
export const useTokeregistryAllowance = () =>
  useBindAndLockStore((state) => state.tokeregistryAllowance);
export const useHyprTokenAddress = () =>
  useBindAndLockStore((state) => state.hyprTokenAddress);
export const useAvailableToBind = () =>
  useBindAndLockStore((state) => state.availableToBind);
export const useBindings = () => useBindAndLockStore((state) => state.bindings);
export const useLastError = () => useBindAndLockStore((state) => state.lastError);
export const useIsLoading = () => useBindAndLockStore((state) => state.isLoading);
export const useError = () => useBindAndLockStore((state) => state.error);
