import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { base, anvil } from 'wagmi/chains';
import {
  BaseError,
  ContractFunctionRevertedError,
  concatHex,
  keccak256,
  parseEther,
  stringToBytes,
} from 'viem';
import './App.css';
import { useBindAndLockStore } from './store/bind_and_lock';

const TOKEN_REGISTRY_ADDRESSES: Record<number, `0x${string}`> = {
  [base.id]: '0x0000000000e8d224B902632757d5dbc51a451456',
  [anvil.id]: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
};

const tokenRegistryAbi = [
  {
    type: 'function',
    name: 'manageLock',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'duration', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'error',
    name: 'InvalidDuration',
    inputs: [
      { name: 'duration', type: 'uint256' },
      { name: 'minDuration', type: 'uint256' },
      { name: 'maxDuration', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'transferRegistration',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'srcNamehash', type: 'bytes32' },
      { name: 'dstNamehash', type: 'bytes32' },
      { name: 'maxAmount', type: 'uint256' },
      { name: 'duration', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const erc20ApproveAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const MIN_LOCK_DURATION_SECONDS = 4 * 7 * 24 * 60 * 60; // 4 weeks
const MAX_LOCK_DURATION_SECONDS = 4 * 52 * 7 * 24 * 60 * 60; // ~4 years
const ZERO_NAMEHASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

function App() {
  const [amountInput, setAmountInput] = useState('');
  const [durationInput, setDurationInput] = useState('');
  const [manageError, setManageError] = useState<string | null>(null);
  const [srcNameInput, setSrcNameInput] = useState('');
  const [dstNameInput, setDstNameInput] = useState('');
  const [transferAmountInput, setTransferAmountInput] = useState('');
  const [transferDurationInput, setTransferDurationInput] = useState('');
  const [transferError, setTransferError] = useState<string | null>(null);
  const [allowanceInput, setAllowanceInput] = useState('');
  const [allowanceError, setAllowanceError] = useState<string | null>(null);

  const {
    nodeId,
    isConnected,
    ownerAddress,
    lockDetails,
    hyprOwned,
    hyprApproved,
    tokeregistryAllowance,
    hyprTokenAddress,
    availableToBind,
    bindings,
    lastError,
    isLoading,
    error,
    initialize,
    fetchLockStatus,
    refreshLockStatus,
    clearError,
  } = useBindAndLockStore();
  const { address, chain, isConnected: isWalletConnected } = useAccount();

  const targetRegistryAddress = useMemo(() => {
    if (chain?.id && TOKEN_REGISTRY_ADDRESSES[chain.id]) {
      return TOKEN_REGISTRY_ADDRESSES[chain.id];
    }
    // default to base mainnet address
    return TOKEN_REGISTRY_ADDRESSES[base.id];
  }, [chain?.id]);

  const {
    data: txHash,
    error: writeError,
    isPending: isWritePending,
    writeContract,
  } = useWriteContract();
  const {
    data: transferTxHash,
    error: transferWriteError,
    isPending: isTransferPending,
    writeContract: writeTransferContract,
  } = useWriteContract();
  const {
    data: approveTxHash,
    error: approveWriteError,
    isPending: isApprovePending,
    writeContract: writeApproveContract,
  } = useWriteContract();

  const {
    isLoading: isConfirming,
    isSuccess: isConfirmed,
  } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (!isConnected) return;

    const interval = setInterval(() => {
      fetchLockStatus();
    }, 30_000);

    return () => clearInterval(interval);
  }, [isConnected, fetchLockStatus]);

  useEffect(() => {
    if (writeError) {
      setManageError(writeError.message ?? 'Failed to start transaction.');
    }
  }, [writeError]);

  useEffect(() => {
    if (transferWriteError) {
      setTransferError(transferWriteError.message ?? 'Failed to start transaction.');
    }
  }, [transferWriteError]);

  useEffect(() => {
    if (approveWriteError) {
      setAllowanceError(approveWriteError.message ?? 'Failed to start transaction.');
    }
  }, [approveWriteError]);

  useEffect(() => {
    if (isConfirmed) {
      setAmountInput('');
      setDurationInput('');
      refreshLockStatus();
    }
  }, [isConfirmed, refreshLockStatus]);

  const {
    isLoading: isTransferConfirming,
    isSuccess: isTransferConfirmed,
  } = useWaitForTransactionReceipt({
    hash: transferTxHash,
  });

  const {
    isLoading: isApproveConfirming,
    isSuccess: isApproveConfirmed,
  } = useWaitForTransactionReceipt({
    hash: approveTxHash,
  });

  useEffect(() => {
    if (isTransferConfirmed) {
      setTransferAmountInput('');
      setTransferDurationInput('');
      setSrcNameInput('');
      setDstNameInput('');
      refreshLockStatus();
    }
  }, [isTransferConfirmed, refreshLockStatus]);

  useEffect(() => {
    if (isApproveConfirmed) {
      setAllowanceInput('');
      refreshLockStatus();
    }
  }, [isApproveConfirmed, refreshLockStatus]);

  const handleManageLock = async (event: FormEvent) => {
    event.preventDefault();
    setManageError(null);

    if (!isWalletConnected || !address) {
      setManageError('Please connect a wallet to manage locks.');
      return;
    }

    if (!amountInput || Number(amountInput) <= 0) {
      setManageError('Enter a positive HYPR amount.');
      return;
    }

    if (!durationInput || Number(durationInput) <= 0) {
      setManageError('Enter a positive duration in seconds.');
      return;
    }

    try {
      const amountWei = parseEther(amountInput);
      const durationSeconds = BigInt(durationInput);
      const approvedWei = hyprApproved ? BigInt(hyprApproved.amount_raw_wei) : null;

      if (durationSeconds < BigInt(MIN_LOCK_DURATION_SECONDS)) {
        setManageError(`Duration must be at least ${formatDurationSeconds(MIN_LOCK_DURATION_SECONDS)}.`);
        return;
      }
      if (durationSeconds > BigInt(MAX_LOCK_DURATION_SECONDS)) {
        setManageError(`Duration must be less than or equal to ${formatDurationSeconds(MAX_LOCK_DURATION_SECONDS)}.`);
        return;
      }
      if (approvedWei !== null && amountWei > approvedWei) {
        setManageError('Amount exceeds HYPR approved for locking.');
        return;
      }

      await writeContract({
        address: targetRegistryAddress,
        abi: tokenRegistryAbi,
        functionName: 'manageLock',
        args: [amountWei, durationSeconds],
      });
    } catch (err) {
      const friendly = decodeManageLockError(err);
      setManageError(friendly);
    }
  };

  const handleTransferRegistration = async (event: FormEvent) => {
    event.preventDefault();
    setTransferError(null);

    if (!isWalletConnected || !address) {
      setTransferError('Please connect a wallet to transfer registrations.');
      return;
    }

    if (!dstNameInput.trim()) {
      setTransferError('Destination name is required.');
      return;
    }
    if (!transferAmountInput || Number(transferAmountInput) <= 0) {
      setTransferError('Enter a positive HYPR amount to transfer.');
      return;
    }
    if (!transferDurationInput || Number(transferDurationInput) < MIN_LOCK_DURATION_SECONDS) {
      setTransferError(`Duration must be at least ${formatDurationSeconds(MIN_LOCK_DURATION_SECONDS)}.`);
      return;
    }

    try {
      const srcHash = resolveNamehash(srcNameInput);
      const dstHash = resolveNamehash(dstNameInput);
      if (dstHash === ZERO_NAMEHASH) {
        setTransferError('Destination cannot be the default registration.');
        return;
      }

      const maxAmountWei = parseEther(transferAmountInput);
      const durationSeconds = BigInt(transferDurationInput);

      await writeTransferContract({
        address: targetRegistryAddress,
        abi: tokenRegistryAbi,
        functionName: 'transferRegistration',
        args: [srcHash, dstHash, maxAmountWei, durationSeconds],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to submit transaction.';
      setTransferError(message);
    }
  };

  const handleSetAllowance = async (event: FormEvent) => {
    event.preventDefault();
    setAllowanceError(null);

    if (!isWalletConnected || !address) {
      setAllowanceError('Please connect a wallet to set allowance.');
      return;
    }

    if (!hyprTokenAddress) {
      setAllowanceError('HYPR token address unavailable.');
      return;
    }

    if (!allowanceInput && allowanceInput !== '0') {
      setAllowanceError('Enter an allowance amount.');
      return;
    }

    const allowanceValue = Number(allowanceInput);
    if (Number.isNaN(allowanceValue) || allowanceValue < 0) {
      setAllowanceError('Enter a non-negative allowance.');
      return;
    }

    try {
      const amountWei = parseEther(allowanceInput || '0');
      if (hyprOwned) {
        const ownedWei = BigInt(hyprOwned.amount_raw_wei);
        if (amountWei > ownedWei) {
          setAllowanceError('Allowance cannot exceed wallet HYPR balance.');
          return;
        }
      }
      await writeApproveContract({
        address: hyprTokenAddress as `0x${string}`,
        abi: erc20ApproveAbi,
        functionName: 'approve',
        args: [targetRegistryAddress, amountWei],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to submit transaction.';
      setAllowanceError(message);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-top">
          <h1 className="app-title">🔐 Bind & Lock</h1>
          <ConnectButton chainStatus="icon" showBalance={false} />
        </div>
        <div className="node-info">
          {isConnected ? (
            <>
              Connected as <span className="node-id">{nodeId}</span>
            </>
          ) : (
            <span className="not-connected">Not connected to Hyperware</span>
          )}
        </div>
      </header>

      {error && (
        <div className="error error-message">
          {error}
          <button onClick={clearError} style={{ marginLeft: '1rem' }}>
            Dismiss
          </button>
        </div>
      )}

      {isConnected && (
        <>
        <section className="section">
          <h2 className="section-title">Lock Details</h2>
          <p>The app reads on-chain lock data for this node’s owner.</p>

          <div className="card">
            <div className="row">
              <span className="label">Node ID</span>
              <span>{nodeId}</span>
            </div>
            <div className="row">
              <span className="label">Owner Address</span>
              <span>{ownerAddress ?? 'Resolving...'}</span>
            </div>

            {lockDetails ? (
              <>
                <div className="row">
                  <span className="label">Locked amount</span>
                  <span>
                    {lockDetails.amount_formatted_hypr}
                    <br />
                    <small>{lockDetails.amount_raw_wei} wei</small>
                  </span>
                </div>
                <div className="row">
                  <span className="label">Unlock Timestamp</span>
                  <span>{formatTimestamp(lockDetails.unlock_timestamp)}</span>
                </div>
                <div className="row">
                  <span className="label">Remaining Seconds</span>
                  <span>{lockDetails.remaining_seconds.toLocaleString()}</span>
                </div>
              </>
            ) : (
              <p>No lock data found for this account.</p>
            )}

            {lastError && (
              <div className="error inline-error">{lastError}</div>
            )}

            <button onClick={refreshLockStatus} disabled={isLoading} className="primary-button">
              {isLoading ? <span className="spinner" /> : 'Refresh'}
            </button>
          </div>
        </section>

        <section className="section">
          <h2 className="section-title">Bindings List</h2>
          <p>Each active registration and the HYPR bound to it.</p>
          <div className="card summary-card">
            <div className="row">
              <span className="label">Available HYPR to bind</span>
              <span>{availableToBind ? availableToBind.amount_formatted_hypr : '0 HYPR'}</span>
            </div>
          </div>

          <div className="card bindings-list">
            {bindings.length === 0 ? (
              <p>No bindings found.</p>
            ) : (
              bindings.map((binding) => (
                <div className="binding-row" key={binding.namehash}>
                  <div className="row">
                    <span className="label">Name</span>
                    <span>{binding.name ?? 'Unknown'}</span>
                  </div>
                  <div className="row">
                    <span className="label">Namehash</span>
                    <span className="mono">{binding.namehash}</span>
                  </div>
                  <div className="row">
                    <span className="label">Amount</span>
                    <span>
                      {binding.amount_formatted_hypr}
                      <br />
                      <small>{binding.amount_raw_wei} wei</small>
                    </span>
                  </div>
                  <div className="row">
                    <span className="label">Unlock Timestamp</span>
                    <span>{formatTimestamp(binding.unlock_timestamp)}</span>
                  </div>
                  <div className="row">
                    <span className="label">Remaining Seconds</span>
                    <span>{binding.remaining_seconds.toLocaleString()}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="section">
          <h2 className="section-title">Set Lockable Allowance</h2>
          <p>Approve how much HYPR the TokenRegistry contract may use for locks.</p>

          <form className="card manage-lock-form" onSubmit={handleSetAllowance}>
            <div className="row">
              <span className="label">HYPR owned by account</span>
              <span>{hyprOwned ? hyprOwned.amount_formatted_hypr : 'Loading...'}</span>
            </div>
            <div className="row">
              <span className="label">Current lockable allowance</span>
              <span>{tokeregistryAllowance ? tokeregistryAllowance.amount_formatted_hypr : 'Loading...'}</span>
            </div>
            <div className="row">
              <label className="label" htmlFor="allowanceInput">
                New allowance (HYPR)
              </label>
              <input
                id="allowanceInput"
                type="number"
                min="0"
                step="0.000000000000000001"
                placeholder="100.0"
                value={allowanceInput}
                onChange={(e) => setAllowanceInput(e.target.value)}
              />
            </div>

            {allowanceError && <div className="error inline-error">{allowanceError}</div>}
            {(isApprovePending || isApproveConfirming) && (
              <div className="info inline-info">Submitting approval transaction…</div>
            )}
            {isApproveConfirmed && approveTxHash && (
              <div className="success inline-success">
                Allowance updated! Tx {approveTxHash.slice(0, 8)}…{approveTxHash.slice(-6)}
              </div>
            )}

            <button
              type="submit"
              className="primary-button"
              disabled={!isWalletConnected || isApprovePending || isApproveConfirming || !hyprTokenAddress}
            >
              {isApprovePending || isApproveConfirming ? <span className="spinner" /> : 'Set new allowance'}
            </button>
          </form>
        </section>

        <section className="section">
          <h2 className="section-title">Manage Lock</h2>
          <p>Use your connected wallet to create or extend a lock via TokenRegistry.</p>

          <form className="card manage-lock-form" onSubmit={handleManageLock}>
            <div className="row">
              <span className="label">HYPR owned by account</span>
              <span>{hyprOwned ? hyprOwned.amount_formatted_hypr : 'Loading...'}</span>
            </div>
            <div className="row">
              <span className="label">Lockable HYPR available</span>
              <span>
                {hyprApproved ? hyprApproved.amount_formatted_hypr : 'Loading...'}
                <br />
                <small>(Lockable balance, less any HYPR already locked)</small>
              </span>
            </div>
            <div className="row">
              <label className="label" htmlFor="amountInput">
                HYPR Amount
              </label>
              <input
                id="amountInput"
                type="number"
                min="0"
                step="0.000000000000000001"
                placeholder="1.0"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
              />
            </div>

            <div className="row">
              <label className="label" htmlFor="durationInput">
                Duration (seconds)
              </label>
              <input
                id="durationInput"
                type="number"
                min={MIN_LOCK_DURATION_SECONDS}
                max={MAX_LOCK_DURATION_SECONDS}
                step="1"
                placeholder={MIN_LOCK_DURATION_SECONDS.toString()}
                value={durationInput}
                onChange={(e) => setDurationInput(e.target.value)}
              />
            </div>

            {manageError && <div className="error inline-error">{manageError}</div>}
            {(isWritePending || isConfirming) && (
              <div className="info inline-info">Waiting for wallet confirmation and on-chain receipt…</div>
            )}
            {isConfirmed && txHash && (
              <div className="success inline-success">
                Lock updated! Tx {txHash.slice(0, 8)}…{txHash.slice(-6)}
              </div>
            )}

            <button
              type="submit"
              className="primary-button"
              disabled={!isWalletConnected || isWritePending || isConfirming}
            >
              {isWritePending || isConfirming ? <span className="spinner" /> : 'Submit'}
            </button>
          </form>
        </section>

        <section className="section">
          <h2 className="section-title">Manage Bindings</h2>
          <p>Move locked HYPR from one Hypermap entry to another.</p>

          <form className="card manage-lock-form" onSubmit={handleTransferRegistration}>
            <div className="row">
              <label className="label" htmlFor="srcNameInput">
                Source Hypermap name (blank for Available HYPR)
              </label>
              <input
                id="srcNameInput"
                type="text"
                placeholder="leave blank for Available HYPR"
                value={srcNameInput}
                onChange={(e) => setSrcNameInput(e.target.value)}
              />
            </div>

            <div className="row">
              <label className="label" htmlFor="dstNameInput">
                Destination Hypermap name
              </label>
              <input
                id="dstNameInput"
                type="text"
                placeholder="sample-node.os"
                value={dstNameInput}
                onChange={(e) => setDstNameInput(e.target.value)}
                required
              />
            </div>

            <div className="row">
              <label className="label" htmlFor="transferAmountInput">
                HYPR amount
              </label>
              <input
                id="transferAmountInput"
                type="number"
                min="0"
                step="0.000000000000000001"
                placeholder="1.0"
                value={transferAmountInput}
                onChange={(e) => setTransferAmountInput(e.target.value)}
              />
            </div>

            <div className="row">
              <label className="label" htmlFor="transferDurationInput">
                Duration (seconds)
              </label>
              <input
                id="transferDurationInput"
                type="number"
                min={MIN_LOCK_DURATION_SECONDS}
                max={MAX_LOCK_DURATION_SECONDS}
                step="1"
                placeholder={MIN_LOCK_DURATION_SECONDS.toString()}
                value={transferDurationInput}
                onChange={(e) => setTransferDurationInput(e.target.value)}
              />
            </div>

            {transferError && <div className="error inline-error">{transferError}</div>}
            {(isTransferPending || isTransferConfirming) && (
              <div className="info inline-info">Submitting transfer transaction…</div>
            )}
            {isTransferConfirmed && transferTxHash && (
              <div className="success inline-success">
                Registration updated! Tx {transferTxHash.slice(0, 8)}…{transferTxHash.slice(-6)}
              </div>
            )}

            <button
              type="submit"
              className="primary-button"
              disabled={!isWalletConnected || isTransferPending || isTransferConfirming}
            >
              {isTransferPending || isTransferConfirming ? <span className="spinner" /> : 'Bind'}
            </button>
          </form>
        </section>
        </>
      )}
    </div>
  );
}

const formatTimestamp = (seconds: number) => {
  if (!seconds) return '0';
  if (seconds === Number.MAX_SAFE_INTEGER) return 'Unknown';
  return new Date(seconds * 1000).toLocaleString();
};

const formatDurationSeconds = (seconds: number) => {
  const weeks = seconds / 604800;
  if (Number.isInteger(weeks)) {
    return `${weeks.toLocaleString()} week${weeks === 1 ? '' : 's'} (${seconds.toLocaleString()} seconds)`;
  }
  const days = seconds / 86400;
  if (Number.isInteger(days)) {
    return `${days.toLocaleString()} day${days === 1 ? '' : 's'} (${seconds.toLocaleString()} seconds)`;
  }
  return `${seconds.toLocaleString()} seconds`;
};

const isHexHash = (value: string): value is `0x${string}` =>
  /^0x[a-fA-F0-9]{64}$/.test(value);

const resolveNamehash = (input: string): `0x${string}` => {
  const trimmed = input.trim();
  if (!trimmed) {
    return ZERO_NAMEHASH;
  }
  if (isHexHash(trimmed)) {
    return trimmed.toLowerCase() as `0x${string}`;
  }
  const labels = trimmed
    .toLowerCase()
    .split('.')
    .map((label) => label.trim())
    .filter(Boolean)
    .reverse();

  return labels.reduce<`0x${string}`>((node, label) => {
    const labelHash = keccak256(stringToBytes(label));
    return keccak256(concatHex([node, labelHash])) as `0x${string}`;
  }, ZERO_NAMEHASH);
};

const decodeManageLockError = (err: unknown): string => {
  let fallback = 'Failed to submit transaction.';

  if (err instanceof BaseError) {
    const walked = err.walk((error) => error instanceof ContractFunctionRevertedError);
    const revertError = walked instanceof ContractFunctionRevertedError ? walked : null;
    const decoded = revertError?.data;

    if (decoded && 'errorName' in decoded && decoded.errorName === 'InvalidDuration') {
      const [, min, max] = decoded.args as readonly [bigint, bigint, bigint];
      return `Duration must be between ${formatDurationSeconds(Number(min))} and ${formatDurationSeconds(
        Number(max),
      )}.`;
    }

    return revertError?.shortMessage ?? err.shortMessage ?? fallback;
  }

  if (err instanceof Error) {
    return err.message;
  }

  return fallback;
};

export default App;
