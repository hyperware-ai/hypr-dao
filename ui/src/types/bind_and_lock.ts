export interface LockDetailsView {
  amount_raw_wei: string;
  amount_formatted_hypr: string;
  unlock_timestamp: number;
  remaining_seconds: number;
}

export interface BalanceView {
  amount_raw_wei: string;
  amount_formatted_hypr: string;
}

export interface BindingView {
  namehash: string;
  name: string | null;
  amount_raw_wei: string;
  amount_formatted_hypr: string;
  unlock_timestamp: number;
  remaining_seconds: number;
}

export interface LockStatusPayload {
  node_id: string;
  owner_address: string | null;
  lock_details: LockDetailsView | null;
  hypr_owned: BalanceView | null;
  hypr_approved: BalanceView | null;
  tokeregistry_allowance: BalanceView | null;
  hypr_token_address: string | null;
  available_to_bind: BalanceView | null;
  bindings: BindingView[];
  error: string | null;
}

export interface BindAndLockState {
  nodeId: string | null;
  isConnected: boolean;
  ownerAddress: string | null;
  lockDetails: LockDetailsView | null;
  hyprOwned: BalanceView | null;
  hyprApproved: BalanceView | null;
  tokeregistryAllowance: BalanceView | null;
  hyprTokenAddress: string | null;
  availableToBind: BalanceView | null;
  bindings: BindingView[];
  lastError: string | null;
  isLoading: boolean;
  error: string | null;
}
