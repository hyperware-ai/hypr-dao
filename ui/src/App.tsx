import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    description: 'Commit some or all of your HYPR to the Registry to enable binding.',
    icon: 'lock',
  },
  {
    id: 'bind',
    title: 'Bind',
    description: 'Distribute locked HYPR to named bindings.',
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
                    <h2 className="step-heading">{activeStepTitle}</h2>
                    <button
                      type="button"
                      className="refresh-inline-button"
                      disabled={isLoading}
                      onClick={refreshLockStatus}
                    >
                      {isLoading ? <span className="spinner" /> : 'Refresh values'}
                    </button>
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
                      onRequireLockInfo={(resume) => showLockInfoModal(resume)}
                      minLockDurationSeconds={minLockDurationSeconds}
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
}: LockStepProps) => {
  const [amountInput, setAmountInput] = useState('');
  const [durationInputs, setDurationInputs] = useState<DurationInputValues>(createDefaultDurationInputs);
  const [lockDurationMode, setLockDurationMode] = useState<DurationMode>('duration');
  const [lockEndDateInput, setLockEndDateInput] = useState<Date | null>(null);
  const [showLockPrecision, setShowLockPrecision] = useState(false);
  const [manageError, setManageError] = useState<BannerMessage | null>(null);
  const [manageSuccessHash, setManageSuccessHash] = useState<`0x${string}` | null>(null);
  const manageErrorIdRef = useRef(0);
  const manageErrorRef = useRef<HTMLDivElement | null>(null);
  const manageSuccessRef = useRef<HTMLDivElement | null>(null);

  const [pendingLock, setPendingLock] = useState<{ amount: bigint; duration: bigint } | null>(null);
  const allowanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nowSecondsRef = useRef(Math.floor(Date.now() / 1000));
  const nowSeconds = nowSecondsRef.current;

  const durationParts = useMemo(() => inputsToDurationParts(durationInputs), [durationInputs]);
  const lockedAmountWei = lockDetails?.amount_raw_wei ? BigInt(lockDetails.amount_raw_wei) : 0n;
  const hasExistingLock = lockedAmountWei > 0n;
  const lastDefaultDurationSeconds = useRef<number | null>(null);
  useEffect(() => {
    if (!hasExistingLock || !lockDetails) {
      lastDefaultDurationSeconds.current = null;
      return;
    }
    const remainingSeconds = lockDetails.remaining_seconds ?? 0;
    if (remainingSeconds === 0 || lastDefaultDurationSeconds.current === remainingSeconds) {
      return;
    }
    const parts = durationInputsFromSeconds(BigInt(remainingSeconds));
    setDurationInputs(parts);
    setLockEndDateInput(new Date(lockDetails.unlock_timestamp * 1000));
    lastDefaultDurationSeconds.current = remainingSeconds;
  }, [hasExistingLock, lockDetails]);
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
  useEffect(() => {
    if (lockDurationMode === 'end-date' && !lockEndDateInput) {
      setLockEndDateInput(lockEndDateMin);
    }
  }, [lockDurationMode, lockEndDateInput, lockEndDateMin]);
  const lockEndDateDurationSeconds = secondsUntilDate(lockEndDateInput, nowSeconds);
  const selectedLockDurationSeconds =
    lockDurationMode === 'duration'
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

  const pushManageError = useCallback(
    (message: string) => {
      manageErrorIdRef.current += 1;
      setManageError({ id: manageErrorIdRef.current, text: message });
    },
    [setManageError],
  );

  useEffect(() => {
    if (allowanceWriteError) {
      pushManageError(getErrorMessage(allowanceWriteError));
      setPendingLock(null);
    }
  }, [allowanceWriteError, pushManageError]);

  useEffect(() => {
    if (manageWriteError) {
      pushManageError(getErrorMessage(manageWriteError));
    }
  }, [manageWriteError, pushManageError]);

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
      setLockDurationMode('duration');
      setLockEndDateInput(null);
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

  const lockHeaderTitle = hasExistingLock ? 'Manage lock' : 'Create HYPR lock';
  const lockHeaderSubtitle = hasExistingLock
    ? 'Add HYPR to existing locked balance, or extend the current duration (enter 0 for HYPR amount).'
    : 'Lock an amount of HYPR for a specified duration to use in bindings.';
  const allowZeroAmount = hasExistingLock;
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
  const hasValidEndDate = lockDurationMode === 'duration' ? true : Boolean(lockEndDateDurationSeconds);
  const zeroAmountExtendingOnly =
    hasExistingLock && additionalAmountWei === 0n && existingDurationSeconds > 0n;
  const durationLessThanExisting =
    zeroAmountExtendingOnly && selectedLockDurationSeconds < existingDurationSeconds;
  const lockButtonDisabled =
    !walletConnected ||
    isManagePending ||
    isManageConfirming ||
    isAllowancePending ||
    isAllowanceConfirming ||
    !amountProvided ||
    (!allowZeroAmount && amountValue <= 0) ||
    !hasValidEndDate ||
    durationLessThanExisting;
  const showLockFormContent =
    amountProvided && (amountValue > 0 || (allowZeroAmount && amountValue === 0));
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

  return (
    <section className="step-card lock-step">
      <div className="lock-grid">
        <LockMetric label="HYPR owned" value={hyprOwned?.amount_formatted_hypr ?? 'Loading…'} />
      </div>

      {hasAllowance && tokeregistryAllowance && (
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

      <div className="lock-grid">
        {lockDetails && hasExistingLock ? (
          <div className="lock-detail-card">
            <div className="lock-card lock-detail-stat">
              <span className="lock-card-label">Locked amount</span>
              <span className="lock-card-value">{lockDetails.amount_formatted_hypr}</span>
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
            <p>Lock HYPR to enable binding. Once HYPR has been locked it will appear here.</p>
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
            durationSeconds={selectedLockDurationSeconds}
            unlockPreview={lockUnlockPreview}
            computedDurationLabel={
              hasExistingLock ? formatSeconds(Number(selectedLockDurationSeconds)) : undefined
            }
            computedUnlockLabel={
              hasExistingLock ? lockUnlockPreview ?? undefined : undefined
            }
            resolvedDurationLabel={
              hasExistingLock && additionalAmountWei > 0n
                ? formatSeconds(Number(requiredDurationSeconds))
                : undefined
            }
            mode={lockDurationMode}
            onModeChange={setLockDurationMode}
            endDateValue={lockEndDateInput}
            onEndDateChange={setLockEndDateInput}
            endDateMin={lockEndDateMin}
            endDateMax={lockEndDateMax}
            showUnlockPreview={!hasExistingLock}
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
  lockDetails: LockDetailsView | null;
  bindings: BindingView[];
  refreshLockStatus: () => Promise<void>;
  minLockDurationSeconds: number;
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
}: BindStepProps) => {
  const [srcNameInput, setSrcNameInput] = useState('');
  const [dstNameInput, setDstNameInput] = useState('');
  const [transferAmountInput, setTransferAmountInput] = useState('');
  const [transferDurationInputs, setTransferDurationInputs] = useState<DurationInputValues>(
    createDefaultDurationInputs,
  );
  const [transferDurationMode, setTransferDurationMode] = useState<DurationMode>('duration');
  const [transferEndDateInput, setTransferEndDateInput] = useState<Date | null>(null);
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
  const transferDurationSecondsFromInputs = useMemo(
    () => durationPartsToSeconds(transferDurationParts),
    [transferDurationParts],
  );
  const transferNowSecondsRef = useRef(Math.floor(Date.now() / 1000));
  const transferNowSeconds = transferNowSecondsRef.current;
  const minDurationSecondsBigInt = BigInt(minLockDurationSeconds);
  const transferEndDateMin = useMemo(
    () => new Date((transferNowSeconds + minLockDurationSeconds) * 1000),
    [transferNowSeconds, minLockDurationSeconds],
  );
  const transferEndDateMax = useMemo(
    () => new Date((transferNowSeconds + MAX_LOCK_DURATION_SECONDS) * 1000),
    [transferNowSeconds],
  );
  useEffect(() => {
    if (transferDurationMode === 'end-date' && !transferEndDateInput) {
      setTransferEndDateInput(transferEndDateMin);
    }
  }, [transferDurationMode, transferEndDateInput, transferEndDateMin]);
  const transferEndDateDurationSeconds = secondsUntilDate(transferEndDateInput, transferNowSeconds);
  const selectedTransferDurationSeconds =
    transferDurationMode === 'duration'
      ? transferDurationSecondsFromInputs
      : transferEndDateDurationSeconds ?? 0n;
  const hasTransferValidEndDate =
    transferDurationMode === 'duration' ? true : Boolean(transferEndDateDurationSeconds);
  const transferUnlockPreview = useMemo(() => {
    if (selectedTransferDurationSeconds <= 0n) {
      return null;
    }
    return formatTimestamp(transferNowSeconds + Number(selectedTransferDurationSeconds));
  }, [selectedTransferDurationSeconds, transferNowSeconds]);

  const destinationHash = useMemo(() => resolveNamehash(dstNameInput), [dstNameInput]);
  const destinationHasActiveBinding = useMemo(() => {
    if (destinationHash === ZERO_NAMEHASH) {
      return false;
    }
    return bindings.some(
      (binding) =>
        binding.namehash.toLowerCase() === destinationHash.toLowerCase() &&
        (binding.remaining_seconds ?? 0) > 0,
    );
  }, [bindings, destinationHash]);
  const transferAmountProvided = transferAmountInput !== '';
  const transferAmountValue = transferAmountProvided ? Number(transferAmountInput) : NaN;
  const transferAmountIsValid = transferAmountProvided && Number.isFinite(transferAmountValue);
  const shouldShowTransferDuration =
    transferAmountIsValid && (transferAmountValue > 0 || destinationHasActiveBinding);
  const bindButtonDisabled =
    !walletConnected ||
    isTransferPending ||
    isTransferConfirming ||
    !hasTransferValidEndDate ||
    !transferAmountProvided ||
    !transferAmountIsValid ||
    (transferAmountValue <= 0 && !destinationHasActiveBinding);

  const pushTransferError = (message: string) => {
    transferErrorIdRef.current += 1;
    setTransferError({ id: transferErrorIdRef.current, text: message });
  };

  const handleTransferDurationInputChange = (field: DurationField, value: string) => {
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

  useEffect(() => {
    if (isTransferConfirmed) {
      setSrcNameInput('');
      setDstNameInput('');
      setTransferAmountInput('');
      setTransferDurationInputs(createDefaultDurationInputs());
      setTransferDurationMode('duration');
      setTransferEndDateInput(null);
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

    if (!transferAmountInput) {
      pushTransferError('Enter an amount to bind.');
      return;
    }
    const amountNumber = Number(transferAmountInput);
    if (!Number.isFinite(amountNumber) || amountNumber < 0) {
      pushTransferError('Enter a valid HYPR amount to bind.');
      return;
    }
    if (amountNumber === 0 && !destinationHasActiveBinding) {
      pushTransferError('Zero HYPR can only be bound to an existing active binding.');
      return;
    }

    const srcHash = resolveNamehash(srcNameInput);
    const maxAmountWei = parseEther(transferAmountInput);
    if (srcHash !== ZERO_NAMEHASH) {
      const sourceBinding = bindings.find(
        (binding) => binding.namehash.toLowerCase() === srcHash.toLowerCase(),
      );
      if (!sourceBinding) {
        pushTransferError('Source binding is unknown.');
        return;
      }
      if ((sourceBinding.remaining_seconds ?? 0) > 0) {
        pushTransferError('Source binding has not expired yet.');
        return;
      }
      const sourceAmountWei = BigInt(sourceBinding.amount_raw_wei);
      if (maxAmountWei > sourceAmountWei) {
        pushTransferError('Amount exceeds HYPR available in the expired source binding.');
        return;
      }
    }
    if (availableToBind) {
      const availableWei = BigInt(availableToBind.amount_raw_wei);
      if (maxAmountWei > availableWei) {
        pushTransferError('Amount exceeds HYPR available to bind.');
        return;
      }
    }

    if (transferDurationMode === 'end-date') {
      if (!transferEndDateInput) {
        pushTransferError('Select an end date.');
        return;
      }
      if (!transferEndDateDurationSeconds) {
        pushTransferError('Select an end date within the allowed range.');
        return;
      }
    }

    if (selectedTransferDurationSeconds <= 0n) {
      pushTransferError('Enter a positive duration.');
      return;
    }
    if (selectedTransferDurationSeconds < minDurationSecondsBigInt) {
      pushTransferError(`Duration must be at least ${formatDurationSeconds(minLockDurationSeconds)}.`);
      return;
    }
    if (selectedTransferDurationSeconds > BigInt(MAX_LOCK_DURATION_SECONDS)) {
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

      await writeTransferContract({
        address: targetRegistryAddress,
        abi: transferRegistrationAbi,
        functionName: 'transferRegistration',
        args: [srcHash, dstHash, maxAmountWei, selectedTransferDurationSeconds],
      });
    } catch (error) {
        pushTransferError(getErrorMessage(error));
    }
  };

  const maxBindingExpiry = lockDetails
    ? formatTimestamp(lockDetails.unlock_timestamp)
    : 'No lock detected';
  const maxBindingSub = lockDetails
    ? lockDetails.remaining_seconds === Number.MAX_SAFE_INTEGER
      ? 'Unknown remaining time'
      : `${formatSeconds(lockDetails.remaining_seconds)} remaining`
    : 'Lock HYPR to enable max expiry';

  return (
    <section className="step-card lock-step">
      <div className="lock-grid">
        <div className="lock-card">
          <div className="lock-card-label">HYPR available to bind</div>
          <div className="lock-card-value">{availableToBind?.amount_formatted_hypr ?? '0 HYPR'}</div>
          <div className="lock-card-divider" />
          <div className="lock-card-label">Max binding expiry date</div>
          <div className="lock-card-value">{maxBindingExpiry}</div>
          <div className="lock-card-sub">{maxBindingSub}</div>
        </div>
        <div className="lock-card">
          <div className="lock-card-label">Bindings</div>
          {bindings.length === 0 ? (
            <div className="lock-card-sub">No bindings detected</div>
          ) : (
            <div className="bindings-list">
              {bindings.map((binding) => (
                <div className="binding-row" key={binding.namehash}>
                  <div className="binding-name">{binding.name ?? 'Unknown name'}</div>
                  <div className="binding-amount">{binding.amount_formatted_hypr}</div>
                  <div className="binding-sub">Unlocks {formatTimestamp(binding.unlock_timestamp)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <form className="lock-form" onSubmit={handleTransfer}>
        <div className="form-header">
          <div>
            <h3>Bind HYPR</h3>
            <p>Bind HYPR from your available balance (or from expired bindings) to a named destination.</p>
          </div>
        </div>
        <div className="input-grid">
          <label className="input-field">
              <span>Source name</span>
              <input
                type="text"
                placeholder="optional.expired.bind.os"
                value={srcNameInput}
                onChange={(event) => setSrcNameInput(event.target.value)}
              />
          </label>
          <label className="input-field">
              <span>Destination name</span>
              <input
                type="text"
                placeholder="example.name.os"
                value={dstNameInput}
                onChange={(event) => setDstNameInput(event.target.value)}
                required
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
    {shouldShowTransferDuration && (
      <DurationInputs
        values={transferDurationInputs}
        onChange={handleTransferDurationInputChange}
        onBlurField={handleTransferDurationInputBlur}
            showPrecision={showTransferPrecision}
            onTogglePrecision={() => setShowTransferPrecision((prev) => !prev)}
            durationSeconds={selectedTransferDurationSeconds}
            unlockPreview={transferUnlockPreview}
            mode={transferDurationMode}
            onModeChange={setTransferDurationMode}
            endDateValue={transferEndDateInput}
            onEndDateChange={setTransferEndDateInput}
            endDateMin={transferEndDateMin}
            endDateMax={transferEndDateMax}
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
        <div className="form-actions">
          <button type="submit" className="secondary-button" disabled={bindButtonDisabled}>
            {isTransferPending || isTransferConfirming ? <span className="spinner" /> : 'Bind'}
          </button>
        </div>
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
  computedDurationLabel?: string | null;
  computedUnlockLabel?: string | null;
  resolvedDurationLabel?: string | null;
  mode: DurationMode;
  onModeChange: (mode: DurationMode) => void;
  endDateValue: Date | null;
  onEndDateChange: (value: Date | null) => void;
  endDateMin?: Date;
  endDateMax?: Date;
  showUnlockPreview?: boolean;
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
  computedDurationLabel,
  computedUnlockLabel,
  resolvedDurationLabel,
  mode,
  onModeChange,
  endDateValue,
  onEndDateChange,
  endDateMin,
  endDateMax,
  showUnlockPreview = true,
}: DurationInputsProps) => {
  const SecondsTimeInput = ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  }) => (
    <input
      type="time"
      step="1"
      value={value ?? ''}
      onChange={(event) => onChange?.(event)}
      className="date-picker-time-input"
    />
  );

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
      <div className="duration-mode-toggle">
        <button
          type="button"
          className={mode === 'duration' ? 'active' : ''}
          onClick={() => onModeChange('duration')}
        >
          Duration
        </button>
        <button
          type="button"
          className={mode === 'end-date' ? 'active' : ''}
          onClick={() => onModeChange('end-date')}
        >
          End date
        </button>
      </div>
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
        <label className="input-field">
          <span>Select end date</span>
          <DatePicker
            selected={endDateValue}
            onChange={onEndDateChange}
            showTimeInput
            timeInputLabel="Time"
            customTimeInput={<SecondsTimeInput />}
            dateFormat="yyyy-MM-dd HH:mm:ss"
            minDate={endDateMin}
            maxDate={endDateMax}
            className="date-picker-input"
            calendarClassName="date-picker-calendar"
            popperClassName="date-picker-popper"
          />
        </label>
      )}
      <div className="duration-summary">
        {showUnlockPreview && !computedUnlockLabel && <span>Unlock timestamp: {unlockText}</span>}
        {!computedDurationLabel && <span>Duration total: {durationLabel}</span>}
        {computedUnlockLabel && <span>Requested final unlock: {computedUnlockLabel}</span>}
        {computedDurationLabel && <span>Requested final duration: {computedDurationLabel}</span>}
        {resolvedDurationLabel && (
          <span>(Duration to be supplied to tx): {resolvedDurationLabel}</span>
        )}
      </div>
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

export default App;
