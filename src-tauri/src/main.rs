// src-tauri/src/main.rs
// QTC Wallet — Rust backend (Tauri commands)
//
// Exposes four commands to the React frontend via Tauri's IPC bridge:
//   generate_keypair  — create a new Dilithium2 keypair, save to keystore
//   load_keystore     — load existing keypair from keystore file
//   get_address       — derive 32-byte address from loaded pubkey (SHA3-256)
//   sign_transaction  — sign serialized tx bytes with loaded secret key
//
// The secret key NEVER leaves the Rust process. The frontend only ever
// sees the public key and address.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use pqcrypto_dilithium::dilithium2;
use pqcrypto_traits::sign::{PublicKey, SecretKey, DetachedSignature};
use sha3::{Digest, Sha3_256};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

// ---------------------------------------------------------------------------
// Keystore (persisted to disk as JSON)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct Keystore {
    /// Hex-encoded Dilithium2 public key (1312 bytes = 2624 hex chars)
    pk_hex: String,
    /// Hex-encoded Dilithium2 secret key (2560 bytes = 5120 hex chars)
    /// TODO M12+: encrypt with a password-derived key (Argon2 + AES-256-GCM)
    sk_hex: String,
}

// ---------------------------------------------------------------------------
// In-memory wallet state (loaded once per session)
// ---------------------------------------------------------------------------

struct WalletState {
    pk: Option<Vec<u8>>,
    sk: Option<Vec<u8>>,
}

type SafeWalletState = Mutex<WalletState>;

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Generate a new Dilithium2 keypair and save it to `keystore.json`
/// in the app's local data directory.
///
/// Returns the hex-encoded public key and derived address.
/// The secret key is stored in state and on disk, but NOT returned to the
/// frontend.
#[tauri::command]
fn generate_keypair(
    state: State<SafeWalletState>,
    app_handle: tauri::AppHandle,
) -> Result<KeypairInfo, String> {
    let (pk, sk) = dilithium2::keypair();
    let pk_bytes = pk.as_bytes().to_vec();
    let sk_bytes = sk.as_bytes().to_vec();

    // Save to keystore file
    let keystore = Keystore {
        pk_hex: hex::encode(&pk_bytes),
        sk_hex: hex::encode(&sk_bytes),
    };
    save_keystore(&app_handle, &keystore)?;

    // Store in memory
    let mut w = state.lock().unwrap();
    w.pk = Some(pk_bytes.clone());
    w.sk = Some(sk_bytes);

    let address = derive_address(&pk_bytes);
    Ok(KeypairInfo {
        pk_hex: hex::encode(&pk_bytes),
        address,
    })
}

/// Load an existing keypair from `keystore.json`.
/// Returns the public key and address; secret key stays in memory only.
#[tauri::command]
fn load_keystore(
    state: State<SafeWalletState>,
    app_handle: tauri::AppHandle,
) -> Result<KeypairInfo, String> {
    let keystore = read_keystore(&app_handle)?;
    let pk_bytes = hex::decode(&keystore.pk_hex)
        .map_err(|e| format!("invalid pk hex in keystore: {e}"))?;
    let sk_bytes = hex::decode(&keystore.sk_hex)
        .map_err(|e| format!("invalid sk hex in keystore: {e}"))?;

    if pk_bytes.len() != 1312 {
        return Err(format!("keystore pk is {} bytes, expected 1312", pk_bytes.len()));
    }
    if sk_bytes.len() != 2560 {
        return Err(format!("keystore sk is {} bytes, expected 2560", sk_bytes.len()));
    }

    let address = derive_address(&pk_bytes);

    let mut w = state.lock().unwrap();
    w.pk = Some(pk_bytes.clone());
    w.sk = Some(sk_bytes);

    Ok(KeypairInfo {
        pk_hex: hex::encode(&pk_bytes),
        address,
    })
}

/// Return the wallet address (SHA3-256 of the loaded public key).
/// Matches consensus::registry::address_from_pubkey in qc-node (M10).
#[tauri::command]
fn get_address(state: State<SafeWalletState>) -> Result<String, String> {
    let w = state.lock().unwrap();
    match &w.pk {
        Some(pk) => Ok(derive_address(pk)),
        None => Err("no keypair loaded — call generate_keypair or load_keystore first".into()),
    }
}

/// Sign raw transaction bytes with the loaded secret key.
/// `tx_bytes_hex` is the hex-encoded output of qtc-client's
/// `serializeTransaction` (called from the React frontend).
///
/// Returns the Dilithium2 detached signature as a hex string (2420 bytes =
/// 4840 hex chars). The frontend appends this to the tx before calling
/// eth_sendRawTransaction.
#[tauri::command]
fn sign_transaction(
    state: State<SafeWalletState>,
    tx_bytes_hex: String,
) -> Result<String, String> {
    let tx_bytes = hex::decode(&tx_bytes_hex)
        .map_err(|e| format!("invalid tx_bytes_hex: {e}"))?;

    let w = state.lock().unwrap();
    let sk_bytes = w.sk.as_ref()
        .ok_or_else(|| "no keypair loaded".to_string())?;

    let sk = dilithium2::SecretKey::from_bytes(sk_bytes)
        .map_err(|e| format!("invalid secret key: {e}"))?;

    let sig = dilithium2::detached_sign(&tx_bytes, &sk);
    let sig_bytes = sig.as_bytes();

    if sig_bytes.len() != 2420 {
        return Err(format!("unexpected sig length: {}", sig_bytes.len()));
    }

    Ok(hex::encode(sig_bytes))
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct KeypairInfo {
    /// Hex-encoded Dilithium2 public key (2624 hex chars)
    pk_hex: String,
    /// "0x" + hex-encoded 32-byte address (SHA3-256 of pubkey)
    address: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn derive_address(pk: &[u8]) -> String {
    let mut hasher = Sha3_256::new();
    hasher.update(pk);
    let hash: [u8; 32] = hasher.finalize().into();
    format!("0x{}", hex::encode(hash))
}

fn keystore_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app_handle
        .path_resolver()
        .app_local_data_dir()
        .map(|p| p.join("keystore.json"))
        .ok_or_else(|| "could not resolve app data dir".to_string())
}

fn save_keystore(app_handle: &tauri::AppHandle, keystore: &Keystore) -> Result<(), String> {
    let path = keystore_path(app_handle)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create data dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(keystore)
        .map_err(|e| format!("serialization failed: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("failed to write keystore: {e}"))?;
    Ok(())
}

fn read_keystore(app_handle: &tauri::AppHandle) -> Result<Keystore, String> {
    let path = keystore_path(app_handle)?;
    let json = std::fs::read_to_string(&path)
        .map_err(|e| format!("keystore not found — generate a keypair first: {e}"))?;
    serde_json::from_str(&json)
        .map_err(|e| format!("keystore corrupt: {e}"))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(WalletState { pk: None, sk: None }))
        .invoke_handler(tauri::generate_handler![
            generate_keypair,
            load_keystore,
            get_address,
            sign_transaction,
        ])
        .run(tauri::generate_context!())
        .expect("error running QTC wallet");
}
