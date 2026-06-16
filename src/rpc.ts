// src/rpc.ts
// Wallet-specific RPC helpers — wraps QtcClient from qtc-client and wires
// in the Tauri sign_transaction command for the send flow.
//
// The signing flow:
//   1. Frontend builds UnsignedTransaction
//   2. computeTxHash() -> hash
//   3. serializeTransaction(tx with empty sig) -> bytes
//   4. invoke("sign_transaction", { tx_bytes_hex }) -> sig hex (Rust/Dilithium2)
//   5. client.sendRawTransaction(tx with real sig) -> txHash

import { invoke } from '@tauri-apps/api/tauri';
import {
  QtcClient,
  computeTxHash,
  serializeTransaction,
  fromHex,
  toHex,
  type Hex,
  type UnsignedTransaction,
} from 'qtc-client';

// Default: local node. In production, point at your qc-node's public IP.
const DEFAULT_RPC = 'http://localhost:8545';

export function makeClient(rpcUrl = DEFAULT_RPC): QtcClient {
  return new QtcClient({ url: rpcUrl });
}

/**
 * Build, sign (via Rust), and submit a transaction.
 * Returns the tx hash from qc-node on success.
 */
export async function sendTransaction(
  client: QtcClient,
  tx: UnsignedTransaction
): Promise<Hex> {
  // 1. Compute hash
  const hash = computeTxHash(tx);

  // 2. Serialize with empty signature to get the signable bytes
  const signableBytes = serializeTransaction({
    ...tx,
    hash,
    signature: new Uint8Array(0),
    receivedAt: 0n,
  });

  // 3. Sign via Tauri (Rust backend, Dilithium2)
  const sigHex: string = await invoke('sign_transaction', {
    txBytesHex: toHex(signableBytes).slice(2), // strip "0x" for Rust hex::decode
  });
  const signature = fromHex(sigHex);

  // 4. Submit full signed tx
  return client.sendRawTransaction({
    ...tx,
    hash,
    signature,
    receivedAt: BigInt(Math.floor(Date.now() / 1000)),
  });
}

/** Load wallet identity from Tauri (pk + address). */
export async function loadWallet(): Promise<{ pkHex: string; address: Hex }> {
  try {
    // Try loading existing keystore first
    const result = await invoke<{ pk_hex: string; address: string }>('load_keystore');
    return { pkHex: result.pk_hex, address: result.address as Hex };
  } catch {
    // No keystore yet — generate a new keypair
    const result = await invoke<{ pk_hex: string; address: string }>('generate_keypair');
    return { pkHex: result.pk_hex, address: result.address as Hex };
  }
}
