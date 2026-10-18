import type {
	ITriggerFunctions,
	INodeType,
	INodeTypeDescription,
	ITriggerResponse,
} from 'n8n-workflow';
import {
	createMemoryTokenStore,
	getLockEvent,
	isBatteryCritical,
	normalizeUuid,
	parseTokensJson,
} from './SesameHelper';
import type { LockEvent, StateInfo } from './SesameHelper';

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
		subtitle: 'Sesame Lock Event',
		description: 'Triggers the workflow when a SESAME smart lock is locked or unlocked',
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
				displayName: 'Event Filter',
				name: 'eventFilter',
				type: 'options',
				options: [
					{ name: 'All Events', value: 'all' },
					{ name: 'Locked Only', value: 'locked' },
					{ name: 'Unlocked Only', value: 'unlocked' },
				],
				default: 'all',
				description: 'Which lock events should trigger the workflow',
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

		const eventFilter = this.getNodeParameter('eventFilter') as 'all' | LockEvent;
		const emitOnlyOnChange = this.getNodeParameter('emitOnlyOnChange') as boolean;

		const watched = new Set(deviceUuids.map(normalizeUuid));
		const lastEventByDevice = new Map<string, LockEvent>();

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

			// Most pushes are `{wm2State: true}` heartbeats with no lock status.
			const event = getLockEvent(stateInfo);
			if (event === null) return;

			if (emitOnlyOnChange && lastEventByDevice.get(key) === event) return;
			lastEventByDevice.set(key, event);

			if (eventFilter !== 'all' && eventFilter !== event) return;

			this.emit([
				this.helpers.returnJsonArray([
					{
						event,
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

		const session = SesameHub3.use(
			{ tokenStore, config: { companyID } },
			async (hub: SesameHubLike) => {
				// The server only pushes for devices named in a `subscribeDevicesUpdate` frame, and
				// it expects the frame to carry `deviceModel` as the official web app sends it — a
				// UUID-only item is accepted but produces no pushes. Look the models up once.
				const models = new Map<string, string | undefined>();
				try {
					for (const device of await hub.listDevices()) {
						if (device?.deviceUUID) {
							models.set(normalizeUuid(device.deviceUUID), device.deviceModel);
						}
					}
				} catch (error) {
					this.logger.warn(
						`Could not list SESAME devices, subscribing without deviceModel: ${(error as Error).message}`,
					);
				}

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
	onLockStateChangeDevice: (
		deviceUUID: string,
		fn: (msg: StateChangePush) => void,
		opts?: { deviceModel?: string },
	) => () => void;
}
