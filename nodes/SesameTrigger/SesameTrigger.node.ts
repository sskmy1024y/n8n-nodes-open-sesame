import type {
	ITriggerFunctions,
	INodeType,
	INodeTypeDescription,
	ITriggerResponse,
} from 'n8n-workflow';
import {
	createMemoryTokenStore,
	deriveEvent,
	isBatteryCritical,
	normalizeUuid,
	parseEventFilter,
	parseTokensJson,
	runRetryLadder,
} from './SesameHelper';
import type { StateInfo } from './SesameHelper';

/** How many times a failed re-arm is retried in place before the trigger is restarted. */
const REARM_ATTEMPTS = 3;
/** Base delay between re-arm attempts; multiplied by the attempt number. */
const REARM_RETRY_DELAY_MS = 2_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface StateChangePush {
	data?: {
		deviceUUID?: string;
		stateInfo?: StateInfo;
	};
}

export class SesameTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Sesame Trigger',
		name: 'sesameTrigger',
		icon: 'file:sesame.svg',
		group: ['trigger'],
		version: 1,
		subtitle: 'Sesame Device Event',
		description:
			'Triggers the workflow when a SESAME smart lock is locked or unlocked, or an Open Sensor reports the door opening or closing',
		defaults: {
			name: 'Sesame Trigger',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'sesameApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'eventFilter',
				type: 'multiOptions',
				options: [
					{ name: 'Locked', value: 'locked', description: 'A lock was locked' },
					{ name: 'Unlocked', value: 'unlocked', description: 'A lock was unlocked' },
					{ name: 'Opened', value: 'open', description: 'An Open Sensor reported the door open' },
					{
						name: 'Closed',
						value: 'closed',
						description: 'An Open Sensor reported the door closed',
					},
				],
				default: ['locked', 'unlocked'],
				description:
					'Which device events should trigger the workflow. Open Sensor events only arrive for sensor UUIDs listed in the credential.',
			},
			{
				displayName: 'Emit Unknown Statuses',
				name: 'emitUnknownStatuses',
				type: 'boolean',
				default: false,
				description:
					'Whether to also emit statuses outside the known vocabulary. The cloud reports CHSesame2Status as a free-form string, so a device model this node has not seen may use a value not in the Events list; such statuses are logged as a warning either way.',
			},
			{
				displayName: 'Emit Only On Change',
				name: 'emitOnlyOnChange',
				type: 'boolean',
				default: true,
				description:
					'Whether to only emit events when the lock status changes from the previous state',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = await this.getCredentials('sesameApi');

		const deviceUuids = (credentials.deviceUuids as string)
			.split(',')
			.map((u) => u.trim())
			.filter(Boolean);

		if (deviceUuids.length === 0) {
			throw new Error(
				'No device UUIDs configured. Please add at least one device UUID in the credentials.',
			);
		}

		const tokens = parseTokensJson((credentials.tokensJson as string) ?? '');
		const companyID = ((credentials.companyID as string) || 'ch_CandyhouseMobile').trim();

		const eventFilter = parseEventFilter(this.getNodeParameter('eventFilter', ['locked', 'unlocked']));
		const emitOnlyOnChange = this.getNodeParameter('emitOnlyOnChange') as boolean;
		const emitUnknownStatuses = this.getNodeParameter('emitUnknownStatuses', false) as boolean;

		if (eventFilter?.size === 0 && !emitUnknownStatuses) {
			this.logger.warn(
				'No events are selected, so this trigger will never fire. Pick at least one event.',
			);
		}

		const watched = new Set(deviceUuids.map(normalizeUuid));
		const lastEventByDevice = new Map<string, string>();
		const warnedStatuses = new Set<string>();

		// Released by closeFunction; keeps the scoped `SesameHub3.use` session open.
		let release: () => void = () => {};
		const sessionEnd = new Promise<void>((resolve) => {
			release = resolve;
		});

		const handlePush = (msg: StateChangePush) => {
			const deviceUuid = msg?.data?.deviceUUID;
			const stateInfo = msg?.data?.stateInfo;
			if (!deviceUuid || !stateInfo) return;

			const key = normalizeUuid(deviceUuid);
			if (!watched.has(key)) return;

			this.logger.debug(`Sesame push for ${deviceUuid}: ${JSON.stringify(stateInfo)}`);

			// Most pushes are `{wm2State: true}` heartbeats with no status at all.
			const derived = deriveEvent(stateInfo);
			if (derived === null) return;
			const { event, category } = derived;

			if (category === 'unknown') {
				if (!warnedStatuses.has(event)) {
					warnedStatuses.add(event);
					this.logger.warn(
						`Unrecognised CHSesame2Status "${event}" from ${deviceUuid}` +
							(emitUnknownStatuses ? '' : '; enable "Emit Unknown Statuses" to forward it'),
					);
				}
				// An unknown status cannot be named in the Events list, so that list cannot gate it.
				if (!emitUnknownStatuses) return;
			}

			if (emitOnlyOnChange && lastEventByDevice.get(key) === event) return;
			lastEventByDevice.set(key, event);

			if (category !== 'unknown' && eventFilter && !eventFilter.has(event)) return;

			this.emit([
				this.helpers.returnJsonArray([
					{
						event,
						eventCategory: category,
						deviceUuid,
						batteryPercentage: stateInfo.batteryPercentage,
						batteryVoltage: stateInfo.batteryVoltage,
						isBatteryCritical: isBatteryCritical(stateInfo.batteryPercentage),
						position: stateInfo.position,
						wm2State: stateInfo.wm2State,
						timestamp: new Date().toISOString(),
						raw: { stateInfo },
					},
				]),
			]);
		};

		// `@sesame-kit/core` is ESM-only. `new Function` keeps this a real dynamic import after
		// TypeScript emits CommonJS (a plain `await import()` would be downlevelled to `require`,
		// which cannot load an ESM package on the Node versions n8n ships with).
		const dynamicImport = new Function('specifier', 'return import(specifier)') as (
			specifier: string,
		) => Promise<{ SesameHub3: SesameHub3Like }>;
		const { SesameHub3 } = await dynamicImport('@sesame-kit/core/client');

		const tokenStore = createMemoryTokenStore(tokens);

		// `@sesame-kit/core` logs connect/close/reconnect/token-refresh to stderr when `debug` is
		// set. Those are the events that explain a subscription going quiet, and nothing else
		// surfaces them — n8n's own log level cannot reach inside the library. Off by default
		// because the transport also logs (redacted) frame payloads.
		const transportDebug = /^(1|true)$/i.test(process.env.N8N_SESAME_DEBUG ?? '');

		const session = SesameHub3.use(
			{ tokenStore, config: { companyID }, debug: transportDebug },
			async (hub: SesameHubLike) => {
				const models = new Map<string, string | undefined>();
				const loadDevices = async () => {
					models.clear();
					for (const device of await hub.listDevices()) {
						if (device?.deviceUUID) {
							models.set(normalizeUuid(device.deviceUUID), device.deviceModel);
						}
					}
				};

				try {
					await loadDevices();
				} catch (error) {
					this.logger.warn(
						`Could not list SESAME devices, subscribing without deviceModel: ${(error as Error).message}`,
					);
				}

				// What actually arms state pushes for a connection is the `getCompanyDevice` frame
				// that listDevices() sends — NOT `subscribeDevicesUpdate`, which this cloud answers
				// with `400 Invalid operation`. A reconnect therefore silently un-subscribes us:
				// the transport re-sends only the (rejected) subscribe frame, the socket looks
				// healthy, and no push ever arrives again. Observed in production on 2026-10-23:
				// pushes stopped dead at the first reconnect and never resumed.
				//
				// The official web app avoids this by re-fetching the device list on every new
				// connection (useManageDevice.js:352-358, onConnectionIdChange -> getCompanyDevices
				// -> subscribeDevices). Do the same. Registered before the per-device subscriptions
				// so this callback runs first, matching that order.
				// Recovery ladder for a failed re-arm. A reconnect often coincides with the network
				// still settling, so a first failure is usually transient and worth retrying in
				// place. Only once that is exhausted is the trigger genuinely unable to receive
				// events, and the honest response is to fail loudly: emitError makes n8n tear the
				// trigger down and re-activate it, which builds a whole new session — connection,
				// token and `getCompanyDevice` included. Staying quiet instead would recreate the
				// exact silent-death this node exists to avoid.
				let rearmInFlight = false;
				const rearm = async () => {
					// Reconnects can arrive back-to-back; one ladder at a time is enough.
					if (rearmInFlight) return;
					rearmInFlight = true;
					try {
						await runRetryLadder({
							attempts: REARM_ATTEMPTS,
							attempt: loadDevices,
							delayMs: (n) => REARM_RETRY_DELAY_MS * n,
							sleep: delay,
							onRetry: (n, error) =>
								this.logger.warn(
									`Re-arming the SESAME subscription failed (attempt ${n}/${REARM_ATTEMPTS}): ` +
										`${error.message}; retrying`,
								),
							onGiveUp: (error) => {
								this.logger.error(
									`Could not re-arm the SESAME subscription after ${REARM_ATTEMPTS} attempts; ` +
										'no events can arrive on this connection, so the trigger is being restarted',
									{ error: error.message },
								);
								this.emitError?.(error);
							},
						}).then((ok) => {
							if (ok) this.logger.info('SESAME subscription re-armed after reconnect');
						});
					} finally {
						rearmInFlight = false;
					}
				};

				hub.onReconnect(() => {
					this.logger.info('SESAME push connection re-established; re-arming subscription');
					void rearm();
				});

				const unsubscribes = deviceUuids.map((uuid) => {
					const deviceModel = models.get(normalizeUuid(uuid));
					if (models.size > 0 && !deviceModel) {
						this.logger.warn(
							`Device ${uuid} is not in this account's device list; it will never emit`,
						);
					}
					return hub.onLockStateChangeDevice(uuid, handlePush, { deviceModel });
				});
				this.logger.info(`Subscribed to SESAME state push for ${deviceUuids.length} device(s)`);
				await sessionEnd;
				for (const off of unsubscribes) {
					try {
						off();
					} catch {
						// ignore unsubscribe errors on shutdown
					}
				}
			},
		);

		session.catch((error: Error) => {
			this.logger.error('Sesame state-push session ended with an error', {
				error: error.message,
			});
			// Surface the failure in n8n instead of dying silently, which is how the previous
			// MQTT implementation hid its own breakage for weeks.
			this.emitError?.(error);
		});

		const closeFunction = async () => {
			release();
			try {
				await session;
			} catch {
				// already reported above
			}
			this.logger.info('Sesame state-push session closed');
		};

		const manualTriggerFunction = async () => {
			// Nothing extra to do: `trigger()` already opened the subscription.
		};

		if (this.getMode() !== 'manual') {
			return { closeFunction };
		}
		return { closeFunction, manualTriggerFunction };
	}
}

interface SesameHub3Like {
	use: (
		opts: Record<string, unknown>,
		fn: (hub: SesameHubLike) => Promise<void>,
	) => Promise<void>;
}

interface SesameDeviceLike {
	deviceUUID?: string;
	deviceModel?: string;
}

interface SesameHubLike {
	listDevices: () => Promise<SesameDeviceLike[]>;
	/** Registers a callback fired after the transport re-opens the WebSocket. */
	onReconnect: (fn: () => void) => () => void;
	onLockStateChangeDevice: (
		deviceUUID: string,
		fn: (msg: StateChangePush) => void,
		opts?: { deviceModel?: string },
	) => () => void;
}
