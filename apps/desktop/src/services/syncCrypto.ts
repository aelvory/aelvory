import { argon2id } from '@noble/hashes/argon2';
import { blake2b } from '@noble/hashes/blake2b';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';

export interface CryptoHeader {
  alg: 'xchacha20poly1305';
  kdf: 'argon2id';
  /** Base64 of the Argon2id salt that produced the encryption key. */
  salt: string;
  /** Base64 of the per-entry nonce used to encrypt the payload (24 bytes). */
  nonce: string;
  /** KDF parameter hint. "interactive" = ~64 MiB / 2 iter / parallel 1. */
  kdfParams: 'interactive' | 'moderate' | 'sensitive';
}

export interface DerivedKey {
  bytes: Uint8Array;
  salt: Uint8Array;
  params: 'interactive' | 'moderate' | 'sensitive';
}

const SALT_LEN = 16;
const NONCE_LEN = 24; // xchacha20poly1305
const KEY_LEN = 32;

// Argon2id parameter sets — match libsodium's pwhash levels reasonably.
const PARAMS = {
  interactive: { t: 2, m: 1 << 16, p: 1 }, //  64 MiB
  moderate: { t: 3, m: 1 << 18, p: 1 }, // 256 MiB
  sensitive: { t: 4, m: 1 << 20, p: 1 }, //   1 GiB
} as const;

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesFromUtf8(s: string): Uint8Array {
  return enc.encode(s);
}

function bytesToUtf8(b: Uint8Array): string {
  return dec.decode(b);
}

function randomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

/**
 * Deterministic salt from email — `blake2b(email|"aelvory-e2ee-salt-v1", 16)`.
 * Same email + same passphrase = same key on any device, no server round-trip.
 * Weaker than a random per-user salt stored server-side, but fine for MVP.
 */
export async function deriveSaltFromEmail(email: string): Promise<Uint8Array> {
  const data = bytesFromUtf8(`${email.toLowerCase().trim()}|aelvory-e2ee-salt-v1`);
  return blake2b(data, { dkLen: SALT_LEN });
}

export async function deriveKey(
  passphrase: string,
  email: string,
): Promise<DerivedKey> {
  const salt = await deriveSaltFromEmail(email);
  const params = PARAMS.interactive;
  // argon2id is CPU-bound and synchronous in @noble/hashes — at 64 MiB / 2 iter
  // it'll block the main thread for ~1s. Acceptable for an unlock action.
  const bytes = argon2id(bytesFromUtf8(passphrase), salt, {
    t: params.t,
    m: params.m,
    p: params.p,
    dkLen: KEY_LEN,
  });
  return { bytes, salt, params: 'interactive' };
}

export async function encryptPayload(
  plaintext: Uint8Array,
  key: DerivedKey,
): Promise<{ ciphertext: Uint8Array; header: CryptoHeader }> {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = xchacha20poly1305(key.bytes, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  return {
    ciphertext,
    header: {
      alg: 'xchacha20poly1305',
      kdf: 'argon2id',
      salt: bytesToBase64Sync(key.salt),
      nonce: bytesToBase64Sync(nonce),
      kdfParams: key.params,
    },
  };
}

export async function decryptPayload(
  ciphertext: Uint8Array,
  headerJson: string,
  key: DerivedKey,
): Promise<Uint8Array> {
  const header = JSON.parse(headerJson) as CryptoHeader;
  if (header.alg !== 'xchacha20poly1305' || header.kdf !== 'argon2id') {
    throw new Error(`Unsupported crypto header: alg=${header.alg} kdf=${header.kdf}`);
  }
  const nonce = bytesFromBase64Sync(header.nonce);
  const cipher = xchacha20poly1305(key.bytes, nonce);
  return cipher.decrypt(ciphertext);
}

// --- Base64 helpers (browser btoa/atob, no extra deps) ---

function bytesToBase64Sync(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function bytesFromBase64Sync(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export async function bytesFromBase64(b64: string): Promise<Uint8Array> {
  return bytesFromBase64Sync(b64);
}

export async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  return bytesToBase64Sync(bytes);
}

export function bytesFromJson(obj: unknown): Uint8Array {
  return bytesFromUtf8(JSON.stringify(obj));
}

export function bytesToJson<T>(bytes: Uint8Array): T {
  return JSON.parse(bytesToUtf8(bytes)) as T;
}
