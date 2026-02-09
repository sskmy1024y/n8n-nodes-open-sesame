import type {
	ITriggerFunctions,
	INodeType,
	INodeTypeDescription,
	ITriggerResponse,
} from 'n8n-workflow';
import type { device as AwsIotDevice } from 'aws-iot-device-sdk';
import {
	getCognitoCredentials,
	createMqttConnection,
	scheduleCredentialRefresh,
	getShadowTopic,
	parseMechStatus,
	getLockEvent,
} from './SesameHelper';
import type { LockEvent } from './SesameHelper';

export class SesameTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Sesame Trigger',
		name: 'sesameTrigger',
		icon: 'file:sesame.svg',
		group: ['trigger'],
		version: 1,
		subtitle: 'Sesame Lock Event',
		description:
			'Triggers the workflow when a SESAME smart lock is locked or unlocked',
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
		const deviceUuidsRaw = credentials.deviceUuids as string;
		const deviceUuids = deviceUuidsRaw
			.split(',')
			.map((u) => u.trim())
			.filter(Boolean);

		if (deviceUuids.length === 0) {
			throw new Error(
				'No device UUIDs configured. Please add at least one device UUID in the credentials.',
			);
		}

		const eventFilter = this.getNodeParameter('eventFilter') as string;
		const emitOnlyOnChange = this.getNodeParameter(
			'emitOnlyOnChange',
		) as boolean;

		let mqttDevice: AwsIotDevice | null = null;
		let refreshTimer: NodeJS.Timeout | null = null;
		const lastEventByDevice = new Map<string, LockEvent>();
		const decoder = new TextDecoder('utf8');

		const startConsumer = async () => {
			const cognitoCredentials = await getCognitoCredentials();
			mqttDevice = createMqttConnection(cognitoCredentials);

			// クレデンシャルの自動更新をスケジュール
			refreshTimer = scheduleCredentialRefresh(
				mqttDevice,
				cognitoCredentials,
				(err) => {
					this.logger.error(
						'Failed to refresh Cognito credentials',
						{ error: err.message },
					);
				},
			);

			mqttDevice.on('connect', () => {
				this.logger.info('Connected to Sesame AWS IoT');

				for (const uuid of deviceUuids) {
					const topic = getShadowTopic(uuid);
					mqttDevice!.subscribe(topic, { qos: 1 }, (err) => {
						if (err) {
							this.logger.error(
								`Failed to subscribe to device ${uuid}`,
								{ error: String(err) },
							);
						} else {
							this.logger.info(`Subscribed to device ${uuid}`);
						}
					});
				}
			});

			mqttDevice.on('message', (topic: string, payload: Uint8Array) => {
				try {
					const data = decoder.decode(payload);
					const json = JSON.parse(data);
					const mechstHex: unknown = json?.state?.reported?.mechst;

					if (typeof mechstHex !== 'string') return;

					// トピックからデバイスUUIDを抽出
					const topicParts = topic.split('/');
					const deviceUuid =
						topicParts[topicParts.indexOf('name') + 1] ?? 'unknown';

					const status = parseMechStatus(mechstHex);
					const event = getLockEvent(status);

					// "moving" はフィルタ対象外
					if (event === 'moving') return;

					// 変化がない場合はスキップ（オプション）
					if (emitOnlyOnChange) {
						const lastEvent = lastEventByDevice.get(deviceUuid);
						if (lastEvent === event) return;
					}
					lastEventByDevice.set(deviceUuid, event);

					// イベントフィルタチェック
					if (eventFilter !== 'all' && eventFilter !== event) return;

					this.emit([
						this.helpers.returnJsonArray([
							{
								event,
								deviceUuid,
								batteryVoltage: status.batteryVoltage,
								batteryPercentage: status.batteryPercentage,
								isBatteryCritical: status.isBatteryCritical,
								position: status.position,
								target: status.target,
								isInLockRange: status.isInLockRange,
								isInUnlockRange: status.isInUnlockRange,
								timestamp: new Date().toISOString(),
								raw: { mechst: mechstHex },
							},
						]),
					]);
				} catch (err) {
					this.logger.error('Failed to process MQTT message', {
						error: String(err),
					});
				}
			});

			mqttDevice.on('error', (error: string | Error) => {
				const message =
					typeof error === 'string' ? error : error.message;
				this.logger.error('Sesame MQTT error', { error: message });
			});

			mqttDevice.on('reconnect', () => {
				this.logger.info('Reconnecting to Sesame AWS IoT...');
			});

			mqttDevice.on('close', () => {
				this.logger.info('Sesame MQTT connection closed');
			});
		};

		const closeFunction = async () => {
			if (refreshTimer) {
				clearTimeout(refreshTimer);
				refreshTimer = null;
			}
			if (mqttDevice) {
				return new Promise<void>((resolve) => {
					mqttDevice!.end(false, () => {
						this.logger.info('Sesame MQTT client disconnected');
						mqttDevice = null;
						resolve();
					});
				});
			}
		};

		const manualTriggerFunction = async () => {
			await startConsumer();
		};

		if (this.getMode() !== 'manual') {
			await startConsumer();
			return { closeFunction };
		}
		return { closeFunction, manualTriggerFunction };
	}
}
