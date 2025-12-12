import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useReconnect, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { base, anvil } from 'wagmi/chains';
import { concatHex, keccak256, parseEther, stringToBytes } from 'viem';
import duration from 'human-duration';
import './App.css';
import { useBindAndLockStore } from './store/lock_and_bind';
import type { BalanceView, BindingView, LockDetailsView } from './types/lock_and_bind';
import { HyprDao as CallerApp } from '#caller-utils';

const simulationMode = import.meta.env.VITE_SIMULATION_MODE === 'true';

type StepId = 'approve' | 'lock' | 'bind';
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
    id: 'approve',
    title: 'Approve',
    description: '',
    icon: 'check',
  },
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
  [anvil.id]: '0x326Aa6822847B97a8387445a497e01253aC6E82B',
};

const showDiagnostics = import.meta.env.VITE_SHOW_DIAGNOSTICS === 'true';

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
const FALLBACK_CHAIN_ID =
  import.meta.env.VITE_SIMULATION_MODE === 'true' || import.meta.env.MODE === 'development'
    ? anvil.id
    : base.id;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const COLLAPSE_BUFFER_MS = 5 * 1000;
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
  let h = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const hh = String(h).padStart(2, '0');
  return `${mm} ${dd} '${yy} ${hh}:${minutes} ${suffix}`;
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
  months: '0',
  weeks: '0',
  days: '0',
  hours: '0',
  minutes: '0',
  seconds: '0',
};

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
  durationInputsFromSeconds(BigInt(minSeconds));

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

  // Lock button animation state (for bottom tabs)
  const [showLockPopAnimation, setShowLockPopAnimation] = useState(false);
  const [showLockShimmer, setShowLockShimmer] = useState(false);
  const lockShimmerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lockShimmerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLockApproved = useRef(false);

  // Bind tab animation state (for bottom tabs)
  const [showBindTabPopAnimation, setShowBindTabPopAnimation] = useState(false);
  const [showBindTabShimmer, setShowBindTabShimmer] = useState(false);
  const bindTabShimmerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bindTabShimmerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevHasLock = useRef(false);
  const [connectPulse, setConnectPulse] = useState(false);
  const [desiredBindView, setDesiredBindView] = useState<BindView | null>(null);

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
  const lockedWei = lockDetails?.amount_raw_wei ? BigInt(lockDetails.amount_raw_wei) : 0n;
  const [activeStep, setActiveStep] = useState<StepId>('approve');
  const [initialStepResolved, setInitialStepResolved] = useState(false);
  const hasBalanceData = hyprOwned !== null;
  const hasHyprHoldings = (hyprOwned?.amount_raw_wei ? BigInt(hyprOwned.amount_raw_wei) : 0n) > 0n || lockedWei > 0n;
  const lockAllowanceWei = tokeregistryAllowance?.amount_raw_wei
    ? BigInt(tokeregistryAllowance.amount_raw_wei)
    : 0n;
  const isApproved = lockAllowanceWei > 0n;
  const showHyprRequiredNotice =
    walletConnected &&
    connectComplete &&
    environmentReady &&
    hasBalanceData &&
    !hasHyprHoldings;
  const contentReady = connectComplete && !showHyprRequiredNotice && environmentReady;
  const showContent = walletConnected ? contentReady : true;
  const approveTabEnabled = walletConnected ? contentReady && !lockExpired : true;
  const lockTabEnabled = walletConnected ? contentReady && (lockAllowanceWei > 0n || lockedWei > 0n) : true;
  const bindTabEnabled =
    (walletConnected ? contentReady && !lockExpired : true) &&
    ((availableToBind && availableToBind.amount_raw_wei !== '0') || bindings.length > 0 || !walletConnected);

  // Decide initial tab after we have lock data (or know we won't)
  useEffect(() => {
    if (initialStepResolved) return;
    if (!walletConnected) {
      setActiveStep('approve');
      setInitialStepResolved(true);
      return;
    }
    // lockDetails/hyprOwned are populated after the first fetch; use that as the readiness signal
    if (lockDetails !== null || hyprOwned !== null) {
      setActiveStep(lockedWei > 0n ? 'lock' : 'approve');
      setInitialStepResolved(true);
    }
  }, [initialStepResolved, walletConnected, lockDetails, hyprOwned, lockedWei]);

  const navigateToBindView = (view: BindView) => {
    setDesiredBindView(view);
    setActiveStep('bind');
  };

  const handleDisconnectedTap = () => {
    if (!walletConnected) {
      setConnectPulse(true);
    }
  };

  useEffect(() => {
    if (lockExpired && activeStep !== 'lock') {
      setActiveStep('lock');
    }
  }, [lockExpired, activeStep]);

  useEffect(() => {
    const pickFallback = () => {
      if (lockTabEnabled) return 'lock';
      if (approveTabEnabled) return 'approve';
      if (bindTabEnabled) return 'bind';
      return activeStep;
    };

    // If current tab is not enabled, fall back (prefer Lock when available).
    if (activeStep === 'lock' && !lockTabEnabled) {
      setActiveStep(pickFallback());
      return;
    }
    if (activeStep === 'approve' && !approveTabEnabled) {
      setActiveStep(pickFallback());
      return;
    }
    if (activeStep === 'bind' && !bindTabEnabled) {
      setActiveStep(pickFallback());
      return;
    }
  }, [lockTabEnabled, bindTabEnabled, approveTabEnabled, activeStep]);

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
    if (id === 'approve') {
      return approveTabEnabled;
    }
    if (id === 'lock') {
      return lockTabEnabled;
    }
    if (id === 'bind') {
      return bindTabEnabled;
    }
    return false;
  };

  // Visual grayed state for Lock & Bind based on approval/lock status
  const hasExistingLockApp = lockedWei > 0n;

  const isStepGrayed = (id: StepId) => {
    // Allow browsing when disconnected
    // When user has a lock, nothing is grayed
    if (hasExistingLockApp) {
      return false;
    }
    if (id === 'lock') {
      // Lock is gray only when not approved
      return !isApproved && hasHyprHoldings;
    }
    if (id === 'bind') {
      // Bind is gray until user has a lock
      return hasHyprHoldings;
    }
    return false;
  };

  // Lock button pop & shine animation when approval happens
  useEffect(() => {
    const shouldAnimate = walletConnected && isApproved && !hasExistingLockApp;

    if (shouldAnimate && !prevLockApproved.current) {
      // Just approved - trigger pop animation
      setShowLockPopAnimation(true);

      // Start shimmer after 1s, repeat every 3s
      lockShimmerTimeoutRef.current = setTimeout(() => {
        setShowLockShimmer(true);
        setTimeout(() => setShowLockShimmer(false), 800);

        lockShimmerIntervalRef.current = setInterval(() => {
          setShowLockShimmer(true);
          setTimeout(() => setShowLockShimmer(false), 800);
        }, 3000);
      }, 1000);
    }

    if (!shouldAnimate) {
      setShowLockPopAnimation(false);
      setShowLockShimmer(false);
      if (lockShimmerTimeoutRef.current) {
        clearTimeout(lockShimmerTimeoutRef.current);
        lockShimmerTimeoutRef.current = null;
      }
      if (lockShimmerIntervalRef.current) {
        clearInterval(lockShimmerIntervalRef.current);
        lockShimmerIntervalRef.current = null;
      }
    }

    prevLockApproved.current = isApproved;
  }, [walletConnected, isApproved, hasExistingLockApp]);

  // Cleanup shimmer interval on unmount
  useEffect(() => {
    return () => {
      if (lockShimmerTimeoutRef.current) clearTimeout(lockShimmerTimeoutRef.current);
      if (lockShimmerIntervalRef.current) clearInterval(lockShimmerIntervalRef.current);
    };
  }, []);

  // Bind tab animation - shine when have lock but no bindings
  useEffect(() => {
    const hasLock = lockedWei > 0n;
    const hasBindings = bindings.length > 0;
    const shouldAnimate = walletConnected && hasLock && !hasBindings;

    if (shouldAnimate && !prevHasLock.current) {
      // Just got a lock - trigger pop animation
      setShowBindTabPopAnimation(true);

      // Start shimmer after 1s, repeat every 3s
      bindTabShimmerTimeoutRef.current = setTimeout(() => {
        setShowBindTabShimmer(true);
        setTimeout(() => setShowBindTabShimmer(false), 800);

        bindTabShimmerIntervalRef.current = setInterval(() => {
          setShowBindTabShimmer(true);
          setTimeout(() => setShowBindTabShimmer(false), 800);
        }, 3000);
      }, 1000);
    }

    if (!shouldAnimate) {
      setShowBindTabPopAnimation(false);
      setShowBindTabShimmer(false);
      if (bindTabShimmerTimeoutRef.current) {
        clearTimeout(bindTabShimmerTimeoutRef.current);
        bindTabShimmerTimeoutRef.current = null;
      }
      if (bindTabShimmerIntervalRef.current) {
        clearInterval(bindTabShimmerIntervalRef.current);
        bindTabShimmerIntervalRef.current = null;
      }
    }

    prevHasLock.current = hasLock;
  }, [walletConnected, lockedWei, bindings.length]);

  // Cleanup Bind tab shimmer interval on unmount
  useEffect(() => {
    return () => {
      if (bindTabShimmerTimeoutRef.current) clearTimeout(bindTabShimmerTimeoutRef.current);
      if (bindTabShimmerIntervalRef.current) clearInterval(bindTabShimmerIntervalRef.current);
    };
  }, []);

  // Lock create button shimmer when creating first lock
  // Reuse tab animations for create buttons
  const createLockButtonPop = showLockPopAnimation;
  const createLockButtonShimmer = showLockShimmer;
  const createBindButtonPop = showBindTabPopAnimation;
  const createBindButtonShimmer = showBindTabShimmer;
  const handleSelectStep = (id: StepId) => {
    if (canAccessStep(id)) {
      setActiveStep(id);
    }
  };

  const stepDescription = useMemo(() => {
    if (activeStep === 'approve' || activeStep === 'lock' || activeStep === 'bind') return '';
    return steps.find((step) => step.id === activeStep)?.description ?? '';
  }, [activeStep]);
  const activeStepTitle = useMemo(() => {
    if (activeStep === 'approve' || activeStep === 'lock' || activeStep === 'bind') return '';
    return steps.find((step) => step.id === activeStep)?.title ?? '';
  }, [activeStep]);

  if (walletConnected && !initialStepResolved) {
    return (
      <div className={`app${!walletConnected ? ' disconnected' : ''}`}>
        <div className="phone-shell">
          <div className="phone-frame">
            <TopStatusBar
              walletConnected={walletConnected}
              triggerConnectPulse={connectPulse}
              onConsumeConnectPulse={() => setConnectPulse(false)}
            />
            <div className="phone-body">
              <div className="hypr-required-card">
                <h3>Loading</h3>
                <p>Fetching lock status…</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app${!walletConnected ? ' disconnected' : ''}`}>
      <div className="phone-shell">
        <div className="phone-frame">
          <TopStatusBar
            walletConnected={walletConnected}
            triggerConnectPulse={connectPulse}
            onConsumeConnectPulse={() => setConnectPulse(false)}
          />

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

                <main className="step-content" onClick={handleDisconnectedTap}>
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
          {activeStep === 'approve' && (
            <ApproveStep
              walletConnected={walletConnected}
              walletAddress={address}
              hyprTokenAddress={hyprTokenAddress}
              hyprOwned={hyprOwned}
              lockAllowance={tokeregistryAllowance}
              targetRegistryAddress={targetRegistryAddress}
              refreshLockStatus={refreshLockStatusForWallet}
              hasExistingLock={lockedWei > 0n}
              lockDetails={lockDetails}
              onNavigateLock={() => setActiveStep('lock')}
              onNavigateBind={navigateToBindView}
            />
          )}

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
              bindings={bindings}
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
              hasBindings={bindings.length > 0}
              onNavigateBind={navigateToBindView}
              bindTabPop={showBindTabPopAnimation}
              bindTabShimmer={showBindTabShimmer}
              lockCreatePop={createLockButtonPop}
              lockCreateShimmer={createLockButtonShimmer}
              onWithdrawSuccess={() => setActiveStep('approve')}
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
              desiredBindView={desiredBindView}
              onConsumeDesiredBindView={() => setDesiredBindView(null)}
              bindCreatePop={createBindButtonPop}
              bindCreateShimmer={createBindButtonShimmer}
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
            isStepGrayed={isStepGrayed}
            onSelect={handleSelectStep}
            lockPopAnimation={showLockPopAnimation}
            lockShimmer={showLockShimmer}
            bindPopAnimation={showBindTabPopAnimation}
            bindShimmer={showBindTabShimmer}
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
  bindings: BindingView[];
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
  hasBindings: boolean;
  onNavigateBind: (view: BindView) => void;
  bindTabPop: boolean;
  bindTabShimmer: boolean;
  lockCreatePop: boolean;
  lockCreateShimmer: boolean;
  onWithdrawSuccess?: () => void;
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
  bindings,
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
  hasBindings,
  onNavigateBind,
  bindTabPop,
  bindTabShimmer,
  lockCreatePop,
  lockCreateShimmer,
  onWithdrawSuccess,
}: LockStepProps) => {
  const nowMs = useCurrentTimeMs();
  const [amountInput, setAmountInput] = useState('');
  const [durationInputs, setDurationInputs] = useState<DurationInputValues>(() =>
    createDefaultDurationInputsAtLeastMin(minLockDurationSeconds),
  );
  const [lockView, setLockView] = useState<LockView>(() => {
    const lockedAmountWeiInit = lockDetails?.amount_raw_wei ? BigInt(lockDetails.amount_raw_wei) : 0n;
    return lockedAmountWeiInit > 0n ? 'details' : 'manage';
  });
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
  const withdrawHandledRef = useRef(false);

  const [pendingLock, setPendingLock] = useState<{ amount: bigint; duration: bigint } | null>(null);
  const allowanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manageRetryRef = useRef(false);
  const nowSeconds = Math.floor(nowMs / 1000);
  const [userSetLockView, setUserSetLockView] = useState(false);

  const durationParts = useMemo(() => inputsToDurationParts(durationInputs), [durationInputs]);
  const lockedAmountWei = lockDetails?.amount_raw_wei ? BigInt(lockDetails.amount_raw_wei) : 0n;
  const hasExistingLock = lockedAmountWei > 0n;
  const displayLockView =
    hasExistingLock && lockView === 'manage' && !userSetLockView ? 'details' : lockView;
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
    } else if (!hasExistingLock && lockView !== 'manage') {
      setLockView('manage');
    }
  }, [hasExistingLock, lockView, userSetLockView]);

  useEffect(() => {
    if (lockExpired && displayLockView !== 'details') {
      setUserSetLockView(false);
      setLockView('details');
    }
  }, [lockExpired, displayLockView]);
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
  const lockEndDateMin = useMemo(
    () => new Date((nowSeconds + minLockDurationSeconds) * 1000),
    [nowSeconds, minLockDurationSeconds],
  );
  const lockEndDateMax = useMemo(
    () => new Date((nowSeconds + MAX_LOCK_DURATION_SECONDS) * 1000),
    [nowSeconds],
  );
  const extendMinDurationSeconds = useMemo(() => {
    if (!hasExistingLock || !lockDetails?.unlock_timestamp) return minLockDurationSeconds;
    const remaining = Math.max(0, lockDetails.unlock_timestamp - nowSeconds);
    // Clamp up to the protocol min; if the lock is close to expiring, min becomes the global minimum.
    return Math.max(minLockDurationSeconds, remaining + 1);
  }, [hasExistingLock, lockDetails?.unlock_timestamp, minLockDurationSeconds, nowSeconds]);
  const extendMinMillis = useMemo(
    () => nowMs + extendMinDurationSeconds * 1000,
    [extendMinDurationSeconds, nowMs],
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
  // Duration is source of truth for all lock flows
  const effectiveMode: DurationMode = 'duration';
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
    lockView === 'extend' && hasExistingLock && !lockDurationDirty
      ? BigInt(extendMinDurationSeconds)
      : lockDurationSecondsFromInputs;
  // If user chooses the live MIN duration in extend mode, keep it in sync (do not mark dirty)
  useEffect(() => {
    if (!hasExistingLock) return;
    if (lockView !== 'extend') return;
    const minSecondsBigInt = BigInt(extendMinDurationSeconds);
    if (selectedLockDurationSeconds === minSecondsBigInt && lockDurationDirty) {
      setLockDurationDirty(false);
      setDurationInputs(durationInputsFromSeconds(minSecondsBigInt));
    }
  }, [
    extendMinDurationSeconds,
    hasExistingLock,
    lockDurationDirty,
    lockView,
    selectedLockDurationSeconds,
  ]);
  // Keep extend view synced to the live minimum duration unless the user has edited the duration inputs.
  useEffect(() => {
    if (!hasExistingLock) return;
    if (lockView !== 'extend') return;
    if (lockDurationDirty) return;
    const minSecondsBigInt = BigInt(extendMinDurationSeconds);
    if (selectedLockDurationSeconds !== minSecondsBigInt) {
      setDurationInputs(durationInputsFromSeconds(minSecondsBigInt));
    }
  }, [
    extendMinDurationSeconds,
    hasExistingLock,
    lockDurationDirty,
    lockView,
    selectedLockDurationSeconds,
  ]);
  useEffect(() => {
    if (hasExistingLock) return;
    if (displayLockView !== 'manage') return;
    if (selectedLockDurationSeconds <= 0n) return;
    let next: Date;
    if (
      lockView === 'extend' &&
      hasExistingLock &&
      !lockDurationDirty &&
      lockDetails?.unlock_timestamp
    ) {
      next = new Date((lockDetails.unlock_timestamp + 1) * 1000);
    } else {
      next = new Date(nowMs + Number(selectedLockDurationSeconds) * 1000);
    }
    setLockEndDateInput(next);
  }, [hasExistingLock, lockView, lockDurationDirty, displayLockView, selectedLockDurationSeconds, nowMs, lockDetails?.unlock_timestamp]);
  useEffect(() => {
    if (!hasExistingLock) return;
    if (lockView !== 'extend') return;
    if (selectedLockDurationSeconds <= 0n) return;
    const next = new Date(nowMs + Number(selectedLockDurationSeconds) * 1000);
    setLockEndDateInput(next);
  }, [hasExistingLock, lockView, selectedLockDurationSeconds, nowMs]);
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
    if (!isWithdrawConfirmed) {
      withdrawHandledRef.current = false;
      return;
    }
    if (withdrawHandledRef.current) return;
    withdrawHandledRef.current = true;
    void refreshLockStatus();
    if (onWithdrawSuccess) {
      onWithdrawSuccess();
    }
  }, [isWithdrawConfirmed, refreshLockStatus, onWithdrawSuccess]);

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

    if (effectiveSelectedLockDurationSeconds <= 0n) {
      pushManageError('Enter a positive duration.');
      return;
    }
    if (effectiveSelectedLockDurationSeconds > BigInt(MAX_LOCK_DURATION_SECONDS)) {
      pushManageError(`Duration must be less than or equal to ${formatDurationSeconds(MAX_LOCK_DURATION_SECONDS)}.`);
      return;
    }

    const amountWei = additionalAmountWei;
    const allowanceWei = lockAllowance ? BigInt(lockAllowance.amount_raw_wei) : 0n;
    const needsAllowanceTopUp = amountWei > allowanceWei;
    let submittedDurationSeconds = lockDurationForValidation;
    if (hasExistingLock && amountWei > 0n) {
      const requiredDuration = calculateRequiredAdditionalDuration(
        existingAmountWei,
        currentRemainingSeconds,
        amountWei,
        lockDurationForValidation,
      );
      if (!requiredDuration) {
        pushManageError(
          'The size and duration of your existing lock restricts you from achieving your new desired lock duration. Consider either committing more HYPR or choosing a target duration closer to the existing lock duration.',
        );
        return;
      }
      submittedDurationSeconds = requiredDuration;
    }
    if (submittedDurationSeconds < BigInt(minLockDurationSeconds)) {
      submittedDurationSeconds = BigInt(minLockDurationSeconds);
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
    const minDelta = Math.max(0, actualMinMsForView - nowMs);
    const maxDelta = Math.max(0, maxMsForView - nowMs);
    const delta = ms - nowMs;
    if (delta < minDelta || delta > maxDelta) {
      return;
    }
    const secondsFromNow = Math.max(0, Math.floor((ms - nowMs) / 1000));
    setDurationInputs(durationInputsFromSeconds(BigInt(secondsFromNow)));
    setLockCustomDateMs(ms);
    setLockMobileDateChoice(ms.toString());
    setLockEndDateInput(candidate);
    setLockEndTimeInput(formatTimeFromDate(candidate));
    setLockEndTimeDirty(true);
    setLockDurationDirty(true);
    setLockMobileDuration('');
    setShowLockCustomModal(false);
  };

  const lockHeaderSubtitle = 'Lock some or all of your approved HYPR to use in bindings and to enable DAO voting rights.';
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
  // Use a live remaining-seconds view so validation stays in sync with the ticking lock
  const currentRemainingSeconds = useMemo(() => {
    if (!hasExistingLock || !lockDetails?.unlock_timestamp) return existingDurationSeconds;
    return BigInt(Math.max(0, lockDetails.unlock_timestamp - nowSeconds));
  }, [existingDurationSeconds, hasExistingLock, lockDetails?.unlock_timestamp, nowSeconds]);
  const zeroAmountExtendingOnly =
    hasExistingLock && additionalAmountWei === 0n && currentRemainingSeconds > 0n;

  const addWeightedMinDurationSeconds = useMemo(() => {
    if (!hasExistingLock || lockView !== 'manage') return null;
    const target = BigInt(minLockDurationSeconds);
    const weighted = weightedDurationSeconds(
      existingAmountWei,
      currentRemainingSeconds,
      additionalAmountWei,
      target,
    );
    if (!weighted) return null;
    return weighted < target ? target : weighted;
  }, [
    additionalAmountWei,
    currentRemainingSeconds,
    existingAmountWei,
    hasExistingLock,
    lockView,
    minLockDurationSeconds,
    weightedDurationSeconds,
  ]);

  const manageMinDurationSeconds = useMemo(() => {
    if (!hasExistingLock || lockView !== 'manage') return null;
    if (addWeightedMinDurationSeconds) return Number(addWeightedMinDurationSeconds);
    const fallback = lockDetails?.remaining_seconds ?? minLockDurationSeconds;
    return Math.max(minLockDurationSeconds, fallback);
  }, [addWeightedMinDurationSeconds, hasExistingLock, lockDetails?.remaining_seconds, lockView, minLockDurationSeconds]);
  const manageMaxDurationSeconds = useMemo(() => {
    if (!hasExistingLock || lockView !== 'manage') return null;
    const remaining = Number(currentRemainingSeconds);
    return Math.max(remaining, manageMinDurationSeconds ?? 0);
  }, [currentRemainingSeconds, hasExistingLock, lockView, manageMinDurationSeconds]);
  // Keep manage view MIN/NO CHANGE selections in sync with live values unless the user has edited inputs
  useEffect(() => {
    if (!hasExistingLock) return;
    if (lockView !== 'manage') return;
    if (lockDurationDirty) return;
    if (lockMobileDuration === '__min__') {
      const minSeconds = manageMinDurationSeconds ?? minLockDurationSeconds;
      const minSecondsBigInt = BigInt(minSeconds);
      if (selectedLockDurationSeconds !== minSecondsBigInt) {
        setDurationInputs(durationInputsFromSeconds(minSecondsBigInt));
      }
      return;
    }
    if (lockMobileDuration === '__current__') {
      const currentSecondsBigInt = BigInt(currentRemainingSeconds);
      if (selectedLockDurationSeconds !== currentSecondsBigInt) {
        setDurationInputs(durationInputsFromSeconds(currentSecondsBigInt));
      }
    }
  }, [
    currentRemainingSeconds,
    hasExistingLock,
    lockDurationDirty,
    lockMobileDuration,
    lockView,
    manageMinDurationSeconds,
    minLockDurationSeconds,
    selectedLockDurationSeconds,
  ]);
  // Keep manage view end-date preview aligned to live min/NO CHANGE when presets are selected
  useEffect(() => {
    if (!hasExistingLock) return;
    if (lockView !== 'manage') return;
    if (lockDurationDirty) return;
    if (lockMobileDuration === '__min__') {
      const minSeconds = manageMinDurationSeconds ?? minLockDurationSeconds;
      const next = new Date(nowMs + minSeconds * 1000);
      setLockEndDateInput(next);
      setLockEndTimeInput(formatTimeFromDate(next));
      return;
    }
    if (lockMobileDuration === '__current__') {
      const currentSeconds = Number(currentRemainingSeconds);
      const next = new Date(nowMs + currentSeconds * 1000);
      setLockEndDateInput(next);
      setLockEndTimeInput(formatTimeFromDate(next));
    }
  }, [
    currentRemainingSeconds,
    formatTimeFromDate,
    hasExistingLock,
    lockDurationDirty,
    lockMobileDuration,
    lockView,
    manageMinDurationSeconds,
    minLockDurationSeconds,
    nowMs,
  ]);
  const applyLockMobileDuration = useCallback(
    (seconds: number) => {
      const next = new Date(Date.now() + seconds * 1000);
      setLockMobileDateChoice('');
      setLockEndDateInput(next);
      setLockEndTimeInput(formatTimeFromDate(next));
      setLockEndTimeDirty(true);
      const isExtendMin =
        hasExistingLock && lockView === 'extend' && seconds === extendMinDurationSeconds;
      const isManageMin =
        hasExistingLock && lockView === 'manage' && seconds === (manageMinDurationSeconds ?? minLockDurationSeconds);
      const isNoChange =
        hasExistingLock && lockView === 'manage' && seconds === Number(currentRemainingSeconds);
      setLockDurationDirty(!(isExtendMin || isManageMin || isNoChange));
      setDurationInputs(durationInputsFromSeconds(BigInt(seconds)));
    },
    [
      currentRemainingSeconds,
      formatTimeFromDate,
      hasExistingLock,
      lockView,
      extendMinDurationSeconds,
      manageMinDurationSeconds,
      minLockDurationSeconds,
    ],
  );
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
    if (!manageMaxDurationSeconds) return null;
    const candidateMs = nowMs + manageMaxDurationSeconds * 1000;
    return Math.min(candidateMs, lockEndDateMax.getTime());
  }, [lockEndDateMax, manageMaxDurationSeconds, nowMs]);

  const maxMsForView = useMemo(() => {
    const base = lockEndDateMax.getTime();
    if (lockView === 'manage' && hasExistingLock && addDynamicMaxMs !== null) {
      // For Add view, cap at current expiry (NO CHANGE) so hints align and do not drift past current expiry
      return addDynamicMaxMs;
    }
    return base;
  }, [addDynamicMaxMs, hasExistingLock, lockEndDateMax, lockView]);

  const lockEndDateDisplayMax = useMemo(() => {
    const base = new Date(maxMsForView);
    base.setHours(0, 0, 0, 0);
    return base;
  }, [maxMsForView]);

  const addDisplayMinDateForHint = useMemo(() => {
    if (lockView === 'manage' && hasExistingLock && manageMinDurationSeconds !== null) {
      return roundUpToNextDay(nowMs + manageMinDurationSeconds * 1000);
    }
    return extendEndDateDisplayMin;
  }, [extendEndDateDisplayMin, hasExistingLock, lockView, manageMinDurationSeconds, nowMs]);
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
      const minSeconds = manageMinDurationSeconds ?? minLockDurationSeconds;
      return nowMs + minSeconds * 1000;
    }
    return lockEndDateMin.getTime();
  }, [extendMinMillis, hasExistingLock, lockEndDateMin, lockView, manageMinDurationSeconds, minLockDurationSeconds, nowMs]);
  const displayMinDateForHint = useMemo(
    () => roundUpToNextDay(actualMinMsForView),
    [actualMinMsForView],
  );
  const minEndDateForValidationMs =
    lockView === 'extend'
      ? extendMinMillis
      : lockView === 'manage' && hasExistingLock
        ? nowMs + (manageMinDurationSeconds ?? minLockDurationSeconds) * 1000
        : lockEndDateMin.getTime();
  const lockMinDurationSecondsForValidation =
    lockView === 'extend'
      ? extendMinDurationSeconds
      : hasExistingLock && lockView === 'manage'
        ? manageMinDurationSeconds ?? minLockDurationSeconds
        : minLockDurationSeconds;
  const lockMaxDurationSecondsForValidation =
    lockView === 'extend'
      ? MAX_LOCK_DURATION_SECONDS
      : hasExistingLock && lockView === 'manage'
        ? manageMaxDurationSeconds ?? lockMinDurationSecondsForValidation
        : MAX_LOCK_DURATION_SECONDS;
  const effectiveSelectedLockDurationSeconds = useMemo(() => {
    const min = BigInt(lockMinDurationSecondsForValidation);
    const max = BigInt(lockMaxDurationSecondsForValidation);
    const cap = BigInt(MAX_LOCK_DURATION_SECONDS);
    let next = selectedLockDurationSeconds;
    if (next < min) next = min;
    if (next > max) next = max;
    if (next > cap) next = cap;
    return next;
  }, [
    lockMaxDurationSecondsForValidation,
    lockMinDurationSecondsForValidation,
    selectedLockDurationSeconds,
  ]);
  const lockCustomActive = useMemo(
    () => isMobile && !!lockCustomDateMs && !!lockMobileDateChoice,
    [isMobile, lockCustomDateMs, lockMobileDateChoice],
  );
  const lockRawCustomDurationSeconds = useMemo(() => {
    if (!lockCustomActive || !lockCustomDateMs) return null;
    return BigInt(Math.max(0, Math.floor((lockCustomDateMs - nowMs) / 1000) + 1));
  }, [lockCustomActive, lockCustomDateMs, nowMs]);
  const lockDurationForValidation =
    lockCustomActive && lockRawCustomDurationSeconds !== null
      ? lockRawCustomDurationSeconds
      : effectiveSelectedLockDurationSeconds;
  const hasValidEndDate =
    lockDurationForValidation >= BigInt(lockMinDurationSecondsForValidation) &&
    lockDurationForValidation <= BigInt(lockMaxDurationSecondsForValidation) &&
    lockDurationForValidation <= BigInt(MAX_LOCK_DURATION_SECONDS);
  const durationLessThanExisting =
    zeroAmountExtendingOnly && lockDurationForValidation < currentRemainingSeconds;
  const requiredDurationSeconds = useMemo(() => {
    if (!hasExistingLock || additionalAmountWei <= 0n) {
      return lockDurationForValidation;
    }
    return (
      calculateRequiredAdditionalDuration(
        existingAmountWei,
        currentRemainingSeconds,
        additionalAmountWei,
        lockDurationForValidation,
      ) ?? lockDurationForValidation
    );
  }, [
    additionalAmountWei,
    existingAmountWei,
    currentRemainingSeconds,
    hasExistingLock,
    lockDurationForValidation,
  ]);
  // When a custom date is active on mobile, keep the raw duration synced each second to the fixed timestamp
  useEffect(() => {
    if (!lockCustomActive || !lockCustomDateMs) return;
    if (!lockMobileDateChoice || lockMobileDateChoice === '') return;
    const rawSeconds = Math.max(0, Math.floor((lockCustomDateMs - nowMs) / 1000) + 1);
    const rawBig = BigInt(rawSeconds);
    if (selectedLockDurationSeconds !== rawBig) {
      setDurationInputs(durationInputsFromSeconds(rawBig));
    }
    const nextDate = new Date(lockCustomDateMs);
    setLockEndDateInput(nextDate);
    setLockEndTimeInput(formatTimeFromDate(nextDate));
  }, [
    formatTimeFromDate,
    lockCustomActive,
    lockCustomDateMs,
    lockMobileDateChoice,
    nowMs,
    selectedLockDurationSeconds,
  ]);
  const lockPreviewMs = useMemo(() => {
    const previewSeconds =
      lockCustomActive && lockRawCustomDurationSeconds !== null
        ? lockRawCustomDurationSeconds
        : effectiveSelectedLockDurationSeconds;
    if (previewSeconds <= 0n) return null;
    const durMs = Number(previewSeconds) * 1000;
    const minMs = actualMinMsForView;
    const maxMs = maxMsForView;
    const target = nowMs + durMs;
    if (target < minMs) return minMs;
    if (target > maxMs) return maxMs;
    return target;
  }, [actualMinMsForView, effectiveSelectedLockDurationSeconds, maxMsForView, nowMs]);
  // Keep the lock expiry preview in sync with the selected duration so the hint ticks with "now"
  useEffect(() => {
    if (effectiveMode !== 'duration') return;
    if (lockPreviewMs === null) return;
    const next = new Date(lockPreviewMs);
    setLockEndDateInput(next);
    setLockEndTimeInput(formatTimeFromDate(next));
  }, [effectiveMode, formatTimeFromDate, lockPreviewMs]);
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

  const lockCustomSetDisabled = useMemo(() => {
    if (!lockCustomModalDate || !lockCustomModalTime) return true;
    const candidate = new Date(`${lockCustomModalDate}T${lockCustomModalTime}:00`);
    if (Number.isNaN(candidate.getTime())) return true;
    const ms = candidate.getTime();
    const minDelta = Math.max(0, actualMinMsForView - nowMs);
    const maxDelta = Math.max(0, maxMsForView - nowMs);
    const delta = ms - nowMs;
    return delta < minDelta || delta > maxDelta;
  }, [actualMinMsForView, lockCustomModalDate, lockCustomModalTime, maxMsForView, nowMs]);
  const lockCustomHintMin = useMemo(
    () => new Date(nowMs + Math.max(0, actualMinMsForView - nowMs)),
    [actualMinMsForView, nowMs],
  );
  const lockCustomHintMax = useMemo(
    () => new Date(nowMs + Math.max(0, maxMsForView - nowMs)),
    [maxMsForView, nowMs],
  );
  const lockCustomPrefillMs = useMemo(() => {
    const baseRaw = lockEndDateInput ?? new Date(defaultEndMsForView);
    const plusBuffer = baseRaw.getTime() + 60 * 1000;
    const clamped = Math.min(Math.max(plusBuffer, actualMinMsForView), maxMsForView);
    return normalizeToMinute(clamped);
  }, [actualMinMsForView, defaultEndMsForView, lockEndDateInput, maxMsForView]);
  const lockRangeCollapsed = false;
  const handleLockDateClick = () => {
    const base = new Date(nowMs);
    setLockCustomModalDate(formatDateIsoInput(base));
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

  const lockMinSecondsForOptions = useMemo(() => {
    if (lockView === 'extend' && hasExistingLock) {
      return extendMinDurationSeconds;
    }
    if (lockView === 'manage' && hasExistingLock) {
      return Math.max(0, (manageMinDurationSeconds ?? minLockDurationSeconds) + 60);
    }
    // Use a 60s cushion above the live min to avoid edge/rounding drift vs validation min
    const minMs = lockEndDateMin.getTime();
    return Math.max(0, Math.round((minMs - nowMs) / 1000) + 60);
  }, [
    extendMinDurationSeconds,
    hasExistingLock,
    lockEndDateMin,
    lockView,
    manageMinDurationSeconds,
    minLockDurationSeconds,
    nowMs,
  ]);

  const lockMobileDurationOptions = useMemo(() => {
    if (isMobile && lockView === 'manage' && hasExistingLock) {
      const baseSeconds = Number(currentRemainingSeconds);
      if (baseSeconds <= 0) return [];
      const minSeconds = Math.max(0, manageMinDurationSeconds ?? minLockDurationSeconds);
      const maxSeconds = Math.max(minSeconds, manageMaxDurationSeconds ?? baseSeconds);
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
      const candidates: { label: string; seconds: number; value: string }[] = [];
      // MIN duration entry (live min)
      candidates.push({ label: 'MIN duration', seconds: minSeconds, value: '__min__' });
      deltas.forEach((delta) => {
        const candidateSeconds = Math.max(0, baseSeconds - delta.seconds);
        if (candidateSeconds >= minSeconds && candidateSeconds <= maxSeconds) {
          candidates.push({ label: delta.label, seconds: candidateSeconds, value: delta.label });
        }
      });
      const currentSeconds = baseSeconds;
      if (currentSeconds >= minSeconds && currentSeconds <= maxSeconds) {
        candidates.push({ label: 'NO CHANGE', seconds: currentSeconds, value: '__current__' });
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
    }
    if (!isMobile) return MOBILE_DURATION_OPTIONS;
    const minSeconds = lockMinSecondsForOptions;
    const nowMsLocal = nowMs;
    const maxSeconds = Math.max(minSeconds, Math.round((maxMsForView - nowMsLocal) / 1000));
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
    currentRemainingSeconds,
    existingDurationSeconds,
    hasExistingLock,
    isMobile,
    lockDetails?.unlock_timestamp,
    lockView,
    manageMaxDurationSeconds,
    manageMinDurationSeconds,
    maxMsForView,
    minEndDateForValidationMs,
    minLockDurationSeconds,
    nowMs,
    nowSeconds,
  ]);
  // Keep mobile manage preset selections (including relative deltas) synced to the live remaining time
  useEffect(() => {
    if (!isMobile) return;
    if (!(lockView === 'manage' && hasExistingLock)) return;
    if (!lockMobileDuration) return;
    if (lockMobileDuration === '__custom__') return;
    const opt = lockMobileDurationOptions.find((o) => o.value === lockMobileDuration);
    if (!opt) return;
    const nextSeconds = opt.seconds;
    const nextBig = BigInt(nextSeconds);
    if (selectedLockDurationSeconds === nextBig && !lockDurationDirty) {
      return;
    }
    setDurationInputs(durationInputsFromSeconds(nextBig));
    setLockDurationDirty(false);
    const nextDate = new Date(nowMs + nextSeconds * 1000);
    setLockEndDateInput(nextDate);
    setLockEndTimeInput(formatTimeFromDate(nextDate));
  }, [
    formatTimeFromDate,
    hasExistingLock,
    isMobile,
    lockDurationDirty,
    lockMobileDuration,
    lockMobileDurationOptions,
    lockView,
    nowMs,
    selectedLockDurationSeconds,
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
      !lockEndDateInput ||
      (lockMobileDuration === '' && !lockMobileDateChoice && lockCustomDateMs === null);
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

  const maxAmountLabel = walletConnected
    ? lockAllowance?.amount_formatted_hypr ?? 'HYPR'
    : 'HYPR';
  const amountLabel = !walletConnected
    ? 'Amount (HYPR)'
    : hasExistingLock
      ? `Amount to add (approved up to ${maxAmountLabel})`
      : `Amount (approved up to ${maxAmountLabel})`;
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
      // Preserve a chosen custom date; otherwise clear the selection
      if (lockCustomDateMs === null) {
        setLockMobileDateChoice(null);
      }
      return;
    }
  }, [lockCustomDateMs, lockFilteredSpecialDates]);
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

  const handleShowDetailsPanel = useCallback(() => {
    if (hasExistingLock) {
      setUserSetLockView(true);
      setLockView('details');
    }
  }, [hasExistingLock]);

  return (
    <section className="step-card lock-step">
      {displayLockView === 'details' && (
        <div className="lock-grid">
          {lockDetails && hasExistingLock ? (
            <div className="lock-detail-card">
              <div className="lock-card lock-detail-stat">
                <span className="lock-card-label">
                  {lockExpired ? 'Previously locked amount' : 'Locked amount'}
                </span>
                <span className="lock-card-value">
                  {lockDetails.amount_formatted_hypr}
                  {lockExpired && (
                    <button
                      type="button"
                      className="pill-button warning-pill inline-pill"
                      onClick={handleWithdraw}
                    >
                      {isWithdrawPending || isWithdrawConfirming ? <span className="spinner" /> : 'Withdraw'}
                    </button>
                  )}
                </span>
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
                {!lockExpired && (
                  <span className="lock-card-sub actions-inline">
                    <button
                      type="button"
                      className="pill-button"
                      onClick={handleShowExtendPanel}
                    >
                      Extend lock
                    </button>
                    {lockAvailableWei > 0n && (
                      <button
                        type="button"
                        className="pill-button"
                        onClick={handleShowManagePanel}
                      >
                        Add HYPR
                      </button>
                    )}
                  </span>
                )}
                {lockExpired && (
                  <div className="inline-hint">
                    HYPR must be withdrawn from an expired lock to permit creation of a new lock.
                  </div>
                )}
              </div>
              {!lockExpired && (
                <div className="approval-locked-row" style={{ marginTop: '0.35rem' }}>
                  <div className="lock-detail-stat">
                  <span className="lock-card-label">Amount already bound</span>
                  <span className="lock-card-value">
                      {(() => {
                        const totalBoundWei = bindings.reduce((acc: bigint, b: BindingView) => {
                          return acc + BigInt(b.amount_raw_wei ?? '0');
                        }, 0n);
                        return totalBoundWei === 0n ? '0 HYPR' : formatHyprWei(totalBoundWei);
                      })()}{' '}
                      <button
                        type="button"
                        className={`pill-button${bindTabPop ? ' bind-button-pop' : ''}${bindTabShimmer ? ' bind-button-shimmer' : ''} inline-pill`}
                        style={{ fontWeight: hasBindings ? 500 : 700 }}
                        onClick={() => onNavigateBind(hasBindings ? 'details' : 'create')}
                      >
                        {hasBindings ? 'View bindings' : 'Create binding'}
                      </button>
                    </span>
                  </div>
                </div>
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
          ) : (
            <div className="lock-empty">
              <h3>No lock detected</h3>
              <p>Lock HYPR to enable binding. Once HYPR has been locked it will appear here.</p>
            </div>
          )}
        </div>
      )}

          {(displayLockView === 'manage' || displayLockView === 'extend') && (
        <form className="lock-form" onSubmit={handleManageLock}>
          <div className="form-header">
            <div className="form-header-text">
              <h3>
                {displayLockView === 'extend'
                  ? 'Extend lock'
                : hasExistingLock
                  ? 'Add HYPR to lock'
                  : 'Create your HYPR lock'}
              </h3>
              {displayLockView === 'manage' && !hasExistingLock && <p>{lockHeaderSubtitle}</p>}
            </div>
            {showDiagnostics && (displayLockView === 'manage' || displayLockView === 'extend') && (
              <button type="button" className="secondary-button ghost diag-button" onClick={openLockDiagnostics}>
                Diagnostics
              </button>
            )}
          </div>
          {displayLockView !== 'extend' && (
          <div className="input-grid">
            <label className="input-field">
              <span>
                {amountLabel}
              </span>
              <input
                type="number"
                min="0"
                step="0.000000000000000001"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                placeholder="0.0"
              />
              {hasExistingLock &&
                displayLockView === 'manage' &&
                additionalAmountWei > 0n &&
                !exceedsLockAvailable && (
                <span className="input-subtext">
                  New total locked amount: {formatHyprWei(existingAmountWei + additionalAmountWei)}
                </span>
              )}
            </label>
          </div>
          )}
          {showLockFormContent || displayLockView === 'extend' ? (
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
                durationSeconds={effectiveSelectedLockDurationSeconds}
                unlockPreview={null}
                computedDurationLabel={
                  lockView === 'extend'
                    ? undefined
                    : hasExistingLock
                      ? formatSeconds(Number(effectiveSelectedLockDurationSeconds))
                      : undefined
                }
                computedUnlockLabel={
                  lockView === 'extend'
                    ? undefined
                    : hasExistingLock
                      ? undefined
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
                endDateMin={undefined}
                endDateMax={undefined}
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
            <button
              type="submit"
              className={`secondary-button${!hasExistingLock ? ' lock-create-button' : ''}${!hasExistingLock && lockCreatePop ? ' bind-button-pop' : ''}${!hasExistingLock && lockCreateShimmer ? ' bind-button-shimmer' : ''}`}
              disabled={lockButtonDisabled}
            >
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
                    value={lockCustomModalDate}
                    onChange={(e) => {
                      setLockCustomModalDate(e.target.value);
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
          <div className={`input-subtext modal-hint${lockCustomSetDisabled ? ' inline-error' : ''}`}>
            The custom value must be between {formatDateTimeAmPm(lockCustomHintMin.getTime())} and{' '}
            {formatDateTimeAmPm(lockCustomHintMax.getTime())}.
          </div>
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

interface ApproveStepProps {
  walletConnected: boolean;
  walletAddress?: `0x${string}`;
  hyprTokenAddress: string | null;
  hyprOwned: BalanceView | null;
  lockAllowance: BalanceView | null;
  targetRegistryAddress: `0x${string}`;
  refreshLockStatus: () => Promise<void>;
  hasExistingLock: boolean;
  lockDetails: LockDetailsView | null;
  onNavigateLock: () => void;
  onNavigateBind: (view: BindView) => void;
}

const ApproveStep = ({
  walletConnected,
  walletAddress,
  hyprTokenAddress,
  hyprOwned,
  lockAllowance,
  targetRegistryAddress,
  refreshLockStatus,
  hasExistingLock,
  lockDetails,
  onNavigateLock,
  onNavigateBind,
}: ApproveStepProps) => {
  const [amountInput, setAmountInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successHash, setSuccessHash] = useState<`0x${string}` | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  const [showResize, setShowResize] = useState(false);
  const [showCreateLockPop, setShowCreateLockPop] = useState(false);
  const [showCreateLockShimmer, setShowCreateLockShimmer] = useState(false);
  const createLockShimmerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createLockShimmerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevCreateLockAnim = useRef(false);

  const hyprOwnedWei = hyprOwned?.amount_raw_wei ? BigInt(hyprOwned.amount_raw_wei) : 0n;
  const lockAvailableWei = lockAllowance?.amount_raw_wei ? BigInt(lockAllowance.amount_raw_wei) : 0n;
  const amountProvided = amountInput !== '';
  const hasExistingApproval = lockAvailableWei > 0n;
  const hasActiveLock = hasExistingLock;
  const lockedAmountFormatted = lockDetails?.amount_formatted_hypr ?? '0';

  const {
    data: allowanceTxHash,
    error: allowanceWriteError,
    isPending: isAllowancePending,
    writeContract: writeApproveContract,
    reset: resetAllowanceWrite,
  } = useWriteContract();

  const {
    isLoading: isAllowanceConfirming,
    isSuccess: isAllowanceConfirmed,
  } = useWaitForTransactionReceipt({
    hash: allowanceTxHash,
  });

  // Handle approval confirmation
  useEffect(() => {
    if (isAllowanceConfirmed && allowanceTxHash) {
      setSuccessHash(allowanceTxHash);
      setAmountInput('');
      setShowResize(false);
      setIsRevoking(false);
      void refreshLockStatus();
    }
  }, [isAllowanceConfirmed, allowanceTxHash, refreshLockStatus]);

  // Handle write errors
  useEffect(() => {
    if (allowanceWriteError) {
      setError(allowanceWriteError.message || 'Approval failed');
      setIsRevoking(false);
    }
  }, [allowanceWriteError]);

  useEffect(() => {
    const shouldAnimate = hasExistingApproval && !hasActiveLock && walletConnected;
    if (shouldAnimate && !prevCreateLockAnim.current) {
      setShowCreateLockPop(true);
      createLockShimmerTimeoutRef.current = setTimeout(() => {
        setShowCreateLockShimmer(true);
        setTimeout(() => setShowCreateLockShimmer(false), 800);
        createLockShimmerIntervalRef.current = setInterval(() => {
          setShowCreateLockShimmer(true);
          setTimeout(() => setShowCreateLockShimmer(false), 800);
        }, 3000);
      }, 1000);
    }
    if (!shouldAnimate) {
      setShowCreateLockPop(false);
      setShowCreateLockShimmer(false);
      if (createLockShimmerTimeoutRef.current) {
        clearTimeout(createLockShimmerTimeoutRef.current);
        createLockShimmerTimeoutRef.current = null;
      }
      if (createLockShimmerIntervalRef.current) {
        clearInterval(createLockShimmerIntervalRef.current);
        createLockShimmerIntervalRef.current = null;
      }
    }
    prevCreateLockAnim.current = shouldAnimate;
    return () => {
      if (createLockShimmerTimeoutRef.current) {
        clearTimeout(createLockShimmerTimeoutRef.current);
        createLockShimmerTimeoutRef.current = null;
      }
      if (createLockShimmerIntervalRef.current) {
        clearInterval(createLockShimmerIntervalRef.current);
        createLockShimmerIntervalRef.current = null;
      }
    };
  }, [hasExistingApproval, hasActiveLock, walletConnected]);

  useEffect(() => {
    if (error) {
      const timeout = setTimeout(() => setError(null), 10_000);
      return () => clearTimeout(timeout);
    }
  }, [error]);

  useEffect(() => {
    if (successHash) {
      const timeout = setTimeout(() => setSuccessHash(null), 10_000);
      return () => clearTimeout(timeout);
    }
  }, [successHash]);
  useEffect(() => {
    if (!hasExistingApproval) {
      setShowResize(false);
    }
  }, [hasExistingApproval]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccessHash(null);
    resetAllowanceWrite();

    if (!walletConnected || !walletAddress) {
      setError('Connect a wallet to approve.');
      return;
    }
    if (!hyprTokenAddress) {
      setError('Unable to resolve HYPR token address.');
      return;
    }
    if (!amountInput) {
      setError('Enter a HYPR amount.');
      return;
    }
    if (Number(amountInput) <= 0) {
      setError('Enter a positive HYPR amount.');
      return;
    }
    const amountWei = (() => {
      try {
        return parseEther(amountInput);
      } catch {
        return 0n;
      }
    })();
    if (amountWei <= 0n) {
      setError('Enter a valid HYPR amount.');
      return;
    }
    if (amountWei > hyprOwnedWei) {
      setError('Amount exceeds HYPR balance.');
      return;
    }
    try {
      await writeApproveContract({
        address: hyprTokenAddress as `0x${string}`,
        abi: erc20ApproveAbi,
        functionName: 'approve',
        args: [targetRegistryAddress, amountWei],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    }
  };

  const handleRevoke = async () => {
    setError(null);
    setSuccessHash(null);
    resetAllowanceWrite();

    if (!walletConnected || !walletAddress) {
      setError('Connect a wallet to revoke.');
      return;
    }
    if (!hyprTokenAddress) {
      setError('Unable to resolve HYPR token address.');
      return;
    }
    try {
      setIsRevoking(true);
      await writeApproveContract({
        address: hyprTokenAddress as `0x${string}`,
        abi: erc20ApproveAbi,
        functionName: 'approve',
        args: [targetRegistryAddress, 0n],
      });
    } catch (err) {
      setIsRevoking(false);
      setError(err instanceof Error ? err.message : 'Revoke failed');
    }
  };

  const approveButtonDisabled =
    !walletConnected ||
    isAllowancePending ||
    isAllowanceConfirming ||
    !amountProvided ||
    Number(amountInput) <= 0;

  const approveFormClass = `lock-form${hasExistingApproval ? ' lock-form-plain' : ''}`;

  return (
    <section className="step-panel approve-step">
      <form className={approveFormClass} onSubmit={handleSubmit}>
        {!hasExistingApproval && (
          <div className="form-header">
            <div className="form-header-text">
              <h3>{hasActiveLock ? 'Approve HYPR to enable additional locking' : 'Approve HYPR to enable locking'}</h3>
              <p className="form-subtitle">
                {hasActiveLock ? 'Approve only as much as you intend to add to your lock.' : 'Approve only as much as you intend to lock.'}
              </p>
            </div>
          </div>
        )}

        {lockAvailableWei > 0n && (
          <>
            <div className="lock-card">
              <div className="approval-stack">
                <div className="approval-row">
                  <div className="lock-detail-stat">
                    <span className="lock-card-label">
                      {hasActiveLock ? 'Amount approved to add to lock' : 'Amount approved to lock'}
                    </span>
                    <span className="lock-card-value">
                      {lockAllowance?.amount_formatted_hypr ?? '0'}{' '}
                      <button
                        type="button"
                        className={`pill-button ghost inline-pill${showResize ? ' active' : ''}`}
                        disabled={!walletConnected || isAllowancePending || isAllowanceConfirming}
                        onClick={() => setShowResize((prev) => !prev)}
                      >
                        Resize
                      </button>{' '}
                      <button
                        type="button"
                        className="pill-button ghost inline-pill"
                        disabled={!walletConnected || isAllowancePending || isAllowanceConfirming}
                        onClick={handleRevoke}
                      >
                        {isRevoking || isAllowancePending || isAllowanceConfirming ? (
                          <span className="spinner" />
                        ) : (
                          'Revoke approval'
                        )}
                      </button>
                    </span>
                  </div>
                </div>
                <div className="approval-locked-row">
                  <div className="lock-detail-stat">
                    <span className="lock-card-label">Amount already locked</span>
                    <span className="lock-card-value">
                      {lockedAmountFormatted}{' '}
                      <button
                        type="button"
                        className={`pill-button${hasActiveLock ? ' ghost' : ''} inline-pill${!hasActiveLock && showCreateLockPop ? ' bind-button-pop' : ''}${!hasActiveLock && showCreateLockShimmer ? ' bind-button-shimmer' : ''}`}
                        style={{ fontWeight: hasActiveLock ? 500 : 700 }}
                        onClick={() => onNavigateLock()}
                      >
                        {hasActiveLock ? 'View lock' : 'Create lock'}
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            </div>
            {showResize && (
              <div className="lock-card">
                <h3 className="lock-card-title">Resize approved amount</h3>
                <div className="input-grid">
                  <label className="input-field">
                    <span>
                      New approved amount {hyprOwned ? `(up to ${hyprOwned.amount_formatted_hypr})` : '(HYPR)'}
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.000000000000000001"
                      value={amountInput}
                      onChange={(event) => setAmountInput(event.target.value)}
                      placeholder="0.0"
                      required
                      disabled={!walletConnected}
                    />
                  </label>
                </div>
                <div className="form-actions resize-actions">
                  <button type="submit" className="secondary-button" disabled={approveButtonDisabled}>
                    {isAllowancePending || isAllowanceConfirming ? <span className="spinner" /> : 'Resize'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {lockAvailableWei === 0n && (
          <>
            <div className="input-grid">
              <label className="input-field">
                <span>
                  {hasActiveLock
                    ? `Amount to approve ${hyprOwned ? `(up to ${hyprOwned.amount_formatted_hypr})` : '(HYPR)'}`
                    : `Amount to approve ${hyprOwned ? `(up to ${hyprOwned.amount_formatted_hypr})` : '(HYPR)'}`}
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.000000000000000001"
                  value={amountInput}
                  onChange={(event) => setAmountInput(event.target.value)}
                  placeholder="0.0"
                  required
                />
              </label>
            </div>

            <div className="form-actions">
              <button type="submit" className="secondary-button" disabled={approveButtonDisabled}>
                {isAllowancePending || isAllowanceConfirming ? <span className="spinner" /> : 'Submit'}
              </button>
            </div>
          </>
        )}

        {error && (
          <div className="inline-error">
            {error}
          </div>
        )}
        {successHash && (
          <div className="inline-success">
            Approval confirmed! Tx {successHash.slice(0, 6)}...{successHash.slice(-4)}
          </div>
        )}
      </form>
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
  desiredBindView: BindView | null;
  onConsumeDesiredBindView: () => void;
  bindCreatePop: boolean;
  bindCreateShimmer: boolean;
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
  desiredBindView,
  onConsumeDesiredBindView,
  bindCreatePop,
  bindCreateShimmer,
}: BindStepProps) => {
  const nowMs = useCurrentTimeMs();
  const [dstNameInput, setDstNameInput] = useState('');
  const [transferAmountInput, setTransferAmountInput] = useState('');
  const [transferDurationInputs, setTransferDurationInputs] = useState<DurationInputValues>(() =>
    createDefaultDurationInputsAtLeastMin(minLockDurationSeconds),
  );
  const [transferDurationDirty, setTransferDurationDirty] = useState(false);
  const [transferDurationMode, setTransferDurationMode] = useState<DurationMode>('duration');
  const [transferEndDateInput, setTransferEndDateInput] = useState<Date | null>(null);
  const [transferEndTimeInput, setTransferEndTimeInput] = useState('00:00:00');
  const [transferEndTimeDirty, setTransferEndTimeDirty] = useState(false);
  const [showTransferPrecision, setShowTransferPrecision] = useState(false);
  const [transferMobileDuration, setTransferMobileDuration] = useState<string>('');
  const [transferMobileDateChoice, setTransferMobileDateChoice] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<BannerMessage | null>(null);
  const [transferSuccessHash, setTransferSuccessHash] = useState<`0x${string}` | null>(null);
  const [bindView, setBindView] = useState<BindView>(
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
    // Only auto-assign when the user hasn't selected a view AND we're not in an explicit add/extend flow.
    if (!userSetBindView && bindView !== 'add' && bindView !== 'extend' && bindView !== 'add-hypr') {
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
    if (!desiredBindView) return;
    setBindView(desiredBindView);
    setUserSetBindView(true);
    setExtendBindingName(null);
    setAddHyprBindingName(null);
    onConsumeDesiredBindView();
  }, [desiredBindView, onConsumeDesiredBindView]);

  useEffect(() => {
    if (!desiredBindView) return;
    setBindView(desiredBindView);
    setUserSetBindView(true);
    setExtendBindingName(null);
    setAddHyprBindingName(null);
    onConsumeDesiredBindView();
  }, [desiredBindView, onConsumeDesiredBindView]);

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

  const transferNowSeconds = Math.floor(nowMs / 1000);
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
      // Live min: current binding expiry + 1s
      return extendBindingUnlockMs + 1_000;
    }
    return transferEndDateMin.getTime();
  }, [bindView, extendBindingUnlockMs, transferEndDateMin]);
  const effectiveTransferEndDateMaxMs = useMemo(() => {
    const raw = transferEndDateMax.getTime();
    // Ensure max is never below min so collapsed windows remain valid
    return Math.max(raw, effectiveTransferEndDateMinMs);
  }, [transferEndDateMax, effectiveTransferEndDateMinMs]);
  const transferMinDurationSeconds = useMemo(() => {
    // Ceil to avoid millisecond jitter from floor(nowMs/1000) vs nowMs
    const deltaSeconds = Math.max(0, Math.ceil((effectiveTransferEndDateMinMs - nowMs) / 1000));
    return Math.max(minLockDurationSeconds, deltaSeconds);
  }, [effectiveTransferEndDateMinMs, minLockDurationSeconds, nowMs]);
  const transferMaxDurationSeconds = useMemo(() => {
    // Floor so max never dips below min due to rounding jitter
    return Math.max(0, Math.floor((effectiveTransferEndDateMaxMs - nowMs) / 1000));
  }, [effectiveTransferEndDateMaxMs, nowMs]);
  const effectiveTransferEndDateDefault = useMemo(() => {
    if (bindView === 'add-hypr') return null;
    return new Date(effectiveTransferEndDateMaxMs);
  }, [bindView, effectiveTransferEndDateMaxMs]);
  const applyTransferMobileDuration = useCallback(
    (seconds: number) => {
      const nextDate = new Date(Date.now() + seconds * 1000);
      setTransferMobileDateChoice('');
      setTransferEndDateInput(nextDate);
      setTransferEndTimeInput(formatTimeFromDate(nextDate));
      setTransferEndTimeDirty(true);
      const isExtendMin = bindView === 'extend' && seconds === transferMinDurationSeconds;
      setTransferDurationDirty(!isExtendMin);
      setTransferDurationMode('duration');
      setTransferDurationInputs(durationInputsFromSeconds(BigInt(seconds)));
    },
    [bindView, formatTimeFromDate, transferMinDurationSeconds],
  );
  const bindHintMinMs = useMemo(() => {
    if (bindView === 'extend') return nowMs + transferMinDurationSeconds * 1000;
    if (bindView === 'add' || bindView === 'create') return nowMs + transferMinDurationSeconds * 1000;
    return 0;
  }, [bindView, nowMs, transferMinDurationSeconds]);
  const bindHintMaxMs = useMemo(() => {
    if (bindView === 'extend') return nowMs + transferMaxDurationSeconds * 1000;
    if (bindView === 'add' || bindView === 'create') return nowMs + transferMaxDurationSeconds * 1000;
    return 0;
  }, [bindView, nowMs, transferMaxDurationSeconds]);
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
    const minSeconds = transferMinDurationSeconds;
    const maxSeconds = Math.max(minSeconds, transferMaxDurationSeconds);
    const inRange = MOBILE_DURATION_OPTIONS.filter(
      (opt) => opt.seconds >= minSeconds && opt.seconds <= maxSeconds,
    );
    const withBounds: { label: string; seconds: number; value: string }[] = [
      { label: 'MIN duration', seconds: minSeconds, value: '__min__' },
      ...inRange,
      { label: 'MAX duration', seconds: maxSeconds, value: '__max__' },
    ];
    return withBounds;
  }, [isMobile, transferMaxDurationSeconds, transferMinDurationSeconds]);
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
    // Avoid clobbering live MIN selection in extend when new status arrives
    if (bindView === 'extend' && transferMobileDuration === '__min__') {
      lastTransferSyncedSeconds.current = remainingSeconds;
      return;
    }
    const minUnbindSeconds = Math.floor(nowMs / 1000) + minLockDurationSeconds;
    const effectiveUnbindSeconds = Math.max(lockDetails.unlock_timestamp, minUnbindSeconds);
    setTransferEndDateInput(new Date(effectiveUnbindSeconds * 1000));
    lastTransferSyncedSeconds.current = remainingSeconds;
  }, [
    bindView,
    effectiveTransferEndDateDefault,
    lockDetails,
    minLockDurationSeconds,
    nowMs,
    transferDurationDirty,
    transferMobileDuration,
  ]);

  useEffect(() => {
    setTransferDurationDirty(false);
    setTransferDurationMode('duration');
    if (bindView !== 'add-hypr' && effectiveTransferEndDateDefault) {
      setTransferEndDateInput(effectiveTransferEndDateDefault);
    }
    setTransferEndTimeDirty(false);
    lastTransferSyncedSeconds.current = null;
  }, [bindView, effectiveTransferEndDateDefault, lockUpdateNonce, minLockDurationSeconds]);
  const transferEndDateDurationSeconds = secondsUntilDate(transferEndDateInput, transferNowSeconds);
  const transferDurationSecondsFromInputs = useMemo(
    () => durationPartsToSeconds(inputsToDurationParts(transferDurationInputs)),
    [transferDurationInputs],
  );
  const transferCustomActive = useMemo(
    () => isMobile && !!transferCustomDateMs && !!transferMobileDateChoice,
    [isMobile, transferCustomDateMs, transferMobileDateChoice],
  );
  const transferRawCustomDurationSeconds = useMemo(() => {
    if (!transferCustomActive || !transferCustomDateMs) return null;
    return BigInt(Math.max(0, Math.floor((transferCustomDateMs - nowMs) / 1000) + 1));
  }, [nowMs, transferCustomActive, transferCustomDateMs]);
  const selectedTransferDurationSeconds =
    transferDurationMode === 'duration'
      ? transferDurationSecondsFromInputs
      : transferEndDateDurationSeconds ?? 0n;
  const transferDurationForValidation =
    transferCustomActive && transferRawCustomDurationSeconds !== null
      ? transferRawCustomDurationSeconds
      : selectedTransferDurationSeconds;
  // When a custom date is active on mobile, keep the raw duration synced each second to the fixed timestamp
  useEffect(() => {
    if (!transferCustomActive || !transferCustomDateMs) return;
    if (!transferMobileDateChoice || transferMobileDateChoice === '') return;
    const rawSeconds = Math.max(0, Math.floor((transferCustomDateMs - nowMs) / 1000) + 1);
    const rawBig = BigInt(rawSeconds);
    if (selectedTransferDurationSeconds !== rawBig) {
      setTransferDurationInputs(durationInputsFromSeconds(rawBig));
    }
    const nextDate = new Date(transferCustomDateMs);
    setTransferEndDateInput(nextDate);
    setTransferEndTimeInput(formatTimeFromDate(nextDate));
  }, [
    formatTimeFromDate,
    nowMs,
    selectedTransferDurationSeconds,
    transferCustomActive,
    transferCustomDateMs,
    transferMobileDateChoice,
  ]);
  // If user chooses the live MIN duration in bind extend mode, keep it in sync (do not mark dirty)
  useEffect(() => {
    if (bindView !== 'extend') return;
    if (transferMobileDuration !== '__min__') return;
    const minSecondsBigInt = BigInt(transferMinDurationSeconds);
    if (selectedTransferDurationSeconds === minSecondsBigInt && transferDurationDirty) {
      setTransferDurationDirty(false);
      setTransferDurationInputs(durationInputsFromSeconds(minSecondsBigInt));
    }
  }, [
    bindView,
    selectedTransferDurationSeconds,
    transferDurationDirty,
    transferMinDurationSeconds,
    transferMobileDuration,
  ]);
  // Keep extend view synced to the live minimum duration unless the user has edited the duration inputs.
  useEffect(() => {
    if (bindView !== 'extend') return;
    if (transferDurationDirty) return;
    if (transferMobileDuration !== '__min__') return;
    const minSecondsBigInt = BigInt(transferMinDurationSeconds);
    if (selectedTransferDurationSeconds !== minSecondsBigInt) {
      setTransferDurationInputs(durationInputsFromSeconds(minSecondsBigInt));
    }
  }, [
    bindView,
    selectedTransferDurationSeconds,
    transferDurationDirty,
    transferMinDurationSeconds,
    transferMobileDuration,
  ]);
  const destinationHash = useMemo(() => resolveNamehash(dstNameInput), [dstNameInput]);
  const destinationIsDefault = destinationHash === ZERO_NAMEHASH;
  const hasTransferValidEndDate = useMemo(() => {
    if (bindView === 'add-hypr') return true;
    if (destinationIsDefault) return false;
    // Duration-first: validate only the selected duration for create/add/extend
    if (transferDurationForValidation <= 0n) return false;
    const seconds = Number(transferDurationForValidation);
    if (seconds < transferMinDurationSeconds) return false;
    // No maximum enforcement per request; still keep hints populated elsewhere
    return true;
  }, [
    bindView,
    destinationIsDefault,
    transferDurationForValidation,
    transferMinDurationSeconds,
  ]);
  // Compute a preview end timestamp; if duration meets/exceeds max, pin to max target timestamp (stable);
  // if at/below min, use live min; else use now + duration.
  const transferPreviewMs = useMemo(() => {
    const previewSeconds = transferCustomActive && transferRawCustomDurationSeconds !== null
      ? transferRawCustomDurationSeconds
      : selectedTransferDurationSeconds;
    if (previewSeconds <= 0n) return null;
    const durMs = Number(previewSeconds) * 1000;
    const minMs = transferMinDurationSeconds * 1000;
    const maxMs = transferMaxDurationSeconds * 1000;
    if (durMs >= maxMs) return effectiveTransferEndDateMaxMs;
    if (durMs <= minMs) return nowMs + minMs;
    return nowMs + durMs;
  }, [
    effectiveTransferEndDateMaxMs,
    nowMs,
    selectedTransferDurationSeconds,
    transferMaxDurationSeconds,
    transferMinDurationSeconds,
  ]);
  // Keep the stored end-date/time in sync for display using the preview timestamp.
  useEffect(() => {
    if (transferDurationMode !== 'duration') return;
    if (transferPreviewMs === null) return;
    const next = new Date(transferPreviewMs);
    setTransferEndDateInput(next);
    setTransferEndTimeInput(formatTimeFromDate(next));
  }, [formatTimeFromDate, transferDurationMode, transferPreviewMs]);
  const transferUnlockPreview = useMemo(() => {
    if (transferPreviewMs === null) return null;
    return formatTimestamp(Math.floor(transferPreviewMs / 1000));
  }, [transferPreviewMs]);

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
  const transferRangeCollapsed = false;
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
    const minDelta = transferMinDurationSeconds * 1000;
    const maxDelta = transferMaxDurationSeconds * 1000;
    const delta = ms - nowMs;
    return delta < minDelta || delta > maxDelta;
  }, [
    nowMs,
    transferCustomModalDate,
    transferCustomModalTime,
    transferMaxDurationSeconds,
    transferMinDurationSeconds,
  ]);
  const transferCustomHintMin = useMemo(
    () => new Date(nowMs + transferMinDurationSeconds * 1000),
    [nowMs, transferMinDurationSeconds],
  );
  const transferCustomHintMax = useMemo(
    () => new Date(nowMs + transferMaxDurationSeconds * 1000),
    [nowMs, transferMaxDurationSeconds],
  );
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
    const minDelta = Math.max(0, effectiveTransferEndDateMinMs - nowMs);
    const maxDelta = Math.max(0, effectiveTransferEndDateMaxMs - nowMs);
    const delta = ms - nowMs;
    if (delta < minDelta || delta > maxDelta) {
      return;
    }
    setTransferCustomDateMs(ms);
    setTransferMobileDateChoice(ms.toString());
    setTransferEndDateInput(candidate);
    setTransferEndTimeInput(formatTimeFromDate(candidate));
    setTransferEndTimeDirty(true);
    // Sync duration inputs to the chosen custom date so duration-first logic stays aligned
    const durationSeconds = Math.max(0, Math.round(delta / 1000));
    setTransferDurationInputs(durationInputsFromSeconds(BigInt(durationSeconds)));
    setTransferDurationMode('duration');
    setTransferDurationDirty(true);
    // Mark custom selection so defaulting logic does not overwrite with MIN
    setTransferMobileDuration('__custom__');
    setShowTransferCustomModal(false);
  };
  const handleTransferDateClick = () => {
    if (!transferDateEnabled) return;
    const base = new Date(nowMs);
    setTransferCustomModalDate(formatDateIsoInput(base));
    setTransferCustomModalTime(formatTimeFromDate(base).slice(0, 5));
    setShowTransferCustomModal(true);
    setTransferMobileDateChoice('__custom__');
    setTransferMobileDuration('');
  };
  useEffect(() => {
    if (!isMobile) return;
    if (!shouldShowTransferEndInputs || transferRangeCollapsed) return;
    const defaultOpt =
      bindView === 'extend'
        ? transferMobileDurationOptions[0]
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
    // Force duration-first
    setTransferDurationMode('duration');
  };

  // Keep preset MIN/MAX selections in sync with the live min/max when the user hasn't edited duration manually.
  useEffect(() => {
    if (transferDurationMode !== 'duration') return;
    if (transferDurationDirty) return;
    const minSeconds = BigInt(transferMinDurationSeconds);
    const maxSeconds = BigInt(transferMaxDurationSeconds);
    if (selectedTransferDurationSeconds === minSeconds) {
      setTransferDurationInputs(durationInputsFromSeconds(minSeconds));
    } else if (selectedTransferDurationSeconds === maxSeconds) {
      setTransferDurationInputs(durationInputsFromSeconds(maxSeconds));
    }
  }, [
    transferDurationMode,
    transferDurationDirty,
    transferMinDurationSeconds,
    transferMaxDurationSeconds,
    selectedTransferDurationSeconds,
  ]);

  useEffect(() => {
    if (!isTransferConfirmed) return;
    setDstNameInput('');
    setTransferAmountInput('');
    setTransferDurationInputs(createDefaultDurationInputsAtLeastMin(minLockDurationSeconds));
    setTransferDurationMode('duration');
    const resetMinDate = new Date((Math.floor(Date.now() / 1000) + minLockDurationSeconds) * 1000);
    setTransferEndDateInput(resetMinDate);
    setTransferEndTimeDirty(false);
    lastTransferSyncedSeconds.current = null;
    void refreshLockStatus();
    setUserSetBindView(false);
    setBindView('details');
    onBindSuccess();
  }, [isTransferConfirmed, refreshLockStatus, minLockDurationSeconds, onBindSuccess]);

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
      pushTransferError('Enter a binding target.');
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
      pushTransferError('A binding already exists for this target.');
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

      const minDurationBigInt = BigInt(transferMinDurationSeconds);
      const durationForSubmit =
        transferCustomActive && transferRawCustomDurationSeconds !== null
          ? transferRawCustomDurationSeconds
          : selectedTransferDurationSeconds;
      if (durationForSubmit < minDurationBigInt) {
        pushTransferError(`Duration must be at least ${formatDurationSeconds(transferMinDurationSeconds)}.`);
        return;
      }
      if (durationForSubmit > BigInt(MAX_LOCK_DURATION_SECONDS)) {
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
      if (bindView === 'add-hypr') {
        durationForSubmission = 0n; // adding HYPR should not change expiry
      } else if (bindView === 'extend' && targetBinding) {
        const currentRemaining = BigInt(targetBinding.remaining_seconds ?? 0);
        const desiredRemaining = selectedTransferDurationSeconds;
        durationForSubmission =
          desiredRemaining > currentRemaining ? desiredRemaining - currentRemaining : 0n;
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
        {walletConnected && (
          <div className="lock-grid">
            <div className="lock-card">
              <div className="lock-card-label">HYPR available to bind</div>
              <div className="lock-card-value">{availableToBind?.amount_formatted_hypr ?? '0 HYPR'}</div>
            </div>
          </div>
        )}

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
                    <div className="binding-row" key={binding.namehash}>
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
                        <div className="binding-actions">
                          <button
                            type="button"
                            className="pill-button warning-pill"
                            disabled={isTransferPending || isTransferConfirming}
                            onClick={() => handleReclaimBinding(binding)}
                          >
                            {reclaimingThis ? <span className="spinner" /> : 'Reclaim HYPR from expired binding'}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {bindView === 'details' && walletConnected && (
        <div className="form-actions">
          <button
            type="button"
            className={`secondary-button${showBindPopAnimation || bindCreatePop ? ' bind-button-pop' : ''}${showBindShimmer || bindCreateShimmer ? ' bind-button-shimmer' : ''}`}
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
              {bindView === 'create' && <h3>Create your first binding</h3>}
              {bindView === 'add' && <h3>Add new binding</h3>}
              {bindView === 'create' && (
                <p className="form-subtitle">
                  Empower app functionality by binding some or all of your locked HYPR to one or more Hypermap nodes.
                </p>
              )}
            </div>
            {showDiagnostics && (bindView === 'create' || bindView === 'add' || bindView === 'extend') && (
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
                  placeholder="0.0"
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
                    placeholder="0.0"
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
            <div className={`input-subtext modal-hint${transferCustomSetDisabled ? ' inline-error' : ''}`}>
              The custom value must be between {formatDateTimeAmPm(transferCustomHintMin.getTime())} and{' '}
              {formatDateTimeAmPm(transferCustomHintMax.getTime())}.
            </div>
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
  isStepGrayed: (id: StepId) => boolean;
  onSelect: (id: StepId) => void;
  lockPopAnimation: boolean;
  lockShimmer: boolean;
  bindPopAnimation: boolean;
  bindShimmer: boolean;
}

type BindView = 'details' | 'create' | 'add' | 'extend' | 'add-hypr';

const BottomTabs = ({
  steps,
  activeStep,
  canAccessStep,
  isStepGrayed,
  onSelect,
  lockPopAnimation,
  lockShimmer,
  bindPopAnimation,
  bindShimmer,
}: BottomTabsProps) => (
  <nav className="bottom-tabs">
    {steps.map((step) => {
      const accessible = canAccessStep(step.id);
      const grayed = isStepGrayed(step.id);
      const isActive = activeStep === step.id;
      const icon = iconGlyph[step.icon];
      let animClass = '';
      if (step.id === 'lock') {
        animClass = `${lockPopAnimation ? ' bind-button-pop' : ''}${lockShimmer ? ' bind-button-shimmer' : ''}`;
      } else if (step.id === 'bind') {
        animClass = `${bindPopAnimation ? ' bind-button-pop' : ''}${bindShimmer ? ' bind-button-shimmer' : ''}`;
      }
      return (
        <button
          type="button"
          key={step.id}
          className={`bottom-tab tab-${step.id}${isActive ? ' active' : ''}${grayed ? ' grayed' : ''}${animClass}`}
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
  check: '🆗',
  lock: '🔒',
  chain: '⛓',
};

// Use local date (not UTC) for date input prefill to avoid off-by-one-day shifts
const formatDateIsoInput = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatDateIso = (date: Date) => {
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `${month} ${day}, ${year}`;
};

const useCurrentTimeMs = () => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return nowMs;
};

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
  endDateMin: _endDateMin,
  endDateMax: _endDateMax,
  showUnlockPreview = true,
  endDateLabel = 'New end date',
  endTimeLabel = 'New end time',
  timestampLabel = 'Unlock timestamp',
  showSummary = true,
  durationRangeLabel,
  endDateRangeLabel,
  showModeToggle = true,
}: DurationInputsProps) => {
  const [liveUnlockPreview, setLiveUnlockPreview] = useState<string | null>(null);
  useEffect(() => {
    const update = () => {
      if (unlockPreview) {
        setLiveUnlockPreview(unlockPreview);
      } else if (durationSeconds > 0n) {
        const now = Math.floor(Date.now() / 1000);
        setLiveUnlockPreview(formatTimestamp(now + Number(durationSeconds)));
      } else {
        setLiveUnlockPreview(null);
      }
    };
    update();
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [unlockPreview, durationSeconds]);

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
  const unlockText = liveUnlockPreview ?? 'Set a duration to preview end time';

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

const TopStatusBar = ({
  walletConnected,
  triggerConnectPulse,
  onConsumeConnectPulse,
}: {
  walletConnected: boolean;
  triggerConnectPulse: boolean;
  onConsumeConnectPulse: () => void;
}) => {
  const [showPopAnimation, setShowPopAnimation] = useState(!walletConnected);
  const [showShimmer, setShowShimmer] = useState(false);
  const shimmerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shimmerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!walletConnected) {
      setShowPopAnimation(true);
      if (shimmerIntervalRef.current) clearInterval(shimmerIntervalRef.current);
      if (shimmerTimeoutRef.current) clearTimeout(shimmerTimeoutRef.current);
    } else {
      // Wallet connected - stop animations
      setShowPopAnimation(false);
      setShowShimmer(false);
      if (shimmerIntervalRef.current) {
        clearInterval(shimmerIntervalRef.current);
        shimmerIntervalRef.current = null;
      }
      if (shimmerTimeoutRef.current) {
        clearTimeout(shimmerTimeoutRef.current);
        shimmerTimeoutRef.current = null;
      }
    }
  }, [walletConnected]);

  useEffect(() => {
    if (walletConnected) return;
    if (!triggerConnectPulse) return;
    setShowPopAnimation(true);
    shimmerTimeoutRef.current = setTimeout(() => {
      setShowShimmer(true);
      setTimeout(() => setShowShimmer(false), 800);
    }, 1000);
    setTimeout(() => setShowPopAnimation(false), 400);
    onConsumeConnectPulse();
    return () => {
      if (shimmerTimeoutRef.current) {
        clearTimeout(shimmerTimeoutRef.current);
        shimmerTimeoutRef.current = null;
      }
    };
  }, [triggerConnectPulse, walletConnected, onConsumeConnectPulse]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (shimmerIntervalRef.current) clearInterval(shimmerIntervalRef.current);
      if (shimmerTimeoutRef.current) clearTimeout(shimmerTimeoutRef.current);
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
  return `${formatDateIso(d)} ${pad(hours12)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm}`;
};

const formatTimestamp = (seconds: number) => {
  if (!seconds) return '0';
  if (seconds === Number.MAX_SAFE_INTEGER) return 'Unknown';
  return formatDateTimeAmPm(seconds * 1000);
};

const formatMsWithSeconds = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return 'N/A';
  return formatTimestamp(Math.floor(ms / 1000));
};


const formatSeconds = (value: number) => {
  if (value <= 0) return '0s';
  return duration.fmt(value * 1000).segments(2);
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
  if (seconds <= 0) return '0 seconds';
  return duration.fmt(seconds * 1000).segments(2);
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
