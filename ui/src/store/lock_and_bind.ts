// Zustand store for Hyperapp Skeleton state management
import { create } from 'zustand';
import type { LockAndBindState, LockStatusPayload } from '../types/lock_and_bind';
import { getNodeId } from '../types/global';
import { App } from '#caller-utils';

interface LockAndBindStore extends LockAndBindState {
  initialize: () => void;
  fetchLockStatus: () => Promise<void>;
  refreshLockStatus: () => Promise<void>;
  setError: (error: string | null) => void;
  clearError: () => void;
  acknowledgeLockModal: () => Promise<void>;
}

// Create the Zustand store
export const useBindAndLockStore = create<LockAndBindStore>((set, get) => ({
  nodeId: null,
  isConnected: false,
  ownerAddress: null,
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
    const nodeId = getNodeId();
    set({
      nodeId,
      isConnected: nodeId !== null,
    });
    
    if (nodeId) {
      get().fetchLockStatus();
    }
  },

  fetchLockStatus: async () => {
    set({ isLoading: true, error: null });
    try {
      const status = await App.get_lock_status();
      applyStatus(status, set);
    } catch (error) {
      set({
        error: getErrorMessage(error),
        isLoading: false,
      });
    }
  },

  refreshLockStatus: async () => {
    set({ isLoading: true, error: null });
    try {
      const status = await App.refresh_lock_status();
      applyStatus(status, set);
    } catch (error) {
      set({
        error: getErrorMessage(error),
        isLoading: false,
      });
    }
  },

  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  acknowledgeLockModal: async () => {
    try {
      await App.acknowledge_lock_modal();
      set({ lockModalSeen: true });
    } catch (error) {
      set({ error: getErrorMessage(error) });
    }
  },
}));

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown error occurred';
}

function applyStatus(status: LockStatusPayload, set: (updater: Partial<LockAndBindState>) => void) {
  set({
    nodeId: status.node_id,
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
