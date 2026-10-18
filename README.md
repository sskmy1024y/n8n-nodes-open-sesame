# n8n-nodes-open-sesame

A custom n8n trigger node that detects SESAME smart lock (CANDY HOUSE) lock/unlock events in real time.

It subscribes to the device-state push channel that the official SESAME web app uses, so lock
and unlock events arrive immediately — no polling, no Web API rate-limit concerns.

> **Breaking change in v0.2.0** — v0.1.x subscribed to the AWS IoT device shadow with
> *unauthenticated* Cognito credentials (the route popularised by `homebridge-open-sesame` and
> `pysesame3`). CANDY HOUSE revoked IoT access for the published identity pool around late
> September 2026: both the old (`a3i4hui4gxwoo8-ats`) and current (`d06107753ay3c67v7y9pa-ats`)
> endpoints now answer `403 Forbidden` for unauthenticated **and** authenticated identities, and
> the MQTT client simply reconnect-loops in silence. v0.2.0 replaces that route with the
> authenticated Biz3 WebSocket (`biz3TriggerLocker:pubDeviceStateChange`), which requires a
> logged-in SESAME account. See [Setup](#setup).

## Installation

1. Open your n8n instance
2. Go to **Settings** > **Community Nodes**
3. Enter `n8n-nodes-open-sesame` and click **Install**

Alternatively, install via CLI:

```bash
# In your n8n installation directory
npm install n8n-nodes-open-sesame
```

## Setup

### 1. Sign in to your SESAME account once

The push channel requires a logged-in account. The official login is passwordless: a code is
emailed to you. [`sesame-kit`](https://github.com/FukumotoIkuma/sesame-kit) implements the same
flow as the official app, so use it to mint the tokens:

```bash
npx sesame-kit login you@example.com   # a verification code is emailed to you
npx sesame-kit verify <code>           # writes ~/.config/sesame-kit/tokens.json
```

### 2. Find your device UUID

`npx sesame-kit devices` lists them, or open the device settings in the SESAME app.

Note that only locks report `CHSesame2Status: locked / unlocked`. A SESAME Bot or an Open Sensor
publishes different values (`Open` / `Closed`), which this trigger ignores.

### 3. Configure credentials in n8n

1. Go to **Credentials** > **New** > **Sesame API**
2. **Device UUID(s)** — the lock(s) to watch, comma-separated
3. **Tokens JSON** — paste the entire contents of `~/.config/sesame-kit/tokens.json`
4. **Company ID** — leave at `ch_CandyhouseMobile` for a personal account (verify with
   `npx sesame-kit whoami`)

> The tokens grant full control of your lock. Treat them like a password: they live in n8n's
> encrypted credential store and should not be committed or pasted anywhere else.

The node refreshes the Cognito id token on its own. Refresh tokens are not rotated, so the pasted
value keeps working across n8n restarts; you only repeat step 1 if you sign out elsewhere or the
refresh token is revoked.

### 4. Create a workflow

1. Add a **Sesame Trigger** node
2. Select your Sesame API credential
3. Choose an **Event Filter**:
   - `All Events` — both lock and unlock
   - `Locked Only` — lock events only
   - `Unlocked Only` — unlock events only
4. Enable **Emit Only On Change** to trigger only when the state changes
5. Connect downstream nodes (Slack, email, etc.)

## Output Data

```json
{
  "event": "unlocked",
  "deviceUuid": "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX",
  "batteryVoltage": 5.996,
  "batteryPercentage": 100,
  "isBatteryCritical": false,
  "position": 822,
  "wm2State": true,
  "timestamp": "2026-10-18T07:46:32.005Z",
  "raw": {
    "stateInfo": { "CHSesame2Status": "unlocked", "batteryPercentage": 100 }
  }
}
```

### Field Reference

| Field | Type | Description |
|---|---|---|
| `event` | `"locked"` \| `"unlocked"` | Lock state |
| `deviceUuid` | string | Device UUID |
| `batteryVoltage` | number | Battery voltage (V) |
| `batteryPercentage` | number | Battery level (%) |
| `isBatteryCritical` | boolean | True at 20% or below |
| `position` | number | Current thumb-turn position |
| `wm2State` | boolean | Wi-Fi Module / Hub connectivity |
| `timestamp` | string | Time the push was received (ISO 8601) |
| `raw.stateInfo` | object | Unmodified push payload |

`event` is derived from `stateInfo.CHSesame2Status`. Pushes without that field (frequent
`{"wm2State": true}` connectivity heartbeats) are ignored.

## Slack Notification Example

Connect Sesame Trigger to a Slack node and use expressions like:

```
🔐 Sesame Lock Event
Event: {{ $json.event }}
Device: {{ $json.deviceUuid }}
Battery: {{ $json.batteryPercentage }}%
Time: {{ $json.timestamp }}
```

## Testing

Verify the subscription without n8n:

```bash
npm install && npm run build
SESAME_UUID=<device uuid> node test/harness.js
```

The harness fakes n8n's trigger context, reads the tokens from
`~/.config/sesame-kit/tokens.json`, connects, and prints every emitted item. Lock or unlock the
device and the event appears. It exits after `WAIT_SEC` seconds (default 300).

## How It Works

- Reads the stored SESAME account tokens and refreshes the Cognito id token as needed
  (`REFRESH_TOKEN_AUTH`, including `DEVICE_KEY` for device-tracking pools)
- Connects to the Biz3 WebSocket used by the official web app and sends
  `biz3ManageDevice:subscribeDevicesUpdate` for each watched device
- Receives `biz3TriggerLocker:pubDeviceStateChange` pushes and maps
  `stateInfo.CHSesame2Status` to a lock event
- Re-sends the subscription frame after a reconnect (server-side subscriptions do not survive a
  dropped connection) and reports a dead session through n8n's error channel instead of looping
  silently

Auth, transport and reconnection are delegated to
[`@sesame-kit/core`](https://www.npmjs.com/package/@sesame-kit/core).

## License

MIT
