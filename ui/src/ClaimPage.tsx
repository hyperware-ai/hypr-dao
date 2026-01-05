import { useEffect, useMemo, useRef, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { isAddress } from 'viem';
import './App.css';

const MERKLE_DISTRIBUTOR_ADDRESS = '0x000000000081090d75148e17045ff99C9360289f' as const;

const merkleDistributorAbi = [
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_dIndex', type: 'uint256' },
      { name: '_index', type: 'uint256' },
      { name: '_kind', type: 'uint8' },
      { name: '_receiver', type: 'address' },
      { name: '_amount', type: 'uint256' },
      { name: '_isClaimable', type: 'bool' },
      { name: '_merkleProof', type: 'bytes32[]' },
    ],
    outputs: [],
  },
] as const;

type ClaimParams = {
  dIndex: bigint | null;
  index: bigint | null;
  kind: number | null;
  receiver: `0x${string}` | null;
  amount: bigint | null;
  isClaimable: boolean | null;
  merkleProof: `0x${string}`[] | null;
  quarter: string;
  errors: string[];
};

const formatTerseNumber = (value: string) => {
  const num = parseFloat(value.replace(/,/g, ''));
  if (isNaN(num)) return value;

  if (num >= 1_000_000) {
    const millions = num / 1_000_000;
    return `${millions.toFixed(1)}m`;
  }

  if (num >= 1_000) {
    const thousands = num / 1_000;
    return `${thousands.toFixed(1)}k`;
  }

  if (num >= 100) return num.toFixed(1);
  if (num >= 10) return num.toFixed(1);
  return num.toFixed(1);
};

const formatHyprAmount = (wei: bigint | null) => {
  if (wei === null) return '-';
  if (wei === 0n) return '0.0';
  const digits = wei.toString().padStart(19, '0');
  const whole = digits.slice(0, -18).replace(/^0+/, '') || '0';
  const frac = digits.slice(-18).replace(/0+$/, '');
  const numeric = frac.length > 0 ? `${whole}.${frac}` : whole;
  return formatTerseNumber(numeric);
};

const parseBigIntParam = (value: string | null, label: string, errors: string[]) => {
  if (value === null || value.trim() === '') {
    errors.push(`Missing ${label}.`);
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    errors.push(`Invalid ${label}.`);
    return null;
  }
};

const parseKindParam = (value: string | null, errors: string[]) => {
  if (value === null || value.trim() === '') {
    errors.push('Missing kind.');
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    errors.push('Invalid kind.');
    return null;
  }
  return parsed;
};

const parseBooleanParam = (value: string | null, errors: string[]) => {
  if (value === null || value.trim() === '') {
    errors.push('Missing isclaimable.');
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  errors.push('Invalid isclaimable.');
  return null;
};

const parseMerkleProof = (value: string | null, errors: string[]) => {
  if (value === null || value.trim() === '') {
    errors.push('Missing merkleproof.');
    return null;
  }
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    errors.push('Missing merkleproof.');
    return null;
  }
  const normalized: `0x${string}`[] = [];
  for (const part of parts) {
    if (!part.startsWith('0x') || part.length !== 66) {
      errors.push('Invalid merkleproof.');
      return null;
    }
    normalized.push(part as `0x${string}`);
  }
  return normalized;
};

const parseReceiverParam = (value: string | null, errors: string[]) => {
  if (value === null || value.trim() === '') {
    errors.push('Missing receiver.');
    return null;
  }
  const trimmed = value.trim();
  if (!isAddress(trimmed)) {
    errors.push('Invalid receiver.');
    return null;
  }
  return trimmed as `0x${string}`;
};

const parseQuarterParam = (value: string | null, errors: string[]) => {
  if (value === null || value.trim() === '') {
    return 'q4-2025';
  }
  const trimmed = value.trim().toLowerCase();
  if (!/^q[1-4]-\d{4}$/.test(trimmed)) {
    errors.push('Invalid quarter.');
    return 'q4-2025';
  }
  return trimmed;
};

const parseClaimParams = (search: string): ClaimParams => {
  const params = new URLSearchParams(search);
  const errors: string[] = [];
  const dIndex = parseBigIntParam(params.get('dindex'), 'dindex', errors);
  const index = parseBigIntParam(params.get('index'), 'index', errors);
  const kind = parseKindParam(params.get('kind'), errors);
  const receiver = parseReceiverParam(params.get('receiver'), errors);
  const amount = parseBigIntParam(params.get('amount'), 'amount', errors);
  const isClaimable = parseBooleanParam(params.get('isclaimable'), errors);
  const merkleProof = parseMerkleProof(params.get('merkleproof'), errors);
  const quarter = parseQuarterParam(params.get('q'), errors);
  return { dIndex, index, kind, receiver, amount, isClaimable, merkleProof, quarter, errors };
};

export default function ClaimPage() {
  const { address, chain, isConnected } = useAccount();
  const {
    data: claimHash,
    error: claimError,
    isPending: isClaimPending,
    writeContract: writeClaimContract,
    reset: resetClaim,
  } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: claimConfirmed } = useWaitForTransactionReceipt({
    hash: claimHash,
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const claimParams = useMemo(() => parseClaimParams(search), [search]);
  const walletConnected = Boolean(isConnected && address);
  const networkMismatch = walletConnected && chain?.id !== base.id;
  const displayAddress = claimParams.receiver ?? 'your address';
  const displayAmount = formatHyprAmount(claimParams.amount);
  const receiverMismatch =
    walletConnected && claimParams.receiver !== null && address?.toLowerCase() !== claimParams.receiver.toLowerCase();
  const shareReady = claimParams.receiver !== null && claimParams.amount !== null;
  const shareReceiver = claimParams.receiver?.toLowerCase() ?? null;
  const shareIntentText =
    shareReceiver && claimParams.amount !== null
      ? `I locked ${displayAmount} $HYPR and participated in the @Hyperware_ai DAO vote and just claimed my ${displayAmount} $HYPR voting incentives. Don't miss out on votes in Q1 2026 if you want a share of the incentives!\n\nhttps://incentives.hyperware.ai/x/${claimParams.quarter}/${shareReceiver}`
      : '';
  const shareIntentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareIntentText)}`;
  const paramsValid =
    claimParams.errors.length === 0 &&
    claimParams.dIndex !== null &&
    claimParams.index !== null &&
    claimParams.kind !== null &&
    claimParams.receiver !== null &&
    claimParams.amount !== null &&
    claimParams.isClaimable !== null &&
    claimParams.merkleProof !== null;
  const claimReady = walletConnected && paramsValid && !networkMismatch && !receiverMismatch;
  const connectAttention = !claimReady && !receiverMismatch;
  const claimAttention = claimReady;
  const [showConnectPop, setShowConnectPop] = useState(false);
  const [showConnectShimmer, setShowConnectShimmer] = useState(false);
  const [showClaimPop, setShowClaimPop] = useState(false);
  const [showClaimShimmer, setShowClaimShimmer] = useState(false);
  const connectIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const claimIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const claimTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevConnectAttention = useRef(false);
  const prevClaimAttention = useRef(false);

  useEffect(() => {
    if (connectAttention && !prevConnectAttention.current) {
      setShowConnectPop(true);
      connectTimeoutRef.current = setTimeout(() => {
        setShowConnectShimmer(true);
        setTimeout(() => setShowConnectShimmer(false), 800);

        connectIntervalRef.current = setInterval(() => {
          setShowConnectShimmer(true);
          setTimeout(() => setShowConnectShimmer(false), 800);
        }, 3000);
      }, 1000);
    }

    if (!connectAttention) {
      setShowConnectPop(false);
      setShowConnectShimmer(false);
      if (connectTimeoutRef.current) {
        clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
      if (connectIntervalRef.current) {
        clearInterval(connectIntervalRef.current);
        connectIntervalRef.current = null;
      }
    }

    prevConnectAttention.current = connectAttention;
  }, [connectAttention]);

  useEffect(() => {
    if (claimAttention && !prevClaimAttention.current) {
      setShowClaimPop(true);
      claimTimeoutRef.current = setTimeout(() => {
        setShowClaimShimmer(true);
        setTimeout(() => setShowClaimShimmer(false), 800);

        claimIntervalRef.current = setInterval(() => {
          setShowClaimShimmer(true);
          setTimeout(() => setShowClaimShimmer(false), 800);
        }, 3000);
      }, 1000);
    }

    if (!claimAttention) {
      setShowClaimPop(false);
      setShowClaimShimmer(false);
      if (claimTimeoutRef.current) {
        clearTimeout(claimTimeoutRef.current);
        claimTimeoutRef.current = null;
      }
      if (claimIntervalRef.current) {
        clearInterval(claimIntervalRef.current);
        claimIntervalRef.current = null;
      }
    }

    prevClaimAttention.current = claimAttention;
  }, [claimAttention]);

  useEffect(() => {
    return () => {
      if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
      if (connectIntervalRef.current) clearInterval(connectIntervalRef.current);
      if (claimTimeoutRef.current) clearTimeout(claimTimeoutRef.current);
      if (claimIntervalRef.current) clearInterval(claimIntervalRef.current);
    };
  }, []);

  const handleClaim = () => {
    setSubmitError(null);
    resetClaim();
    if (!walletConnected || !address) {
      setSubmitError('Connect a wallet to claim.');
      return;
    }
    if (networkMismatch) {
      setSubmitError('Switch to Base to claim.');
      return;
    }
    if (!paramsValid) {
      setSubmitError('Fix the query parameters before claiming.');
      return;
    }
    if (
      claimParams.dIndex === null ||
      claimParams.index === null ||
      claimParams.kind === null ||
      claimParams.receiver === null ||
      claimParams.amount === null ||
      claimParams.isClaimable === null ||
      claimParams.merkleProof === null
    ) {
      setSubmitError('Fix the query parameters before claiming.');
      return;
    }
    if (receiverMismatch) {
      setSubmitError(`ERROR: Must connect ${claimParams.receiver}`);
      return;
    }
    const { dIndex, index, kind, receiver, amount, isClaimable, merkleProof } = claimParams;
    writeClaimContract({
      address: MERKLE_DISTRIBUTOR_ADDRESS,
      abi: merkleDistributorAbi,
      functionName: 'claim',
      args: [dIndex, index, kind, receiver, amount, isClaimable, merkleProof],
      chainId: base.id,
    });
  };

  return (
    <div className="app claim-page">
      <div className="phone-shell">
        <div className="phone-frame">
          <div className="top-banner">
            <div
              className={`connect-button-wrapper${showConnectPop ? ' bind-button-pop' : ''}${
                showConnectShimmer ? ' bind-button-shimmer' : ''
              }`}
            >
              <ConnectButton />
            </div>
          </div>
          <div className="phone-body">
            <div className="step-card claim-card">
              <div className="step-info">
                <div className="step-heading-row">
                  <h2 className="step-heading">Claim Voting Incentives</h2>
                </div>
                <p className="step-description claim-prose">
                  Address{' '}
                  <span className="claim-address">{displayAddress}</span>{' '}
                  is eligible to claim <span className="claim-amount">{displayAmount} HYPR</span>
                </p>
              </div>
              <div className="claim-warning">
                WARNING: Double-check this link was from a message sent in the official Chat app by dao.hypr and that
                this app is the HYPR DAO app before proceeding!
              </div>
              {claimParams.errors.length > 0 && (
                <div className="error-banner claim-error">
                  <span>{claimParams.errors[0]}</span>
                </div>
              )}
              {receiverMismatch && claimParams.receiver && (
                <div className="error-banner claim-error">
                  <span>
                    ERROR: Must connect{' '}
                    <span className="claim-address">{claimParams.receiver}</span>
                  </span>
                </div>
              )}
              {submitError && (
                <div className="error-banner claim-error">
                  <span>{submitError}</span>
                </div>
              )}
              {claimError && (
                <div className="error-banner claim-error">
                  <span>{claimError.message}</span>
                </div>
              )}
              {networkMismatch && (
                <div className="error-banner claim-error">
                  <span>Wrong network. Switch to Base to continue.</span>
                </div>
              )}
              {claimConfirmed && (
                <div className="success-banner claim-success">
                  <span>Claim confirmed.</span>
                </div>
              )}
              <button
                type="button"
                className={`primary-button${showClaimPop ? ' bind-button-pop' : ''}${
                  showClaimShimmer ? ' bind-button-shimmer' : ''
                }`}
                onClick={handleClaim}
                disabled={
                  !walletConnected ||
                  !paramsValid ||
                  networkMismatch ||
                  receiverMismatch ||
                  isClaimPending ||
                  isConfirming
                }
              >
                {isClaimPending || isConfirming ? 'Claiming...' : 'Claim'}
              </button>
              <a
                className="secondary-button claim-share-button"
                href={shareReady ? shareIntentUrl : undefined}
                target={shareReady ? '_blank' : undefined}
                rel={shareReady ? 'noreferrer' : undefined}
                aria-disabled={!shareReady}
                onClick={(event) => {
                  if (!shareReady) {
                    event.preventDefault();
                  }
                }}
              >
                Share on X
              </a>
              {claimHash && (
                <div className="claim-hash">
                  Tx: <span>{claimHash}</span>
                </div>
              )}
            </div>
            <div className="body-placeholder" />
          </div>
        </div>
      </div>
    </div>
  );
}
