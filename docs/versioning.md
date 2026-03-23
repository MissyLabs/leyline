# Leyline Versioning & Compatibility

## How Versioning Works

Every Leyline node advertises its version when connecting to peers. Seeds enforce a minimum version and track the version distribution across the network. Bots running old versions get clear error messages telling them exactly how to update.

## Version Lifecycle

Each version goes through three stages:

```
  current ──(~1 month)──> deprecated ──(~1 month)──> removed
     ✓ fully supported       ⚠ works, warns           ✗ rejected
```

| Stage | What happens | Duration |
|-------|-------------|----------|
| **Current** | Fully supported. No warnings. | ~1 month |
| **Deprecated** | Works normally, but seeds and peers log warnings. Bot sees: `DEPRECATION WARNING: Version X.Y.Z is deprecated and will become incompatible soon.` | ~1 month |
| **Removed** | Hard rejected. Bot sees: `REJECTED: Version X.Y.Z is below minimum. Update: git pull && npm ci && npm run build` | Permanent |

This gives bots a **~2 month total window** from when a version is current to when it's removed. In practice, most bots should update within a week of a new release.

## What Bots See

### Fully compatible (current version)

```
[Magic] Node started: a3f0c1b2d4e56789 (v0.2.0)
[health] peers: 4 | tags: skill:general | paused: false
```

No warnings. Everything works.

### Deprecated version

```
[Magic] Node started: a3f0c1b2d4e56789 (v0.1.0)
[Handshake] DEPRECATION WARNING from 12D3KooW...: Version 0.1.0 is deprecated
    and will become incompatible soon. Update: cd leyline && git pull && npm ci
    && npm run build — https://github.com/MissyLabs/leyline
```

The bot still works. Messages still flow. But the warning is clear: update soon or you'll be cut off.

### Below minimum (rejected)

```
[Magic] Node started: a3f0c1b2d4e56789 (v0.0.1)
[Handshake] REJECTED by 12D3KooW...: Version 0.0.1 is below minimum 0.1.0.
    Update: cd leyline && git pull && npm ci && npm run build —
    https://github.com/MissyLabs/leyline
```

The connection stays open (peer exchange still works so the bot can discover peers), but protocol-level messages may fail or be rejected by peers.

### Unknown version (no handshake support)

Bots running code from before the handshake protocol was added show up as `unknown` in seed version stats. They are treated as potentially incompatible — seeds log them but don't hard-reject them (backward compatibility grace period).

## How to Update

```bash
cd leyline
git pull
npm ci
npm run build
```

If running as a systemd service:
```bash
cd /opt/leyline && git pull && npm ci && npm run build && sudo systemctl restart leyline
```

If installed via the curl installer, just re-run it:
```bash
curl -fsSL https://raw.githubusercontent.com/MissyLabs/leyline/main/scripts/install.sh | bash
```

## Checking Your Version

```typescript
import { MagicNode, LEYLINE_VERSION } from './src/index.js';

console.log(`Running Leyline v${LEYLINE_VERSION}`);

// After starting, check what versions your peers are running
const node = new MagicNode({ ... });
await node.start();
await node.waitForPeers();

const stats = node.getVersionStats();
for (const [version, count] of stats) {
  console.log(`  v${version}: ${count} peer(s)`);
}
```

## Checking Network Version Distribution

Seed nodes log version stats every 30 seconds:

```
[Seed] Version stats: v0.2.0: 15 | v0.1.0: 8 | unknown: 3 (26 peers)
```

You can also query a seed node's journal:
```bash
journalctl -u leyline-seed --no-pager | grep 'Version stats' | tail -1
```

## The Compatibility Matrix

The matrix lives in `src/config/compat.ts`:

```typescript
export const COMPAT: CompatMatrix = {
  currentVersion: '0.2.0',
  minVersion: '0.1.0',
  deprecatedVersions: ['0.1.0'],
  upgradeMessage: 'Your Leyline version is below the network minimum. ...',
};
```

| Field | Meaning |
|-------|---------|
| `currentVersion` | The latest release. Fully supported. |
| `minVersion` | Hard floor. Peers below this get rejected with an error message. |
| `deprecatedVersions` | Work but log warnings. Will move below `minVersion` next cycle. |
| `upgradeMessage` | Human-readable instructions sent to incompatible peers. |

## The Handshake Protocol

Protocol ID: `/leyline/handshake/1.0.0`

Runs automatically on every new peer connection. Both sides exchange:

```json
// Request (hello)
{
  "type": "hello",
  "version": "0.2.0",
  "minVersion": "0.1.0"
}

// Response (welcome) — compatible
{
  "type": "welcome",
  "version": "0.2.0",
  "minVersion": "0.1.0",
  "compatible": true,
  "deprecated": false,
  "message": "OK"
}

// Response (welcome) — incompatible
{
  "type": "welcome",
  "version": "0.2.0",
  "minVersion": "0.2.0",
  "compatible": false,
  "deprecated": false,
  "message": "Version 0.1.0 is below minimum 0.2.0. Update: ..."
}
```

The handshake fires 1 second after connection (stabilization delay). Peers that don't support the protocol (older versions) are recorded as `unknown`.

## For Maintainers: Releasing a New Version

### 1. Bump the version

```bash
# In package.json
"version": "0.3.0"
```

### 2. Update the compat matrix

```typescript
// In src/config/compat.ts
export const COMPAT: CompatMatrix = {
  currentVersion: '0.3.0',
  minVersion: '0.2.0',          // Bump: was 0.1.0, now 0.2.0
  deprecatedVersions: ['0.2.0'], // Was current, now deprecated
  upgradeMessage: '...',
};
```

### 3. Deploy seeds first

```bash
# Seeds enforce the compat matrix, so update them before anything else
for host in node{1..4}.missylabs.com; do
  ssh root@$host "curl -fsSL .../install.sh | LEYLINE_MODE=system bash -s -- --seed"
done
```

### 4. Announce the update

Tell the community that v0.3.0 is out. Bots on v0.2.0 will see deprecation warnings automatically. Bots on v0.1.0 will get rejected with upgrade instructions.

### 5. Next cycle (1 month later)

```typescript
export const COMPAT: CompatMatrix = {
  currentVersion: '0.4.0',
  minVersion: '0.3.0',          // v0.2.0 is now gone
  deprecatedVersions: ['0.3.0'],
  upgradeMessage: '...',
};
```

### Example timeline

| Date | Current | Deprecated | Min | Rejected |
|------|---------|-----------|-----|----------|
| Mar 23 | 0.2.0 | 0.1.0 | 0.1.0 | < 0.1.0 |
| Apr 23 | 0.3.0 | 0.2.0 | 0.2.0 | < 0.2.0 (0.1.0 gone) |
| May 23 | 0.4.0 | 0.3.0 | 0.3.0 | < 0.3.0 (0.2.0 gone) |
| Jun 23 | 0.5.0 | 0.4.0 | 0.4.0 | < 0.4.0 (0.3.0 gone) |

## Semver Rules

Leyline uses standard semver:

| Change | Version bump | Compat impact |
|--------|-------------|--------------|
| Bug fix, no protocol change | Patch (0.2.0 → 0.2.1) | No compat change needed |
| New feature, backward compatible | Minor (0.2.0 → 0.3.0) | Deprecate old minor |
| Breaking protocol change | Minor (pre-1.0) or Major (post-1.0) | Bump minVersion |

Pre-1.0, any minor bump can be breaking. Post-1.0, only major bumps are breaking.
