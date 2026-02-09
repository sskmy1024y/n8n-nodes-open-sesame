import {
	CognitoIdentityClient,
	GetIdCommand,
	GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import * as awsIot from 'aws-iot-device-sdk';
import { v4 as uuidv4 } from 'uuid';

const IOT_ENDPOINT = 'a3i4hui4gxwoo8-ats.iot.ap-northeast-1.amazonaws.com';
const COGNITO_IDENTITY_POOL_ID =
	'ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae';
const COGNITO_REGION = 'ap-northeast-1';

/** AWS Cognito 一時クレデンシャルの有効期限マージン (ms) */
const CREDENTIAL_REFRESH_MARGIN_MS = 2.5 * 60 * 1000;

export interface CognitoCredentials {
	accessKeyId: string;
	secretKey: string;
	sessionToken: string;
	expiration: Date;
}

export interface MechStatus {
	batteryVoltage: number;
	batteryPercentage: number;
	isBatteryCritical: boolean;
	isInLockRange: boolean;
	isInUnlockRange: boolean;
	position: number;
	target: number;
}

export type LockEvent = 'locked' | 'unlocked' | 'moving';

/**
 * AWS Cognito Identity Pool から一時的なクレデンシャルを取得する
 */
export async function getCognitoCredentials(): Promise<CognitoCredentials> {
	const client = new CognitoIdentityClient({ region: COGNITO_REGION });

	const idResponse = await client.send(
		new GetIdCommand({ IdentityPoolId: COGNITO_IDENTITY_POOL_ID }),
	);

	const credResponse = await client.send(
		new GetCredentialsForIdentityCommand({
			IdentityId: idResponse.IdentityId,
		}),
	);

	const creds = credResponse.Credentials;
	if (!creds?.AccessKeyId || !creds.SecretKey || !creds.SessionToken) {
		throw new Error('Failed to obtain Cognito credentials');
	}

	return {
		accessKeyId: creds.AccessKeyId,
		secretKey: creds.SecretKey,
		sessionToken: creds.SessionToken,
		expiration: creds.Expiration ?? new Date(Date.now() + 3600_000),
	};
}

/**
 * クレデンシャル自動更新のタイマーを設定する
 */
export function scheduleCredentialRefresh(
	device: awsIot.device,
	credentials: CognitoCredentials,
	onError: (err: Error) => void,
): NodeJS.Timeout {
	const msUntilExpiry =
		credentials.expiration.getTime() - Date.now() - CREDENTIAL_REFRESH_MARGIN_MS;
	const refreshIn = Math.max(msUntilExpiry, 30_000);

	return setTimeout(async () => {
		try {
			const newCreds = await getCognitoCredentials();
			device.updateWebSocketCredentials(
				newCreds.accessKeyId,
				newCreds.secretKey,
				newCreds.sessionToken,
				newCreds.expiration,
			);
			// 次回の更新をスケジュール
			scheduleCredentialRefresh(device, newCreds, onError);
		} catch (err) {
			onError(err instanceof Error ? err : new Error(String(err)));
		}
	}, refreshIn);
}

/**
 * AWS IoT MQTT 接続を作成する
 */
export function createMqttConnection(
	credentials: CognitoCredentials,
): awsIot.device {
	return new awsIot.device({
		host: IOT_ENDPOINT,
		protocol: 'wss',
		clean: false,
		keepalive: 60,
		clientId: uuidv4(),
		accessKeyId: credentials.accessKeyId,
		secretKey: credentials.secretKey,
		sessionToken: credentials.sessionToken,
	});
}

/**
 * デバイスUUID からサブスクライブ対象のMQTTトピックを生成する
 */
export function getShadowTopic(deviceUuid: string): string {
	return `$aws/things/sesame2/shadow/name/${deviceUuid}/update/accepted`;
}

/**
 * mechst hex文字列をパースして機械的ステータスに変換する
 */
export function parseMechStatus(mechstHex: string): MechStatus {
	const bytes = Buffer.from(mechstHex, 'hex');

	const voltageRaw = bytes[0] | (bytes[1] << 8);
	const batteryVoltage = (voltageRaw * 7.2) / 1023;

	const target = bytes[2] | (bytes[3] << 8);
	const position = bytes[4] | (bytes[5] << 8);

	const flags = bytes[7];
	const isInLockRange = (flags & 0x02) !== 0;
	const isInUnlockRange = (flags & 0x04) !== 0;
	const isBatteryCritical = (flags & 0x20) !== 0;

	return {
		batteryVoltage,
		batteryPercentage: voltageToBatteryPercentage(batteryVoltage),
		isBatteryCritical,
		isInLockRange,
		isInUnlockRange,
		position,
		target,
	};
}

/**
 * MechStatusからロックイベント種別を判定する
 */
export function getLockEvent(status: MechStatus): LockEvent {
	if (status.isInLockRange && !status.isInUnlockRange) {
		return 'locked';
	}
	if (!status.isInLockRange && status.isInUnlockRange) {
		return 'unlocked';
	}
	return 'moving';
}

/**
 * バッテリー電圧からパーセンテージを算出する (Sesame 3/4/5 向け)
 * 電圧閾値テーブルを使い線形補間する
 */
function voltageToBatteryPercentage(voltage: number): number {
	const table: [number, number][] = [
		[6.0, 100],
		[5.8, 90],
		[5.7, 80],
		[5.6, 70],
		[5.4, 60],
		[5.2, 50],
		[5.1, 40],
		[5.0, 32],
		[4.8, 21],
		[4.6, 10],
		[4.4, 0],
	];

	if (voltage >= table[0][0]) return 100;
	if (voltage <= table[table.length - 1][0]) return 0;

	for (let i = 0; i < table.length - 1; i++) {
		const [v1, p1] = table[i];
		const [v2, p2] = table[i + 1];
		if (voltage >= v2) {
			const ratio = (voltage - v2) / (v1 - v2);
			return Math.round(p2 + ratio * (p1 - p2));
		}
	}

	return 0;
}
