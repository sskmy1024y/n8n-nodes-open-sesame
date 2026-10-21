# n8n-nodes-open-sesame

A custom n8n trigger node that detects SESAME smart lock (CANDY HOUSE) events in real time:
lock/unlock from a lock, and door open/closed from an Open Sensor.

It subscribes to the device-state push channel that the official SESAME web app uses, so lock
and unlock events arrive immediately — no polling, no Web API rate-limit concerns.

> **New in v0.3.0** — Open Sensor support. The `Event Filter` dropdown became an **Events**
> multi-select (`Locked` / `Unlocked` / `Opened` / `Closed`, default `Locked` + `Unlocked`) and
> output gained `eventCategory`. Existing workflows keep working: the old single-value filter is
> still understood, and sensor events only arrive for sensor UUIDs you add to the credential.
> Minting tokens no longer needs the separate `sesame-kit` CLI — this package ships the login flow.

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
emailed to you. This package ships a small CLI that runs the same flow, so no extra tool is
needed — it is a thin wrapper over `@sesame-kit/core`, which the node itself runs on:

```bash
npx n8n-nodes-open-sesame login you@example.com   # a verification code is emailed to you
npx n8n-nodes-open-sesame verify <code>           # prints the Tokens JSON to paste into n8n
```

Tokens are also written to `~/.config/sesame-kit/tokens.json` (override with `--config-dir`), so
`npx n8n-nodes-open-sesame tokens` re-prints them later. `logout` revokes the refresh token.

### 2. Find your device UUID

```bash
npx n8n-nodes-open-sesame devices    # UUID, model and nickname per device
```

The SESAME app shows the same UUIDs under device settings.

Locks (`sesame_5`, `sesame_5_pro`, ...) and a SESAME Bot (`bot_2`) report
`CHSesame2Status: locked / unlocked`; an Open Sensor (`open_sensor_1`) reports `Open` / `Closed`,
capitalised. All of them are supported and matched case-insensitively — list whichever UUIDs you
want to watch. Other models (Touch, Face, ...) may publish values this node has not seen; see
[Unknown statuses](#unknown-statuses).

### 3. Configure credentials in n8n

1. Go to **Credentials** > **New** > **Sesame API**
2. **Device UUID(s)** — the lock(s) and/or Open Sensor(s) to watch, comma-separated
3. **Tokens JSON** — paste the JSON printed by `verify` (or re-print it with
   `npx n8n-nodes-open-sesame tokens`)
4. **Company ID** — leave at `ch_CandyhouseMobile` for a personal account

> The tokens grant full control of your lock. Treat them like a password: they live in n8n's
> encrypted credential store and should not be committed or pasted anywhere else.

The node refreshes the Cognito id token on its own. Refresh tokens are not rotated, so the pasted
value keeps working across n8n restarts; you only repeat step 1 if you sign out elsewhere or the
refresh token is revoked.

### 4. Create a workflow

1. Add a **Sesame Trigger** node
2. Select your Sesame API credential
3. Pick the **Events** to listen for — `Locked`, `Unlocked`, `Opened`, `Closed`
   (default: `Locked` + `Unlocked`)
4. Enable **Emit Only On Change** to trigger only when the state changes
5. Connect downstream nodes (Slack, email, etc.)

Open Sensor events only arrive for sensor UUIDs listed in the credential, so selecting `Opened` /
`Closed` without a sensor configured simply does nothing.

### Unknown statuses

`CHSesame2Status` is a free-form string in the cloud API, so a device model this node has not seen
may report something outside the four events above. Such a status is always logged as a warning
naming the exact value; turn on **Emit Unknown Statuses** to forward it to the workflow as well
(it arrives with `eventCategory: "unknown"` and bypasses the Events list). Connectivity heartbeats
(`{"wm2State": true}`) and the OS2 intermediate state `moved` are always dropped.

## Output Data

```json
{
  "event": "unlocked",
  "eventCategory": "lock",
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
| `event` | `"locked"` \| `"unlocked"` \| `"open"` \| `"closed"` \| string | Device state, lower-cased |
| `eventCategory` | `"lock"` \| `"sensor"` \| `"unknown"` | Which kind of device the event came from |
| `deviceUuid` | string | Device UUID |
| `batteryVoltage` | number | Battery voltage (V) |
| `batteryPercentage` | number | Battery level (%) |
| `isBatteryCritical` | boolean | True at 20% or below |
| `position` | number | Current thumb-turn position |
| `wm2State` | boolean | Wi-Fi Module / Hub connectivity |
| `timestamp` | string | Time the push was received (ISO 8601) |
| `raw.stateInfo` | object | Unmodified push payload |

`event` is `stateInfo.CHSesame2Status` lower-cased. Pushes without that field (frequent
`{"wm2State": true}` connectivity heartbeats) are ignored. `batteryVoltage`, `position` and
`wm2State` are whatever the device reported: an Open Sensor sends `batteryPercentage` but no
voltage, position or `wm2State`.

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
