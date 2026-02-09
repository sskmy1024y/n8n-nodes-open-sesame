/**
 * AWS IoT MQTT サブスクライブのテストスクリプト
 *
 * 使い方:
 *   npx tsx test/subscribe.ts <DEVICE_UUID>
 *
 * Cognito認証 → MQTT接続 → トピックサブスクライブ → メッセージ待ち受け
 * を順番に確認する。Ctrl+C で終了。
 */

import {
	getCognitoCredentials,
	createMqttConnection,
	getShadowTopic,
	parseMechStatus,
	getLockEvent,
} from '../nodes/SesameTrigger/SesameHelper';

const deviceUuid = process.argv[2];
if (!deviceUuid) {
	console.error('Usage: npx ts-node test/subscribe.ts <DEVICE_UUID>');
	process.exit(1);
}

async function main() {
	// ── Step 1: Cognito 認証 ──
	console.log('[1/3] Cognito クレデンシャルを取得中...');
	const credentials = await getCognitoCredentials();
	console.log('  ✓ AccessKeyId:', credentials.accessKeyId.slice(0, 8) + '...');
	console.log('  ✓ Expiration:', credentials.expiration.toISOString());

	// ── Step 2: MQTT 接続 ──
	console.log('\n[2/3] AWS IoT MQTT 接続中...');
	const device = createMqttConnection(credentials);

	const topic = getShadowTopic(deviceUuid);
	console.log('  Topic:', topic);

	device.on('connect', () => {
		console.log('  ✓ MQTT 接続成功\n');

		// ── Step 3: トピックサブスクライブ ──
		console.log('[3/3] トピックをサブスクライブ中...');
		device.subscribe(topic, { qos: 1 }, (err) => {
			if (err) {
				console.error('  ✗ サブスクライブ失敗:', err);
				process.exit(1);
			}
			console.log('  ✓ サブスクライブ成功');
			console.log('\n━━━ メッセージ待ち受け中 (Ctrl+C で終了) ━━━\n');
		});
	});

	const decoder = new TextDecoder('utf8');

	device.on('message', (receivedTopic: string, payload: Uint8Array) => {
		const timestamp = new Date().toISOString();
		console.log(`[${timestamp}] メッセージ受信`);
		console.log('  Topic:', receivedTopic);

		try {
			const data = JSON.parse(decoder.decode(payload));
			const mechstHex: unknown = data?.state?.reported?.mechst;

			if (typeof mechstHex === 'string') {
				const status = parseMechStatus(mechstHex);
				const event = getLockEvent(status);

				console.log('  mechst:', mechstHex);
				console.log('  Event:', event);
				console.log('  Status:', JSON.stringify(status, null, 4));
			} else {
				console.log('  Payload:', JSON.stringify(data, null, 4));
			}
		} catch {
			console.log('  Raw:', decoder.decode(payload));
		}
		console.log();
	});

	device.on('error', (error: string | Error) => {
		const message = typeof error === 'string' ? error : error.message;
		console.error('MQTT エラー:', message);
	});

	device.on('reconnect', () => {
		console.log('MQTT 再接続中...');
	});

	device.on('close', () => {
		console.log('MQTT 接続が閉じました');
	});

	// Ctrl+C でクリーンアップ
	process.on('SIGINT', () => {
		console.log('\n切断中...');
		device.end(false, () => {
			console.log('完了');
			process.exit(0);
		});
	});
}

main().catch((err) => {
	console.error('エラー:', err);
	process.exit(1);
});
