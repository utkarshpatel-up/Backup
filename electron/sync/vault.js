'use strict';
// Encrypted, atomically written files for the account cache, the upload queue and the
// session tokens. The data key is random per account and stored only wrapped by the OS
// (Electron safeStorage: Keychain / DPAPI / libsecret). No plaintext fallback: when the
// OS can't protect it, opening fails and the app says so.
const nodeCrypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

class VaultError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const KEY_STORE_HELP = 'If macOS asks about "AV Backup Safe Storage", enter your Mac password and choose Always Allow, then try again.';
/** A key store that refuses (Keychain prompt denied, or locked) is not a damaged file: say what to do. */
function osCall(fn) {
  try { return fn(); } catch (_) { throw new VaultError('os_key_store', `This computer refused access to its secure key store. ${KEY_STORE_HELP}`); }
}

/** safeStorage is usable only with a real OS backend (Linux 'basic_text' is plain obfuscation). */
function osProtectionAvailable(safeStorage) {
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
  if (typeof safeStorage.getSelectedStorageBackend === 'function') {
    const b = safeStorage.getSelectedStorageBackend();
    if (b === 'basic_text' || b === 'unknown') return false;
  }
  return true;
}

/** Write then fsync then rename: a crash leaves the old file or the new one, never half. */
function writeAtomic(fs, file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${nodeCrypto.randomBytes(4).toString('hex')}.tmp`;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      // writeSync may write fewer bytes than asked: keep going, and stop on no progress.
      for (let off = 0; off < buf.length;) {
        const n = fs.writeSync(fd, buf, off, buf.length - off);
        if (!(n > 0)) { const e = new Error('The disk accepted no more data.'); e.code = 'EIO'; throw e; }
        off += n;
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* best effort */ }
    throw e;
  }
  try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (_) { /* not on Windows */ }
}

/**
 * One account's encrypted JSON document. `aad` ties the ciphertext to that account and
 * server, so a file copied into another account's folder fails to open.
 */
class SealedFile {
  constructor({ file, keyFile, aad, safeStorage, fs = nodeFs, crypto = nodeCrypto }) {
    Object.assign(this, { file, keyFile, aad: Buffer.from(aad), safeStorage, fs, crypto });
    this.key = null;
  }
  _key(create) {
    if (this.key) return this.key;
    if (!osProtectionAvailable(this.safeStorage)) {
      throw new VaultError('no_os_encryption', 'This computer cannot protect the account data (no OS key store). Account mode is unavailable here.');
    }
    if (this.fs.existsSync(this.keyFile)) {
      let key;
      try { key = Buffer.from(this.safeStorage.decryptString(this.fs.readFileSync(this.keyFile)), 'base64'); } catch (_) { key = null; }
      if (!key || key.length !== 32) throw new VaultError('bad_key', `The account key on this computer could not be unlocked. ${KEY_STORE_HELP}`);
      this.key = key;
    } else {
      if (!create) return null;
      const key = this.crypto.randomBytes(32);
      writeAtomic(this.fs, this.keyFile, osCall(() => this.safeStorage.encryptString(key.toString('base64'))));
      this.key = key;   // only once it is on disk: a cache must never be written under a key that isn't
    }
    return this.key;
  }
  read() {
    if (!this.fs.existsSync(this.file)) return null;
    const key = this._key(false);
    if (!key) throw new VaultError('bad_key', 'The account data on this computer has no key; it cannot be opened.');
    let box;
    try { box = JSON.parse(this.fs.readFileSync(this.file, 'utf8')); } catch (_) { throw new VaultError('tampered', 'The account data on this computer is damaged.'); }
    try {
      const d = this.crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
      d.setAAD(this.aad);
      d.setAuthTag(Buffer.from(box.tag, 'base64'));
      const plain = Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]);
      return JSON.parse(plain.toString('utf8'));
    } catch (_) {
      throw new VaultError('tampered', 'The account data on this computer was changed or belongs to another account; it was not opened.');
    }
  }
  write(obj) {
    const key = this._key(true);
    const iv = this.crypto.randomBytes(12);
    const c = this.crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(this.aad);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
    writeAtomic(this.fs, this.file, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') }));
  }
}

/** The signed-in session (tokens): one small safeStorage blob, never plain on disk. */
class SessionStore {
  constructor({ file, safeStorage, fs = nodeFs }) { Object.assign(this, { file, safeStorage, fs }); }
  load() {
    if (!this.fs.existsSync(this.file)) return null;
    if (!osProtectionAvailable(this.safeStorage)) return null;
    try { return JSON.parse(this.safeStorage.decryptString(this.fs.readFileSync(this.file))); } catch (_) { return null; }
  }
  save(session) {
    if (!osProtectionAvailable(this.safeStorage)) {
      throw new VaultError('no_os_encryption', 'This computer cannot protect sign-in tokens (no OS key store), so it cannot stay signed in.');
    }
    writeAtomic(this.fs, this.file, osCall(() => this.safeStorage.encryptString(JSON.stringify(session))));
  }
  clear() { this.fs.rmSync(this.file, { force: true }); }
}

module.exports = { SealedFile, SessionStore, VaultError, writeAtomic, osProtectionAvailable };
