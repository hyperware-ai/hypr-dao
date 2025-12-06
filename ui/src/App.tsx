import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useReconnect, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { concatHex, keccak256, parseEther, stringToBytes } from 'viem';
import './App.css';
import { useBindAndLockStore } from './store/lock_and_bind';
import type { BalanceView, BindingView, LockDetailsView } from './types/lock_and_bind';
import { HyprDao as CallerApp } from '#caller-utils';

const simulationMode = import.meta.env.VITE_SIMULATION_MODE === 'true';

type StepId = 'lock' | 'bind';
type StepIcon = 'check' | 'lock' | 'chain';
type LockView = 'details' | 'manage' | 'extend' | 'approve';

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

const MAX_LOCK_DURATION_SECONDS = 4 * 52 * 7 * 24 * 60 * 60; // ~4 years
const ZERO_NAMEHASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
const CHAIN_LABELS: Record<number, string> = {
  [base.id]: 'Base',
};
const FALLBACK_CHAIN_ID = base.id;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const COLLAPSE_BUFFER_MS = 2 * 60 * 1000;
const normalizeToMinute = (ms: number) => {
  const d = new Date(ms);
  d.setSeconds(0, 0);
  return d.getTime();
};

type DurationField = 'years' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds';
type DurationMode = 'duration' | 'end-date';

const MOBILE_DURATION_OPTIONS: { label: string; seconds: number; value: string }[] = [
  { label: '10 minutes', seconds: 10 * SECONDS_PER_MINUTE, value: '10m' },
  { label: '1 hour', seconds: 1 * SECONDS_PER_HOUR, value: '1h' },
  { label: '3 hours', seconds: 3 * SECONDS_PER_HOUR, value: '3h' },
  { label: '12 hours', seconds: 12 * SECONDS_PER_HOUR, value: '12h' },
  { label: '1 day', seconds: 1 * SECONDS_PER_DAY, value: '1d' },
  { label: '3 days', seconds: 3 * SECONDS_PER_DAY, value: '3d' },
  { label: '1 week', seconds: 1 * SECONDS_PER_WEEK, value: '1w' },
  { label: '2 weeks', seconds: 2 * SECONDS_PER_WEEK, value: '2w' },
  { label: '3 weeks', seconds: 3 * SECONDS_PER_WEEK, value: '3w' },
  { label: '4 weeks', seconds: 4 * SECONDS_PER_WEEK, value: '4w' },
  { label: '1 month', seconds: 1 * SECONDS_PER_MONTH, value: '1mo' },
  { label: '2 months', seconds: 2 * SECONDS_PER_MONTH, value: '2mo' },
  { label: '3 months', seconds: 3 * SECONDS_PER_MONTH, value: '3mo' },
  { label: '4 months', seconds: 4 * SECONDS_PER_MONTH, value: '4mo' },
  { label: '6 months', seconds: 6 * SECONDS_PER_MONTH, value: '6mo' },
  { label: '9 months', seconds: 9 * SECONDS_PER_MONTH, value: '9mo' },
  { label: '1 year', seconds: 1 * SECONDS_PER_YEAR, value: '1y' },
  { label: '2 years', seconds: 2 * SECONDS_PER_YEAR, value: '2y' },
  { label: '3 years', seconds: 3 * SECONDS_PER_YEAR, value: '3y' },
  { label: '4 years', seconds: 4 * SECONDS_PER_YEAR, value: '4y' },
];

const formatTimeFromDate = (date: Date) => {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
};

const formatShortDateLabel = (date: Date) => {
  const mm = MONTH_ABBR[date.getMonth()];
  const dd = String(date.getDate()).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  return `${mm} ${dd} '${yy}`;
};

const buildSpecialDateOptions = () => {
  const now = new Date();
  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);
  type SpecialCandidate = { date: Date; legend: string };
  const candidates: SpecialCandidate[] = [];

  const nextWeekday = (weekday: number, start: Date) => {
    const d = new Date(start);
    d.setDate(d.getDate() + 1);
    while (d.getDay() !== weekday) {
      d.setDate(d.getDate() + 1);
    }
    d.setHours(23, 55, 0, 0);
    return d;
  };

  const endOfMonthAfter = (start: Date) => {
    const d = new Date(start);
    const year = d.getFullYear();
    const month = d.getMonth();
    let candidate = new Date(year, month + 1, 0);
    candidate.setHours(23, 55, 0, 0);
    return candidate;
  };

  const endOfQuarterAfter = (start: Date) => {
    const d = new Date(start);
    let year = d.getFullYear();
    const month = d.getMonth();
    const quarterEndMonths = [2, 5, 8, 11];
    let targetMonth = quarterEndMonths.find((m) => m >= month) ?? 2;
    if (targetMonth < month) {
      year += 1;
    }
    if (targetMonth < month && targetMonth !== 2) {
      targetMonth = 2;
    }
    let candidate = new Date(year, targetMonth + 1, 0);
    candidate.setHours(23, 55, 0, 0);
    if (candidate.getTime() <= start.getTime()) {
      const nextMonth = targetMonth === 11 ? 2 : quarterEndMonths[quarterEndMonths.indexOf(targetMonth) + 1] ?? 2;
      year = targetMonth === 11 ? year + 1 : year;
      candidate = new Date(year, nextMonth + 1, 0);
      candidate.setHours(23, 55, 0, 0);
    }
    return candidate;
  };

  const endOfYearAfter = (start: Date, offsetYears: number) => {
    const year = start.getFullYear() + offsetYears;
    const candidate = new Date(year, 12, 0);
    candidate.setHours(23, 55, 0, 0);
    if (candidate.getTime() <= start.getTime()) {
      const next = new Date(year + 1, 12, 0);
      next.setHours(23, 55, 0, 0);
      return next;
    }
    return candidate;
  };

  const firstFriday = nextWeekday(5, todayMidnight);
  const secondFriday = new Date(firstFriday);
  secondFriday.setDate(firstFriday.getDate() + 7);
  candidates.push({ date: firstFriday, legend: 'upcoming Friday' });
  candidates.push({ date: secondFriday, legend: 'Friday of upcoming week' });

  const endMonth = endOfMonthAfter(todayMidnight);
  const endNextMonth = endOfMonthAfter(new Date(endMonth.getFullYear(), endMonth.getMonth() + 1, 1));
  candidates.push({ date: endMonth, legend: 'end of this month' });
  candidates.push({ date: endNextMonth, legend: 'end of next month' });

  const firstQuarterEnd = endOfQuarterAfter(todayMidnight);
  const nextQuarterStart = new Date(firstQuarterEnd);
  nextQuarterStart.setDate(nextQuarterStart.getDate() + 1);
  const secondQuarterEnd = endOfQuarterAfter(nextQuarterStart);
  candidates.push({ date: firstQuarterEnd, legend: 'end of this quarter' });
  candidates.push({ date: secondQuarterEnd, legend: 'end of next quarter' });

  const yearEnd1 = endOfYearAfter(todayMidnight, 0);
  const yearEnd2 = endOfYearAfter(todayMidnight, 1);
  const yearEnd3 = endOfYearAfter(todayMidnight, 2);
  candidates.push({ date: yearEnd1, legend: 'end of this year' });
  candidates.push({ date: yearEnd2, legend: 'end of next year' });
  candidates.push({ date: yearEnd3, legend: 'end of year after next' });

  const deduped = new Map<number, SpecialCandidate>();
  candidates.forEach((candidate) => {
    const ts = new Date(candidate.date).setHours(0, 0, 0, 0);
    if (!deduped.has(ts)) {
      deduped.set(ts, { ...candidate, date: new Date(candidate.date) });
    }
  });

  return Array.from(deduped.values())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((entry) => ({
      label: formatShortDateLabel(entry.date),
      value: entry.date.getTime().toString(),
      date: entry.date,
      legend: entry.legend,
    }));
};

const useIsMobile = () => {
  // Force mobile experience on all clients
  return true;
};

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
  const [lockUpdateNonce, setLockUpdateNonce] = useState(0);
  const [hasBoundAnything, setHasBoundAnything] = useState(() =>
    localStorage.getItem('hypr-dao-has-bound') === 'true'
  );
  const handleLockUpdated = useCallback(() => {
    setLockUpdateNonce((prev) => prev + 1);
  }, []);
  const markHasBound = useCallback(() => {
    setHasBoundAnything(true);
    localStorage.setItem('hypr-dao-has-bound', 'true');
  }, []);
  const {
    nodeId,
    ownerAddress,
    lockDetails,
    hyprOwned,
    hyprApproved,
    tokeregistryAllowance,
    availableToBind,
    bindings,
    hyprTokenAddress,
    lastError,
    isLoading,
    error,
    initialize,
    fetchLockStatus,
    fetchBaseLockStatus,
    refreshLockStatus: refreshLockStatusRaw,
    resetWalletState,
    clearError,
    minLockDurationSeconds: minLockDurationSecondsRaw,
  } = useBindAndLockStore();
  const [initLoadTimeout, setInitLoadTimeout] = useState(false);
  const MIN_LOCK_DURATION_FALLBACK = 600; // 10 minutes - safe default
  const minLockDurationReady = minLockDurationSecondsRaw !== null;
  const minLockDurationSeconds = minLockDurationSecondsRaw ?? MIN_LOCK_DURATION_FALLBACK;
  const isMobile = useIsMobile();
  const lockExpired =
    lockDetails !== null &&
    BigInt(lockDetails?.amount_raw_wei ?? '0') > 0n &&
    (lockDetails.remaining_seconds ?? 0) === 0;
  const { address, chain, isConnected: isWalletConnected } = useAccount();
  const { reconnect } = useReconnect();
  const reconnectIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const wasConnectedRef = useRef(isWalletConnected);
  const targetRegistryAddress = useMemo(() => {
    if (chain?.id && TOKEN_REGISTRY_ADDRESSES[chain.id]) {
      return TOKEN_REGISTRY_ADDRESSES[chain.id];
    }
    return TOKEN_REGISTRY_ADDRESSES[base.id];
  }, [chain?.id]);

  useEffect(() => {
    initialize();
    void fetchBaseLockStatus();
  }, [initialize, fetchBaseLockStatus]);

  // Timeout fallback for loading state
  useEffect(() => {
    const timer = setTimeout(() => setInitLoadTimeout(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  // Reset wallet-specific state when transitioning from connected to disconnected
  useEffect(() => {
    if (wasConnectedRef.current && !isWalletConnected) {
      resetWalletState();
    }
    wasConnectedRef.current = isWalletConnected;
  }, [isWalletConnected, resetWalletState]);

  // Kick off a fetch as soon as wallet address is known.
  useEffect(() => {
    if (isWalletConnected && address) {
      void fetchLockStatus(address);
    }
  }, [isWalletConnected, address, fetchLockStatus]);

  useEffect(() => {
    const reconnectOnResume = () => {
      if (document.visibilityState !== 'visible') return;
      if (!isWalletConnected) {
        void reconnect();
      }
    };
    window.addEventListener('focus', reconnectOnResume);
    document.addEventListener('visibilitychange', reconnectOnResume);
    return () => {
      window.removeEventListener('focus', reconnectOnResume);
      document.removeEventListener('visibilitychange', reconnectOnResume);
    };
  }, [isWalletConnected, reconnect]);

  useEffect(() => {
    if (isWalletConnected) {
      if (reconnectIntervalRef.current) {
        clearInterval(reconnectIntervalRef.current);
        reconnectIntervalRef.current = null;
      }
      reconnectAttemptsRef.current = 0;
      return;
    }
    if (reconnectIntervalRef.current) return;
    reconnectIntervalRef.current = setInterval(() => {
      if (isWalletConnected) {
        if (reconnectIntervalRef.current) {
          clearInterval(reconnectIntervalRef.current);
          reconnectIntervalRef.current = null;
        }
        reconnectAttemptsRef.current = 0;
        return;
      }
      reconnectAttemptsRef.current += 1;
      if (reconnectAttemptsRef.current > 5) {
        if (reconnectIntervalRef.current) {
          clearInterval(reconnectIntervalRef.current);
          reconnectIntervalRef.current = null;
        }
        reconnectAttemptsRef.current = 0;
        return;
      }
      void reconnect();
    }, 1500);
    return () => {
      if (reconnectIntervalRef.current) {
        clearInterval(reconnectIntervalRef.current);
        reconnectIntervalRef.current = null;
      }
    };
  }, [isWalletConnected, reconnect]);

  const walletConnected = Boolean(isWalletConnected && address);

  const fetchLockStatusForWallet = useCallback(async () => {
    if (walletConnected && address) {
      await fetchLockStatus(address);
    }
  }, [walletConnected, address, fetchLockStatus]);

  const refreshLockStatusForWallet = useCallback(async () => {
    if (walletConnected && address) {
      await refreshLockStatusRaw(address);
    }
  }, [walletConnected, address, refreshLockStatusRaw]);

  useEffect(() => {
    const refreshOnResume = () => {
      if (document.visibilityState === 'visible') {
        void refreshLockStatusForWallet();
      }
    };
    window.addEventListener('focus', refreshOnResume);
    document.addEventListener('visibilitychange', refreshOnResume);
    return () => {
      window.removeEventListener('focus', refreshOnResume);
      document.removeEventListener('visibilitychange', refreshOnResume);
    };
  }, [refreshLockStatusForWallet]);

  const expectedChainId = useBindAndLockStore((state) => state.chainId) ?? FALLBACK_CHAIN_ID;
  const expectedChainName = CHAIN_LABELS[expectedChainId] ?? `Chain ${expectedChainId}`;
  const networkMismatch =
    walletConnected && chain?.id !== undefined && chain.id !== expectedChainId;
  const environmentReady = !networkMismatch;
  const connectComplete = Boolean(walletConnected && environmentReady);
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
  // Always show content for browsing
  const showContent = true;
  const lockTabEnabled = true;
  const bindTabEnabled = true;

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
      void fetchLockStatusForWallet();
    }
  }, [connectComplete, fetchLockStatusForWallet]);

  useEffect(() => {
    const id = setInterval(() => {
      if (connectComplete && environmentReady) {
        void refreshLockStatusForWallet();
      }
    }, 20_000);
    return () => clearInterval(id);
  }, [connectComplete, environmentReady, refreshLockStatusForWallet]);

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
    <div className={`app${!walletConnected ? ' disconnected' : ''}`}>
      <div className="phone-shell">
        <div className="phone-frame">
          <TopStatusBar walletConnected={walletConnected} />

          <div className="phone-body">
            {!walletConnected && (
              <div className="hypr-required-card">
                <h3>Wallet required</h3>
                <p>Connect wallet to use app.</p>
              </div>
            )}

            {showHyprRequiredNotice && (
              <div className="hypr-required-card">
                <h3>HYPR required</h3>
                <p>Add HYPR to wallet to use app.</p>
              </div>
            )}

            {connectComplete && !environmentReady && (
              <div className="warning-card">
                <h3>Connection required</h3>
                {networkMismatch && (
                  <p>
                    Switch THE wallet network to {expectedChainName} (chain ID {expectedChainId}) to continue. You are on{' '}
                    {chain ? chain.name : 'an unknown network'}.
                  </p>
                )}
                {networkMismatch && (
                  <p className="warning-note">Use the network selector above or your wallet to switch networks.</p>
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
                      onClick={refreshLockStatusForWallet}
                    >
                      {isLoading ? <span className="spinner" /> : 'Refresh values'}
                    </button>
                  </div>
                  {stepDescription ? <p className="step-description">{stepDescription}</p> : null}
                </div>

                <main className="step-content">
                  {!minLockDurationReady && !initLoadTimeout ? (
                    <div className="lock-grid">
                      <div className="lock-card">
                        <span className="lock-card-label">Loading lock rules…</span>
                        <span className="lock-card-value">
                          <span className="spinner" />
                        </span>
                      </div>
                    </div>
                  ) : (
                    <>
                      {activeStep === 'lock' && (
                        <LockStep
                          connectComplete={connectComplete}
                          nodeId={nodeId}
                          ownerAddress={ownerAddress}
                          lockDetails={lockDetails}
                          hyprOwned={hyprOwned}
                          hyprApproved={hyprApproved}
                          lockAllowance={tokeregistryAllowance}
                          availableToBind={availableToBind}
                          hyprTokenAddress={hyprTokenAddress}
                          lastError={lastError}
                          isLoading={isLoading}
                          refreshLockStatus={refreshLockStatusForWallet}
                          walletConnected={walletConnected}
                          walletAddress={address}
                          targetRegistryAddress={targetRegistryAddress}
                          minLockDurationSeconds={minLockDurationSeconds}
                          onLockUpdated={handleLockUpdated}
                          isMobile={isMobile}
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
                          refreshLockStatus={refreshLockStatusForWallet}
                          minLockDurationSeconds={minLockDurationSeconds}
                          lockUpdateNonce={lockUpdateNonce}
                          isMobile={isMobile}
                          activeStep={activeStep}
                          hasBoundAnything={hasBoundAnything}
                          onBindSuccess={markHasBound}
                        />
                      )}
                    </>
                  )}
                </main>
              </>
            )}

          </div>

          <BottomTabs
            steps={steps}
            activeStep={activeStep}
            canAccessStep={canAccessStep}
            onSelect={handleSelectStep}
          />
        </div>
      </div>
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
  lockAllowance: BalanceView | null;
  availableToBind: BalanceView | null;
  hyprTokenAddress: string | null;
  lastError: string | null;
  isLoading: boolean;
  refreshLockStatus: () => Promise<void>;
  walletConnected: boolean;
  walletAddress?: `0x${string}`;
  targetRegistryAddress: `0x${string}`;
  minLockDurationSeconds: number;
  onLockUpdated: () => void;
  isMobile: boolean;
}

const LockStep = ({
  connectComplete,
  nodeId,
  ownerAddress,
  lockDetails,
  hyprOwned,
  hyprApproved,
  lockAllowance,
  availableToBind,
  hyprTokenAddress,
  lastError,
  isLoading,
  refreshLockStatus,
  walletConnected,
  walletAddress,
  targetRegistryAddress,
  minLockDurationSeconds,
  onLockUpdated,
  isMobile,
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
  const [lockMobileDuration, setLockMobileDuration] = useState<string>('');
  const [lockMobileDateChoice, setLockMobileDateChoice] = useState<string | null>(null);
  const [showLockCustomModal, setShowLockCustomModal] = useState(false);
  const [lockCustomDateMs, setLockCustomDateMs] = useState<number | null>(null);
  const [lockCustomModalDate, setLockCustomModalDate] = useState<string>('');
  const [lockCustomModalTime, setLockCustomModalTime] = useState<string>('');
  const [diagModal, setDiagModal] = useState<{
    title: string;
    rows: { label: string; value: string }[];
  } | null>(null);
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
  const manageRetryRef = useRef(false);
  const nowSecondsRef = useRef(Math.floor(Date.now() / 1000));
  const nowSeconds = nowSecondsRef.current;
  const [userSetLockView, setUserSetLockView] = useState(false);

  const durationParts = useMemo(() => inputsToDurationParts(durationInputs), [durationInputs]);
  const lockedAmountWei = lockDetails?.amount_raw_wei ? BigInt(lockDetails.amount_raw_wei) : 0n;
  const hasExistingLock = lockedAmountWei > 0n;
  const hyprOwnedWei = hyprOwned?.amount_raw_wei ? BigInt(hyprOwned.amount_raw_wei) : 0n;
  const lockAvailableWei = lockAllowance?.amount_raw_wei ? BigInt(lockAllowance.amount_raw_wei) : 0n;
  const lockExpired = hasExistingLock && (lockDetails?.remaining_seconds ?? 0) === 0;
  useEffect(() => {
    // when lock existence changes (e.g., after refresh), allow default routing again
    setUserSetLockView(false);
  }, [hasExistingLock]);
  useEffect(() => {
    if (userSetLockView) return;
    if (hasExistingLock && lockView !== 'details') {
      setLockView('details');
    } else if (!hasExistingLock) {
      const targetView = lockAvailableWei === 0n ? 'approve' : 'manage';
      if (lockView !== targetView) {
        setLockView(targetView);
      }
    }
  }, [hasExistingLock, lockAvailableWei, lockView, userSetLockView]);

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
  const hasAllowance = lockAllowance && lockAllowance.amount_raw_wei !== '0';
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
    const unlockPlusBuffer = unlockMs > 0 ? unlockMs + 60_000 : 0;
    return Math.max(lockEndDateMin.getTime(), unlockPlusBuffer);
  }, [lockDetails, lockEndDateMin]);
  const applyLockMobileDuration = useCallback(
    (seconds: number) => {
      const next = new Date(Date.now() + seconds * 1000);
      setLockMobileDateChoice('');
      setLockEndDateInput(next);
      setLockEndTimeInput(formatTimeFromDate(next));
      setLockEndTimeDirty(true);
      setLockDurationDirty(true);
    },
    [formatTimeFromDate],
  );
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
      manageRetryRef.current = false;
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
      manageRetryRef.current = false;
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
    if (isAllowanceConfirmed && pendingLock) {
      void triggerLock(pendingLock);
    }
  }, [isAllowanceConfirmed, pendingLock]);

  useEffect(() => {
    if (manageTxHash || !pendingLock) {
      manageRetryRef.current = false;
    }
  }, [manageTxHash, pendingLock]);

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
      }, 90_000);
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
      }, 90_000);
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
      manageRetryRef.current = true;
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

  useEffect(() => {
    const attemptManageLock = () => {
      if (!isAllowanceConfirmed || !pendingLock || manageTxHash || isManagePending) {
        return;
      }
      if (manageRetryRef.current) return;
      manageRetryRef.current = true;
      void triggerLock(pendingLock);
    };
    const handleResume = () => {
      manageRetryRef.current = false;
      attemptManageLock();
    };
    window.addEventListener('focus', handleResume);
    document.addEventListener('visibilitychange', handleResume);
    attemptManageLock();
    return () => {
      window.removeEventListener('focus', handleResume);
      document.removeEventListener('visibilitychange', handleResume);
    };
  }, [isAllowanceConfirmed, pendingLock, manageTxHash, isManagePending, triggerLock]);

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
    const allowanceWei = lockAllowance ? BigInt(lockAllowance.amount_raw_wei) : 0n;
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

    await submitLockRequest();
  };

  const handleLockCustomCancel = () => {
    setShowLockCustomModal(false);
    setLockCustomDateMs(null);
    setLockMobileDateChoice('');
    setLockEndDateInput(null);
    setLockEndTimeInput('00:00:00');
    setLockEndTimeDirty(false);
    setLockDurationDirty(false);
  };

  const handleLockCustomSet = () => {
    if (!lockCustomModalDate || !lockCustomModalTime) {
      setShowLockCustomModal(false);
      return;
    }
    const candidate = new Date(`${lockCustomModalDate}T${lockCustomModalTime}:00`);
    if (Number.isNaN(candidate.getTime())) {
      setShowLockCustomModal(false);
      return;
    }
    const ms = candidate.getTime();
    if (ms < actualMinMsForView || ms > maxMsForView) {
      return;
    }
    setLockCustomDateMs(ms);
    setLockMobileDateChoice(ms.toString());
    setLockEndDateInput(candidate);
    setLockEndTimeInput(formatTimeFromDate(candidate));
    setLockEndTimeDirty(true);
    setLockDurationDirty(true);
    setLockMobileDuration('');
    setShowLockCustomModal(false);
  };

  const handleApproveOnly = async (event: FormEvent) => {
    event.preventDefault();
    if (!walletConnected || !walletAddress) {
      pushManageError('Connect a wallet to approve.');
      return;
    }
    if (!hyprTokenAddress) {
      pushManageError('Unable to resolve HYPR token address.');
      return;
    }
    if (!amountInput) {
      pushManageError('Enter a HYPR amount.');
      return;
    }
    const disallowZero = lockAvailableWei === 0n;
    if (Number(amountInput) < 0 || (disallowZero && Number(amountInput) === 0)) {
      pushManageError(disallowZero ? 'Enter a positive HYPR amount.' : 'Enter a non-negative HYPR amount.');
      return;
    }
    const amountWei = (() => {
      try {
        return parseEther(amountInput);
      } catch {
        return 0n;
      }
    })();
    if (amountWei < 0n || (disallowZero && amountWei === 0n)) {
      pushManageError(disallowZero ? 'Enter a positive HYPR amount.' : 'Enter a valid HYPR amount.');
      return;
    }
    if (amountWei > hyprOwnedWei) {
      pushManageError('Amount exceeds HYPR available to approve.');
      return;
    }
    try {
      await writeApproveContract({
        address: hyprTokenAddress as `0x${string}`,
        abi: erc20ApproveAbi,
        functionName: 'approve',
        args: [targetRegistryAddress, amountWei],
      });
      if (hasExistingLock) {
        setLockView('details');
      } else if (amountWei > 0n) {
        setAmountInput('');
        setLockView('manage');
      } else {
        setLockView('approve');
      }
    } catch (err) {
      pushManageError(getErrorMessage(err));
    }
  };

  const lockHeaderSubtitle = 'Lock an amount of HYPR for a specified duration to use in bindings.';
  const allowZeroAmount = lockView === 'extend';
  const amountProvided = amountInput !== '';
  const amountValue = amountProvided ? Number(amountInput) : 0;
  useEffect(() => {
    // When min duration arrives from the backend (or changes), refresh defaults for the initial create flow
    if (!hasExistingLock && lockView === 'manage' && !lockDurationDirty && !amountProvided) {
      setDurationInputs(createDefaultDurationInputsAtLeastMin(minLockDurationSeconds));
      setLockEndDateInput(null);
      setLockEndTimeInput('00:00:00');
      setLockEndTimeDirty(false);
    }
  }, [amountProvided, hasExistingLock, lockDurationDirty, lockView, minLockDurationSeconds]);
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
    // For Add view, cap at the current lock duration (do not extend beyond existing expiry)
    return existingDurationSeconds > 0n ? existingDurationSeconds : null;
  }, [
    existingDurationSeconds,
    hasExistingLock,
    lockView,
  ]);

  const currentExpiryMs = useMemo(() => {
    if (!hasExistingLock || !lockDetails?.unlock_timestamp) return null;
    return lockDetails.unlock_timestamp * 1000;
  }, [hasExistingLock, lockDetails?.unlock_timestamp]);

  const addWeightedMinMsRaw = useMemo(() => {
    if (!hasExistingLock || lockView !== 'manage') return null;
    if (!addWeightedMinDurationSeconds) return currentExpiryMs ?? lockEndDateMin.getTime();
    return Number((BigInt(nowSeconds) + addWeightedMinDurationSeconds) * 1000n);
  }, [
    addWeightedMinDurationSeconds,
    currentExpiryMs,
    hasExistingLock,
    lockEndDateMin,
    lockView,
    nowSeconds,
  ]);

  const addDynamicMinMsBuffered = useMemo(() => {
    if (!hasExistingLock || lockView !== 'manage') return null;
    const baseMin = addWeightedMinMsRaw ?? currentExpiryMs ?? extendMinMillis;
    const buffered = baseMin + TWENTY_FOUR_HOURS_MS;
    const clampTarget = currentExpiryMs ?? extendMinMillis;
    // buffered min used for selector/hints (clamp so it never exceeds current expiry)
    return Math.min(buffered, clampTarget);
  }, [
    addWeightedMinMsRaw,
    currentExpiryMs,
    extendMinMillis,
    hasExistingLock,
    lockView,
  ]);

  const addDynamicMaxMs = useMemo(() => {
    if (!addWeightedMaxDurationSeconds) return null;
    const candidateMs =
      Number((BigInt(nowSeconds) + addWeightedMaxDurationSeconds) * 1000n);
    return Math.min(candidateMs, lockEndDateMax.getTime());
  }, [addWeightedMaxDurationSeconds, lockEndDateMax, nowSeconds]);

  const maxMsForView = useMemo(() => {
    const base = lockEndDateMax.getTime();
    if (lockView === 'manage' && hasExistingLock && addDynamicMaxMs !== null) {
      // For Add view, cap at current expiry but ensure it never falls below the protocol min window
      return Math.max(addDynamicMaxMs, lockEndDateMin.getTime());
    }
    return base;
  }, [addDynamicMaxMs, hasExistingLock, lockEndDateMax, lockEndDateMin, lockView]);

  const lockEndDateDisplayMax = useMemo(() => {
    const base = new Date(maxMsForView);
    base.setHours(0, 0, 0, 0);
    return base;
  }, [maxMsForView]);

  const addDisplayMinDateForHint = useMemo(() => {
    if (lockView === 'manage' && hasExistingLock && addDynamicMinMsBuffered !== null) {
      return roundUpToNextDay(addDynamicMinMsBuffered);
    }
    return extendEndDateDisplayMin;
  }, [addDynamicMinMsBuffered, extendEndDateDisplayMin, hasExistingLock, lockView]);
  const suppressLockHint = useMemo(() => {
    if (lockView === 'extend') {
      return extendEndDateDisplayMin.getTime() >= lockEndDateDisplayMax.getTime();
    }
    if (lockView === 'manage' && !hasExistingLock) {
      return lockEndDateDisplayMin.getTime() >= lockEndDateDisplayMax.getTime();
    }
    return false;
  }, [extendEndDateDisplayMin, hasExistingLock, lockEndDateDisplayMax, lockEndDateDisplayMin, lockView]);

  const actualMinMsForView = useMemo(() => {
    if (lockView === 'extend') {
      return extendMinMillis;
    }
    if (lockView === 'manage' && hasExistingLock) {
      const raw = addWeightedMinMsRaw ?? lockEndDateMin.getTime();
      return Math.max(raw, lockEndDateMin.getTime());
    }
    return lockEndDateMin.getTime();
  }, [addWeightedMinMsRaw, hasExistingLock, lockEndDateMin, lockView, extendMinMillis]);
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
    ? Math.max(addWeightedMinMsRaw ?? extendMinMillis, extendMinMillis)
    : lockEndDateMin.getTime();
  const hasValidEndDate =
    lockDurationMode === 'duration'
      ? true
      : Boolean(lockEndDateDurationSeconds) &&
        Boolean(lockEndDateInput) &&
        lockEndDateInput!.getTime() >= minEndDateForValidationMs &&
        lockEndDateInput!.getTime() <= lockEndDateDisplayMax.getTime();
  const lockCustomSetDisabled = useMemo(() => {
    if (!lockCustomModalDate || !lockCustomModalTime) return true;
    const candidate = new Date(`${lockCustomModalDate}T${lockCustomModalTime}:00`);
    if (Number.isNaN(candidate.getTime())) return true;
    const ms = candidate.getTime();
    return ms < actualMinMsForView || ms > maxMsForView;
  }, [actualMinMsForView, lockCustomModalDate, lockCustomModalTime, maxMsForView]);
  const lockCustomPrefillMs = useMemo(() => {
    const baseRaw = lockEndDateInput ?? new Date(defaultEndMsForView);
    const plusBuffer = baseRaw.getTime() + 60 * 1000;
    const clamped = Math.min(Math.max(plusBuffer, actualMinMsForView), maxMsForView);
    return normalizeToMinute(clamped);
  }, [actualMinMsForView, defaultEndMsForView, lockEndDateInput, maxMsForView]);
  const lockRangeCollapsed = actualMinMsForView + COLLAPSE_BUFFER_MS >= maxMsForView;
  useEffect(() => {
    if (!lockRangeCollapsed) return;
    const minDate = new Date(actualMinMsForView);
    setLockEndDateInput(minDate);
    setLockEndTimeInput(formatTimeFromDate(minDate));
    setLockEndTimeDirty(true);
    setLockDurationDirty(true);
    setLockMobileDuration('');
    setLockMobileDateChoice(null);
    setLockCustomDateMs(null);
    setShowLockCustomModal(false);
  }, [actualMinMsForView, lockRangeCollapsed]);
  const handleLockDateClick = () => {
    const baseRaw = lockEndDateInput ?? new Date(defaultEndMsForView);
    const plusBuffer = baseRaw.getTime() + 60 * 1000;
    const clampedMs = Math.min(Math.max(plusBuffer, actualMinMsForView), maxMsForView);
    const base = new Date(clampedMs);
    setLockCustomModalDate(formatDateIso(base));
    setLockCustomModalTime(formatTimeFromDate(base).slice(0, 5));
    setShowLockCustomModal(true);
    setLockMobileDateChoice('__custom__');
    setLockMobileDuration('');
  };
  const openLockDiagnostics = () => {
    const actualMin = actualMinMsForView;
    const minDuration =
      lockView === 'manage' && hasExistingLock
        ? addDynamicMinMsBuffered ?? null
        : displayMinDateForHint.getTime();
    const defaultMs = defaultEndMsForView;
    const actualMax = maxMsForView;
    const maxDuration =
      lockView === 'manage' && hasExistingLock
        ? currentExpiryMs ?? actualMax
        : actualMax;
    const rows = [
      { label: 'Actual minimum', value: formatMsWithSeconds(actualMin) },
      { label: 'MIN duration option', value: formatMsWithSeconds(minDuration) },
      { label: 'Default end', value: formatMsWithSeconds(defaultMs) },
      {
        label: lockView === 'manage' && hasExistingLock ? 'NO CHANGE (current expiry)' : 'MAX duration option',
        value: formatMsWithSeconds(maxDuration),
      },
      { label: 'Initial custom modal time', value: formatMsWithSeconds(lockCustomPrefillMs) },
      { label: 'Actual maximum', value: formatMsWithSeconds(actualMax) },
    ];
    setDiagModal({ title: 'Lock diagnostics', rows });
  };

  const lockMobileDurationOptions = useMemo(() => {
    if (isMobile && lockView === 'manage' && hasExistingLock) {
      const baseSeconds = existingDurationSeconds;
      if (baseSeconds <= 0n) return [];
      const deltas: { label: string; seconds: number }[] = [
        { label: '-3 years', seconds: 3 * SECONDS_PER_YEAR },
        { label: '-2 years', seconds: 2 * SECONDS_PER_YEAR },
        { label: '-1 year', seconds: 1 * SECONDS_PER_YEAR },
        { label: '-9 months', seconds: 9 * SECONDS_PER_MONTH },
        { label: '-6 months', seconds: 6 * SECONDS_PER_MONTH },
        { label: '-4 months', seconds: 4 * SECONDS_PER_MONTH },
        { label: '-3 months', seconds: 3 * SECONDS_PER_MONTH },
        { label: '-2 months', seconds: 2 * SECONDS_PER_MONTH },
        { label: '-1 month', seconds: 1 * SECONDS_PER_MONTH },
        { label: '-4 weeks', seconds: 4 * SECONDS_PER_WEEK },
        { label: '-3 weeks', seconds: 3 * SECONDS_PER_WEEK },
        { label: '-2 weeks', seconds: 2 * SECONDS_PER_WEEK },
        { label: '-1 week', seconds: 1 * SECONDS_PER_WEEK },
        { label: '-3 days', seconds: 3 * SECONDS_PER_DAY },
      ];
      const nowMs = Date.now();
      const minOptionMs = addDynamicMinMsBuffered ?? minEndDateForValidationMs + TWENTY_FOUR_HOURS_MS;
      const maxOptionMs = currentExpiryMs ?? maxMsForView;
      const candidates: { label: string; seconds: number; value: string }[] = [];
      // MIN duration entry (buffered min)
      const minSeconds = Math.max(0, Math.round((minOptionMs - nowMs) / 1000));
      candidates.push({ label: 'MIN duration', seconds: minSeconds, value: '__min__' });
      deltas.forEach((delta) => {
        const candidateSeconds = Number(baseSeconds > BigInt(delta.seconds) ? baseSeconds - BigInt(delta.seconds) : 0n);
        const expiryMs = nowMs + candidateSeconds * 1000;
        if (expiryMs >= minOptionMs && expiryMs <= maxOptionMs) {
          candidates.push({ label: delta.label, seconds: candidateSeconds, value: delta.label });
        }
      });
      // NO CHANGE (current lock duration)
      const currentSeconds = Number(baseSeconds);
      // Always include NO CHANGE at the exact current expiry; never remove it.
      candidates.push({ label: 'NO CHANGE', seconds: currentSeconds, value: '__current__' });
      const dedup = new Map<number, { label: string; seconds: number; value: string }>();
      candidates
        .sort((a, b) => a.seconds - b.seconds)
        .forEach((opt) => {
          if (!dedup.has(opt.seconds)) {
            dedup.set(opt.seconds, opt);
          }
        });
      return Array.from(dedup.values());
    }
    if (!isMobile) return MOBILE_DURATION_OPTIONS;
    const nowMs = Date.now();
    const minSeconds = Math.max(0, Math.round((minEndDateForValidationMs - nowMs) / 1000));
    const maxSeconds = Math.max(minSeconds, Math.round((maxMsForView - nowMs) / 1000));
    const currentDurationSeconds =
      hasExistingLock && lockDetails?.unlock_timestamp
        ? Math.max(0, lockDetails.unlock_timestamp - nowSeconds)
        : null;
    const inRange = MOBILE_DURATION_OPTIONS.filter(
      (opt) => opt.seconds >= minSeconds && opt.seconds <= maxSeconds,
    );
    const candidates: { label: string; seconds: number; value: string }[] = [
      { label: 'MIN duration', seconds: minSeconds, value: '__min__' },
      ...inRange,
      { label: 'MAX duration', seconds: maxSeconds, value: '__max__' },
    ];
    if (
      lockView === 'manage' &&
      hasExistingLock &&
      currentDurationSeconds !== null &&
      currentDurationSeconds >= minSeconds &&
      currentDurationSeconds <= maxSeconds
    ) {
      candidates.push({ label: 'NO CHANGE', seconds: currentDurationSeconds, value: '__current__' });
    }
    const dedup = new Map<number, { label: string; seconds: number; value: string }>();
    candidates
      .sort((a, b) => a.seconds - b.seconds)
      .forEach((opt) => {
        if (!dedup.has(opt.seconds)) {
          dedup.set(opt.seconds, opt);
        }
      });
    return Array.from(dedup.values());
  }, [
    addDynamicMinMsBuffered,
    addDynamicMaxMs,
    additionalAmountWei,
    currentExpiryMs,
    existingDurationSeconds,
    hasExistingLock,
    isMobile,
    lockDetails?.unlock_timestamp,
    lockView,
    maxMsForView,
    minEndDateForValidationMs,
    nowSeconds,
  ]);
  const lockExpiryHintLabel = useMemo(() => {
    if (lockView === 'extend') return 'New Expiry:';
    if (lockView === 'manage' && hasExistingLock) {
      if (lockMobileDuration === '__current__') return 'Current Expiry:';
      return 'New Expiry:';
    }
    return 'Expires at';
  }, [hasExistingLock, lockMobileDuration, lockView]);

  useEffect(() => {
    if (!isMobile) return;
    const first = lockMobileDurationOptions[0];
    if (!first) return;
    const shouldSetDefault =
      !lockEndDateInput || (lockMobileDuration === '' && !lockMobileDateChoice);
    if (shouldSetDefault) {
      const currentOpt = lockMobileDurationOptions.find((opt) => opt.value === '__current__');
      const defaultOpt =
        lockView === 'manage' && hasExistingLock && currentOpt ? currentOpt : first;
      setLockMobileDuration(defaultOpt.value);
      applyLockMobileDuration(defaultOpt.seconds);
    }
  }, [
    applyLockMobileDuration,
    hasExistingLock,
    isMobile,
    lockEndDateInput,
    lockMobileDateChoice,
    lockMobileDuration,
    lockMobileDurationOptions,
    lockView,
  ]);
  useEffect(() => {
    if (!isMobile) return;
    if (!(lockView === 'manage' && hasExistingLock)) return;
    setLockMobileDuration('');
    setLockMobileDateChoice(null);
    setLockCustomDateMs(null);
    setLockEndDateInput(null);
    setLockEndTimeInput('00:00:00');
    setLockDurationDirty(false);
  }, [amountInput, hasExistingLock, isMobile, lockView]);

  useEffect(() => {
    if (lockDurationDirty) {
      return;
    }
    if (isMobile) {
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
  }, [defaultEndMsForView, isMobile, lockDurationDirty, lockEndDateInput, lockEndTimeDirty]);

  const maxAmountLabel = lockAllowance?.amount_formatted_hypr ?? 'Loading…';
  const maxAmountWei = lockAllowance?.amount_raw_wei ? BigInt(lockAllowance.amount_raw_wei) : 0n;
  const exceedsLockAvailable = additionalAmountWei > maxAmountWei;
  const lockButtonDisabled =
    !walletConnected ||
    isManagePending ||
    isManageConfirming ||
    isAllowancePending ||
    isAllowanceConfirming ||
    !amountProvided ||
    (!allowZeroAmount && amountValue <= 0) ||
    exceedsLockAvailable ||
    !hasValidEndDate ||
    durationLessThanExisting;
  const approveButtonDisabled =
    !walletConnected ||
    isAllowancePending ||
    isAllowanceConfirming ||
    !amountProvided ||
    (lockAvailableWei === 0n ? Number(amountInput) <= 0 : Number(amountInput) < 0) ||
    additionalAmountWei > hyprOwnedWei;
  const showLockFormContent = isMobile
    ? amountProvided && amountValue > 0 && !exceedsLockAvailable
    : amountProvided &&
      (amountValue > 0 || (allowZeroAmount && amountValue === 0)) &&
      !exceedsLockAvailable &&
      (!hasExistingLock ||
        (addDynamicMinMsBuffered !== null &&
          addDynamicMaxMs !== null &&
          addDynamicMinMsBuffered < extendMinMillis - TWENTY_FOUR_HOURS_MS &&
          addDynamicMaxMs > extendMinMillis + TWENTY_FOUR_HOURS_MS));
  const waitingForManagePrompt =
    isAllowanceConfirmed && pendingLock && !manageTxHash && !isManagePending && !isManageConfirming;
  const specialDateOptions = useMemo(() => buildSpecialDateOptions(), []);
  const lockFilteredSpecialDates = useMemo(() => {
    let filtered = specialDateOptions.filter(
      (opt) =>
        opt.date.getTime() >= minEndDateForValidationMs && opt.date.getTime() <= maxMsForView,
    );
    if (lockView === 'extend') {
      // Keep the regular options and optionally add a custom entry if range is wide enough
      const allowCustom = actualMinMsForView + 5 * 60 * 1000 <= maxMsForView;
      if (allowCustom) {
        const customEntries =
          lockCustomDateMs !== null
            ? [
              {
                label: formatShortDateLabel(new Date(lockCustomDateMs)),
                value: lockCustomDateMs.toString(),
                date: new Date(lockCustomDateMs),
                legend: 'custom',
              },
            ]
            : [
              {
                label: 'CUSTOM',
                value: '__custom__',
                date: new Date(),
                legend: 'custom',
              },
            ];
        filtered = [...filtered, ...customEntries];
        if (lockCustomDateMs !== null) {
          filtered = filtered.filter((opt) => opt.value !== '__custom__');
        }
      }
    }
    if (!isMobile) return filtered;
    return filtered;
  }, [
    isMobile,
    lockCustomDateMs,
    lockView,
    maxMsForView,
    minEndDateForValidationMs,
    specialDateOptions,
  ]);
  useEffect(() => {
    if (lockFilteredSpecialDates.length === 0) {
      setLockMobileDateChoice(null);
    }
  }, [lockFilteredSpecialDates]);
  const minFinalDurationLabel = simulationMode ? '4 minutes' : '4 weeks';
  const lockMobileGroupLabel =
    hasExistingLock && (lockView === 'manage' || lockView === 'extend')
      ? 'Select new duration or date'
      : 'Select duration or date';
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

  const handleShowApprovePanel = useCallback(() => {
    setUserSetLockView(true);
    setAmountInput('');
    setLockView('approve');
    resetLockEndDefaults();
  }, [resetLockEndDefaults]);

  const handleShowDetailsPanel = useCallback(() => {
    if (hasExistingLock) {
      setUserSetLockView(true);
      setLockView('details');
    }
  }, [hasExistingLock]);

  return (
    <section className="step-card lock-step">
      {lockView === 'details' && hasAllowance && lockAllowance && (
        <div className="lock-grid">
          <div className="lock-card">
            <div className="lock-card-label">Approved HYPR pending locking</div>
            <div className="lock-card-value">{lockAllowance.amount_formatted_hypr}</div>
            <button
              type="button"
              className="secondary-button"
              disabled={isAllowancePending || isAllowanceConfirming}
              onClick={handleResetApproval}
              style={{ marginTop: '0.5rem', width: 'fit-content' }}
            >
              {isAllowancePending || isAllowanceConfirming ? <span className="spinner" /> : 'Revoke approval'}
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
                  <button type="button" className="secondary-button" style={{ width: 'fit-content' }} onClick={handleShowExtendPanel}>
                    Extend lock
                  </button>
                )}
                {!lockExpired && lockAvailableWei > 0n && (
                  <button
                    type="button"
                    className="secondary-button ghost"
                    style={{ marginTop: '0.5rem', width: 'fit-content' }}
                    onClick={handleShowManagePanel}
                  >
                    Add HYPR to lock
                  </button>
                )}
                {!lockExpired && lockAvailableWei === 0n && hyprOwnedWei > 0n && (
                  <button
                    type="button"
                    className="secondary-button ghost"
                    style={{ marginTop: '0.5rem', width: 'fit-content' }}
                    onClick={handleShowApprovePanel}
                  >
                    Approve HYPR to add to lock
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
            {(lockView === 'manage' || lockView === 'extend') && (
              <button type="button" className="secondary-button ghost diag-button" onClick={openLockDiagnostics}>
                Diagnostics
              </button>
            )}
          </div>
          {lockView !== 'extend' && (
          <div className="input-grid">
            <label className="input-field">
              <span>
                {hasExistingLock ? (
                  hyprOwnedWei > lockAvailableWei ? (
                    <>
                      Amount to add (up to {maxAmountLabel} -- click{' '}
                      <button type="button" className="link-button" onClick={handleShowApprovePanel}>
                        here
                      </button>{' '}
                      to approve a higher limit)
                    </>
                  ) : (
                    `Amount to add (up to ${maxAmountLabel})`
                  )
                ) : (
                  <>
                    Amount (up to {maxAmountLabel} -- click{' '}
                    <button type="button" className="link-button" onClick={handleShowApprovePanel}>
                      here
                    </button>{' '}
                    to{' '}
                    {hyprOwnedWei > lockAvailableWei
                      ? 'approve a higher limit'
                      : 'approve a different limit'}
                    )
                  </>
                )}
              </span>
              <input
                type="number"
                min="0"
                step="0.000000000000000001"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
              />
              {hasExistingLock &&
                lockView === 'manage' &&
                additionalAmountWei > 0n &&
                !exceedsLockAvailable && (
                <span className="input-subtext">
                  New total locked amount: {formatHyprWei(existingAmountWei + additionalAmountWei)}
                </span>
              )}
            </label>
          </div>
          )}
          {showLockFormContent || lockView === 'extend' ? (
            isMobile ? (
              <>
                {hasExistingLock && lockView === 'manage' && additionalAmountWei > 0n && !exceedsLockAvailable && (
                  <div className="input-subtext">
                    {`Adding HYPR to your lock may allow you to optionally reduce its duration, up to a minimum final duration of ${minFinalDurationLabel} depending on the initial lock and the amount being added.`}
                  </div>
                )}
                {!lockRangeCollapsed && (
                  <div className="mobile-duration-group">
                    <span className="mobile-group-title">
                {lockMobileGroupLabel}
                    </span>
                    <div className="input-grid mobile-duration-row">
                      <div className="input-field mobile-duration-select">
                        <label className="mobile-sub-label">Duration</label>
                        <select
                          value={lockMobileDuration}
                          onChange={(event) => {
                            const nextVal = event.target.value;
                            setLockMobileDuration(nextVal);
                            if (lockCustomDateMs) {
                              setLockCustomDateMs(null);
                              setLockMobileDateChoice('');
                            }
                            if (nextVal === '') {
                              setLockEndDateInput(null);
                              setLockEndTimeInput('00:00:00');
                              return;
                            }
                            setLockMobileDateChoice('');
                            const opt = lockMobileDurationOptions.find((o) => o.value === nextVal);
                            if (opt) {
                              applyLockMobileDuration(opt.seconds);
                            }
                          }}
                        >
                          <option value="">--</option>
                          {lockMobileDurationOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="input-field mobile-duration-select">
                        <label className="mobile-sub-label">Date</label>
                        <input
                          type="text"
                          readOnly
                          value={lockCustomDateMs ? formatShortDateLabel(new Date(lockCustomDateMs)) : '--'}
                          onClick={handleLockDateClick}
                        />
                      </div>
                    </div>
                  </div>
                )}
                {lockEndDateInput && (
                  <div className="input-subtext mobile-expiry-hint">
                    {lockExpiryHintLabel}{' '}
                    {formatTimestamp(Math.floor(lockEndDateInput.getTime() / 1000))}
                    {lockCustomDateMs ? ' (custom)' : ''}
                  </div>
                )}
              </>
            ) : (
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
            )
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
                Cancel
              </button>
            )}
          </div>
          {waitingForManagePrompt && (
            <div className="lock-card-sub">
              Waiting for lock confirmation in your wallet. If you don’t see a prompt, open MetaMask to continue.
            </div>
          )}
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

      {lockView === 'approve' && (
        <form className="lock-form" onSubmit={handleApproveOnly}>
          <div className="form-header">
            <div className="form-header-text">
              <h3>Approve HYPR for locking</h3>
            </div>
          </div>

          <div className="input-grid">
            <label className="input-field">
              <span>
                {lockAvailableWei > 0n
                  ? `New approval limit ${hyprOwned ? `(up to ${hyprOwned.amount_formatted_hypr})` : '(HYPR)'}`
                  : `Amount to approve ${hyprOwned ? `(up to ${hyprOwned.amount_formatted_hypr})` : '(HYPR)'}`}
              </span>
              <input
                type="number"
                min="0"
                step="0.000000000000000001"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                required
              />
            </label>
          </div>

          <div className="form-actions">
            <button type="submit" className="secondary-button" disabled={approveButtonDisabled}>
              {isAllowancePending || isAllowanceConfirming ? <span className="spinner" /> : 'Submit Approval'}
            </button>
            {hasExistingLock && (
              <button type="button" className="secondary-button ghost" onClick={handleShowDetailsPanel}>
                Cancel
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

      {showLockCustomModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>Choose custom expiry</h3>
            <div className="input-grid">
                <label className="input-field">
                  <span>Date</span>
                  <input
                    type="date"
                    min={formatDateIso(new Date(actualMinMsForView))}
                    max={formatDateIso(new Date(maxMsForView))}
                    value={lockCustomModalDate}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (!raw) {
                        setLockCustomModalDate(raw);
                        return;
                      }
                      const timePart = lockCustomModalTime || '00:00';
                      const candidate = new Date(`${raw}T${timePart}:00`);
                      if (Number.isNaN(candidate.getTime())) {
                        return;
                      }
                      const clampedMs = Math.min(
                        Math.max(candidate.getTime(), actualMinMsForView),
                        maxMsForView,
                      );
                      const clamped = new Date(clampedMs);
                      setLockCustomModalDate(formatDateIso(clamped));
                    }}
                  />
                </label>
                <label className="input-field">
                <span>Time</span>
                <input
                  type="time"
                  step="60"
                  value={lockCustomModalTime}
                  onChange={(e) => setLockCustomModalTime(e.target.value)}
                />
              </label>
              </div>
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={handleLockCustomSet}
              disabled={lockCustomSetDisabled}
            >
              Set
            </button>
            <button type="button" className="secondary-button ghost" onClick={handleLockCustomCancel}>
              Cancel
            </button>
          </div>
          {lockCustomSetDisabled && (
            <div className="input-subtext modal-hint">
              The custom value must be between {formatDateTimeAmPm(actualMinMsForView)} and{' '}
              {formatDateTimeAmPm(maxMsForView)}.
            </div>
          )}
          </div>
        </div>
      )}
      {diagModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>{diagModal.title}</h3>
            <ul className="diag-list">
              {diagModal.rows.map((row) => (
                <li key={row.label}>
                  <strong>{row.label}:</strong> {row.value}
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setDiagModal(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};



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
  isMobile: boolean;
  activeStep: StepId;
  hasBoundAnything: boolean;
  onBindSuccess: () => void;
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
  isMobile,
  activeStep,
  hasBoundAnything,
  onBindSuccess,
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
  const [transferMobileDuration, setTransferMobileDuration] = useState<string>('');
  const [transferMobileDateChoice, setTransferMobileDateChoice] = useState<string | null>(null);
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
  const [bindDiagModal, setBindDiagModal] = useState<{
    title: string;
    rows: { label: string; value: string }[];
  } | null>(null);
  const [showTransferCustomModal, setShowTransferCustomModal] = useState(false);
  const [transferCustomDateMs, setTransferCustomDateMs] = useState<number | null>(null);
  const [transferCustomModalDate, setTransferCustomModalDate] = useState<string>('');
  const [transferCustomModalTime, setTransferCustomModalTime] = useState<string>('');
  const transferErrorIdRef = useRef(0);
  const transferErrorRef = useRef<HTMLDivElement | null>(null);
  const transferSuccessRef = useRef<HTMLDivElement | null>(null);
  const lastTransferSyncedSeconds = useRef<number | null>(null);
  const [reclaimingNamehash, setReclaimingNamehash] = useState<string | null>(null);

  // Animation state for Bind button
  const [showBindPopAnimation, setShowBindPopAnimation] = useState(false);
  const [showBindShimmer, setShowBindShimmer] = useState(false);
  const bindShimmerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevBindButtonEnabled = useRef(false);

  const applyTransferMobileDuration = useCallback(
    (seconds: number) => {
      const next = new Date(Date.now() + seconds * 1000);
      setTransferMobileDateChoice('');
      setTransferEndDateInput(next);
      setTransferEndTimeInput(formatTimeFromDate(next));
      setTransferEndTimeDirty(true);
      setTransferDurationDirty(true);
      setTransferDurationMode('end-date');
    },
    [],
  );

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
    const baseMin = transferEndDateMin.getTime();
    if (bindView === 'extend' && extendBindingUnlockMs !== null) {
      const buffered = extendBindingUnlockMs + 60_000;
      return Math.max(buffered, baseMin);
    }
    return baseMin;
  }, [bindView, extendBindingUnlockMs, transferEndDateMin]);
  const effectiveTransferEndDateMaxMs = useMemo(() => {
    const raw = transferEndDateMax.getTime();
    // Ensure max is never below min so collapsed windows remain valid
    return Math.max(raw, effectiveTransferEndDateMinMs);
  }, [transferEndDateMax, effectiveTransferEndDateMinMs]);
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
  const openBindDiagnostics = () => {
    const actualMin = bindHintMinMs || null;
    const minDuration = bindHintMinMs || null;
    const defaultMs = effectiveTransferEndDateDefault
      ? effectiveTransferEndDateDefault.getTime()
      : null;
    const actualMax = bindHintMaxMs || null;
    const maxDuration = bindHintMaxMs || null;
    const transferCustomPrefillMs = (() => {
      const baseRaw =
        transferEndDateInput ??
        (effectiveTransferEndDateDefault ?? new Date(effectiveTransferEndDateMaxMs));
      const plusBuffer = baseRaw.getTime() + 60 * 1000;
      const clamped = Math.min(
        Math.max(plusBuffer, effectiveTransferEndDateMinMs),
        effectiveTransferEndDateMaxMs,
      );
      return normalizeToMinute(clamped);
    })();
    const rows = [
      { label: 'Actual minimum', value: formatMsWithSeconds(actualMin) },
      { label: 'MIN duration option', value: formatMsWithSeconds(minDuration) },
      { label: 'Default end', value: formatMsWithSeconds(defaultMs) },
      { label: bindView === 'extend' ? 'Lock duration' : 'MAX duration option', value: formatMsWithSeconds(maxDuration) },
      { label: 'Initial custom modal time', value: formatMsWithSeconds(transferCustomPrefillMs) },
      { label: 'Actual maximum', value: formatMsWithSeconds(actualMax) },
    ];
    setBindDiagModal({ title: 'Bind diagnostics', rows });
  };
  const transferSpecialDateOptions = useMemo(() => buildSpecialDateOptions(), []);
  const transferMobileDurationOptions = useMemo(() => {
    if (!isMobile) return MOBILE_DURATION_OPTIONS;
    const nowMs = Date.now();
    const minSeconds = Math.max(0, Math.round((effectiveTransferEndDateMinMs - nowMs) / 1000));
    const maxSeconds = Math.max(minSeconds, Math.round((effectiveTransferEndDateMaxMs - nowMs) / 1000));
    const inRange = MOBILE_DURATION_OPTIONS.filter(
      (opt) => opt.seconds >= minSeconds && opt.seconds <= maxSeconds,
    );
    const withBounds: { label: string; seconds: number; value: string }[] = [
      { label: 'MIN duration', seconds: minSeconds, value: '__min__' },
      ...inRange,
      { label: 'Lock duration', seconds: maxSeconds, value: '__max__' },
    ];
    return withBounds;
  }, [effectiveTransferEndDateMaxMs, effectiveTransferEndDateMinMs, isMobile]);
  const transferFilteredSpecialDates = useMemo(() => {
    if (!isMobile) return transferSpecialDateOptions;
    return transferSpecialDateOptions.filter(
      (opt) =>
        opt.date.getTime() >= effectiveTransferEndDateMinMs &&
        opt.date.getTime() <= effectiveTransferEndDateMaxMs,
    );
  }, [effectiveTransferEndDateMaxMs, effectiveTransferEndDateMinMs, isMobile, transferSpecialDateOptions]);
  useEffect(() => {
    if (transferFilteredSpecialDates.length === 0) {
      setTransferMobileDateChoice(null);
    }
  }, [transferFilteredSpecialDates]);
  const transferMobileGroupLabel =
    bindView === 'extend' ? 'Select new duration or date' : 'Select duration or date';
  const transferExpiryHintLabel = useMemo(
    () => (bindView === 'extend' ? 'New Expiry:' : 'Expires at'),
    [bindView],
  );
  useEffect(() => {
    if (bindView === 'add-hypr') return;
    if (isMobile) return;
    if (!transferEndDateInput && effectiveTransferEndDateDefault) {
      setTransferEndDateInput(effectiveTransferEndDateDefault);
    }
  }, [bindView, effectiveTransferEndDateDefault, isMobile, transferEndDateInput]);

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
  const transferAvailableWei = availableToBind ? BigInt(availableToBind.amount_raw_wei) : 0n;
  const transferAmountWei = transferAmountProvided && transferAmountIsValid ? parseEther(transferAmountInput || '0') : 0n;
  const transferExceedsAvailable = transferAmountProvided && transferAmountIsValid && transferAmountWei > transferAvailableWei;
  const transferAvailableLabel = availableToBind?.amount_formatted_hypr ?? '0';
  const transferAmountLabel = useMemo(() => {
    if (bindView === 'add') {
      return transferExceedsAvailable
        ? `Amount (up to ${transferAvailableLabel} HYPR)`
        : 'Amount (HYPR)';
    }
    if (bindView === 'add-hypr') {
      return transferExceedsAvailable
        ? `Amount to add (up to ${transferAvailableLabel} HYPR)`
        : 'Amount to add (HYPR)';
    }
    return bindView === 'extend' ? 'Amount (HYPR)' : 'Amount (HYPR)';
  }, [bindView, transferAvailableLabel, transferExceedsAvailable]);
  const shouldShowTransferEndInputs =
    bindView !== 'add-hypr' &&
    transferAmountIsValid &&
    dstNameInput.trim().length > 0 &&
    (transferAmountValue > 0 || bindView === 'extend') &&
    !transferExceedsAvailable;
  const transferDateEnabled =
    shouldShowTransferEndInputs && effectiveTransferEndDateMaxMs >= effectiveTransferEndDateMinMs;
  const transferRangeCollapsed =
    transferDateEnabled &&
    effectiveTransferEndDateMinMs + COLLAPSE_BUFFER_MS >= effectiveTransferEndDateMaxMs;
  useEffect(() => {
    if (!transferRangeCollapsed) return;
    const minDate = new Date(effectiveTransferEndDateMinMs);
    setTransferEndDateInput(minDate);
    setTransferEndTimeInput(formatTimeFromDate(minDate));
    setTransferEndTimeDirty(true);
    setTransferDurationDirty(true);
    setTransferMobileDuration('');
    setTransferMobileDateChoice(null);
    setTransferCustomDateMs(null);
    setShowTransferCustomModal(false);
  }, [effectiveTransferEndDateMinMs, transferRangeCollapsed]);
  const handleTransferCustomCancel = () => {
    setShowTransferCustomModal(false);
    setTransferCustomDateMs(null);
    setTransferMobileDateChoice(null);
    setTransferEndDateInput(null);
    setTransferEndTimeInput('00:00:00');
    setTransferEndTimeDirty(false);
    setTransferDurationDirty(false);
    setTransferCustomModalDate('');
    setTransferCustomModalTime('');
  };
  const transferCustomSetDisabled = useMemo(() => {
    if (!transferCustomModalDate || !transferCustomModalTime) return true;
    const candidate = new Date(`${transferCustomModalDate}T${transferCustomModalTime}:00`);
    if (Number.isNaN(candidate.getTime())) return true;
    const ms = candidate.getTime();
    return ms < effectiveTransferEndDateMinMs || ms > effectiveTransferEndDateMaxMs;
  }, [effectiveTransferEndDateMaxMs, effectiveTransferEndDateMinMs, transferCustomModalDate, transferCustomModalTime]);
  const handleTransferCustomSet = () => {
    if (!transferCustomModalDate || !transferCustomModalTime) {
      setShowTransferCustomModal(false);
      return;
    }
    const candidate = new Date(`${transferCustomModalDate}T${transferCustomModalTime}:00`);
    if (Number.isNaN(candidate.getTime())) {
      setShowTransferCustomModal(false);
      return;
    }
    const ms = candidate.getTime();
    if (ms < effectiveTransferEndDateMinMs || ms > effectiveTransferEndDateMaxMs) {
      return;
    }
    setTransferCustomDateMs(ms);
    setTransferMobileDateChoice(ms.toString());
    setTransferEndDateInput(candidate);
    setTransferEndTimeInput(formatTimeFromDate(candidate));
    setTransferEndTimeDirty(true);
    setTransferDurationDirty(true);
    setTransferMobileDuration('');
    setShowTransferCustomModal(false);
  };
  const handleTransferDateClick = () => {
    if (!transferDateEnabled) return;
    const baseRaw =
      transferEndDateInput ??
      (effectiveTransferEndDateDefault ?? new Date(effectiveTransferEndDateMaxMs));
    const plusBuffer = baseRaw.getTime() + 60 * 1000;
    const clampedMs = Math.min(
      Math.max(plusBuffer, effectiveTransferEndDateMinMs),
      effectiveTransferEndDateMaxMs,
    );
    const base = new Date(clampedMs);
    setTransferCustomModalDate(formatDateIso(base));
    setTransferCustomModalTime(formatTimeFromDate(base).slice(0, 5));
    setShowTransferCustomModal(true);
    setTransferMobileDateChoice('__custom__');
    setTransferMobileDuration('');
  };
  useEffect(() => {
    if (!isMobile) return;
    if (!shouldShowTransferEndInputs || transferRangeCollapsed) return;
    const defaultOpt =
      bindView === 'add'
        ? transferMobileDurationOptions[transferMobileDurationOptions.length - 1]
        : bindView === 'extend'
          ? transferMobileDurationOptions[transferMobileDurationOptions.length - 1]
          : transferMobileDurationOptions[0];
    if (!defaultOpt) return;
    const shouldSetDefault =
      !transferEndDateInput || (transferMobileDuration === '' && !transferMobileDateChoice);
    if (shouldSetDefault) {
      setTransferMobileDuration(defaultOpt.value);
      applyTransferMobileDuration(defaultOpt.seconds);
    }
  }, [
    applyTransferMobileDuration,
    isMobile,
    shouldShowTransferEndInputs,
    transferRangeCollapsed,
    transferEndDateInput,
    transferMobileDateChoice,
    transferMobileDuration,
    transferMobileDurationOptions,
  ]);
  useEffect(() => {
    if (!isMobile) return;
    if (!shouldShowTransferEndInputs) return;
    // Custom date modal handles date selection; no default date choice
  }, [
    isMobile,
    shouldShowTransferEndInputs,
  ]);
  const hasActiveLock = lockDetails && BigInt(lockDetails.amount_raw_wei) > 0n;
  const bindButtonDisabled =
    !walletConnected ||
    !hasActiveLock ||
    isTransferPending ||
    isTransferConfirming ||
    (!hasTransferValidEndDate && bindView !== 'add-hypr') ||
    !transferAmountProvided ||
    !transferAmountIsValid ||
    transferExceedsAvailable ||
    (transferAmountValue <= 0 && bindView !== 'extend' && bindView !== 'add-hypr') ||
    dstNameInput.trim().length === 0;

  // Animation logic: show pop and shimmer when Bind button becomes ready
  const shouldAnimateBindButton = walletConnected && !!hasActiveLock && activeStep === 'lock' && !hasBoundAnything;

  useEffect(() => {
    const nowEnabled = !bindButtonDisabled && shouldAnimateBindButton;

    if (nowEnabled && !prevBindButtonEnabled.current) {
      // Button just became enabled - trigger pop animation
      setShowBindPopAnimation(true);

      // Start shimmer after 3s, repeat every 5-10s
      const timeout = setTimeout(() => {
        setShowBindShimmer(true);
        setTimeout(() => setShowBindShimmer(false), 800);

        bindShimmerIntervalRef.current = setInterval(() => {
          setShowBindShimmer(true);
          setTimeout(() => setShowBindShimmer(false), 800);
        }, 5000 + Math.random() * 5000);
      }, 3000);

      return () => clearTimeout(timeout);
    }

    if (!nowEnabled) {
      setShowBindPopAnimation(false);
      setShowBindShimmer(false);
      if (bindShimmerIntervalRef.current) {
        clearInterval(bindShimmerIntervalRef.current);
        bindShimmerIntervalRef.current = null;
      }
    }

    prevBindButtonEnabled.current = nowEnabled;
  }, [bindButtonDisabled, shouldAnimateBindButton]);

  // Cleanup shimmer interval on unmount
  useEffect(() => {
    return () => {
      if (bindShimmerIntervalRef.current) clearInterval(bindShimmerIntervalRef.current);
    };
  }, []);

  const stopBindAnimations = useCallback(() => {
    setShowBindPopAnimation(false);
    setShowBindShimmer(false);
    if (bindShimmerIntervalRef.current) {
      clearInterval(bindShimmerIntervalRef.current);
      bindShimmerIntervalRef.current = null;
    }
  }, []);

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
      onBindSuccess();
    }
  }, [isTransferConfirmed, refreshLockStatus, minLockDurationSeconds, transferEndDateMin, onBindSuccess]);

  useEffect(() => {
    if (transferReceipt) {
      void refreshLockStatus();
    }
  }, [transferReceipt, refreshLockStatus]);

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
                        <div className="binding-actions">
                          {(() => {
                            const extendMin = Math.max(
                              (binding.unlock_timestamp ?? 0) * 1000 + 60_000,
                              transferEndDateMin.getTime(),
                            );
                            const extendMax = Math.max(
                              transferEndDateMax.getTime(),
                              extendMin,
                            );
                            const extendDisabled = extendMin + COLLAPSE_BUFFER_MS >= extendMax;
                            return (
                          <button
                            type="button"
                            className="pill-button"
                            disabled={extendDisabled}
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
                            );
                          })()}
                          <button
                            type="button"
                            className="pill-button"
                            disabled={!availableToBind || BigInt(availableToBind.amount_raw_wei) === 0n}
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
                        </div>
                      )}
                      {expired && (
                        <button
                          type="button"
                          className="pill-button warning-pill"
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
            disabled={!availableToBind || BigInt(availableToBind.amount_raw_wei) === 0n}
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
            {(bindView === 'create' || bindView === 'add' || bindView === 'extend') && (
              <button type="button" className="secondary-button ghost diag-button" onClick={openBindDiagnostics}>
                Diagnostics
              </button>
            )}
          </div>

          {bindView !== 'extend' && bindView !== 'add-hypr' && (
            <div className="input-grid">
              <label className="input-field">
                <span>Binding target</span>
                <input
                  type="text"
                  placeholder="example.name.os"
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={dstNameInput}
                  onChange={(event) => setDstNameInput(event.target.value)}
                />
              </label>
            <label className="input-field">
              <span>{transferAmountLabel}</span>
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
                  <span>{transferAmountLabel}</span>
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
              {addHyprBindingName &&
                Number(transferAmountInput) > 0 &&
                !transferExceedsAvailable && (
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

      {shouldShowTransferEndInputs && !transferRangeCollapsed &&
        (isMobile ? (
          <>
            <div className="mobile-duration-group">
              <span className="mobile-group-title">
                {transferMobileGroupLabel}
              </span>
              <div className="input-grid mobile-duration-row">
                <div className="input-field mobile-duration-select">
                  <label className="mobile-sub-label">Duration</label>
                  <select
                    value={transferMobileDuration}
                    onChange={(event) => {
                      const nextVal = event.target.value;
                      setTransferMobileDuration(nextVal);
                      if (nextVal === '') {
                        setTransferEndDateInput(null);
                        setTransferEndTimeInput('00:00:00');
                        return;
                      }
                      setTransferMobileDateChoice('');
                      setTransferCustomDateMs(null);
                      const opt = transferMobileDurationOptions.find((o) => o.value === nextVal);
                      if (opt) {
                        applyTransferMobileDuration(opt.seconds);
                      }
                    }}
                  >
                    <option value="">--</option>
                    {transferMobileDurationOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="input-field mobile-duration-select">
                  <label className="mobile-sub-label">Date</label>
                  <input
                    type="text"
                    readOnly
                    value={transferCustomDateMs ? formatShortDateLabel(new Date(transferCustomDateMs)) : '--'}
                    onClick={handleTransferDateClick}
                  />
                </div>
              </div>
            </div>
            {transferEndDateInput && (
              <div className="input-subtext mobile-expiry-hint">
                {transferExpiryHintLabel}{' '}
                {formatTimestamp(Math.floor(transferEndDateInput.getTime() / 1000))}
                {transferCustomDateMs ? ' (custom)' : ''}
              </div>
            )}
          </>
        ) : (
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
        ))}
      <div className="form-actions">
        <button
          type="submit"
          className={`secondary-button${showBindPopAnimation ? ' bind-button-pop' : ''}${showBindShimmer ? ' bind-button-shimmer' : ''}`}
          disabled={bindButtonDisabled}
          onClick={stopBindAnimations}
        >
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
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      <div className="inline-message-slot">
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
      </div>
      {showTransferCustomModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>Choose custom expiry</h3>
            <div className="input-grid">
              <label className="input-field">
                <span>Date</span>
                <input
                  type="date"
                  min={formatDateIso(new Date(effectiveTransferEndDateMinMs))}
                  max={formatDateIso(new Date(effectiveTransferEndDateMaxMs))}
                  value={transferCustomModalDate}
                  onChange={(e) => setTransferCustomModalDate(e.target.value)}
                />
              </label>
              <label className="input-field">
                <span>Time</span>
                <input
                  type="time"
                  step="60"
                  value={transferCustomModalTime}
                  onChange={(e) => setTransferCustomModalTime(e.target.value)}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={handleTransferCustomSet}
                disabled={transferCustomSetDisabled}
              >
                Set
              </button>
              <button type="button" className="secondary-button ghost" onClick={handleTransferCustomCancel}>
                Cancel
              </button>
            </div>
            {transferCustomSetDisabled && (
              <div className="input-subtext modal-hint">
                The custom value must be between {formatDateTimeAmPm(effectiveTransferEndDateMinMs)} and{' '}
                {formatDateTimeAmPm(effectiveTransferEndDateMaxMs)}.
              </div>
            )}
          </div>
        </div>
      )}
      {bindDiagModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>{bindDiagModal.title}</h3>
            <ul className="diag-list">
              {bindDiagModal.rows.map((row) => (
                <li key={row.label}>
                  <strong>{row.label}:</strong> {row.value}
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setBindDiagModal(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
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
          className={`bottom-tab tab-${step.id}${isActive ? ' active' : ''}`}
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

const TopStatusBar = ({ walletConnected }: { walletConnected: boolean }) => {
  const [showPopAnimation, setShowPopAnimation] = useState(!walletConnected);
  const [showShimmer, setShowShimmer] = useState(false);
  const shimmerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!walletConnected) {
      // Start shimmer after 3s, repeat every 5-10s
      const timeout = setTimeout(() => {
        setShowShimmer(true);
        setTimeout(() => setShowShimmer(false), 800);

        shimmerIntervalRef.current = setInterval(() => {
          setShowShimmer(true);
          setTimeout(() => setShowShimmer(false), 800);
        }, 5000 + Math.random() * 5000);
      }, 3000);

      return () => {
        clearTimeout(timeout);
        if (shimmerIntervalRef.current) clearInterval(shimmerIntervalRef.current);
      };
    } else {
      // Wallet connected - stop animations
      setShowPopAnimation(false);
      setShowShimmer(false);
      if (shimmerIntervalRef.current) {
        clearInterval(shimmerIntervalRef.current);
        shimmerIntervalRef.current = null;
      }
    }
  }, [walletConnected]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (shimmerIntervalRef.current) clearInterval(shimmerIntervalRef.current);
    };
  }, []);

  return (
    <div className="top-banner">
      <div
        className={`connect-button-wrapper${showPopAnimation ? ' bind-button-pop' : ''}${showShimmer ? ' bind-button-shimmer' : ''}`}
      >
        <ConnectButton chainStatus="full" showBalance={false} />
      </div>
    </div>
  );
};

const shortHash = (hash: `0x${string}`) => `${hash.slice(0, 8)}…${hash.slice(-6)}`;

const formatDateTimeAmPm = (ms: number) => {
  const d = new Date(ms);
  const pad = (v: number) => v.toString().padStart(2, '0');
  const hours24 = d.getHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hours12)}:${pad(d.getMinutes())} ${ampm}`;
};

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

const formatMsWithSeconds = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return 'N/A';
  return formatTimestamp(Math.floor(ms / 1000));
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
