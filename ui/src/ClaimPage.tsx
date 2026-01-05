import { useEffect, useMemo, useRef, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { isAddress } from 'viem';
import hyperwareWordmark from './assets/hyperware-wordmark-glow.svg';
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

type ShareAmounts = {
  nodeId: string;
  locked: string;
  incentive: string;
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
  const shareReceiver = claimParams.receiver?.toLowerCase() ?? null;
  const [shareAmounts, setShareAmounts] = useState<ShareAmounts | null>(null);
  const [shareAmountsError, setShareAmountsError] = useState<string | null>(null);

  useEffect(() => {
    if (!shareReceiver) {
      setShareAmounts(null);
      setShareAmountsError(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const loadShareAmounts = async () => {
      try {
        setShareAmountsError(null);
        const response = await fetch(
          `https://incentives.hyperware.ai/x/amount/${claimParams.quarter}/${shareReceiver}`,
          { signal: controller.signal }
        );
        if (!response.ok) {
          throw new Error('Share amounts unavailable.');
        }
        const data = (await response.json()) as {
          'node-id'?: string;
          locked?: string;
          incentive?: string;
        };
        if (!data['node-id'] || !data.locked || !data.incentive) {
          throw new Error('Share amounts unavailable.');
        }
        if (!cancelled) {
          setShareAmounts({
            nodeId: data['node-id'],
            locked: data.locked,
            incentive: data.incentive,
          });
        }
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setShareAmounts(null);
        setShareAmountsError('Share amounts unavailable.');
      }
    };
    loadShareAmounts();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [claimParams.quarter, shareReceiver]);

  const shareReady = Boolean(shareAmounts && shareReceiver && !shareAmountsError);
  const shareIntentText =
    shareAmounts && shareReceiver
      ? `I locked ${shareAmounts.locked} $HYPR and participated in the @Hyperware_ai DAO vote and just claimed my ${shareAmounts.incentive} $HYPR voting incentives. Don't miss out on votes in Q1 2026 if you want a share of the incentives!\n\nhttps://incentives.hyperware.ai/x/${claimParams.quarter}/${shareReceiver}`
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

  useEffect(() => {
    const { body } = document;
    const prevOverflow = body.style.overflow;
    const prevMinHeight = body.style.minHeight;
    const prevHeight = body.style.height;
    body.style.overflow = 'auto';
    body.style.minHeight = '100dvh';
    body.style.height = 'auto';
    return () => {
      body.style.overflow = prevOverflow;
      body.style.minHeight = prevMinHeight;
      body.style.height = prevHeight;
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
      <div className="claim-background" aria-hidden="true">
        <div className="claim-glow claim-glow-top" />
        <div className="claim-glow claim-glow-bottom" />
        <div className="claim-grid" />
      </div>
      <header className="claim-nav">
        <img className="claim-brand" src={hyperwareWordmark} alt="Hyperware" />
      </header>
      <div
        className={`claim-connect-floating connect-button-wrapper${showConnectPop ? ' bind-button-pop' : ''}${
          showConnectShimmer ? ' bind-button-shimmer' : ''
        }`}
      >
        <ConnectButton />
      </div>
      <main className="claim-main">
        <div className="claim-orb" aria-hidden="true">
          <div className="claim-orb-glow" />
          <div className="claim-orb-core" />
          <div className="claim-orb-ring" />
          <span className="claim-orb-dot claim-orb-dot--one" />
          <span className="claim-orb-dot claim-orb-dot--two" />
          <span className="claim-orb-dot claim-orb-dot--three" />
        </div>
        <section className="claim-header">
          <div className="claim-badge">
            <span className="claim-badge-icon" aria-hidden="true" />
            Incentives Available
          </div>
          <h1 className="claim-title">Claim Voting Incentives</h1>
          <div className="claim-hero">
            <span className="claim-hero-value">{displayAmount}</span>
            <span className="claim-hero-unit">HYPR</span>
          </div>
        </section>
        <section className="claim-card">
          <div className="claim-wallet-row">
            <span className="claim-wallet-label">WALLET</span>
            <span className={`claim-wallet-pill${walletConnected && !receiverMismatch ? ' is-ok' : ''}`}>
              <span className="claim-wallet-dot" />
              <span className="claim-address">{displayAddress}</span>
            </span>
          </div>
          <div className="claim-warning">
            WARNING: Double-check this link was from a message sent in the official Chat app by dao.hypr and that this
            app is the HYPR DAO app before proceeding!
          </div>
          {claimParams.errors.length > 0 && (
            <div className="error-banner claim-error">
              <span>{claimParams.errors[0]}</span>
            </div>
          )}
          {receiverMismatch && claimParams.receiver && (
            <div className="error-banner claim-error">
              <span>
                ERROR: Must connect <span className="claim-address">{claimParams.receiver}</span>
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
            className={`claim-primary-button${showClaimPop ? ' bind-button-pop' : ''}${
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
            {isClaimPending || isConfirming ? 'Claiming...' : 'CLAIM INCENTIVES'}
          </button>
          <a
            className="claim-share-button"
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
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
            </svg>
            Share on X
          </a>
          {claimHash && (
            <div className="claim-hash">
              Tx: <span>{claimHash}</span>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
