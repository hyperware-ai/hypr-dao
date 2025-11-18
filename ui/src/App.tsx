import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { base, anvil } from 'wagmi/chains';
import { concatHex, keccak256, parseEther, stringToBytes } from 'viem';
import './App.css';
import { useBindAndLockStore } from './store/lock_and_bind';
import type { BalanceView, BindingView, LockDetailsView } from './types/lock_and_bind';

type StepId = 'lock' | 'bind';
type StepIcon = 'check' | 'lock' | 'chain';

interface StepConfig {
  id: StepId;
  title: string;
  description: string;
  icon: StepIcon;
}

interface BannerMessage {
  id: number;
  text: string;
}

const steps: StepConfig[] = [
  {
    id: 'lock',
    title: 'Lock',
    description: 'Approve HYPR and manage lock duration and amount.',
    icon: 'lock',
  },
  {
    id: 'bind',
    title: 'Bind',
    description: 'Manage name bindings and distribute HYPR across registrations.',
    icon: 'chain',
  },
];

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

const transferRegistrationAbi = [
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

const MIN_LOCK_DURATION_SECONDS = 4 * 7 * 24 * 60 * 60; // 4 weeks
const MAX_LOCK_DURATION_SECONDS = 4 * 52 * 7 * 24 * 60 * 60; // ~4 years
const ZERO_NAMEHASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;

type DurationField = 'years' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds';

type DurationParts = Record<DurationField, number>;
type DurationInputValues = Record<DurationField, string>;

const BASE_DURATION_FIELDS: DurationField[] = ['years', 'months', 'weeks'];
const PRECISION_DURATION_FIELDS: DurationField[] = ['days', 'hours', 'minutes', 'seconds'];

const DURATION_LABELS: Record<DurationField, string> = {
  years: 'Years',
  months: 'Months',
  weeks: 'Weeks',
  days: 'Days',
  hours: 'Hours',
  minutes: 'Minutes',
  seconds: 'Seconds',
};

const createDefaultDurationInputs = (): DurationInputValues => ({
  years: '0',
  months: '1',
  weeks: '0',
  days: '0',
  hours: '0',
  minutes: '0',
  seconds: '0',
});

const inputsToDurationParts = (inputs: DurationInputValues): DurationParts => ({
  years: parseDurationInputValue(inputs.years),
  months: parseDurationInputValue(inputs.months),
  weeks: parseDurationInputValue(inputs.weeks),
  days: parseDurationInputValue(inputs.days),
  hours: parseDurationInputValue(inputs.hours),
  minutes: parseDurationInputValue(inputs.minutes),
  seconds: parseDurationInputValue(inputs.seconds),
});

const durationPartsToSeconds = (parts: DurationParts): bigint => {
  return (
    BigInt(parts.years) * BigInt(SECONDS_PER_YEAR) +
    BigInt(parts.months) * BigInt(SECONDS_PER_MONTH) +
    BigInt(parts.weeks) * BigInt(SECONDS_PER_WEEK) +
    BigInt(parts.days) * BigInt(SECONDS_PER_DAY) +
    BigInt(parts.hours) * BigInt(SECONDS_PER_HOUR) +
    BigInt(parts.minutes) * BigInt(SECONDS_PER_MINUTE) +
    BigInt(parts.seconds)
  );
};

const parseDurationInputValue = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
};

function App() {
  const [activeStep, setActiveStep] = useState<StepId>('lock');
  const [showLockModal, setShowLockModal] = useState(false);
  const {
    nodeId,
    isConnected,
    ownerAddress,
    lockDetails,
    hyprOwned,
    hyprApproved,
    tokeregistryAllowance,
    availableToBind,
    bindings,
    hyprTokenAddress,
    lockModalSeen,
    lastError,
    isLoading,
    error,
    initialize,
    fetchLockStatus,
    refreshLockStatus,
    clearError,
    acknowledgeLockModal,
  } = useBindAndLockStore();
  const { address, chain, isConnected: isWalletConnected } = useAccount();

  const showLockInfoModal = () => setShowLockModal(true);
  const dismissLockInfoModal = () => setShowLockModal(false);

  const targetRegistryAddress = useMemo(() => {
    if (chain?.id && TOKEN_REGISTRY_ADDRESSES[chain.id]) {
      return TOKEN_REGISTRY_ADDRESSES[chain.id];
    }
    return TOKEN_REGISTRY_ADDRESSES[base.id];
  }, [chain?.id]);

  useEffect(() => {
    initialize();
  }, [initialize]);

  const walletConnected = Boolean(isWalletConnected && address);
  const connectComplete = Boolean(isConnected && nodeId && walletConnected);
  const hyprOwnedWei = hyprOwned?.amount_raw_wei ? BigInt(hyprOwned.amount_raw_wei) : 0n;
  const lockedWei = lockDetails?.amount_raw_wei ? BigInt(lockDetails.amount_raw_wei) : 0n;
  const hasBalanceData = hyprOwned !== null;
  const hasHyprHoldings = hyprOwnedWei > 0n || lockedWei > 0n;
  const showHyprRequiredNotice =
    walletConnected && connectComplete && hasBalanceData && !hasHyprHoldings;
  const showContent = connectComplete && !showHyprRequiredNotice;
  const lockTabEnabled = showContent;
  const bindTabEnabled =
    showContent &&
    ((availableToBind && availableToBind.amount_raw_wei !== '0') || bindings.length > 0);

  useEffect(() => {
    if (!lockTabEnabled) {
      setActiveStep('lock');
      return;
    }
    if (activeStep === 'bind' && !bindTabEnabled) {
      setActiveStep('lock');
    }
  }, [lockTabEnabled, bindTabEnabled, activeStep]);

  useEffect(() => {
    if (connectComplete) {
      void fetchLockStatus();
    }
  }, [connectComplete, fetchLockStatus]);

  const canAccessStep = (id: StepId) => {
    if (id === 'lock') {
      return lockTabEnabled;
    }
    if (id === 'bind') {
      return bindTabEnabled;
    }
    return false;
  };

  const handleSelectStep = (id: StepId) => {
    if (canAccessStep(id)) {
      setActiveStep(id);
    }
  };

  const stepDescription = useMemo(() => {
    return steps.find((step) => step.id === activeStep)?.description ?? '';
  }, [activeStep]);
  const activeStepTitle = useMemo(() => steps.find((step) => step.id === activeStep)?.title ?? '', [activeStep]);

  return (
    <div className="app">
      <div className="phone-shell">
        <div className="phone-frame">
          <TopStatusBar
            hyperConnected={isConnected}
            walletConnected={walletConnected}
            walletAddress={address}
          />

          <div className="phone-body">
            <header className="app-header">
              <h1 className="app-title">🔐 Lock &amp; Bind</h1>
              <p className="app-subtitle">HYPR registry companion</p>
              {showHyprRequiredNotice && (
                <div className="hypr-required-card">
                  <h3>HYPR required</h3>
                  <p>This account must possess a HYPR balance to use this application.</p>
                </div>
              )}
            </header>

            {showContent && (
              <>
                {error && (
                  <div className="error-banner">
                    <span>{error}</span>
                    <button onClick={clearError}>Dismiss</button>
                  </div>
                )}

                <div className="step-info">
                  <div className="step-heading-row">
                    <h2 className="step-heading">{activeStepTitle}</h2>
                    {activeStep === 'lock' && (
                      <button
                        type="button"
                        className="refresh-inline-button"
                        disabled={isLoading}
                        onClick={refreshLockStatus}
                      >
                        {isLoading ? <span className="spinner" /> : 'Refresh values'}
                      </button>
                    )}
                  </div>
                  <p className="step-description">{stepDescription}</p>
                </div>

                <main className="step-content">
                  {activeStep === 'lock' && (
                    <LockStep
                      connectComplete={connectComplete}
                      nodeId={nodeId}
                      ownerAddress={ownerAddress}
                      lockDetails={lockDetails}
                      hyprOwned={hyprOwned}
                      hyprApproved={hyprApproved}
                      tokeregistryAllowance={tokeregistryAllowance}
                      availableToBind={availableToBind}
                      hyprTokenAddress={hyprTokenAddress}
                      lastError={lastError}
                      isLoading={isLoading}
                      refreshLockStatus={refreshLockStatus}
                      walletConnected={walletConnected}
                      walletAddress={address}
                      targetRegistryAddress={targetRegistryAddress}
                      hasSeenLockModal={lockModalSeen}
                      onRequireLockInfo={showLockInfoModal}
                    />
                  )}

                  {activeStep === 'bind' && (
                    <BindStep
                      connectComplete={connectComplete}
                      walletConnected={walletConnected}
                      walletAddress={address}
                      targetRegistryAddress={targetRegistryAddress}
                      availableToBind={availableToBind}
                      bindings={bindings}
                      refreshLockStatus={refreshLockStatus}
                    />
                  )}
                </main>
              </>
            )}

            {!showContent && <div className="body-placeholder" />}

          </div>

          <BottomTabs
            steps={steps}
            activeStep={activeStep}
            canAccessStep={canAccessStep}
            onSelect={handleSelectStep}
          />
        </div>
      </div>
      {showLockModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>How locking works</h3>
            <p>Locking HYPR can involve two blockchain transactions:</p>
            <ol>
              <li><strong>Approve HYPR:</strong> Authorizes the TokenRegistry to use the amount you specify.</li>
              <li><strong>Lock HYPR:</strong> Moves the approved HYPR into the staking contract for the duration you choose.</li>
            </ol>
            <p>You only need to approve additional HYPR when your existing allowance is too low.</p>
            <button
              className="secondary-button"
              onClick={async () => {
                await acknowledgeLockModal();
                dismissLockInfoModal();
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface LockStepProps {
  connectComplete: boolean;
  nodeId: string | null;
  ownerAddress: string | null;
  lockDetails: LockDetailsView | null;
  hyprOwned: BalanceView | null;
  hyprApproved: BalanceView | null;
  tokeregistryAllowance: BalanceView | null;
  availableToBind: BalanceView | null;
  hyprTokenAddress: string | null;
  lastError: string | null;
  isLoading: boolean;
  refreshLockStatus: () => Promise<void>;
  walletConnected: boolean;
  walletAddress?: `0x${string}`;
  targetRegistryAddress: `0x${string}`;
  hasSeenLockModal: boolean;
  onRequireLockInfo: () => void;
}

const LockStep = ({
  connectComplete,
  nodeId,
  ownerAddress,
  lockDetails,
  hyprOwned,
  hyprApproved,
  tokeregistryAllowance,
  availableToBind,
  hyprTokenAddress,
  lastError,
  isLoading,
  refreshLockStatus,
  walletConnected,
  walletAddress,
  targetRegistryAddress,
  hasSeenLockModal,
  onRequireLockInfo,
}: LockStepProps) => {
  const [amountInput, setAmountInput] = useState('');
  const [durationInputs, setDurationInputs] = useState<DurationInputValues>(createDefaultDurationInputs);
  const [showLockPrecision, setShowLockPrecision] = useState(false);
  const [manageError, setManageError] = useState<BannerMessage | null>(null);
  const [manageSuccessHash, setManageSuccessHash] = useState<`0x${string}` | null>(null);
  const manageErrorIdRef = useRef(0);
  const manageErrorRef = useRef<HTMLDivElement | null>(null);
  const manageSuccessRef = useRef<HTMLDivElement | null>(null);

  const [pendingLock, setPendingLock] = useState<{ amount: bigint; duration: bigint } | null>(null);

  const durationParts = useMemo(() => inputsToDurationParts(durationInputs), [durationInputs]);
  const lockedAmountWei = lockDetails?.amount_raw_wei ? BigInt(lockDetails.amount_raw_wei) : 0n;
  const hasExistingLock = lockedAmountWei > 0n;
  const lockDurationSeconds = useMemo(() => durationPartsToSeconds(durationParts), [durationParts]);
  const hasAllowance = tokeregistryAllowance && tokeregistryAllowance.amount_raw_wei !== '0';
  const lockUnlockPreview = useMemo(() => {
    if (lockDurationSeconds <= 0n) {
      return null;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    return formatTimestamp(nowSeconds + Number(lockDurationSeconds));
  }, [lockDurationSeconds]);

  const {
    data: allowanceTxHash,
    error: allowanceWriteError,
    isPending: isAllowancePending,
    writeContract: writeApproveContract,
  } = useWriteContract();

  const {
    data: manageTxHash,
    error: manageWriteError,
    isPending: isManagePending,
    writeContract: writeManageLock,
  } = useWriteContract();

  const {
    isLoading: isAllowanceConfirming,
    isSuccess: isAllowanceConfirmed,
  } = useWaitForTransactionReceipt({
    hash: allowanceTxHash,
  });

  const {
    isLoading: isManageConfirming,
    isSuccess: isManageConfirmed,
  } = useWaitForTransactionReceipt({
    hash: manageTxHash,
  });

  useEffect(() => {
    if (allowanceWriteError) {
      pushManageError(getErrorMessage(allowanceWriteError));
      setPendingLock(null);
    }
  }, [allowanceWriteError]);

  useEffect(() => {
    if (manageWriteError) {
      pushManageError(getErrorMessage(manageWriteError));
    }
  }, [manageWriteError]);

  useEffect(() => {
    if (manageError) {
      const timeout = setTimeout(() => setManageError(null), 10_000);
      return () => clearTimeout(timeout);
    }
  }, [manageError]);

  useEffect(() => {
    if (manageError) {
      manageErrorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [manageError]);

  useEffect(() => {
    if (isManageConfirmed) {
      setAmountInput('');
      setDurationInputs(createDefaultDurationInputs());
      setPendingLock(null);
      void refreshLockStatus();
    }
  }, [isManageConfirmed, refreshLockStatus]);

  useEffect(() => {
    if (isManageConfirmed && manageTxHash) {
      setManageSuccessHash(manageTxHash);
    }
  }, [isManageConfirmed, manageTxHash]);

  useEffect(() => {
    if (manageSuccessHash) {
      const timeout = setTimeout(() => setManageSuccessHash(null), 10_000);
      return () => clearTimeout(timeout);
    }
  }, [manageSuccessHash]);

  useEffect(() => {
    if (manageSuccessHash) {
      manageSuccessRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [manageSuccessHash]);

  useEffect(() => {
    if (isAllowanceConfirmed && pendingLock) {
      void triggerLock(pendingLock);
    }
  }, [isAllowanceConfirmed, pendingLock]);

  useEffect(() => {
    if (isAllowanceConfirmed && !pendingLock) {
      void refreshLockStatus();
    }
  }, [isAllowanceConfirmed, pendingLock, refreshLockStatus]);

  const pushManageError = (message: string) => {
    manageErrorIdRef.current += 1;
    setManageError({ id: manageErrorIdRef.current, text: message });
  };

  const handleLockDurationInputChange = (field: DurationField, value: string) => {
    setDurationInputs((prev) => ({ ...prev, [field]: value }));
  };

  const handleLockDurationInputBlur = (field: DurationField) => {
    setDurationInputs((prev) => {
      if (prev[field] === '' || Number.isNaN(Number(prev[field]))) {
        return { ...prev, [field]: '0' };
      }
      return prev;
    });
  };

  const triggerLock = async ({ amount, duration }: { amount: bigint; duration: bigint }) => {
    try {
      await writeManageLock({
        address: targetRegistryAddress,
        abi: tokenRegistryAbi,
        functionName: 'manageLock',
        args: [amount, duration],
      });
    } catch (err) {
      pushManageError(getErrorMessage(err));
      setPendingLock(null);
    }
  };

  const handleResetApproval = async () => {
    if (!walletConnected || !walletAddress) {
      pushManageError('Connect a wallet to reset approvals.');
      return;
    }
    if (!hyprTokenAddress) {
      pushManageError('Unable to resolve HYPR token address.');
      return;
    }
    try {
      await writeApproveContract({
        address: hyprTokenAddress as `0x${string}`,
        abi: erc20ApproveAbi,
        functionName: 'approve',
        args: [targetRegistryAddress, 0n],
      });
      setPendingLock(null);
    } catch (err) {
      pushManageError(getErrorMessage(err));
    }
  };

  const handleManageLock = async (event: FormEvent) => {
    event.preventDefault();
    setManageError(null);

    if (!hasSeenLockModal) {
      onRequireLockInfo();
      return;
    }

    if (!walletConnected || !walletAddress) {
      pushManageError('Connect a wallet to manage locks.');
      return;
    }

    if ((!amountInput || Number(amountInput) <= 0) && !hasExistingLock) {
      pushManageError('Enter a positive HYPR amount.');
      return;
    }

    if (lockDurationSeconds <= 0n) {
      pushManageError('Enter a positive duration.');
      return;
    }
    if (lockDurationSeconds < BigInt(MIN_LOCK_DURATION_SECONDS)) {
      pushManageError(`Duration must be at least ${formatDurationSeconds(MIN_LOCK_DURATION_SECONDS)}.`);
      return;
    }
    if (lockDurationSeconds > BigInt(MAX_LOCK_DURATION_SECONDS)) {
      pushManageError(`Duration must be less than or equal to ${formatDurationSeconds(MAX_LOCK_DURATION_SECONDS)}.`);
      return;
    }

    const amountWei = amountInput ? parseEther(amountInput) : 0n;
    const allowanceWei = tokeregistryAllowance ? BigInt(tokeregistryAllowance.amount_raw_wei) : 0n;
    const requiredAllowance = amountWei > allowanceWei ? amountWei - allowanceWei : 0n;

    if (requiredAllowance > 0n) {
      if (!hyprTokenAddress) {
        pushManageError('Unable to resolve HYPR token address.');
        return;
      }
      setPendingLock({ amount: amountWei, duration: lockDurationSeconds });
      try {
        await writeApproveContract({
          address: hyprTokenAddress as `0x${string}`,
          abi: erc20ApproveAbi,
          functionName: 'approve',
          args: [targetRegistryAddress, requiredAllowance],
        });
      } catch (err) {
        setPendingLock(null);
        pushManageError(getErrorMessage(err));
      }
      return;
    }

    await triggerLock({ amount: amountWei, duration: lockDurationSeconds });
  };

  if (!connectComplete) {
    return <></>;
  }

  const lockHeaderTitle = hasExistingLock ? 'Manage lock' : 'Create HYPR lock';
  const lockHeaderSubtitle = hasExistingLock
    ? 'Add HYPR to existing locked balance, or extend the current duration (enter 0 for HYPR amount).'
    : 'Lock an amount of HYPR for a specified duration to use in bindings.';
  const allowZeroAmount = hasExistingLock;
  const amountProvided = amountInput !== '';
  const amountValue = amountProvided ? Number(amountInput) : 0;
  const lockButtonDisabled =
    !walletConnected ||
    isManagePending ||
    isManageConfirming ||
    isAllowancePending ||
    isAllowanceConfirming ||
    !amountProvided ||
    (!allowZeroAmount && amountValue <= 0);
  const showLockFormContent =
    amountProvided && (amountValue > 0 || (allowZeroAmount && amountValue === 0));

  return (
    <section className="step-card lock-step">
      <div className="lock-grid">
        <LockMetric
          label="HYPR owned"
          value={hyprOwned?.amount_formatted_hypr ?? 'Loading…'}
          subValue={hyprOwned?.amount_raw_wei ? `${hyprOwned.amount_raw_wei} wei` : undefined}
        />
      </div>

      {hasAllowance && tokeregistryAllowance && (
        <div className="lock-grid">
          <div className="warning-card">
            <LockMetric
              label="Previously allowed"
              value={tokeregistryAllowance.amount_formatted_hypr}
              subValue={`${tokeregistryAllowance.amount_raw_wei} wei`}
            />
            <button
              type="button"
              className="warning-button"
              disabled={isAllowancePending || isAllowanceConfirming}
              onClick={handleResetApproval}
            >
              {isAllowancePending || isAllowanceConfirming ? <span className="spinner" /> : 'Reset approval'}
            </button>
          </div>
        </div>
      )}

      <div className="lock-grid">
        {lockDetails && hasExistingLock ? (
          <div className="lock-detail-card">
            <div className="lock-card">
              <span className="lock-card-label">Locked amount</span>
              <span className="lock-card-value">{lockDetails.amount_formatted_hypr}</span>
              <span className="lock-card-sub">{lockDetails.amount_raw_wei} wei</span>
            </div>
            <div className="lock-card">
              <span className="lock-card-label">Unlock timestamp</span>
              <span className="lock-card-value">{formatTimestamp(lockDetails.unlock_timestamp)}</span>
              <span className="lock-card-sub">
                {lockDetails.remaining_seconds === Number.MAX_SAFE_INTEGER
                  ? 'Unknown remaining time'
                  : `${formatSeconds(lockDetails.remaining_seconds)} remaining`}
              </span>
            </div>
          </div>
        ) : (
          <div className="lock-empty">
            <h3>No lock detected</h3>
            <p>Lock HYPR to secure your node reservations. Once a lock is active it will appear here.</p>
          </div>
        )}
      </div>

      <form className="lock-form" onSubmit={handleManageLock}>
        <div className="form-header">
          <div className="form-header-text">
            <h3>{lockHeaderTitle}</h3>
            <p>{lockHeaderSubtitle}</p>
          </div>
        </div>
        <div className="input-grid">
          <label className="input-field">
            <span>Amount (HYPR)</span>
            <input
              type="number"
              min="0"
              step="0.000000000000000001"
              value={amountInput}
              onChange={(event) => setAmountInput(event.target.value)}
            />
          </label>
        </div>
        {showLockFormContent && (
          <DurationInputs
            values={durationInputs}
            onChange={handleLockDurationInputChange}
            onBlurField={handleLockDurationInputBlur}
            showPrecision={showLockPrecision}
            onTogglePrecision={() => setShowLockPrecision((prev) => !prev)}
            durationSeconds={lockDurationSeconds}
            unlockPreview={lockUnlockPreview}
          />
        )}
        <div className="form-actions">
          <button type="submit" className="secondary-button" disabled={lockButtonDisabled}>
            {isManagePending || isManageConfirming || isAllowancePending || isAllowanceConfirming ? <span className="spinner" /> : 'Lock'}
          </button>
        </div>
        {manageError && (
          <div className="inline-error" ref={manageErrorRef}>
            {manageError.text}
          </div>
        )}
        {manageSuccessHash && (
          <div className="inline-success" ref={manageSuccessRef}>
            Lock updated! Tx {shortHash(manageSuccessHash)}
          </div>
        )}
      </form>

      {lastError && <div className="inline-error">{lastError}</div>}
    </section>
  );
};

interface LockMetricProps {
  label: string;
  value: string;
  subValue?: string;
}

const LockMetric = ({ label, value, subValue }: LockMetricProps) => (
  <div className="lock-card">
    <span className="lock-card-label">{label}</span>
    <span className="lock-card-value">{value}</span>
    {subValue && <span className="lock-card-sub">{subValue}</span>}
  </div>
);

interface BindStepProps {
  connectComplete: boolean;
  walletConnected: boolean;
  walletAddress?: `0x${string}`;
  targetRegistryAddress: `0x${string}`;
  availableToBind: BalanceView | null;
  bindings: BindingView[];
  refreshLockStatus: () => Promise<void>;
}

const BindStep = ({
  connectComplete,
  walletConnected,
  walletAddress,
  targetRegistryAddress,
  availableToBind,
  bindings,
  refreshLockStatus,
}: BindStepProps) => {
  const [srcNameInput, setSrcNameInput] = useState('');
  const [dstNameInput, setDstNameInput] = useState('');
  const [transferAmountInput, setTransferAmountInput] = useState('');
  const [transferDurationInputs, setTransferDurationInputs] = useState<DurationInputValues>(
    createDefaultDurationInputs,
  );
  const [showTransferPrecision, setShowTransferPrecision] = useState(false);
  const [transferError, setTransferError] = useState<BannerMessage | null>(null);
  const [transferSuccessHash, setTransferSuccessHash] = useState<`0x${string}` | null>(null);
  const transferErrorIdRef = useRef(0);
  const transferErrorRef = useRef<HTMLDivElement | null>(null);
  const transferSuccessRef = useRef<HTMLDivElement | null>(null);

  const {
    data: transferTxHash,
    error: transferWriteError,
    isPending: isTransferPending,
    writeContract: writeTransferContract,
  } = useWriteContract();

  const {
    isLoading: isTransferConfirming,
    isSuccess: isTransferConfirmed,
  } = useWaitForTransactionReceipt({
    hash: transferTxHash,
  });

  useEffect(() => {
    if (transferWriteError) {
      pushTransferError(getErrorMessage(transferWriteError));
    }
  }, [transferWriteError]);

  useEffect(() => {
    if (transferError) {
      const timeout = setTimeout(() => setTransferError(null), 10_000);
      return () => clearTimeout(timeout);
    }
  }, [transferError]);

  useEffect(() => {
    if (transferError) {
      transferErrorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [transferError]);

  const transferDurationParts = useMemo(
    () => inputsToDurationParts(transferDurationInputs),
    [transferDurationInputs],
  );
  const transferDurationSeconds = useMemo(
    () => durationPartsToSeconds(transferDurationParts),
    [transferDurationParts],
  );
  const transferUnlockPreview = useMemo(() => {
    if (transferDurationSeconds <= 0n) {
      return null;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    return formatTimestamp(nowSeconds + Number(transferDurationSeconds));
  }, [transferDurationSeconds]);

  const pushTransferError = (message: string) => {
    transferErrorIdRef.current += 1;
    setTransferError({ id: transferErrorIdRef.current, text: message });
  };

  const handleTransferDurationInputChange = (field: DurationField, value: string) => {
    setTransferDurationInputs((prev) => ({ ...prev, [field]: value }));
  };

  const handleTransferDurationInputBlur = (field: DurationField) => {
    setTransferDurationInputs((prev) => {
      if (prev[field] === '' || Number.isNaN(Number(prev[field]))) {
        return { ...prev, [field]: '0' };
      }
      return prev;
    });
  };

  useEffect(() => {
    if (isTransferConfirmed) {
      setSrcNameInput('');
      setDstNameInput('');
      setTransferAmountInput('');
      setTransferDurationInputs(createDefaultDurationInputs());
      void refreshLockStatus();
    }
  }, [isTransferConfirmed, refreshLockStatus]);

  useEffect(() => {
    if (isTransferConfirmed && transferTxHash) {
      setTransferSuccessHash(transferTxHash);
    }
  }, [isTransferConfirmed, transferTxHash]);

  useEffect(() => {
    if (transferSuccessHash) {
      const timeout = setTimeout(() => setTransferSuccessHash(null), 10_000);
      return () => clearTimeout(timeout);
    }
  }, [transferSuccessHash]);

  useEffect(() => {
    if (transferSuccessHash) {
      transferSuccessRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [transferSuccessHash]);

  if (!connectComplete) {
    return <></>;
  }

  const handleTransfer = async (event: FormEvent) => {
    event.preventDefault();
    setTransferError(null);

    if (!walletConnected || !walletAddress) {
      pushTransferError('Connect a wallet to transfer registrations.');
      return;
    }

    if (!dstNameInput.trim()) {
      pushTransferError('Destination name is required.');
      return;
    }

    if (!transferAmountInput || Number(transferAmountInput) <= 0) {
      pushTransferError('Enter a positive HYPR amount to transfer.');
      return;
    }

    const maxAmountWei = parseEther(transferAmountInput);
    if (availableToBind) {
      const availableWei = BigInt(availableToBind.amount_raw_wei);
      if (maxAmountWei > availableWei) {
        pushTransferError('Amount exceeds HYPR available to bind.');
        return;
      }
    }

    if (transferDurationSeconds <= 0n) {
      pushTransferError('Enter a positive duration.');
      return;
    }
    if (transferDurationSeconds < BigInt(MIN_LOCK_DURATION_SECONDS)) {
      pushTransferError(`Duration must be at least ${formatDurationSeconds(MIN_LOCK_DURATION_SECONDS)}.`);
      return;
    }
    if (transferDurationSeconds > BigInt(MAX_LOCK_DURATION_SECONDS)) {
      pushTransferError(`Duration must be less than or equal to ${formatDurationSeconds(MAX_LOCK_DURATION_SECONDS)}.`);
      return;
    }

    try {
      const srcHash = resolveNamehash(srcNameInput);
      const dstHash = resolveNamehash(dstNameInput);
      if (dstHash === ZERO_NAMEHASH) {
        pushTransferError('Destination cannot be the default registration.');
        return;
      }

      await writeTransferContract({
        address: targetRegistryAddress,
        abi: transferRegistrationAbi,
        functionName: 'transferRegistration',
        args: [srcHash, dstHash, maxAmountWei, transferDurationSeconds],
      });
    } catch (error) {
        pushTransferError(getErrorMessage(error));
    }
  };

  return (
    <section className="step-card lock-step">
      <div className="lock-header">
        <div>
          <h2>Manage bindings</h2>
          <p className="lock-subtitle">View current registrations and bind HYPR to new names.</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void refreshLockStatus()}>
          Refresh
        </button>
      </div>

      <div className="lock-grid">
        <LockMetric
          label="HYPR available to bind"
          value={availableToBind?.amount_formatted_hypr ?? '0 HYPR'}
          subValue={availableToBind?.amount_raw_wei ? `${availableToBind.amount_raw_wei} wei` : undefined}
        />
        <LockMetric label="Active bindings" value={bindings.length.toString()} />
      </div>

      <div className="lock-detail-panel">
        {bindings.length === 0 ? (
          <div className="lock-empty">
            <h3>No bindings detected</h3>
            <p>Bind HYPR to a namehash to kick off registration transfers.</p>
          </div>
        ) : (
          bindings.map((binding) => (
            <div className="lock-detail" key={binding.namehash}>
              <span className="lock-detail-label">{binding.name ?? 'Unknown name'}</span>
              <span className="lock-detail-value">{binding.amount_formatted_hypr}</span>
              <span className="lock-detail-sub">Unlocks {formatTimestamp(binding.unlock_timestamp)}</span>
            </div>
          ))
        )}
      </div>

      <form className="lock-form" onSubmit={handleTransfer}>
        <div className="form-header">
          <div>
            <h3>Transfer registration</h3>
            <p>Move HYPR from the default pool to a destination namehash.</p>
          </div>
          <button
            type="submit"
            className="secondary-button"
            disabled={!walletConnected || isTransferPending || isTransferConfirming}
          >
            {isTransferPending || isTransferConfirming ? <span className="spinner" /> : 'Bind'}
          </button>
        </div>
        <div className="input-grid">
          <label className="input-field">
            <span>Source name</span>
            <input
              type="text"
              placeholder="optional.name.eth"
              value={srcNameInput}
              onChange={(event) => setSrcNameInput(event.target.value)}
            />
          </label>
          <label className="input-field">
            <span>Destination name</span>
            <input
              type="text"
              placeholder="example.name.eth"
              value={dstNameInput}
              onChange={(event) => setDstNameInput(event.target.value)}
              required
            />
          </label>
          <label className="input-field">
            <span>HYPR amount</span>
            <input
              type="number"
              min="0"
              step="0.000000000000000001"
              value={transferAmountInput}
              onChange={(event) => setTransferAmountInput(event.target.value)}
              required
            />
          </label>
        </div>
        {transferAmountInput && Number(transferAmountInput) > 0 && (
          <DurationInputs
            values={transferDurationInputs}
            onChange={handleTransferDurationInputChange}
            onBlurField={handleTransferDurationInputBlur}
            showPrecision={showTransferPrecision}
            onTogglePrecision={() => setShowTransferPrecision((prev) => !prev)}
            durationSeconds={transferDurationSeconds}
            unlockPreview={transferUnlockPreview}
          />
        )}
        {transferError && (
          <div className="inline-error" ref={transferErrorRef}>
            {transferError.text}
          </div>
        )}
        {transferSuccessHash && (
          <div className="inline-success" ref={transferSuccessRef}>
            Binding updated! Tx {shortHash(transferSuccessHash)}
          </div>
        )}
      </form>
    </section>
  );
};

interface DurationInputsProps {
  values: DurationInputValues;
  onChange: (field: DurationField, value: string) => void;
  onBlurField: (field: DurationField) => void;
  showPrecision: boolean;
  onTogglePrecision: () => void;
  durationSeconds: bigint;
  unlockPreview: string | null;
}

interface BottomTabsProps {
  steps: StepConfig[];
  activeStep: StepId;
  canAccessStep: (id: StepId) => boolean;
  onSelect: (id: StepId) => void;
}

const BottomTabs = ({ steps, activeStep, canAccessStep, onSelect }: BottomTabsProps) => (
  <nav className="bottom-tabs">
    {steps.map((step, index) => {
      const accessible = canAccessStep(step.id);
      const isActive = activeStep === step.id;
      const icon = iconGlyph[step.icon];
      return (
        <button
          type="button"
          key={step.id}
          className={`bottom-tab${isActive ? ' active' : ''}`}
          disabled={!accessible}
          onClick={() => onSelect(step.id)}
        >
          <span className="tab-icon" aria-hidden>
            {icon}
          </span>
          <span className="tab-title">{step.title}</span>
        </button>
      );
    })}
  </nav>
);

const iconGlyph: Record<StepIcon, string> = {
  check: '✔',
  lock: '🔒',
  chain: '⛓',
};

const DurationInputs = ({
  values,
  onChange,
  onBlurField,
  showPrecision,
  onTogglePrecision,
  durationSeconds,
  unlockPreview,
}: DurationInputsProps) => {
  const renderField = (field: DurationField) => (
    <label className="input-field" key={field}>
      <span>{DURATION_LABELS[field]}</span>
      <input
        type="number"
        min={0}
        step={1}
        value={values[field] ?? ''}
        onChange={(event) => onChange(field, event.target.value)}
        onBlur={() => onBlurField(field)}
      />
    </label>
  );

  const durationLabel =
    durationSeconds > 0n ? formatDurationSeconds(Number(durationSeconds)) : '0 seconds';
  const unlockText = unlockPreview ?? 'Set a duration to preview end time';

  return (
    <div className="duration-section">
      <div className="duration-grid">{BASE_DURATION_FIELDS.map((field) => renderField(field))}</div>
      {showPrecision && (
        <div className="duration-grid">
          {PRECISION_DURATION_FIELDS.map((field) => renderField(field))}
        </div>
      )}
      <button type="button" className="link-button" onClick={onTogglePrecision}>
        {showPrecision ? 'Hide optional precision' : 'Optional precision duration'}
      </button>
      <div className="duration-summary">
        <span>Unlock preview: {unlockText}</span>
        <span>Duration total: {durationLabel}</span>
      </div>
    </div>
  );
};

interface TopStatusBarProps {
  hyperConnected: boolean;
  walletConnected: boolean;
  walletAddress?: `0x${string}`;
}

const TopStatusBar = ({ hyperConnected, walletConnected, walletAddress }: TopStatusBarProps) => {
  const connectedState = walletConnected && walletAddress;
  return (
    <div className={`top-banner ${connectedState ? 'banner-ready' : 'banner-warning'}`}>
      <div className="banner-main">
        <span className="banner-title">
          {connectedState ? 'Provider connected' : 'Connect your wallet'}
        </span>
        <span className="banner-subtitle">
          {connectedState
            ? shortenAddress(walletAddress)
            : 'Approvals and locks require a connected provider.'}
        </span>
      </div>
      <div className="banner-actions">
        <span className={`banner-chip ${hyperConnected ? 'online' : 'offline'}`}>
          {hyperConnected ? 'Hyperware online' : 'Hyperware offline'}
        </span>
        <ConnectButton chainStatus="icon" showBalance={false} />
      </div>
    </div>
  );
};

const shortenAddress = (address: `0x${string}`) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const shortHash = (hash: `0x${string}`) => `${hash.slice(0, 8)}…${hash.slice(-6)}`;

const formatTimestamp = (seconds: number) => {
  if (!seconds) return '0';
  if (seconds === Number.MAX_SAFE_INTEGER) return 'Unknown';
  return new Date(seconds * 1000).toLocaleString();
};

const formatSeconds = (value: number) => {
  if (value <= 0) return '0s';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
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

const formatDurationSeconds = (seconds: number) => {
  const units = [
    { label: 'year', value: SECONDS_PER_YEAR },
    { label: 'month', value: SECONDS_PER_MONTH },
    { label: 'week', value: SECONDS_PER_WEEK },
    { label: 'day', value: SECONDS_PER_DAY },
  ];
  for (const unit of units) {
    const amount = seconds / unit.value;
    if (Number.isInteger(amount)) {
      return `${amount.toLocaleString()} ${unit.label}${amount === 1 ? '' : 's'} (${seconds.toLocaleString()} seconds)`;
    }
  }
  return `${seconds.toLocaleString()} seconds`;
};

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Action failed.');

export default App;
