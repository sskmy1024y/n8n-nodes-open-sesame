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
export type SensorEvent = 'open' | 'closed';
export type EventCategory = 'lock' | 'sensor' | 'unknown';

/** Shape of the tokens issued by the bundled `login` / `verify` commands. */
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
			'Tokens JSON is not valid JSON. Paste the JSON printed by `npx n8n-nodes-open-sesame verify <code>`.',
		);
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new Error('Tokens JSON must be a JSON object.');
	}
	const tokens = parsed as StoredTokens;
	if (!tokens.refreshToken) {
		throw new Error(
			'Tokens JSON has no refreshToken. Re-run `npx n8n-nodes-open-sesame login` / `verify`.',
		);
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

/** Lock states reported by SESAME locks (`sesame_5`, `sesame_6`, ...). */
export const LOCK_EVENTS: readonly LockEvent[] = ['locked', 'unlocked'];

/** Door states reported by an Open Sensor. Sent capitalised (`Open` / `Closed`) — see below. */
export const SENSOR_EVENTS: readonly SensorEvent[] = ['open', 'closed'];

const CATEGORY_BY_EVENT: ReadonlyMap<string, EventCategory> = new Map([
	...LOCK_EVENTS.map((e) => [e, 'lock' as EventCategory] as const),
	...SENSOR_EVENTS.map((e) => [e, 'sensor' as EventCategory] as const),
]);

/**
 * Statuses that are genuine device states but not worth a workflow run.
 *
 * `moved` is the OS2 in-between state while the thumbturn travels; OS3 locks do not report it
 * (see MECH_STATE in @sesame-kit/core, which is a two-value enum there).
 */
const IGNORED_STATUSES: ReadonlySet<string> = new Set(['moved']);

export interface DerivedEvent {
	/** Lower-cased `CHSesame2Status`. */
	event: string;
	category: EventCategory;
}

/**
 * Maps a push payload to an event.
 *
 * Returns null for the frequent `{wm2State: true}` keepalive-ish pushes that carry no status at
 * all, and for intermediate states listed in IGNORED_STATUSES.
 *
 * `CHSesame2Status` is a free-form string in the cloud API (and in @sesame-kit/core's StateInfo),
 * so anything outside the known vocabulary is returned with category `unknown` rather than being
 * guessed at or silently dropped — the caller decides whether to forward it.
 *
 * The case folding is load-bearing, not defensive: an `open_sensor_1` reports `Closed`
 * (capitalised) while locks report `locked` / `unlocked` in lower case. Verified against a live
 * device via `getDeviceStatus`.
 */
export function deriveEvent(stateInfo: StateInfo | undefined): DerivedEvent | null {
	const raw = stateInfo?.CHSesame2Status;
	if (typeof raw !== 'string') return null;

	const event = raw.trim().toLowerCase();
	if (!event || IGNORED_STATUSES.has(event)) return null;

	return { event, category: CATEGORY_BY_EVENT.get(event) ?? 'unknown' };
}

/**
 * Normalises the `eventFilter` node parameter into a set of wanted events.
 *
 * Returns null for "no filtering", which is what the legacy `all` meant. v0.2.x stored a single
 * string (`all` / `locked` / `unlocked`); v0.3.0 stores a list. Both shapes are accepted so
 * existing workflows keep their behaviour without being re-saved.
 *
 * An empty list is taken at face value — the user deselected everything, so nothing matches. The
 * caller is expected to warn about that, since a trigger that silently never fires is the exact
 * failure mode this node already had once.
 */
export function parseEventFilter(raw: unknown): ReadonlySet<string> | null {
	if (Array.isArray(raw)) {
		return new Set(raw.map((v) => String(v).toLowerCase()));
	}
	if (typeof raw === 'string' && raw !== '') {
		return raw === 'all' ? null : new Set([raw.toLowerCase()]);
	}
	return new Set<string>(LOCK_EVENTS);
}

/** Battery warning threshold, matching the official app's low-battery badge. */
export const BATTERY_CRITICAL_PERCENTAGE = 20;

export function isBatteryCritical(batteryPercentage: number | undefined): boolean {
	return typeof batteryPercentage === 'number'
		? batteryPercentage <= BATTERY_CRITICAL_PERCENTAGE
		: false;
}

export interface RetryLadderOptions {
	/** The work to attempt. Resolves on success, throws to trigger a retry. */
	attempt: () => Promise<void>;
	/** Total attempts, including the first. Must be >= 1. */
	attempts: number;
	/** Delay before the retry that follows a failed attempt N (1-based). */
	delayMs: (attemptNumber: number) => number;
	sleep: (ms: number) => Promise<void>;
	onRetry: (attemptNumber: number, error: Error) => void;
	/** Called once, after the final attempt fails. */
	onGiveUp: (error: Error) => void;
}

/**
 * Runs `attempt` until it succeeds or the budget is spent, then escalates.
 *
 * Extracted from the trigger so the recovery path can actually be tested: it is the branch
 * that only runs when something is already broken, which is exactly the code most likely to
 * be wrong and least likely to be exercised in production.
 *
 * Returns true if an attempt succeeded. No delay is slept after the final failure — the
 * caller escalates immediately rather than pausing on the way out.
 */
export async function runRetryLadder(opts: RetryLadderOptions): Promise<boolean> {
	const { attempt, attempts, delayMs, sleep, onRetry, onGiveUp } = opts;
	for (let n = 1; n <= attempts; n += 1) {
		try {
			await attempt();
			return true;
		} catch (error) {
			if (n < attempts) {
				onRetry(n, error as Error);
				await sleep(delayMs(n));
			} else {
				onGiveUp(error as Error);
			}
		}
	}
	return false;
}
