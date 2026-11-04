// Adds "Exprything Local Signing", a self-signed code signing identity, to your login keychain unless it is
// there already. scripts/sign.mjs signs the app with it, so macOS knows every build as the same app and keeps
// the folder permissions you grant it. The private key is made here and stays in the keychain, unexportable.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IDENTITY_NAME = 'Exprything Local Signing';

/** The identity's certificate hash, or undefined when the keychain doesn't have it. */
export function localIdentity() {
  // Without -v: the certificate is self-signed, so macOS lists it among identities it doesn't trust.
  const found = execFileSync('/usr/bin/security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
  return found.match(new RegExp(`^\\s*\\d+\\) ([0-9A-F]{40}) "${IDENTITY_NAME}"`, 'm'))?.[1];
}

function create() {
  const dir = mkdtempSync(join(tmpdir(), 'exprything-signing-'));
  const file = (name) => join(dir, name);
  try {
    writeFileSync(file('cert.conf'), `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = ${IDENTITY_NAME}
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
`);
    const serial = BigInt(`0x${randomBytes(8).toString('hex')}`).toString();
    execFileSync('/usr/bin/openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-set_serial', serial,
      '-config', file('cert.conf'), '-keyout', file('key.pem'), '-out', file('cert.pem'),
    ], { stdio: 'ignore' });
    // security only imports a key with its certificate from a password-protected PKCS#12 file. The name labels
    // the key, which macOS shows when it asks once whether codesign may use it.
    const password = randomBytes(18).toString('base64url');
    execFileSync('/usr/bin/openssl', [
      'pkcs12', '-export', '-inkey', file('key.pem'), '-in', file('cert.pem'), '-out', file('identity.p12'),
      '-name', IDENTITY_NAME, '-passout', `pass:${password}`,
    ]);
    execFileSync('/usr/bin/security', ['import', file('identity.p12'), '-P', password, '-x', '-T', '/usr/bin/codesign'], {
      stdio: 'ignore',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (localIdentity()) {
    console.log(`${IDENTITY_NAME} is already in your keychain.`);
  } else {
    create();
    console.log(`Added ${IDENTITY_NAME} to your login keychain (${localIdentity()}).`);
  }
}
