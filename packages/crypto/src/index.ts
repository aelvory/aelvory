import sodium from 'libsodium-wrappers-sumo';

let ready: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!ready) ready = sodium.ready;
  return ready;
}

export async function deriveMasterKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  await ensureReady();
  return sodium.crypto_pwhash(
    32,
    passphrase,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function generateKeyPair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  await ensureReady();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export async function generateDek(): Promise<Uint8Array> {
  await ensureReady();
  return sodium.randombytes_buf(32);
}

export async function wrapDek(
  dek: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureReady();
  return sodium.crypto_box_seal(dek, recipientPublicKey);
}

export async function unwrapDek(
  ciphertext: Uint8Array,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureReady();
  return sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey);
}

export interface Sealed {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

export async function encryptSecret(plaintext: string, dek: Uint8Array): Promise<Sealed> {
  await ensureReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, dek);
  return { ciphertext, nonce };
}

export async function decryptSecret(sealed: Sealed, dek: Uint8Array): Promise<string> {
  await ensureReady();
  const plain = sodium.crypto_secretbox_open_easy(sealed.ciphertext, sealed.nonce, dek);
  return new TextDecoder().decode(plain);
}

export function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export async function fromBase64(s: string): Promise<Uint8Array> {
  await ensureReady();
  return sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
}
