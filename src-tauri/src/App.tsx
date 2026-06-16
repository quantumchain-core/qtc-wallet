// src/App.tsx
// QTC Wallet — main React UI
// Design: dark terminal-meets-finance aesthetic. Monospace address display,
// clean numeric balance, single accent colour (cyan #00E5FF) used sparingly.

import { useState, useEffect, useCallback } from 'react';
import { makeClient, sendTransaction, loadWallet } from './rpc';
import { hexToBigInt, type Hex } from 'qtc-client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NANO_PER_QTC = 1_000_000_000n; // 1 QTC = 1e9 nano-QTC
const DEFAULT_RPC = 'http://localhost:8545';
const GAS_LIMIT = 21_000n;
const BASE_FEE = 1_000n;
const PRIORITY_FEE = 100n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nanoToQtc(nano: bigint): string {
  const whole = nano / NANO_PER_QTC;
  const frac = nano % NANO_PER_QTC;
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      width: 8, height: 8,
      borderRadius: '50%',
      background: connected ? '#00E5FF' : '#555',
      marginRight: 6,
      boxShadow: connected ? '0 0 6px #00E5FF' : 'none',
    }} />
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={copy} style={styles.copyBtn}>
      {copied ? '✓' : 'copy'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export default function App() {
  const [rpcUrl, setRpcUrl] = useState(DEFAULT_RPC);
  const [address, setAddress] = useState<Hex | null>(null);
  const [pkHex, setPkHex] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [blockNumber, setBlockNumber] = useState<bigint | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Send form
  const [toAddr, setToAddr] = useState('');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);

  const client = makeClient(rpcUrl);

  // Load wallet identity on mount
  useEffect(() => {
    loadWallet()
      .then(({ pkHex, address }) => {
        setPkHex(pkHex);
        setAddress(address);
      })
      .catch(e => setError(`wallet load failed: ${e}`));
  }, []);

  // Poll node for balance + block number
  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const [bal, blk] = await Promise.all([
        client.getBalance(address),
        client.blockNumber(),
      ]);
      setBalance(bal);
      setBlockNumber(blk);
      setConnected(true);
      setError(null);
    } catch {
      setConnected(false);
    }
  }, [address, rpcUrl]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  // Send transaction
  async function handleSend() {
    if (!address || !pkHex) return setError('wallet not loaded');
    if (!toAddr.match(/^0x[0-9a-fA-F]{64}$/)) return setError('invalid recipient address');
    const amountQtc = parseFloat(amount);
    if (isNaN(amountQtc) || amountQtc <= 0) return setError('invalid amount');

    const valueNano = BigInt(Math.round(amountQtc * Number(NANO_PER_QTC)));
    const nonce = await client.getTransactionCount(address);

    setSending(true);
    setError(null);
    setStatus(null);

    try {
      const txHash = await sendTransaction(client, {
        from: hexToBytes(address),
        to: hexToBytes(toAddr as Hex),
        value: valueNano,
        nonce,
        baseFee: BASE_FEE,
        priorityFee: PRIORITY_FEE,
        gasLimit: GAS_LIMIT,
      });
      setStatus(`sent — tx ${txHash}`);
      setToAddr('');
      setAmount('');
      setTimeout(refresh, 1000);
    } catch (e) {
      setError(`send failed: ${e}`);
    } finally {
      setSending(false);
    }
  }

  function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.logo}>QTC</span>
        <span style={styles.network}>
          <StatusDot connected={connected} />
          {connected ? `block ${blockNumber?.toString() ?? '…'}` : 'disconnected'}
        </span>
      </div>

      {/* Balance */}
      <div style={styles.balanceCard}>
        <div style={styles.balanceLabel}>balance</div>
        <div style={styles.balanceAmount}>
          {balance !== null ? nanoToQtc(balance) : '—'}
          <span style={styles.balanceCurrency}> QTC</span>
        </div>
        <div style={styles.addressRow}>
          <span style={styles.addressText}>
            {address ? shortenAddress(address) : '…'}
          </span>
          {address && <CopyButton text={address} />}
        </div>
      </div>

      {/* Send */}
      <div style={styles.section}>
        <div style={styles.sectionLabel}>send</div>
        <input
          style={styles.input}
          placeholder="recipient  0x…"
          value={toAddr}
          onChange={e => setToAddr(e.target.value)}
          spellCheck={false}
        />
        <div style={styles.row}>
          <input
            style={{ ...styles.input, flex: 1 }}
            placeholder="amount (QTC)"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            type="number"
            min="0"
            step="0.000000001"
          />
          <button
            style={sending ? { ...styles.sendBtn, opacity: 0.5 } : styles.sendBtn}
            onClick={handleSend}
            disabled={sending}
          >
            {sending ? 'signing…' : 'send'}
          </button>
        </div>
      </div>

      {/* Node URL */}
      <div style={styles.section}>
        <div style={styles.sectionLabel}>node</div>
        <div style={styles.row}>
          <input
            style={{ ...styles.input, flex: 1, fontSize: 11 }}
            value={rpcUrl}
            onChange={e => setRpcUrl(e.target.value)}
            spellCheck={false}
          />
          <button style={styles.refreshBtn} onClick={refresh}>↻</button>
        </div>
      </div>

      {/* Feedback */}
      {error && <div style={styles.error}>{error}</div>}
      {status && <div style={styles.statusMsg}>{status}</div>}

      {/* Footer */}
      <div style={styles.footer}>
        post-quantum · Dilithium2 · M11
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  root: {
    background: '#0d0d0d',
    color: '#e0e0e0',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
    minHeight: '100vh',
    padding: '20px 18px 40px',
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
    maxWidth: 420,
    margin: '0 auto',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 12,
    borderBottom: '1px solid #1e1e1e',
  },
  logo: {
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: '0.15em',
    color: '#00E5FF',
  },
  network: {
    fontSize: 11,
    color: '#777',
    display: 'flex',
    alignItems: 'center',
  },
  balanceCard: {
    background: '#111',
    border: '1px solid #1e1e1e',
    borderRadius: 8,
    padding: '20px 18px 16px',
  },
  balanceLabel: {
    fontSize: 10,
    color: '#555',
    letterSpacing: '0.15em',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  balanceAmount: {
    fontSize: 32,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '-0.01em',
    marginBottom: 10,
  },
  balanceCurrency: {
    fontSize: 14,
    fontWeight: 400,
    color: '#555',
  },
  addressRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  addressText: {
    fontSize: 11,
    color: '#444',
    fontFamily: 'inherit',
  },
  copyBtn: {
    background: 'none',
    border: '1px solid #2a2a2a',
    color: '#555',
    fontSize: 10,
    padding: '2px 7px',
    borderRadius: 4,
    cursor: 'pointer',
    letterSpacing: '0.05em',
    fontFamily: 'inherit',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionLabel: {
    fontSize: 10,
    color: '#555',
    letterSpacing: '0.15em',
    textTransform: 'uppercase',
  },
  input: {
    background: '#111',
    border: '1px solid #222',
    borderRadius: 6,
    color: '#e0e0e0',
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '9px 12px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  row: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  sendBtn: {
    background: '#00E5FF',
    color: '#000',
    border: 'none',
    borderRadius: 6,
    padding: '9px 18px',
    fontFamily: 'inherit',
    fontWeight: 700,
    fontSize: 12,
    cursor: 'pointer',
    letterSpacing: '0.05em',
    whiteSpace: 'nowrap',
  },
  refreshBtn: {
    background: 'none',
    border: '1px solid #222',
    color: '#555',
    borderRadius: 6,
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 14,
    fontFamily: 'inherit',
  },
  error: {
    fontSize: 11,
    color: '#ff5555',
    background: '#1a0a0a',
    border: '1px solid #3a1515',
    borderRadius: 6,
    padding: '8px 12px',
  },
  statusMsg: {
    fontSize: 11,
    color: '#00E5FF',
    background: '#001a1f',
    border: '1px solid #00303a',
    borderRadius: 6,
    padding: '8px 12px',
    wordBreak: 'break-all',
  },
  footer: {
    marginTop: 'auto',
    fontSize: 10,
    color: '#2a2a2a',
    textAlign: 'center',
    letterSpacing: '0.1em',
  },
};
