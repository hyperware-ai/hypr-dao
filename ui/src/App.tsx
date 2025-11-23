import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { base, anvil } from 'wagmi/chains';
import { concatHex, keccak256, parseEther, stringToBytes } from 'viem';
import './App.css';
import { useBindAndLockStore } from './store/lock_and_bind';
import type { BalanceView, BindingView, LockDetailsView } from './types/lock_and_bind';
import { App as CallerApp } from '#caller-utils';

type StepId = 'lock' | 'bind';
type StepIcon = 'check' | 'lock' | 'chain';
type LockView = 'details' | 'manage' | 'extend';

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
    description: '',
    icon: 'lock',
  },
  {
    id: 'bind',
    title: 'Bind',
    description: '',
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
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
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

const DEFAULT_MIN_LOCK_DURATION_SECONDS = 4 * 7 * 24 * 60 * 60; // 4 weeks
const MAX_LOCK_DURATION_SECONDS = 4 * 52 * 7 * 24 * 60 * 60; // ~4 years
const ZERO_NAMEHASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
const CHAIN_LABELS: Record<number, string> = {
  [base.id]: 'Base',
  [anvil.id]: 'Anvil',
};
const FALLBACK_CHAIN_ID = anvil.id;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;

type DurationField = 'years' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds';
type DurationMode = 'duration' | 'end-date';

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

const DURATION_INPUT_DEFAULTS: DurationInputValues = {
  years: '0',
  months: '1',
  weeks: '0',
  days: '0',
  hours: '0',
  minutes: '0',
  seconds: '0',
};

const createDefaultDurationInputs = (): DurationInputValues => ({
  ...DURATION_INPUT_DEFAULTS,
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

const durationInputsFromSeconds = (seconds: bigint): DurationInputValues => {
  let remaining = seconds;
  const units: [DurationField, bigint][] = [
    ['years', BigInt(SECONDS_PER_YEAR)],
    ['months', BigInt(SECONDS_PER_MONTH)],
    ['weeks', BigInt(SECONDS_PER_WEEK)],
    ['days', BigInt(SECONDS_PER_DAY)],
    ['hours', BigInt(SECONDS_PER_HOUR)],
    ['minutes', BigInt(SECONDS_PER_MINUTE)],
  ];
  const result: DurationInputValues = {
    years: '0',
    months: '0',
    weeks: '0',
    days: '0',
    hours: '0',
    minutes: '0',
    seconds: '0',
  };
  units.forEach(([field, unit]) => {
    if (unit === 0n) {
      return;
    }
    const value = remaining / unit;
    remaining %= unit;
    result[field] = value.toString();
  });
  result.seconds = remaining.toString();
  return result;
};

const DEFAULT_DURATION_SECONDS = durationPartsToSeconds(
  inputsToDurationParts(createDefaultDurationInputs()),
);

const clampDurationSeconds = (value: bigint, minSeconds: number) => {
  const minBigInt = BigInt(minSeconds);
  if (minBigInt <= 0) {
    return value;
  }
  return value < minBigInt ? minBigInt : value;
};

const createDurationInputsAtLeastMin = (seconds: bigint, minSeconds: number) =>
  durationInputsFromSeconds(clampDurationSeconds(seconds, minSeconds));

const createDefaultDurationInputsAtLeastMin = (minSeconds: number) =>
  createDurationInputsAtLeastMin(DEFAULT_DURATION_SECONDS, minSeconds);

const calculateRequiredAdditionalDuration = (
  existingAmount: bigint,
  existingDuration: bigint,
  additionalAmount: bigint,
  desiredDuration: bigint,
): bigint | null => {
  if (additionalAmount === 0n) {
    return null;
  }
  const totalAmount = existingAmount + additionalAmount;
  const desiredWeighted = desiredDuration * totalAmount;
  const existingWeighted = existingAmount * existingDuration;
  if (desiredWeighted < existingWeighted) {
    return null;
  }
  return (desiredWeighted - existingWeighted) / additionalAmount;
};

function App() {
  const [activeStep, setActiveStep] = useState<StepId>('lock');
  const [showLockModal, setShowLockModal] = useState(false);
  const [lockModalResume, setLockModalResume] = useState<(() => void) | null>(null);
  const [lockUpdateNonce, setLockUpdateNonce] = useState(0);
  const handleLockUpdated = useCallback(() => {
    setLockUpdateNonce((prev) => prev + 1);
  }, []);
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
  const lockExpired =
    lockDetails !== null &&
    BigInt(lockDetails.amount_raw_wei ?? '0') > 0n &&
    (lockDetails.remaining_seconds ?? 0) === 0;
  const { address, chain, isConnected: isWalletConnected } = useAccount();
  const showLockInfoModal = (resume?: () => void) => {
    setLockModalResume(() => (resume ? () => resume() : null));
    setShowLockModal(true);
  };
  const dismissLockInfoModal = () => {
    setShowLockModal(false);
    setLockModalResume(null);
  };
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
  const normalizedOwnerAddress = ownerAddress?.toLowerCase() ?? null;
  const normalizedWalletAddress = address?.toLowerCase() ?? null;
  const walletMismatch =
    walletConnected &&
    Boolean(normalizedOwnerAddress) &&
    Boolean(normalizedWalletAddress) &&
    normalizedOwnerAddress !== normalizedWalletAddress;
  const expectedChainId = useBindAndLockStore((state) => state.chainId) ?? FALLBACK_CHAIN_ID;
  const expectedChainName = CHAIN_LABELS[expectedChainId] ?? `Chain ${expectedChainId}`;
  const networkMismatch =
    walletConnected && chain?.id !== undefined && chain.id !== expectedChainId;
  const minLockDurationSeconds =
    useBindAndLockStore((state) => state.minLockDurationSeconds) ?? DEFAULT_MIN_LOCK_DURATION_SECONDS;
  const environmentReady = !walletMismatch && !networkMismatch;
  const connectComplete = Boolean(isConnected && nodeId && walletConnected);
  const hyprOwnedWei = hyprOwned?.amount_raw_wei ? BigInt(hyprOwned.amount_raw_wei) : 0n;
  const lockedWei = lockDetails?.amount_raw_wei ? BigInt(lockDetails.amount_raw_wei) : 0n;
  const hasBalanceData = hyprOwned !== null;
  const hasHyprHoldings = hyprOwnedWei > 0n || lockedWei > 0n;
  const showHyprRequiredNotice =
    walletConnected &&
    connectComplete &&
    environmentReady &&
    hasBalanceData &&
    !hasHyprHoldings;
  const showContent = connectComplete && !showHyprRequiredNotice && environmentReady;
  const lockTabEnabled = showContent;
  const bindTabEnabled =
    showContent &&
    ((availableToBind && availableToBind.amount_raw_wei !== '0') || bindings.length > 0);

  useEffect(() => {
    if (lockExpired && activeStep !== 'lock') {
      setActiveStep('lock');
    }
  }, [lockExpired, activeStep]);

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

  useEffect(() => {
    const id = setInterval(() => {
      if (connectComplete && environmentReady) {
        void refreshLockStatus();
      }
    }, 20_000);
    return () => clearInterval(id);
  }, [connectComplete, environmentReady, refreshLockStatus]);

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
    if (activeStep === 'lock' || activeStep === 'bind') return '';
    return steps.find((step) => step.id === activeStep)?.description ?? '';
  }, [activeStep]);
  const activeStepTitle = useMemo(() => {
    if (activeStep === 'lock' || activeStep === 'bind') return '';
    return steps.find((step) => step.id === activeStep)?.title ?? '';
  }, [activeStep]);

  return (
    <div className="app">
      <div className="phone-shell">
        <div className="phone-frame">
          <TopStatusBar />

          <div className="phone-body">
            {showHyprRequiredNotice && (
              <div className="hypr-required-card">
                <h3>HYPR required</h3>
                <p>This account must possess a HYPR balance to use this application.</p>
              </div>
            )}

            {connectComplete && !environmentReady && (
              <div className="warning-card">
                <h3>Connection required</h3>
                {walletMismatch && (
                  <p>
                    Connect wallet <code>{ownerAddress}</code> to manage this node owner's HYPR locks and bindings. You are currently
                    connected as <code>{address}</code>.
                  </p>
                )}
                {networkMismatch && (
                  <p>
                    Switch your wallet network to {expectedChainName} (chain ID {expectedChainId}) to continue. You are on{' '}
                    {chain ? chain.name : 'an unknown network'}.
                  </p>
                )}
              </div>
            )}

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
                    {activeStepTitle ? <h2 className="step-heading">{activeStepTitle}</h2> : <span />}
                    <button
                      type="button"
                      className="refresh-inline-button"
                      disabled={isLoading}
                      onClick={refreshLockStatus}
                    >
                      {isLoading ? <span className="spinner" /> : 'Refresh values'}
                    </button>
                  </div>
                  {stepDescription ? <p className="step-description">{stepDescription}</p> : null}
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
                      onRequireLockInfo={(resume) => showLockInfoModal(resume)}
                      minLockDurationSeconds={minLockDurationSeconds}
                      onLockUpdated={handleLockUpdated}
                    />
                  )}

                  {activeStep === 'bind' && (
                    <BindStep
                      connectComplete={connectComplete}
                      walletConnected={walletConnected}
                      walletAddress={address}
                      targetRegistryAddress={targetRegistryAddress}
                      availableToBind={availableToBind}
                      lockDetails={lockDetails}
                      bindings={bindings}
                      refreshLockStatus={refreshLockStatus}
                      minLockDurationSeconds={minLockDurationSeconds}
                      lockUpdateNonce={lockUpdateNonce}
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
              <li><strong>Lock HYPR:</strong> Moves the approved HYPR into the Registry contract for the duration you choose (between 4 weeks and 4 years).</li>
            </ol>
            <p>
              You may only need to confirm one transaction if you have previously approved sufficient transfer rights to the Registry contract. Under normal circumstances, you will need to approve the amount of HYPR you are attempting to lock (transaction #1) and tell the Registry contract to take possession of it (transaction #2).
              <strong> After these transactions, the HYPR will be kept under the control of the Registry contract for the duration of the lock.</strong>&nbsp;
              Double-check your amount and duration before confirming the transactions.
            </p>
            <div className="modal-actions">
              <button
                className="secondary-button ghost centered"
                onClick={() => {
                  dismissLockInfoModal();
                }}
              >
                Cancel
              </button>
              <button
                className="secondary-button"
                onClick={async () => {
                  await acknowledgeLockModal();
                  const resume = lockModalResume;
                  dismissLockInfoModal();
                  if (resume) {
                    resume();
                  }
                }}
              >
                Accept and continue transactions
              </button>
            </div>
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
  onRequireLockInfo: (resume: () => void) => void;
  minLockDurationSeconds: number;
  onLockUpdated: () => void;
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
  minLockDurationSeconds,
  onLockUpdated,
}: LockStepProps) => {
  const [amountInput, setAmountInput] = useState('');
  const [durationInputs, setDurationInputs] = useState<DurationInputValues>(() =>
    createDefaultDurationInputsAtLeastMin(minLockDurationSeconds),
  );
  const [lockView, setLockView] = useState<LockView>('manage');
  const [lockDurationDirty, setLockDurationDirty] = useState(false);
  const [lockDurationMode, setLockDurationMode] = useState<DurationMode>('duration');
  const [lockEndDateInput, setLockEndDateInput] = useState<Date | null>(null);
  const [showLockPrecision, setShowLockPrecision] = useState(false);
  const [manageError, setManageError] = useState<BannerMessage | null>(null);
  const [txNotice, setTxNotice] = useState<BannerMessage & { kind: 'success' | 'error' } | null>(
    null,
  );
  const [manageSuccessHash, setManageSuccessHash] = useState<`0x${string}` | null>(null);
  const manageErrorIdRef = useRef(0);
  const txNoticeIdRef = useRef(0);
  const manageErrorRef = useRef<HTMLDivElement | null>(null);
  const txNoticeRef = useRef<HTMLDivElement | null>(null);
  const manageSuccessRef = useRef<HTMLDivElement | null>(null);

  const [pendingLock, setPendingLock] = useState<{ amount: bigint; duration: bigint } | null>(null);
  const allowanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nowSecondsRef = useRef(Math.floor(Date.now() / 1000));
  const nowSeconds = nowSecondsRef.current;
  const [userSetLockView, setUserSetLockView] = useState(false);

  const durationParts = useMemo(() => inputsToDurationParts(durationInputs), [durationInputs]);
  const lockedAmountWei = lockDetails?.amount_raw_wei ? BigInt(lockDetails.amount_raw_wei) : 0n;
  const hasExistingLock = lockedAmountWei > 0n;
  const hyprOwnedWei = hyprOwned?.amount_raw_wei ? BigInt(hyprOwned.amount_raw_wei) : 0n;
  const lockExpired = hasExistingLock && (lockDetails?.remaining_seconds ?? 0) === 0;
  useEffect(() => {
    // when lock existence changes (e.g., after refresh), allow default routing again
    setUserSetLockView(false);
  }, [hasExistingLock]);
  useEffect(() => {
    if (userSetLockView) return;
    if (hasExistingLock && lockView !== 'details') {
      setLockView('details');
    } else if (!hasExistingLock && lockView !== 'manage') {
      setLockView('manage');
    }
  }, [hasExistingLock, lockView, userSetLockView]);
  useEffect(() => {
    if (lockExpired && lockView !== 'details') {
      setUserSetLockView(false);
      setLockView('details');
    }
  }, [lockExpired, lockView]);
  const lastSyncedDurationSeconds = useRef<number | null>(null);
  useEffect(() => {
    if (!hasExistingLock) {
      setLockDurationDirty(false);
      lastSyncedDurationSeconds.current = null;
    }
  }, [hasExistingLock]);
  useEffect(() => {
    if (!hasExistingLock || !lockDetails) {
      lastSyncedDurationSeconds.current = null;
      return;
    }
    const remainingSeconds = lockDetails.remaining_seconds ?? 0;
    if (remainingSeconds === 0 || lastSyncedDurationSeconds.current === remainingSeconds) {
      return;
    }
    if (lockDurationDirty) {
      return;
    }
    const nextDurationInputs = createDurationInputsAtLeastMin(
      BigInt(remainingSeconds),
      minLockDurationSeconds,
    );
    setDurationInputs(nextDurationInputs);
    lastSyncedDurationSeconds.current = remainingSeconds;
  }, [hasExistingLock, lockDetails, lockDurationDirty, minLockDurationSeconds]);
  const lockDurationSecondsFromInputs = useMemo(
    () => durationPartsToSeconds(durationParts),
    [durationParts],
  );
  const hasAllowance = tokeregistryAllowance && tokeregistryAllowance.amount_raw_wei !== '0';
  const minDurationSecondsBigInt = BigInt(minLockDurationSeconds);
  const lockEndDateMin = useMemo(
    () => new Date((nowSeconds + minLockDurationSeconds) * 1000),
    [nowSeconds, minLockDurationSeconds],
  );
  const lockEndDateMax = useMemo(
    () => new Date((nowSeconds + MAX_LOCK_DURATION_SECONDS) * 1000),
    [nowSeconds],
  );
  const extendMinMillis = useMemo(() => {
    const unlockMs = lockDetails?.unlock_timestamp ? lockDetails.unlock_timestamp * 1000 : 0;
    return Math.max(lockEndDateMin.getTime(), unlockMs);
  }, [lockDetails, lockEndDateMin]);
  // Removed: legacy default end-date based on DEFAULT_DURATION_SECONDS (1 month)
  const lockEndDateDisplayMin = useMemo(
    () => roundUpToNextDay(lockEndDateMin.getTime()),
    [lockEndDateMin],
  );
  const weightedDurationSeconds = useCallback(
    (existingAmount: bigint, existingDuration: bigint, addAmount: bigint, targetDuration: bigint) => {
      if (addAmount <= 0n) return null;
      const total = existingAmount + addAmount;
      if (total === 0n) return null;
      return (existingAmount * existingDuration + addAmount * targetDuration) / total;
    },
    [],
  );
  const extendEndDateDisplayMin = useMemo(
    () => roundUpToNextDay(extendMinMillis),
    [extendMinMillis],
  );
  const lockEndDateDurationSeconds = secondsUntilDate(lockEndDateInput, Math.floor(Date.now() / 1000));
  const effectiveMode: DurationMode =
    lockView === 'extend' || lockView === 'manage' ? 'end-date' : lockDurationMode;
  const [lockEndTimeInput, setLockEndTimeInput] = useState('00:00:00');
  const [lockEndTimeDirty, setLockEndTimeDirty] = useState(false);
  useEffect(() => {
    if (!lockEndDateInput || !lockEndTimeInput) return;
    const [h, m, s] = lockEndTimeInput.split(':').map((v) => parseInt(v, 10));
    if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return;
    const next = new Date(lockEndDateInput);
    next.setHours(h, m, s, 0);
    setLockEndDateInput(next);
  }, [lockEndTimeInput]);
  useEffect(() => {
    if (lockEndDateInput && (!lockEndTimeInput || !lockEndTimeDirty)) {
      const h = String(lockEndDateInput.getHours()).padStart(2, '0');
      const m = String(lockEndDateInput.getMinutes()).padStart(2, '0');
      const s = String(lockEndDateInput.getSeconds()).padStart(2, '0');
      setLockEndTimeInput(`${h}:${m}:${s}`);
    }
  }, [lockEndDateInput, lockEndTimeDirty, lockEndTimeInput]);
  const selectedLockDurationSeconds =
    effectiveMode === 'duration'
      ? lockDurationSecondsFromInputs
      : lockEndDateDurationSeconds ?? 0n;
  const lockUnlockPreview = useMemo(() => {
    if (selectedLockDurationSeconds <= 0n) {
      return null;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    return formatTimestamp(nowSeconds + Number(selectedLockDurationSeconds));
  }, [selectedLockDurationSeconds]);

  const {
    data: allowanceTxHash,
    error: allowanceWriteError,
    isPending: isAllowancePending,
    writeContract: writeApproveContract,
    reset: resetAllowanceWrite,
  } = useWriteContract();

  const {
    data: manageTxHash,
    error: manageWriteError,
    isPending: isManagePending,
    writeContract: writeManageLock,
    reset: resetManageWrite,
  } = useWriteContract();

  const {
    data: withdrawTxHash,
    error: withdrawError,
    isPending: isWithdrawPending,
    writeContract: writeWithdrawContract,
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
    isError: isManageReceiptError,
    error: manageReceiptError,
  } = useWaitForTransactionReceipt({
    hash: manageTxHash,
  });

  const {
    isLoading: isWithdrawConfirming,
    isSuccess: isWithdrawConfirmed,
  } = useWaitForTransactionReceipt({
    hash: withdrawTxHash,
  });

  const pushManageError = useCallback(
    (message: string) => {
      manageErrorIdRef.current += 1;
      setManageError({ id: manageErrorIdRef.current, text: message });
    },
    [setManageError],
  );
  const pushTxNotice = useCallback(
    (message: string, kind: 'success' | 'error') => {
      txNoticeIdRef.current += 1;
      setTxNotice({ id: txNoticeIdRef.current, text: message, kind });
    },
    [],
  );

  useEffect(() => {
    if (allowanceWriteError) {
      pushManageError(getErrorMessage(allowanceWriteError));
      setPendingLock(null);
    }
  }, [allowanceWriteError, pushManageError]);

  useEffect(() => {
    if (manageWriteError) {
      const msg = getErrorMessage(manageWriteError);
      pushManageError(msg);
      pushTxNotice(msg, 'error');
      setLockView('details');
    }
  }, [manageWriteError, pushManageError, pushTxNotice]);

  useEffect(() => {
    if (withdrawError) {
      pushManageError(getErrorMessage(withdrawError));
    }
  }, [withdrawError, pushManageError]);

  useEffect(() => {
    if (isManageReceiptError && manageReceiptError) {
      const msg = getErrorMessage(manageReceiptError);
      pushManageError(msg);
      pushTxNotice(msg, 'error');
      setLockView('details');
    }
  }, [isManageReceiptError, manageReceiptError, pushManageError, pushTxNotice]);

  useEffect(() => {
    if (manageError) {
      const timeout = setTimeout(() => setManageError(null), 10_000);
      return () => clearTimeout(timeout);
    }
  }, [manageError]);

  useEffect(() => {
    if (txNotice) {
      const timeout = setTimeout(() => setTxNotice(null), 10_000);
      return () => clearTimeout(timeout);
    }
  }, [txNotice]);

  useEffect(() => {
    if (manageError) {
      manageErrorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [manageError]);

  useEffect(() => {
    if (isManageConfirmed) {
      setAmountInput('');
      setDurationInputs(createDefaultDurationInputsAtLeastMin(minLockDurationSeconds));
      setLockDurationMode('duration');
      setLockEndDateInput(null);
      setLockDurationDirty(false);
      lastSyncedDurationSeconds.current = null;
      setPendingLock(null);
      void refreshLockStatus();
      onLockUpdated();
      setLockView('details');
    }
  }, [isManageConfirmed, refreshLockStatus, onLockUpdated, minLockDurationSeconds]);

  useEffect(() => {
    if (isManageConfirmed && manageTxHash) {
      setManageSuccessHash(manageTxHash);
      txNoticeIdRef.current += 1;
      setTxNotice({ id: txNoticeIdRef.current, text: `Lock updated! Tx ${shortHash(manageTxHash)}`, kind: 'success' });
    }
  }, [isManageConfirmed, manageTxHash]);

  useEffect(() => {
    if (isWithdrawConfirmed) {
      void refreshLockStatus();
    }
  }, [isWithdrawConfirmed, refreshLockStatus]);

  useEffect(() => {
    if (isWithdrawConfirmed && withdrawTxHash) {
      setManageSuccessHash(withdrawTxHash);
    }
  }, [isWithdrawConfirmed, withdrawTxHash]);

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

  useEffect(() => {
    if (isAllowancePending) {
      allowanceTimeoutRef.current = setTimeout(() => {
        resetAllowanceWrite();
        allowanceTimeoutRef.current = null;
        setPendingLock(null);
        pushManageError('Approval request timed out. Please try again.');
      }, 30_000);
      return () => {
        if (allowanceTimeoutRef.current) {
          clearTimeout(allowanceTimeoutRef.current);
          allowanceTimeoutRef.current = null;
        }
      };
    }
    if (allowanceTimeoutRef.current) {
      clearTimeout(allowanceTimeoutRef.current);
      allowanceTimeoutRef.current = null;
    }
  }, [isAllowancePending, pushManageError, resetAllowanceWrite]);

  useEffect(() => {
    if (isManagePending) {
      manageTimeoutRef.current = setTimeout(() => {
        resetManageWrite();
        manageTimeoutRef.current = null;
        pushManageError('Lock transaction timed out. Please try again.');
      }, 30_000);
      return () => {
        if (manageTimeoutRef.current) {
          clearTimeout(manageTimeoutRef.current);
          manageTimeoutRef.current = null;
        }
      };
    }
    if (manageTimeoutRef.current) {
      clearTimeout(manageTimeoutRef.current);
      manageTimeoutRef.current = null;
    }
  }, [isManagePending, pushManageError, resetManageWrite]);

const handleLockDurationInputChange = (field: DurationField, value: string) => {
    setLockDurationDirty(true);
    setDurationInputs((prev) => {
      const updated: DurationInputValues = { ...prev, [field]: value };
      if (
        BASE_DURATION_FIELDS.includes(field) &&
        value !== DURATION_INPUT_DEFAULTS[field as DurationField]
      ) {
        PRECISION_DURATION_FIELDS.forEach((precisionField) => {
          updated[precisionField] = '0';
        });
      }
      return updated;
    });
  };

  const handleLockDurationInputBlur = (field: DurationField) => {
    setDurationInputs((prev) => {
      if (prev[field] === '' || Number.isNaN(Number(prev[field]))) {
        return { ...prev, [field]: '0' };
      }
      return prev;
    });
  };

  const handleLockEndDateChange = (value: Date | null) => {
    setLockDurationDirty(true);
    setLockEndDateInput(value);
  };

  const handleLockDurationModeChange = (mode: DurationMode) => {
    setLockDurationDirty(true);
    setLockDurationMode(mode);
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

  const submitLockRequest = async () => {
    setTxNotice(null);
    setManageError(null);

    if (!walletConnected || !walletAddress) {
      pushManageError('Connect a wallet to manage locks.');
      return;
    }

    if ((!amountInput || Number(amountInput) <= 0) && !hasExistingLock) {
      pushManageError('Enter a positive HYPR amount.');
      return;
    }

    if (lockDurationMode === 'end-date') {
      if (!lockEndDateInput) {
        pushManageError('Select an end date.');
        return;
      }
      if (!lockEndDateDurationSeconds) {
        pushManageError('Select an end date within the allowed range.');
        return;
      }
    }

    if (selectedLockDurationSeconds <= 0n) {
      pushManageError('Enter a positive duration.');
      return;
    }
    if (selectedLockDurationSeconds < minDurationSecondsBigInt) {
      pushManageError(`Duration must be at least ${formatDurationSeconds(minLockDurationSeconds)}.`);
      return;
    }
    if (selectedLockDurationSeconds > BigInt(MAX_LOCK_DURATION_SECONDS)) {
      pushManageError(`Duration must be less than or equal to ${formatDurationSeconds(MAX_LOCK_DURATION_SECONDS)}.`);
      return;
    }

    const amountWei = additionalAmountWei;
    const allowanceWei = tokeregistryAllowance ? BigInt(tokeregistryAllowance.amount_raw_wei) : 0n;
    const needsAllowanceTopUp = amountWei > allowanceWei;
    let submittedDurationSeconds = selectedLockDurationSeconds;
    if (hasExistingLock && amountWei > 0n) {
      const requiredDuration = calculateRequiredAdditionalDuration(
        existingAmountWei,
        existingDurationSeconds,
        amountWei,
        selectedLockDurationSeconds,
      );
    if (!requiredDuration) {
      pushManageError('The size and duration of your existing lock restricts you from achieving your new desired lock duration. Consider either committing more HYPR or choosing a target duration closer to the existing lock duration.');
      return;
    }
      if (
        requiredDuration < minDurationSecondsBigInt ||
        requiredDuration > BigInt(MAX_LOCK_DURATION_SECONDS)
      ) {
        pushManageError(
          'The size and duration of your existing lock restricts you from achieving your new desired lock duration. Consider either committing more HYPR or choosing a target duration closer to the existing lock duration.',
        );
        return;
      }
      submittedDurationSeconds = requiredDuration;
    }

    if (needsAllowanceTopUp) {
      if (!hyprTokenAddress) {
        pushManageError('Unable to resolve HYPR token address.');
        return;
      }
      setPendingLock({ amount: amountWei, duration: submittedDurationSeconds });
      try {
        await writeApproveContract({
          address: hyprTokenAddress as `0x${string}`,
          abi: erc20ApproveAbi,
          functionName: 'approve',
          args: [targetRegistryAddress, amountWei],
        });
      } catch (err) {
        setPendingLock(null);
        pushManageError(getErrorMessage(err));
      }
      return;
    }

    await triggerLock({ amount: amountWei, duration: submittedDurationSeconds });
  };

  const handleWithdraw = async () => {
    if (!walletConnected || !walletAddress) {
      pushManageError('Connect a wallet to withdraw.');
      return;
    }
    try {
      await writeWithdrawContract({
        address: targetRegistryAddress,
        abi: tokenRegistryAbi,
        functionName: 'withdraw',
      });
    } catch (err) {
      pushManageError(getErrorMessage(err));
    }
  };

  const handleManageLock = async (event: FormEvent) => {
    event.preventDefault();

    if (!hasSeenLockModal) {
      onRequireLockInfo(() => {
        void submitLockRequest();
      });
      return;
    }

    await submitLockRequest();
  };

  if (!connectComplete) {
    return <></>;
  }

  const lockHeaderSubtitle = 'Lock an amount of HYPR for a specified duration to use in bindings.';
  const allowZeroAmount = lockView === 'extend';
  const amountProvided = amountInput !== '';
  const amountValue = amountProvided ? Number(amountInput) : 0;
  const additionalAmountWei = useMemo(() => {
    if (!amountProvided) {
      return 0n;
    }
    try {
      return parseEther(amountInput || '0');
    } catch {
      return 0n;
    }
  }, [amountInput, amountProvided]);
  const existingAmountWei =
    lockDetails && hasExistingLock ? BigInt(lockDetails.amount_raw_wei) : 0n;
  const existingDurationSeconds =
    lockDetails && hasExistingLock ? BigInt(lockDetails.remaining_seconds ?? 0) : 0n;
  const zeroAmountExtendingOnly =
    hasExistingLock && additionalAmountWei === 0n && existingDurationSeconds > 0n;
  const durationLessThanExisting =
    zeroAmountExtendingOnly && selectedLockDurationSeconds < existingDurationSeconds;

  const requiredDurationSeconds = useMemo(() => {
    if (!hasExistingLock || additionalAmountWei <= 0n) {
      return selectedLockDurationSeconds;
    }
    return (
      calculateRequiredAdditionalDuration(
        existingAmountWei,
        existingDurationSeconds,
        additionalAmountWei,
        selectedLockDurationSeconds,
      ) ?? selectedLockDurationSeconds
    );
  }, [
    additionalAmountWei,
    existingAmountWei,
    existingDurationSeconds,
    hasExistingLock,
    selectedLockDurationSeconds,
  ]);

  const addWeightedMinDurationSeconds = useMemo(() => {
    if (!hasExistingLock || lockView !== 'manage') return null;
    const target = BigInt(minLockDurationSeconds);
    const weighted = weightedDurationSeconds(existingAmountWei, existingDurationSeconds, additionalAmountWei, target);
    if (!weighted) return null;
    return weighted < target ? target : weighted;
  }, [
    additionalAmountWei,
    existingAmountWei,
    existingDurationSeconds,
    hasExistingLock,
    lockView,
    minLockDurationSeconds,
    weightedDurationSeconds,
  ]);

  const addWeightedMaxDurationSeconds = useMemo(() => {
    if (!hasExistingLock || lockView !== 'manage') return null;
    const target = BigInt(MAX_LOCK_DURATION_SECONDS);
    const weighted = weightedDurationSeconds(existingAmountWei, existingDurationSeconds, additionalAmountWei, target);
    if (!weighted) return null;
    return weighted > target ? target : weighted;
  }, [
    additionalAmountWei,
    existingAmountWei,
    existingDurationSeconds,
    hasExistingLock,
    lockView,
    weightedDurationSeconds,
  ]);

  const addDynamicMinMs = useMemo(() => {
    if (!addWeightedMinDurationSeconds) return null;
    const candidateMs =
      Number((BigInt(nowSeconds) + addWeightedMinDurationSeconds) * 1000n);
    return Math.max(candidateMs, lockEndDateMin.getTime());
  }, [addWeightedMinDurationSeconds, lockEndDateMin, nowSeconds]);

  const addDynamicMaxMs = useMemo(() => {
    if (!addWeightedMaxDurationSeconds) return null;
    const candidateMs =
      Number((BigInt(nowSeconds) + addWeightedMaxDurationSeconds) * 1000n);
    return Math.min(candidateMs, lockEndDateMax.getTime());
  }, [addWeightedMaxDurationSeconds, lockEndDateMax, nowSeconds]);

  const maxMsForView = useMemo(() => {
    const base = lockEndDateMax.getTime();
    if (lockView === 'manage' && hasExistingLock && addDynamicMaxMs !== null) {
      return Math.max(addDynamicMaxMs, extendMinMillis);
    }
    return base;
  }, [addDynamicMaxMs, extendMinMillis, hasExistingLock, lockEndDateMax, lockView]);

  const lockEndDateDisplayMax = useMemo(() => {
    const base = new Date(maxMsForView);
    base.setHours(0, 0, 0, 0);
    return base;
  }, [maxMsForView]);

  const addDisplayMinDateForHint = useMemo(() => {
    if (lockView === 'manage' && hasExistingLock && addDynamicMinMs !== null) {
      return roundUpToNextDay(addDynamicMinMs);
    }
    return extendEndDateDisplayMin;
  }, [addDynamicMinMs, extendEndDateDisplayMin, hasExistingLock, lockView]);
  const suppressLockHint = useMemo(() => {
    if (lockView === 'extend') {
      return extendEndDateDisplayMin.getTime() >= lockEndDateDisplayMax.getTime();
    }
    if (lockView === 'manage' && !hasExistingLock) {
      return lockEndDateDisplayMin.getTime() >= lockEndDateDisplayMax.getTime();
    }
    return false;
  }, [extendEndDateDisplayMin, hasExistingLock, lockEndDateDisplayMax, lockEndDateDisplayMin, lockView]);

  const actualMinMsForView = useMemo(
    () => {
      if (lockView === 'extend') {
        return extendMinMillis;
      }
      if (lockView === 'manage' && hasExistingLock) {
        if (addDynamicMinMs !== null) {
          return addDynamicMinMs;
        }
        return extendMinMillis;
      }
      return lockEndDateMin.getTime();
    },
    [addDynamicMinMs, extendMinMillis, hasExistingLock, lockEndDateMin, lockView],
  );
  const pickerMinDateForView = useMemo(() => {
    const d = new Date(actualMinMsForView);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [actualMinMsForView]);
  const displayMinDateForHint = useMemo(
    () => roundUpToNextDay(actualMinMsForView),
    [actualMinMsForView],
  );
  const defaultEndMsForView = useMemo(() => {
    const fiveMinutesMs = 5 * 60 * 1000;
    if (suppressLockHint && (lockView === 'extend' || (lockView === 'manage' && !hasExistingLock))) {
      return actualMinMsForView + fiveMinutesMs;
    }
    if (lockView === 'manage' && hasExistingLock && lockDetails?.unlock_timestamp) {
      return lockDetails.unlock_timestamp * 1000;
    }
    return displayMinDateForHint.getTime();
  }, [actualMinMsForView, displayMinDateForHint, hasExistingLock, lockDetails?.unlock_timestamp, lockView, suppressLockHint]);

  const minEndDateForValidationMs =
    lockView === 'extend'
      ? extendMinMillis
      : lockView === 'manage' && hasExistingLock
        ? addDynamicMinMs ?? lockEndDateMin.getTime()
        : lockEndDateMin.getTime();
  const hasValidEndDate =
    lockDurationMode === 'duration'
      ? true
      : Boolean(lockEndDateDurationSeconds) &&
        Boolean(lockEndDateInput) &&
        lockEndDateInput!.getTime() >= minEndDateForValidationMs &&
        lockEndDateInput!.getTime() <= lockEndDateDisplayMax.getTime();

  useEffect(() => {
    if (lockDurationDirty) {
      return;
    }
    if (!lockEndDateInput) {
      const next = new Date(defaultEndMsForView);
      setLockEndDateInput(next);
      if (!lockEndTimeDirty) {
        const h = String(next.getHours()).padStart(2, '0');
        const m = String(next.getMinutes()).padStart(2, '0');
        const s = String(next.getSeconds()).padStart(2, '0');
        setLockEndTimeInput(`${h}:${m}:${s}`);
      }
    }
  }, [defaultEndMsForView, lockDurationDirty, lockEndDateInput, lockEndTimeDirty]);

  const maxAmountLabel = hyprOwned?.amount_formatted_hypr ?? 'Loading…';
  const maxAmountWei = hyprOwned?.amount_raw_wei ? BigInt(hyprOwned.amount_raw_wei) : 0n;
  const lockButtonDisabled =
    !walletConnected ||
    isManagePending ||
    isManageConfirming ||
    isAllowancePending ||
    isAllowanceConfirming ||
    !amountProvided ||
    (!allowZeroAmount && amountValue <= 0) ||
    ((hasExistingLock ? additionalAmountWei > maxAmountWei : additionalAmountWei > maxAmountWei)) ||
    !hasValidEndDate ||
    durationLessThanExisting;
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  const showLockFormContent =
    amountProvided &&
    (amountValue > 0 || (allowZeroAmount && amountValue === 0)) &&
    (!hasExistingLock ||
      (addDynamicMinMs !== null &&
        addDynamicMaxMs !== null &&
        addDynamicMinMs < extendMinMillis - twentyFourHoursMs &&
        addDynamicMaxMs > extendMinMillis + twentyFourHoursMs));
  const addRangeLabel =
    lockView === 'manage' && hasExistingLock && amountValue > 0
      ? `By adding ${amountInput} HYPR, you may also change the lock expiration to a new date between ${formatDateIso(addDisplayMinDateForHint)} and ${formatDateIso(lockEndDateDisplayMax)}`
      : undefined;

  const resetLockEndDefaults = useCallback(() => {
    setLockDurationDirty(false);
    setLockEndDateInput(null);
    setLockEndTimeInput('00:00:00');
    setLockEndTimeDirty(false);
  }, []);

  const handleShowManagePanel = useCallback(() => {
    if (lockExpired) return;
    setUserSetLockView(true);
    setLockView('manage');
    setAmountInput('');
    resetLockEndDefaults();
  }, [lockExpired, resetLockEndDefaults]);

  const handleShowExtendPanel = useCallback(() => {
    if (hasExistingLock && !lockExpired) {
      setAmountInput('0');
      setUserSetLockView(true);
      setLockView('extend');
      resetLockEndDefaults();
    }
  }, [hasExistingLock, lockExpired, resetLockEndDefaults]);

  const handleShowDetailsPanel = useCallback(() => {
    if (hasExistingLock) {
      setUserSetLockView(true);
      setLockView('details');
    }
  }, [hasExistingLock]);

  return (
    <section className="step-card lock-step">
      {lockView === 'details' && hasAllowance && tokeregistryAllowance && (
        <div className="lock-grid">
          <div className="warning-card">
            <LockMetric
              label="Previously allowed"
              value={tokeregistryAllowance.amount_formatted_hypr}
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

      {lockView === 'details' && (
        <div className="lock-grid">
          {lockDetails && hasExistingLock ? (
            <div className="lock-detail-card">
              <div className="lock-card lock-detail-stat">
                <span className="lock-card-label">
                  {lockExpired ? 'Previously locked amount' : 'Locked amount'}
                </span>
                <span className="lock-card-value">{lockDetails.amount_formatted_hypr}</span>
              </div>
              <div className={`lock-card${lockExpired ? ' expired-card' : ''}`}>
                <span className="lock-card-label">
                  {lockExpired ? 'Lock expired at' : 'Lock expires at'}
                </span>
                <span className="lock-card-value">{formatTimestamp(lockDetails.unlock_timestamp)}</span>
                <span className="lock-card-sub">
                  {lockDetails.remaining_seconds === Number.MAX_SAFE_INTEGER
                    ? 'Unknown remaining time'
                    : lockExpired
                      ? 'Unlocked'
                      : `${formatSeconds(lockDetails.remaining_seconds)} remaining`}
                </span>
                {lockExpired && (
                  <button
                    type="button"
                    className="secondary-button warning-button"
                    disabled={isWithdrawPending || isWithdrawConfirming}
                    onClick={handleWithdraw}
                  >
                    {isWithdrawPending || isWithdrawConfirming ? <span className="spinner" /> : 'Withdraw'}
                  </button>
                )}
              </div>
              <div className="lock-detail-actions">
                {!lockExpired && (
                  <button type="button" className="secondary-button" onClick={handleShowExtendPanel}>
                    Extend lock
                  </button>
                )}
                {!lockExpired && hyprOwnedWei > 0n && (
                  <button type="button" className="secondary-button ghost" onClick={handleShowManagePanel}>
                    Add HYPR to lock
                  </button>
                )}
                {txNotice && (
                  <div
                    className={txNotice.kind === 'success' ? 'inline-success' : 'inline-error'}
                    ref={txNoticeRef}
                  >
                    {txNotice.text}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="lock-empty">
              <h3>No lock detected</h3>
              <p>Lock HYPR to enable binding. Once HYPR has been locked it will appear here.</p>
            </div>
          )}
        </div>
      )}

      {(lockView === 'manage' || lockView === 'extend') && (
        <form className="lock-form" onSubmit={handleManageLock}>
          <div className="form-header">
            <div className="form-header-text">
              <h3>
                {lockView === 'extend'
                  ? 'Extend lock'
                : hasExistingLock
                  ? 'Add HYPR to lock'
                  : 'Create HYPR lock'}
              </h3>
              {lockView === 'manage' && !hasExistingLock && <p>{lockHeaderSubtitle}</p>}
            </div>
          </div>
          {lockView !== 'extend' && (
          <div className="input-grid">
            <label className="input-field">
              <span>
                {hasExistingLock
                  ? `Amount to add (up to ${maxAmountLabel})`
                  : `Amount (up to ${maxAmountLabel})`}
              </span>
              <input
                type="number"
                min="0"
                step="0.000000000000000001"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
              />
              {hasExistingLock && lockView === 'manage' && additionalAmountWei > 0n && (
                <span className="input-subtext">
                  New total locked amount: {formatHyprWei(existingAmountWei + additionalAmountWei)}
                </span>
              )}
            </label>
          </div>
          )}
          {showLockFormContent || lockView === 'extend' ? (
            <DurationInputs
              values={durationInputs}
              onChange={handleLockDurationInputChange}
              onBlurField={handleLockDurationInputBlur}
              showPrecision={lockView === 'extend' ? false : showLockPrecision}
              onTogglePrecision={
                lockView === 'extend' ? () => {} : () => setShowLockPrecision((prev) => !prev)
              }
              durationSeconds={selectedLockDurationSeconds}
              unlockPreview={lockUnlockPreview}
              computedDurationLabel={
                lockView === 'extend'
                  ? undefined
                  : hasExistingLock
                    ? formatSeconds(Number(selectedLockDurationSeconds))
                    : undefined
              }
              computedUnlockLabel={
                lockView === 'extend'
                  ? undefined
                  : hasExistingLock
                    ? lockUnlockPreview ?? undefined
                    : undefined
              }
              resolvedDurationLabel={
                lockView === 'extend'
                  ? undefined
                  : hasExistingLock && additionalAmountWei > 0n
                    ? formatSeconds(Number(requiredDurationSeconds))
                    : undefined
              }
              mode={effectiveMode}
              onModeChange={lockView === 'extend' || lockView === 'manage' ? () => {} : handleLockDurationModeChange}
              endDateValue={lockEndDateInput}
              onEndDateChange={handleLockEndDateChange}
              onEndTimeChange={(value) => {
                setLockEndTimeInput(value);
                setLockEndTimeDirty(true);
              }}
              endTimeValue={lockEndTimeInput}
              endDateMin={pickerMinDateForView}
              endDateMax={new Date(maxMsForView)}
              showUnlockPreview={!hasExistingLock && lockView !== 'extend'}
              durationRangeLabel={
                lockView === 'manage' && !hasExistingLock
                  ? `From ${formatDurationSeconds(minLockDurationSeconds)} to ${formatDurationSeconds(MAX_LOCK_DURATION_SECONDS)}`
                  : undefined
              }
              endDateRangeLabel={
                lockView === 'extend' && !suppressLockHint
                  ? `From ${formatDateIso(extendEndDateDisplayMin)} to ${formatDateIso(lockEndDateDisplayMax)}`
                  : lockView === 'manage' && !hasExistingLock && !suppressLockHint
                    ? `From ${formatDateIso(lockEndDateDisplayMin)} to ${formatDateIso(lockEndDateDisplayMax)}`
                    : lockView === 'manage' && hasExistingLock
                      ? addRangeLabel
                      : undefined
              }
              showSummary={false}
              showModeToggle={false}
            />
          ) : null}
          <div className="form-actions">
            <button type="submit" className="secondary-button" disabled={lockButtonDisabled}>
              {isManagePending || isManageConfirming || isAllowancePending || isAllowanceConfirming ? (
                <span className="spinner" />
              ) : lockView === 'extend'
                ? 'Update Lock'
                : hasExistingLock && lockView === 'manage'
                  ? 'Update Lock'
                  : 'Create Lock'}
            </button>
            {hasExistingLock && (
              <button type="button" className="secondary-button ghost" onClick={handleShowDetailsPanel}>
                Back to details
              </button>
            )}
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
      )}

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
  lockDetails: LockDetailsView | null;
  bindings: BindingView[];
  refreshLockStatus: () => Promise<void>;
  minLockDurationSeconds: number;
  lockUpdateNonce: number;
}

const BindStep = ({
  connectComplete,
  walletConnected,
  walletAddress,
  targetRegistryAddress,
  availableToBind,
  lockDetails,
  bindings,
  refreshLockStatus,
  minLockDurationSeconds,
  lockUpdateNonce,
}: BindStepProps) => {
  const [dstNameInput, setDstNameInput] = useState('');
  const [transferAmountInput, setTransferAmountInput] = useState('');
  const [transferDurationInputs, setTransferDurationInputs] = useState<DurationInputValues>(() =>
    createDefaultDurationInputsAtLeastMin(minLockDurationSeconds),
  );
  const [transferDurationDirty, setTransferDurationDirty] = useState(false);
  const [transferDurationMode, setTransferDurationMode] = useState<DurationMode>('end-date');
  const [transferEndDateInput, setTransferEndDateInput] = useState<Date | null>(null);
  const [transferEndTimeInput, setTransferEndTimeInput] = useState('00:00:00');
  const [transferEndTimeDirty, setTransferEndTimeDirty] = useState(false);
  const [showTransferPrecision, setShowTransferPrecision] = useState(false);
  const [transferError, setTransferError] = useState<BannerMessage | null>(null);
  const [transferSuccessHash, setTransferSuccessHash] = useState<`0x${string}` | null>(null);
  const [bindView, setBindView] = useState<'details' | 'create' | 'add' | 'extend' | 'add-hypr'>(
    bindings.length > 0 ? 'details' : 'create',
  );
  const [userSetBindView, setUserSetBindView] = useState(false);
  const [bindingsSort, setBindingsSort] = useState<'name-asc' | 'name-desc' | 'expiry-asc' | 'expiry-desc'>('name-asc');
  const [extendBindingName, setExtendBindingName] = useState<string | null>(null);
  const [addHyprBindingName, setAddHyprBindingName] = useState<string | null>(null);
  const [extendBindingUnlockMs, setExtendBindingUnlockMs] = useState<number | null>(null);
  const transferErrorIdRef = useRef(0);
  const transferErrorRef = useRef<HTMLDivElement | null>(null);
  const transferSuccessRef = useRef<HTMLDivElement | null>(null);
  const lastTransferSyncedSeconds = useRef<number | null>(null);
  const [reclaimingNamehash, setReclaimingNamehash] = useState<string | null>(null);

  const {
    data: transferTxHash,
    error: transferWriteError,
    isPending: isTransferPending,
    writeContract: writeTransferContract,
  } = useWriteContract();

  const {
    isLoading: isTransferConfirming,
    isSuccess: isTransferConfirmed,
    data: transferReceipt,
    error: transferReceiptError,
  } = useWaitForTransactionReceipt({
    hash: transferTxHash,
  });
  useEffect(() => {
    if (!isTransferPending && !isTransferConfirming) {
      setReclaimingNamehash(null);
    }
  }, [isTransferPending, isTransferConfirming]);
  const hasBindings = bindings.length > 0;
  const sortedBindings = useMemo(() => {
    const items = [...bindings];
    const byName = (a: BindingView, b: BindingView) =>
      (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase());
    const byExpiry = (a: BindingView, b: BindingView) => {
      const aExp = a.unlock_timestamp ?? Number.MAX_SAFE_INTEGER;
      const bExp = b.unlock_timestamp ?? Number.MAX_SAFE_INTEGER;
      return aExp - bExp;
    };
    switch (bindingsSort) {
      case 'name-desc':
        return items.sort((a, b) => byName(b, a));
      case 'expiry-asc':
        return items.sort(byExpiry);
      case 'expiry-desc':
        return items.sort((a, b) => byExpiry(b, a));
      default:
        return items.sort(byName);
    }
  }, [bindings, bindingsSort]);
  useEffect(() => {
    if (!userSetBindView) {
      setBindView(hasBindings ? 'details' : 'create');
      setExtendBindingName(null);
      setAddHyprBindingName(null);
    }
    if (!hasBindings && bindView === 'details') {
      setBindView('create');
      setExtendBindingName(null);
      setAddHyprBindingName(null);
    }
  }, [bindView, hasBindings, userSetBindView]);

  useEffect(() => {
    if (transferWriteError) {
      pushTransferError(getErrorMessage(transferWriteError));
      setUserSetBindView(false);
      setBindView('details');
    }
  }, [transferWriteError]);

  useEffect(() => {
    if (transferReceiptError) {
      pushTransferError(getErrorMessage(transferReceiptError));
      setUserSetBindView(false);
      setBindView('details');
    }
  }, [transferReceiptError]);

  useEffect(() => {
    if (transferReceipt && transferReceipt.status === 'reverted') {
      pushTransferError('Transaction reverted. Check lock and binding states and try again.');
      setUserSetBindView(false);
      setBindView('details');
    }
  }, [transferReceipt]);

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

  const transferNowSecondsRef = useRef(Math.floor(Date.now() / 1000));
  const transferNowSeconds = transferNowSecondsRef.current;
  const minDurationSecondsBigInt = BigInt(minLockDurationSeconds);
  const transferEndDateMin = useMemo(
    () => new Date((transferNowSeconds + minLockDurationSeconds) * 1000),
    [transferNowSeconds, minLockDurationSeconds],
  );
  const transferEndDateMaxFallback = useMemo(
    () => new Date((transferNowSeconds + MAX_LOCK_DURATION_SECONDS) * 1000),
    [transferNowSeconds],
  );
  const lockExpiryMs = lockDetails?.unlock_timestamp ? lockDetails.unlock_timestamp * 1000 : null;
  const transferEndDateMax = useMemo(
    () => (lockExpiryMs !== null ? new Date(lockExpiryMs) : transferEndDateMaxFallback),
    [lockExpiryMs, transferEndDateMaxFallback],
  );
  const effectiveTransferEndDateMinMs = useMemo(() => {
    if (bindView === 'extend' && extendBindingUnlockMs !== null) {
      return extendBindingUnlockMs;
    }
    return transferEndDateMin.getTime();
  }, [bindView, extendBindingUnlockMs, transferEndDateMin]);
  const effectiveTransferEndDateMaxMs = useMemo(
    () => transferEndDateMax.getTime(),
    [transferEndDateMax],
  );
  const effectiveTransferEndDateDefault = useMemo(() => {
    if (bindView === 'add-hypr') return null;
    return new Date(effectiveTransferEndDateMaxMs);
  }, [bindView, effectiveTransferEndDateMaxMs]);
  const bindHintMinMs = useMemo(() => {
    if (bindView === 'extend') return effectiveTransferEndDateMinMs;
    if (bindView === 'add') return transferEndDateMin.getTime();
    if (bindView === 'create') return transferEndDateMin.getTime();
    return 0;
  }, [bindView, effectiveTransferEndDateMinMs, transferEndDateMin]);
  const bindHintMaxMs = useMemo(() => {
    if (bindView === 'extend') return effectiveTransferEndDateMaxMs;
    if (bindView === 'add' || bindView === 'create') return effectiveTransferEndDateMaxMs;
    return 0;
  }, [bindView, effectiveTransferEndDateMaxMs]);
  useEffect(() => {
    if (bindView === 'add-hypr') return;
    if (!transferEndDateInput && effectiveTransferEndDateDefault) {
      setTransferEndDateInput(effectiveTransferEndDateDefault);
    }
  }, [bindView, effectiveTransferEndDateDefault, transferEndDateInput]);

  useEffect(() => {
    if (!transferEndDateInput || !transferEndTimeInput) return;
    const [h, m, s] = transferEndTimeInput.split(':').map((v) => parseInt(v, 10));
    if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return;
    const next = new Date(transferEndDateInput);
    next.setHours(h, m, s, 0);
    setTransferEndDateInput(next);
  }, [transferEndTimeInput]);

  useEffect(() => {
    if (transferEndDateInput && (!transferEndTimeInput || !transferEndTimeDirty)) {
      const h = String(transferEndDateInput.getHours()).padStart(2, '0');
      const m = String(transferEndDateInput.getMinutes()).padStart(2, '0');
      const s = String(transferEndDateInput.getSeconds()).padStart(2, '0');
      setTransferEndTimeInput(`${h}:${m}:${s}`);
    }
  }, [transferEndDateInput, transferEndTimeDirty, transferEndTimeInput]);

  useEffect(() => {
    if (!lockDetails) {
      lastTransferSyncedSeconds.current = null;
      if (!transferDurationDirty) {
        if (bindView !== 'add-hypr' && effectiveTransferEndDateDefault) {
          setTransferEndDateInput(effectiveTransferEndDateDefault);
        }
        setTransferEndTimeDirty(false);
      }
      return;
    }
    const remainingSeconds = lockDetails.remaining_seconds ?? 0;
    if (remainingSeconds === 0 || lastTransferSyncedSeconds.current === remainingSeconds) {
      return;
    }
    if (transferDurationDirty) {
      return;
    }
    const nowSecondsLatest = Math.floor(Date.now() / 1000);
    const minUnbindSeconds = nowSecondsLatest + minLockDurationSeconds;
    const effectiveUnbindSeconds = Math.max(lockDetails.unlock_timestamp, minUnbindSeconds);
    setTransferEndDateInput(new Date(effectiveUnbindSeconds * 1000));
    lastTransferSyncedSeconds.current = remainingSeconds;
  }, [lockDetails, transferDurationDirty, minLockDurationSeconds, transferEndDateMin]);

  useEffect(() => {
    setTransferDurationDirty(false);
    setTransferDurationMode('end-date');
    if (bindView !== 'add-hypr' && effectiveTransferEndDateDefault) {
      setTransferEndDateInput(effectiveTransferEndDateDefault);
    }
    setTransferEndTimeDirty(false);
    lastTransferSyncedSeconds.current = null;
  }, [bindView, effectiveTransferEndDateDefault, lockUpdateNonce, minLockDurationSeconds]);
  const transferEndDateDurationSeconds = secondsUntilDate(transferEndDateInput, transferNowSeconds);
  const selectedTransferDurationSeconds = transferEndDateDurationSeconds ?? 0n;
  const destinationHash = useMemo(() => resolveNamehash(dstNameInput), [dstNameInput]);
  const destinationIsDefault = destinationHash === ZERO_NAMEHASH;
  const hasTransferValidEndDate = useMemo(() => {
    if (bindView === 'add-hypr') return true;
    if (destinationIsDefault) return false;
    if (!transferEndDateInput) return false;
    const ms = transferEndDateInput.getTime();
    if (ms < effectiveTransferEndDateMinMs) return false;
    if (ms > effectiveTransferEndDateMaxMs) return false;
    return Boolean(transferEndDateDurationSeconds);
  }, [
    bindView,
    destinationIsDefault,
    effectiveTransferEndDateMaxMs,
    effectiveTransferEndDateMinMs,
    transferEndDateDurationSeconds,
    transferEndDateInput,
  ]);
  const transferUnlockPreview = useMemo(() => {
    if (selectedTransferDurationSeconds <= 0n) {
      return null;
    }
    return formatTimestamp(transferNowSeconds + Number(selectedTransferDurationSeconds));
  }, [selectedTransferDurationSeconds, transferNowSeconds]);

  const transferAmountProvided = transferAmountInput !== '';
  const transferAmountValue = transferAmountProvided ? Number(transferAmountInput) : NaN;
  const transferAmountIsValid = transferAmountProvided && Number.isFinite(transferAmountValue);
  const shouldShowTransferEndInputs =
    bindView !== 'add-hypr' &&
    transferAmountIsValid &&
    dstNameInput.trim().length > 0 &&
    (transferAmountValue > 0 || bindView === 'extend');
  const bindButtonDisabled =
    !walletConnected ||
    isTransferPending ||
    isTransferConfirming ||
    (!hasTransferValidEndDate && bindView !== 'add-hypr') ||
    !transferAmountProvided ||
    !transferAmountIsValid ||
    (transferAmountValue <= 0 && bindView !== 'extend' && bindView !== 'add-hypr') ||
    dstNameInput.trim().length === 0;

  const pushTransferError = (message: string) => {
    transferErrorIdRef.current += 1;
    setTransferError({ id: transferErrorIdRef.current, text: message });
  };

  const handleReclaimBinding = async (binding: BindingView) => {
    if (!walletConnected || !walletAddress) {
      pushTransferError('Connect a wallet to reclaim HYPR.');
      return;
    }
    if ((binding.remaining_seconds ?? 0) > 0) {
      pushTransferError('Binding has not expired yet.');
      return;
    }
    const amountWei = BigInt(binding.amount_raw_wei);
    if (amountWei === 0n) {
      pushTransferError('No HYPR available to reclaim from this binding.');
      return;
    }
    setTransferError(null);
    setReclaimingNamehash(binding.namehash);
    try {
      await writeTransferContract({
        address: targetRegistryAddress,
        abi: transferRegistrationAbi,
        functionName: 'transferRegistration',
        args: [binding.namehash as `0x${string}`, ZERO_NAMEHASH, amountWei, 0n],
      });
    } catch (error) {
      pushTransferError(getErrorMessage(error));
      setReclaimingNamehash(null);
    }
  };

  const handleTransferDurationInputChange = (field: DurationField, value: string) => {
    setTransferDurationDirty(true);
    setTransferDurationInputs((prev) => {
      const updated: DurationInputValues = { ...prev, [field]: value };
      if (
        BASE_DURATION_FIELDS.includes(field) &&
        value !== DURATION_INPUT_DEFAULTS[field as DurationField]
      ) {
        PRECISION_DURATION_FIELDS.forEach((precisionField) => {
          updated[precisionField] = '0';
        });
      }
      return updated;
    });
  };

  const handleTransferDurationInputBlur = (field: DurationField) => {
    setTransferDurationInputs((prev) => {
      if (prev[field] === '' || Number.isNaN(Number(prev[field]))) {
        return { ...prev, [field]: '0' };
      }
      return prev;
    });
  };

  const handleTransferEndDateChange = (value: Date | null) => {
    setTransferDurationDirty(true);
    setTransferEndDateInput(value);
  };

  const handleTransferEndTimeChange = (value: string) => {
    setTransferDurationDirty(true);
    setTransferEndTimeDirty(true);
    setTransferEndTimeInput(value);
  };

  const handleTransferDurationModeChange = (mode: DurationMode) => {
    setTransferDurationDirty(true);
    setTransferDurationMode(mode);
  };

  useEffect(() => {
    if (isTransferConfirmed) {
      setDstNameInput('');
      setTransferAmountInput('');
      setTransferDurationInputs(createDefaultDurationInputsAtLeastMin(minLockDurationSeconds));
      setTransferDurationMode('end-date');
      setTransferEndDateInput(transferEndDateMin);
      setTransferEndTimeDirty(false);
      lastTransferSyncedSeconds.current = null;
      void refreshLockStatus();
      setUserSetBindView(false);
      setBindView('details');
    }
  }, [isTransferConfirmed, refreshLockStatus, minLockDurationSeconds, transferEndDateMin]);

  useEffect(() => {
    if (isTransferConfirmed && transferTxHash) {
      setTransferSuccessHash(transferTxHash);
      setUserSetBindView(false);
      setBindView('details');
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

    const hasDestinationName = dstNameInput.trim().length > 0;
    if (!hasDestinationName) {
      pushTransferError('Enter a destination name.');
      return;
    }

    if (bindView !== 'extend') {
      if (!transferAmountInput) {
        pushTransferError('Enter an amount to bind.');
        return;
      }
    }
    const amountNumber = Number(transferAmountInput || '0');
    if (!Number.isFinite(amountNumber) || amountNumber < 0) {
      pushTransferError('Enter a valid HYPR amount to bind.');
      return;
    }
    if (bindView !== 'extend' && amountNumber <= 0) {
      pushTransferError('Enter a valid HYPR amount to bind.');
      return;
    }

    const dstHash = resolveNamehash(dstNameInput);
    const dstIsDefault = dstHash === ZERO_NAMEHASH;
    if (dstIsDefault) {
      pushTransferError('Destination name is unknown. Please choose a registered name.');
      return;
    }
    const targetBinding =
      bindView === 'add-hypr' || bindView === 'extend'
        ? bindings.find((binding) => binding.namehash.toLowerCase() === dstHash.toLowerCase())
        : undefined;
    if (bindView === 'add-hypr') {
      if (!targetBinding) {
        pushTransferError('Binding not found to add HYPR.');
        return;
      }
      if ((targetBinding.remaining_seconds ?? 0) === 0) {
        pushTransferError('Cannot add HYPR to an expired binding.');
        return;
      }
    }
    const bindingExists = bindings.some(
      (binding) => binding.namehash.toLowerCase() === dstHash.toLowerCase(),
    );
    if (bindingExists && bindView !== 'extend' && bindView !== 'add-hypr') {
      pushTransferError('A binding already exists for this name.');
      return;
    }
    const maxAmountWei = parseEther(transferAmountInput);
    if (availableToBind && amountNumber > 0) {
      const availableWei = BigInt(availableToBind.amount_raw_wei);
      if (maxAmountWei > availableWei) {
        pushTransferError('Amount exceeds HYPR available to bind.');
        return;
      }
    }

    if (bindView !== 'add-hypr') {
      if (!transferEndDateInput) {
        pushTransferError('Select an end date.');
        return;
      }
      if (!transferEndDateDurationSeconds) {
        pushTransferError('Select an end date within the allowed range.');
        return;
      }

      if (selectedTransferDurationSeconds < minDurationSecondsBigInt) {
        pushTransferError(`Duration must be at least ${formatDurationSeconds(minLockDurationSeconds)}.`);
        return;
      }
      if (selectedTransferDurationSeconds > BigInt(MAX_LOCK_DURATION_SECONDS)) {
        pushTransferError(
          `Duration must be less than or equal to ${formatDurationSeconds(MAX_LOCK_DURATION_SECONDS)}.`,
        );
        return;
      }
    }

    try {
      try {
        const resolvedDestination = await CallerApp.lookup_name(dstHash);
        if (!resolvedDestination || resolvedDestination.trim() === '') {
          pushTransferError('Destination name is unknown. Please choose a registered name.');
          return;
        }
      } catch (lookupError) {
        pushTransferError('Unable to validate destination name. Please try again.');
        return;
      }

      let durationForSubmission = selectedTransferDurationSeconds;
      if (bindView === 'add-hypr' && targetBinding) {
        durationForSubmission = BigInt(targetBinding.remaining_seconds ?? 0);
      }
      await writeTransferContract({
        address: targetRegistryAddress,
        abi: transferRegistrationAbi,
        functionName: 'transferRegistration',
        args: [ZERO_NAMEHASH, dstHash, maxAmountWei, durationForSubmission],
      });
    } catch (error) {
      pushTransferError(getErrorMessage(error));
    }
  };

  return (
    <section className="step-card lock-step">
      <div className="lock-grid">
        <div className="lock-card">
          <div className="lock-card-label">HYPR available to bind</div>
          <div className="lock-card-value">{availableToBind?.amount_formatted_hypr ?? '0 HYPR'}</div>
        </div>
      </div>

      {bindView === 'details' && (
        <div className="lock-grid">
          <div className="lock-card">
            <div className="bindings-header">
              <div className="lock-card-label">Bindings</div>
              {bindings.length > 0 && (
                <div className="bindings-sort">
                  <button
                    type="button"
                    className={`icon-button${bindingsSort.startsWith('name') ? ' active' : ''}`}
                    title={`Sort bindings ${bindingsSort === 'name-asc' ? 'Z→A' : 'A→Z'}`}
                    onClick={() =>
                      setBindingsSort((prev) => (prev === 'name-asc' ? 'name-desc' : 'name-asc'))
                    }
                  >
                    A↕
                  </button>
                  <button
                    type="button"
                    className={`icon-button${bindingsSort.startsWith('expiry') ? ' active' : ''}`}
                    title={`Sort by ${bindingsSort === 'expiry-asc' ? 'latest' : 'earliest'} expiry`}
                    onClick={() =>
                      setBindingsSort((prev) =>
                        prev === 'expiry-asc' ? 'expiry-desc' : 'expiry-asc',
                      )
                    }
                  >
                    ⏱↕
                  </button>
                </div>
              )}
            </div>
            {bindings.length === 0 ? (
              <div className="lock-card-sub">No bindings detected</div>
            ) : (
              <div className="bindings-list">
                {sortedBindings.map((binding) => {
                  const expired = (binding.remaining_seconds ?? 0) === 0;
                  const reclaimingThis =
                    expired &&
                    reclaimingNamehash === binding.namehash &&
                    (isTransferPending || isTransferConfirming);
                  return (
                    <div className={`binding-row${expired ? ' expired-card' : ''}`} key={binding.namehash}>
                      <div className="binding-name">{binding.name ?? 'Unknown name'}</div>
                      <div className="binding-amount">{binding.amount_formatted_hypr}</div>
                      <div className="binding-sub">
                        {expired
                          ? `Unbound ${formatTimestamp(binding.unlock_timestamp)}`
                          : `Unbinds ${formatTimestamp(binding.unlock_timestamp)}`}
                      </div>
                      {!expired && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => {
                            setUserSetBindView(true);
                            setBindView('extend');
                            const bindingName = binding.name ?? '';
                            setExtendBindingName(bindingName);
                            setDstNameInput(bindingName);
                            setTransferAmountInput('0');
                            setTransferDurationDirty(false);
                            setExtendBindingUnlockMs(
                              binding.unlock_timestamp ? binding.unlock_timestamp * 1000 : null,
                            );
                            if (effectiveTransferEndDateDefault) {
                              setTransferEndDateInput(effectiveTransferEndDateDefault);
                            }
                            setTransferEndTimeDirty(false);
                          }}
                        >
                          Extend binding
                        </button>
                      )}
                      {!expired && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => {
                            const bindingName = binding.name ?? '';
                            setUserSetBindView(true);
                            setBindView('add-hypr');
                            setAddHyprBindingName(bindingName);
                            setDstNameInput(bindingName);
                            setTransferAmountInput('');
                            setTransferDurationDirty(false);
                            setTransferEndDateInput(null);
                            setTransferEndTimeDirty(false);
                          }}
                        >
                          Add HYPR
                        </button>
                      )}
                      {expired && (
                        <button
                          type="button"
                          className="secondary-button warning-button"
                          disabled={isTransferPending || isTransferConfirming}
                          onClick={() => handleReclaimBinding(binding)}
                        >
                          {reclaimingThis ? <span className="spinner" /> : 'Reclaim'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {bindView === 'details' && (
        <div className="form-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setUserSetBindView(true);
              setBindView('add');
            }}
          >
            Add new binding
          </button>
        </div>
      )}

      {(bindView === 'create' || bindView === 'add' || bindView === 'extend' || bindView === 'add-hypr') && (
        <form className="lock-form" onSubmit={handleTransfer}>
          <div className="form-header">
            <div className="form-header-text">
              {bindView === 'extend' && extendBindingName && <h3>Extend {extendBindingName} binding</h3>}
              {bindView === 'add-hypr' && addHyprBindingName && <h3>Add HYPR to {addHyprBindingName} binding</h3>}
              {bindView === 'create' && <h3>Create first binding</h3>}
              {bindView === 'add' && <h3>Add new binding</h3>}
            </div>
          </div>

          {bindView !== 'extend' && bindView !== 'add-hypr' && (
            <div className="input-grid">
              <label className="input-field">
                <span>Binding target</span>
                <input
                  type="text"
                  placeholder="example.name.os"
                  value={dstNameInput}
                  onChange={(event) => setDstNameInput(event.target.value)}
                />
              </label>
              <label className="input-field">
                <span>Amount (HYPR)</span>
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
          )}
          {bindView === 'add-hypr' && (
            <>
              <input type="hidden" value={dstNameInput} readOnly />
              <div className="input-grid">
                <label className="input-field">
                  <span>Amount to add (HYPR)</span>
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
              {addHyprBindingName && Number(transferAmountInput) > 0 && (
                <div className="lock-card-sub">
                  New total amount bound to {addHyprBindingName}:{' '}
                  {`${Number(transferAmountInput) + (bindings.find((b) => b.name === addHyprBindingName)?.amount_formatted_hypr
                    ? Number(bindings.find((b) => b.name === addHyprBindingName)!.amount_formatted_hypr.split(' ')[0])
                    : 0)} HYPR`}
                </div>
              )}
            </>
          )}
          {bindView === 'extend' && (
            <>
              <input type="hidden" value={dstNameInput} readOnly />
              <input type="hidden" value={transferAmountInput} readOnly />
            </>
          )}
          {bindView === 'add-hypr' && (
            <>
              <input type="hidden" value={dstNameInput} readOnly />
            </>
          )}

      {shouldShowTransferEndInputs && (
        <DurationInputs
          values={transferDurationInputs}
          onChange={handleTransferDurationInputChange}
          onBlurField={handleTransferDurationInputBlur}
          showPrecision={showTransferPrecision}
          onTogglePrecision={() => setShowTransferPrecision((prev) => !prev)}
          durationSeconds={selectedTransferDurationSeconds}
          unlockPreview={transferUnlockPreview}
          mode={transferDurationMode}
          onModeChange={handleTransferDurationModeChange}
          endDateValue={transferEndDateInput}
          onEndDateChange={handleTransferEndDateChange}
          endDateMin={transferEndDateMin}
          endDateMax={transferEndDateMax}
          onEndTimeChange={handleTransferEndTimeChange}
          endTimeValue={transferEndTimeInput}
          endDateLabel="Select end date"
          endTimeLabel="Select end time"
          timestampLabel="Unbind timestamp"
          showSummary={false}
          showUnlockPreview={false}
          endDateRangeLabel={
            roundUpToNextDay(bindHintMinMs).getTime() < roundDownToDay(bindHintMaxMs).getTime()
              ? `From ${formatDateIso(roundUpToNextDay(bindHintMinMs))} to ${formatDateIso(
                  roundDownToDay(bindHintMaxMs),
                )}`
              : undefined
          }
          showModeToggle={false}
        />
      )}
          <div className="form-actions">
            <button type="submit" className="secondary-button" disabled={bindButtonDisabled}>
              {isTransferPending || isTransferConfirming ? (
                <span className="spinner" />
              ) : bindView === 'extend' ? (
                'Update binding'
              ) : bindView === 'add' ? (
                'Create binding'
              ) : bindView === 'add-hypr' ? (
                'Update binding'
              ) : (
                'Create binding'
              )}
            </button>
            {hasBindings && (
              <button
                type="button"
                className="secondary-button ghost"
                onClick={() => {
                  setUserSetBindView(true);
                  setBindView('details');
                }}
              >
                Back to bindings
              </button>
            )}
          </div>
        </form>
      )}

      {bindView === 'details' && (
        <>
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
        </>
      )}

      {(bindView === 'create' || bindView === 'add') && (
        <>
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
        </>
      )}
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
  computedDurationLabel?: string | null;
  computedUnlockLabel?: string | null;
  resolvedDurationLabel?: string | null;
  mode: DurationMode;
  onModeChange: (mode: DurationMode) => void;
  endDateValue: Date | null;
  onEndDateChange: (value: Date | null) => void;
  onEndTimeChange?: (value: string) => void;
  endTimeValue?: string;
  endDateMin?: Date;
  endDateMax?: Date;
  showUnlockPreview?: boolean;
  endDateLabel?: string;
  endTimeLabel?: string;
  timestampLabel?: string;
  showSummary?: boolean;
  durationRangeLabel?: string;
  endDateRangeLabel?: string;
  showModeToggle?: boolean;
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

const formatDateIso = (date: Date) => date.toISOString().slice(0, 10);

const roundUpToNextDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() < ms) {
    d.setDate(d.getDate() + 1);
  }
  return d;
};

const roundDownToDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
};

const DurationInputs = ({
  values,
  onChange,
  onBlurField,
  showPrecision,
  onTogglePrecision,
  durationSeconds,
  unlockPreview,
  computedDurationLabel,
  computedUnlockLabel,
  resolvedDurationLabel,
  mode,
  onModeChange,
  endDateValue,
  onEndDateChange,
  onEndTimeChange,
  endTimeValue,
  endDateMin,
  endDateMax,
  showUnlockPreview = true,
  endDateLabel = 'New end date',
  endTimeLabel = 'New end time',
  timestampLabel = 'Unlock timestamp',
  showSummary = true,
  durationRangeLabel,
  endDateRangeLabel,
  showModeToggle = true,
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
      {showModeToggle && (
        <div className="duration-mode-toggle">
          {mode === 'duration' && (
            <button
              type="button"
              className="active"
              onClick={() => onModeChange('duration')}
            >
              Duration
            </button>
          )}
          {mode === 'end-date' && (
            <button
              type="button"
              className="active"
              onClick={() => onModeChange('end-date')}
            >
              End date
            </button>
          )}
        </div>
      )}
      {mode === 'duration' && durationRangeLabel && (
        <p className="duration-range-sub">{durationRangeLabel}</p>
      )}
      {mode === 'end-date' && endDateRangeLabel && (
        <p className="duration-range-sub">{endDateRangeLabel}</p>
      )}
      {mode === 'duration' ? (
        <>
          <div className="duration-grid">{BASE_DURATION_FIELDS.map((field) => renderField(field))}</div>
          {showPrecision && (
            <div className="duration-grid">
              {PRECISION_DURATION_FIELDS.map((field) => renderField(field))}
            </div>
          )}
          <button type="button" className="link-button" onClick={onTogglePrecision}>
            {showPrecision ? 'Hide optional precision' : 'Optional precision duration'}
          </button>
        </>
      ) : (
        <>
          <label className="input-field">
            <span>{endDateLabel}</span>
            <DatePicker
              selected={endDateValue}
              onChange={onEndDateChange}
              dateFormat="yyyy-MM-dd"
              minDate={endDateMin}
              maxDate={endDateMax}
              className="date-picker-input"
              calendarClassName="date-picker-calendar"
              popperClassName="date-picker-popper"
            />
          </label>
          <label className="input-field">
            <span>{endTimeLabel}</span>
            <input
              type="time"
              step="1"
              value={endTimeValue ?? ''}
              onChange={(event) => onEndTimeChange?.(event.target.value)}
              className="date-picker-time-input"
            />
          </label>
        </>
      )}
      {showSummary && (
        <div className="duration-summary">
          {showUnlockPreview && !computedUnlockLabel && (
            <span>
              {timestampLabel}: {unlockText}
            </span>
          )}
          {!computedDurationLabel && <span>Duration total: {durationLabel}</span>}
          {computedUnlockLabel && <span>Requested final unlock: {computedUnlockLabel}</span>}
          {computedDurationLabel && <span>Requested final duration: {computedDurationLabel}</span>}
          {resolvedDurationLabel && (
            <span>(Duration to be supplied to tx): {resolvedDurationLabel}</span>
          )}
        </div>
      )}
    </div>
  );
};

const TopStatusBar = () => (
  <div className="top-banner">
    <ConnectButton chainStatus="icon" showBalance={false} />
  </div>
);

const shortHash = (hash: `0x${string}`) => `${hash.slice(0, 8)}…${hash.slice(-6)}`;

const formatTimestamp = (seconds: number) => {
  if (!seconds) return '0';
  if (seconds === Number.MAX_SAFE_INTEGER) return 'Unknown';
  const d = new Date(seconds * 1000);
  const pad = (v: number) => v.toString().padStart(2, '0');
  const hours24 = d.getHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hours12)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm}`;
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

const secondsUntilDate = (target: Date | null, baseSeconds: number) => {
  if (!target) {
    return null;
  }
  const diffSeconds = Math.floor(target.getTime() / 1000) - baseSeconds;
  if (diffSeconds <= 0) {
    return null;
  }
  return BigInt(diffSeconds);
};

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Action failed.');

const formatHyprWei = (wei: bigint) => {
  if (wei === 0n) return '0 HYPR';
  const digits = wei.toString().padStart(19, '0');
  const whole = digits.slice(0, -18).replace(/^0+/, '') || '0';
  const frac = digits.slice(-18).replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac} HYPR` : `${whole} HYPR`;
};

export default App;
