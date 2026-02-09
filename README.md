# n8n-nodes-open-sesame

SESAME スマートロック (CANDY HOUSE) の鍵開閉イベントをリアルタイムに検知し、n8n ワークフローをトリガーするカスタムノードです。

AWS IoT MQTT over WebSocket を使い、Sesame デバイスのシャドウ更新をサブスクライブすることで、ロック/アンロックイベントを即座に検知します。

## インストール

### n8n Community Node として

```bash
# n8n のカスタムノードディレクトリにインストール
cd ~/.n8n/custom
npm install /path/to/n8n-open-sesame
```

または、n8n の GUI から Community Nodes > Install で `n8n-nodes-open-sesame` を検索してインストールできます。

### 開発用

```bash
git clone <this-repo>
cd n8n-open-sesame
npm install
npm run build
npm link

# n8n のカスタムノードディレクトリでリンク
cd ~/.n8n/custom
npm link n8n-nodes-open-sesame
```

## セットアップ

### 1. Sesame デバイス UUID の取得

Sesame アプリでデバイスの設定画面を開き、UUID を確認してください。

### 2. n8n でクレデンシャルを設定

1. n8n を起動
2. **Credentials** > **New** > **Sesame API** を選択
3. **Device UUID(s)** にデバイスの UUID を入力（複数の場合はカンマ区切り）

### 3. ワークフローの作成

1. **Sesame Trigger** ノードを追加
2. 作成した Sesame API クレデンシャルを選択
3. **Event Filter** でトリガーするイベントを選択:
   - `All Events` - ロック・アンロック両方
   - `Locked Only` - ロック時のみ
   - `Unlocked Only` - アンロック時のみ
4. **Emit Only On Change** を有効にすると、状態が変化した時のみトリガーされます
5. 後続ノード（Slack、メール等）を接続

## 出力データ

トリガー時に以下のデータが出力されます:

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

### フィールド説明

| フィールド | 型 | 説明 |
|---|---|---|
| `event` | `"locked"` \| `"unlocked"` | ロック状態 |
| `deviceUuid` | string | デバイス UUID |
| `batteryVoltage` | number | バッテリー電圧 (V) |
| `batteryPercentage` | number | バッテリー残量 (%) |
| `isBatteryCritical` | boolean | バッテリー低下警告 |
| `position` | number | 現在のロック位置 |
| `target` | number | 目標位置 |
| `timestamp` | string | イベント発生時刻 (ISO 8601) |

## Slack 通知の例

Sesame Trigger → Slack ノードを接続し、メッセージに以下のような Expression を設定:

```
🔐 Sesame Lock Event
Event: {{ $json.event }}
Device: {{ $json.deviceUuid }}
Battery: {{ $json.batteryPercentage }}%
Time: {{ $json.timestamp }}
```

## 技術的な仕組み

- AWS Cognito Identity Pool で一時的なクレデンシャルを取得（認証不要のパブリックアクセス）
- AWS IoT MQTT over WebSocket でデバイスシャドウの更新をサブスクライブ
- クレデンシャルは有効期限前に自動更新
- `mechst` ペイロードを解析してロック状態・バッテリー情報を取得

## ライセンス

MIT
