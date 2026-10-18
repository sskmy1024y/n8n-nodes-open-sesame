/**
 * SESAME realtime state push helpers.
 *
 * Background: until 2026-09 this node subscribed to the AWS IoT device shadow with
 * *unauthenticated* Cognito credentials (the route used by homebridge-open-sesame and
 * pysesame3). CANDY HOUSE revoked IoT access for the published identity pool, so both the
 * old and the current IoT endpoints now answer 403 for unauthenticated *and* authenticated
 * identities. The supported replacement is the Biz3 WebSocket that the official web app
 * uses: state changes arrive as `biz3TriggerLocker:pubDeviceStateChange` pushes.
 *
 * The Cognito login (passwordless, email code) and the WebSocket transport are delegated to
 * `@sesame-kit/core`, which tracks the official app's auth flow including token refresh and
 * re-subscription after a reconnect.
 */

export type LockEvent = 'locked' | 'unlocked';

/** Shape of the tokens issued by `sesame login` / `sesame verify`. */
export interface StoredTokens {
	idToken?: string | null;
	accessToken?: string | null;
	refreshToken?: string | null;
	clientId?: string | null;
	username?: string | null;
	deviceKey?: string | null;
	deviceGroupKey?: string | null;
	devicePassword?: string | null;
	lastRefresh?: string | null;
	[key: string]: unknown;
}

/**
 * In-memory TokenStore for @sesame-kit/core.
 *
 * n8n credentials are the source of truth, so refreshed tokens are kept in memory only.
 * Cognito does not rotate refresh tokens, so the stored refreshToken stays valid across
 * restarts; `onPersist` is offered for callers that want to observe updates (logging).
 */
export function createMemoryTokenStore(
	initial: StoredTokens,
	onPersist?: (tokens: StoredTokens) => void,
) {
	let tokens: StoredTokens = { ...initial };
	let pending: unknown = null;

	return {
		load: () => tokens,
		save: (patch: StoredTokens) => {
			// Mirror FileTokenStore: merge, treating explicit null as "discard this key".
			tokens = { ...tokens, ...patch };
			onPersist?.(tokens);
		},
		clear: () => {
			tokens = {};
			onPersist?.(tokens);
		},
		loadPending: () => pending as never,
		savePending: (s: unknown) => {
			pending = s;
		},
		clearPending: () => {
			pending = null;
		},
	};
}

export function parseTokensJson(raw: string): StoredTokens {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			'Tokens JSON is not valid JSON. Paste the contents of ~/.config/sesame-kit/tokens.json.',
		);
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new Error('Tokens JSON must be a JSON object.');
	}
	const tokens = parsed as StoredTokens;
	if (!tokens.refreshToken) {
		throw new Error('Tokens JSON has no refreshToken. Re-run `sesame login` / `sesame verify`.');
	}
	if (tokens.deviceKey && !(tokens.deviceGroupKey && tokens.devicePassword)) {
		throw new Error(
			'Tokens JSON has a deviceKey but no deviceGroupKey/devicePassword. Re-run the login so ConfirmDevice stores all device credentials.',
		);
	}
	return tokens;
}

/** Normalises a UUID for comparison (the cloud mixes upper/lower case). */
export function normalizeUuid(uuid: string): string {
	return uuid.trim().toUpperCase();
}

export interface StateInfo {
	CHSesame2Status?: string;
	batteryPercentage?: number;
	batteryVoltage?: number;
	position?: number;
	wm2State?: boolean;
	wm2UUID?: string;
	[key: string]: unknown;
}

/**
 * Maps a push payload to a lock event.
 *
 * Returns null for the frequent `{wm2State: true}` keepalive-ish pushes that carry no lock
 * status, and for intermediate states (`moved`, Open Sensor's `Open`/`Closed`, ...).
 */
export function getLockEvent(stateInfo: StateInfo | undefined): LockEvent | null {
	const status = stateInfo?.CHSesame2Status;
	if (status === 'locked') return 'locked';
	if (status === 'unlocked') return 'unlocked';
	return null;
}

/** Battery warning threshold, matching the official app's low-battery badge. */
export const BATTERY_CRITICAL_PERCENTAGE = 20;

export function isBatteryCritical(batteryPercentage: number | undefined): boolean {
	return typeof batteryPercentage === 'number'
		? batteryPercentage <= BATTERY_CRITICAL_PERCENTAGE
		: false;
}
