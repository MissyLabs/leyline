# Discord Integration Testing

End-to-end testing of the Leyline network using Discord bots as test agents.

## Setup

### Credentials

Bot credentials are stored in `.env.discord-test` at the repo root (gitignored, never committed). Load with:

```bash
source .env.discord-test
```

Or in Node.js:

```typescript
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(
  readFileSync('.env.discord-test', 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => l.split('=', 2)),
);
```

### Test Bots on Discord

| Bot | Discord ID | Role | Speed |
|-----|-----------|------|-------|
| **boostie** | `DISCORD_BOOSTIE_ID` | Fast responder, primary test agent | Fast (~2s) |
| **Botrick** | `DISCORD_BOTRICK_ID` | Secondary test agent | Slow (~30-60s) |

Both bots are in channel `DISCORD_CHANNEL_ID`. They require `@mention` to respond.

### ClaudeBot

Our test harness bot. App ID and token in `.env.discord-test`. Connects as `ClaudeBot#1566`.

## Test Scripts

All test scripts live in `/tmp/leyline-discord-test/` (not in the repo). They use `discord.js` installed locally in that directory.

### Prerequisites

```bash
mkdir -p /tmp/leyline-discord-test
cd /tmp/leyline-discord-test
npm init -y && npm install discord.js
```

### Basic Connectivity Test

Verify both bots are online and connected to Leyline:

```javascript
// /tmp/leyline-discord-test/hello.mjs
import { Client, GatewayIntentBits } from 'discord.js';

// Load creds from .env.discord-test
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BOOSTIE_ID = process.env.DISCORD_BOOSTIE_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', async () => {
  console.log(`Connected as ${client.user.tag}`);
  const channel = await client.channels.fetch(CHANNEL_ID);

  // Tag ONE bot at a time (both in one message doesn't work reliably)
  await channel.send(`<@${BOOSTIE_ID}> Are you connected to Leyline? What's your peer count and version?`);

  const collector = channel.createMessageCollector({ time: 60000 });
  collector.on('collect', (msg) => {
    if (msg.author.id === BOOSTIE_ID) {
      console.log(`[${msg.author.username}]: ${msg.content.slice(0, 500)}`);
    }
  });
  collector.on('end', () => { client.destroy(); process.exit(0); });
});

client.login(TOKEN);
```

Run:
```bash
source /path/to/leyline/.env.discord-test
cd /tmp/leyline-discord-test && node hello.mjs
```

## Testing Rules

1. **Tag one bot per message.** Both bots in one `@mention` doesn't work reliably — they may not both trigger.
2. **Botrick is slow.** Allow 60-120 seconds for responses. Set collector timeout accordingly.
3. **Kill previous processes** before running a new test: `pkill -9 -f "leyline-discord-test"` — the Discord gateway only allows one connection per token.
4. **Don't commit credentials.** The `.env.discord-test` file is gitignored. The test scripts in `/tmp/` are ephemeral. This doc references env var names, not values.
5. **Rotate the token** if it's ever exposed in logs, conversations, or commits.

## Test Scenarios

### 1. Connectivity Check
- Tag each bot individually
- Verify: peer count > 0, version = v0.2.0

### 2. Broadcast Test
- Ask boostie to broadcast a message on `broadcast:test`
- Ask Botrick to report if it received the message
- Verify: message delivery via GossipSub or inbox polling

### 3. Service Discovery Test
- Ask boostie to register a service with tags `service:test`
- Ask Botrick to run `discoverServices({ tags: ['service:test'] })`
- Verify: Botrick finds boostie's service

### 4. Ledger Submission Test
- Ask boostie to submit a record to the shared ledger
- Check seed logs for `[Seed] Ledger: confirmed entry`
- Ask Botrick to query ledger entry count
- Verify: entry committed with consensus confirmation

### 5. Store-and-Forward Test
- Ask boostie to broadcast while Botrick is disconnected
- Tell Botrick to reconnect
- Verify: Botrick receives the buffered message via inbox fetch

### 6. Direct Message Test
- Ask boostie to send an encrypted DM to Botrick
- Verify: Botrick receives and decrypts the message
