# n8n-nodes-open-sesame

A custom n8n trigger node that detects SESAME smart lock (CANDY HOUSE) lock/unlock events in real time.

It subscribes to Sesame device shadow updates via AWS IoT MQTT over WebSocket, enabling instant detection of lock/unlock events.

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

### 1. Get Your Sesame Device UUID

Open the device settings in the Sesame app and find your UUID.

### 2. Configure Credentials in n8n

1. Start n8n
2. Go to **Credentials** > **New** > **Sesame API**
3. Enter your device UUID(s) in **Device UUID(s)** (comma-separated for multiple devices)

### 3. Create a Workflow

1. Add a **Sesame Trigger** node
2. Select your Sesame API credential
3. Choose an **Event Filter**:
   - `All Events` — both lock and unlock
   - `Locked Only` — lock events only
   - `Unlocked Only` — unlock events only
4. Enable **Emit Only On Change** to trigger only when the state changes
5. Connect downstream nodes (Slack, email, etc.)

## Output Data

The trigger emits the following data:

```json
{
  "event": "locked",
  "deviceUuid": "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX",
  "batteryVoltage": 5.92,
  "batteryPercentage": 95,
  "isBatteryCritical": false,
  "position": 123,
  "target": 0,
  "isInLockRange": true,
  "isInUnlockRange": false,
  "timestamp": "2026-02-09T12:00:00.000Z",
  "raw": {
    "mechst": "e803..."
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
| `isBatteryCritical` | boolean | Low battery warning |
| `position` | number | Current lock position |
| `target` | number | Target position |
| `timestamp` | string | Event timestamp (ISO 8601) |

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

### MQTT Subscribe Test

You can verify the AWS IoT connection and topic subscription without n8n:

```bash
npm install
npx tsx test/subscribe.ts <DEVICE_UUID>
```

The test runs through the following steps:

1. **Cognito Authentication** — obtain temporary credentials
2. **MQTT Connection** — WebSocket connection to the AWS IoT endpoint
3. **Topic Subscribe** — subscribe to the device shadow topic

After a successful subscription, it enters a message-waiting state. Operating the lock via the Sesame app or physically will display lock state and battery information in real time. Press `Ctrl+C` to exit.

## How It Works

- Obtains temporary credentials from AWS Cognito Identity Pool (unauthenticated public access)
- Subscribes to device shadow updates via AWS IoT MQTT over WebSocket
- Automatically refreshes credentials before expiration
- Parses the `mechst` payload to extract lock state and battery information

## License

MIT
