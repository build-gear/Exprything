// electron-builder's mac.sign hook. It signs with the Exprything Local Signing identity when your keychain has
// it (`pnpm desktop:signing-identity` adds it), so macOS knows every build as the same app and keeps the folder
// permissions you granted. Otherwise it keeps electron-builder's ad-hoc signature, which macOS takes for a new
// app after every build. electron-builder can't pick the identity itself: it only looks among trusted ones,
// and this one is self-signed.
import { signAsync } from '@electron/osx-sign';
import { localIdentity } from './signing-identity.mjs';

export default async function sign(opts) {
  const identity = localIdentity();
  // A secure timestamp only matters for notarization, and costs a round trip to Apple for every file.
  await signAsync(identity ? { ...opts, identity, timestamp: 'none' } : opts);
}
