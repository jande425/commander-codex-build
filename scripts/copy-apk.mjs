// Post-build: drop a copy of the release APK on the Desktop (stable name, so
// side-loading is always "grab CommanderCodex.apk"). Runs automatically at the
// end of `npm run build:apk`; a failed copy must not fail the build.
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apk = resolve(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

try {
  if (!existsSync(apk)) throw new Error(`no APK at ${apk}`);
  // OneDrive-managed desktops live under ~/OneDrive/Desktop
  const desktop = [join(homedir(), 'OneDrive', 'Desktop'), join(homedir(), 'Desktop')].find(existsSync);
  if (!desktop) throw new Error('no Desktop folder found');
  const dest = join(desktop, 'CommanderCodex.apk');
  copyFileSync(apk, dest);
  console.log(`copy-apk: ${(statSync(dest).size / 1e6).toFixed(1)} MB -> ${dest}`);
} catch (e) {
  console.warn(`copy-apk: skipped (${e.message})`);
}
