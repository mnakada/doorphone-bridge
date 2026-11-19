# doorphone-hap

Panasonic VL-X70AH（ドアホン親機）を Apple Home の IP カメラとして見るためのブリッジ。
純正 iOS/Android アプリ「ドアホンコネクト S」を静的解析し、クラウド経由の映像配信フローを
再実装した Node.js 実装。

- Debian arm64 向け `.deb` パッケージを提供（Raspberry Pi 4/5 の 64bit OS で動作確認済み）。
- 初回ペアリング（QR）とその後のライブ視聴まで、Node で完結（Android アプリは不要）。
- HomeKit への追加は Web UI の QR、またはセットアップコード。

## 現在の状態（2026-11-17）

- ✅ ドアホン親機との KVS WebRTC セッション確立 / H264 映像受信 / HomeKit SRTP への再パッケージ
- ✅ `-c:v copy` パススルーで iPhone / Apple TV 側の H264 デコードが安定
- ✅ live stream のオープン・クローズ・再オープンで切断しないよう調整済み
- ✅ **片方向音声 (ドアホン親機 → iPhone)** — PCMU を Opus 16kHz に再エンコード、
  RTP timestamp を HomeKit 仕様に書き換えた上で自前 SRTP で送信
- ✅ MQTT mTLS 経由の AWS 一時クレデンシャル自動更新（10分ごと）
- ✅ Web UI (`:8080`) でペアリング状態 / HomeKit setup QR / Setup code を表示
- ✅ systemd ユニット、`.deb` パッケージ、`doorphone-hap pair` CLI
- 🔎 Web UI からの QR ペアリングは実装済み・**実機未検証**（新規端末追加時のみ必要）
- ❌ 双方向音声・ドアベル通知はscope 外
- ❌ snapshot は live ストリーム中はキャッシュから返す（ライブ停止中は last-known）

## アーキテクチャ

```
                   ┌─────────────────┐
                   │ Panasonic 親機　 │
                   │  (VL-X70AH)     │
                   └────────┬────────┘
                            │ (LAN)
                            │ AWS IoT MQTT (mTLS)
                            │   GET_SIGNALING_CHANNEL
                            │   ← NOTIFY_KVS_CREDENTIAL
                            │
                            │ AWS KVS WebRTC
                            │   SDP/ICE/DTLS/SCTP
                            │   DataChannel: Request_Connect
                            │   SRTP: H264 (Baseline 42e01f)
                            ▼
    ┌──────────────────────────────────────────────────────────┐
    │                     doorphone-hap                        │
    │                                                          │
    │  ┌──────────────┐    ┌──────────────────────────────┐    │
    │  │ creds-       │    │ doorphone-source             │    │
    │  │ refresher    │    │ (node-datachannel)           │    │
    │  │ (mqtt mTLS)  │    │  → H264 depacketize + PCMU   │    │
    │  └──────────────┘    └────┬──────────────────┬──────┘    │
    │                           │ H264 Annex-B     │ PCMU 8k   │
    │                           ▼                  ▼           │
    │                   ┌───────────────┐   ┌──────────────┐   │
    │                   │ ffmpeg(V)     │   │ Node pacer   │   │
    │                   │  -c:v copy    │   │(hrtime, 20ms)│   │
    │                   └────┬──────────┘   └────┬─────────┘   │
    │                        │ SRTP(V)           │ mulaw 20ms  │
    │                        │                   ▼             │
    │                        │              ┌──────────────┐   │
    │                        │              │ ffmpeg(A)    │   │
    │                        │              │  libopus     │   │
    │                        │              └────┬─────────┘   │
    │                        │                   │ plain RTP(A)│
    │                        │                   ▼             │
    │                        │              ┌───────────────┐  │
    │  ┌──────────────┐      │              │Node SRTP proxy│  │
    │  │ pair-web     │      │              │ (TS rewrite + │  │
    │  │ (:8080) QR   │      │              │  AES_CM+HMAC) │  │
    │  └───────┬──────┘      │              └────┬──────────┘  │
    │          │             │                   │ SRTP(A)     │
    │          │             ▼                   ▼             │
    │          │          ┌──────────────────────────────┐     │
    │          │          │ HAP-NodeJS (CameraController)│     │
    │          │          └────┬─────────────────────────┘     │
    │          │               │ mDNS _hap._tcp                │
    └──────────┼───────────────┼───────────────────────────────┘
               │               │
          Web  │               │ HAP (TLS) + SRTP (UDP)
          UI   │               │
               ▼               ▼
          (browser)      (iPhone / Apple TV / Home Hub)
```

### リポジトリ構成

```
doorphone/
├── hap/                    # Node.js アクセサリ本体
│   ├── accessory.js        # HAP-NodeJS + ブート
│   ├── doorphone-source.js # ドアホン親機との WebRTC + H264 depacketize + PCMU 分配
│   ├── streaming.js        # HomeKit CameraStreamingDelegate + 音声 SRTP proxy
│   ├── srtp.js             # 自前 AES_CM_128_HMAC_SHA1_80 (Opus TS 書換え用)
│   ├── creds-refresher.js  # MQTT mTLS で temp creds 更新
│   ├── pair.js             # QR → /reg → CSR → KVS → cert 保存
│   ├── pair-web.js         # Web UI (ペアリング + HomeKit QR)
│   ├── h264-depay.js       # RFC 6184 H264 depacketizer
│   ├── config.js           # 設定ローダ
│   └── bin/doorphone-hap   # CLI (pair / serve / status)
├── packaging/              # .deb ビルド (Linux arm64 container 内で npm install)
│   ├── deb/                # Debian パッケージツリー
│   ├── Containerfile       # linux/arm64 ビルダイメージ
│   ├── do-build.sh         # ホスト側呼び出し
│   └── scripts-mount/do-build.sh  # コンテナ内で dpkg-deb --build
├── Makefile                # ビルド entry point (container 自動検出)
├── proto/                  # ドアホン親機 ↔ 我々の Protobuf (jadx 復元)
│   ├── webrtc_if.proto
│   ├── call.proto
│   └── pairing.proto
├── doorphone-hap_*.deb     # (gitignore) ビルドされた .deb
├── research/               # リバースエンジニアリング時の検証コード
│   ├── pair.py             # Python 版 QR/reg
│   ├── get_kvs_creds.py    # Python 版 creds 取得
│   ├── node-viewer/        # スタンドアロン KVS viewer 群
│   └── gen/                # Python protobuf バインディング
└── README.md
```

## セットアップ（Raspberry Pi 4/5, Debian 13 arm64）

### 前提

- RPi 側: `nodejs (>= 18)` / `ffmpeg` （`apt` で自動的に満たされる）
- ビルドマシンはいずれか:
  - **macOS (Apple Silicon)**: Apple `container` CLI
    （`brew install --cask container` + 初回のみ `container system start`）
  - **Linux (x86_64 or arm64)**: `docker` or `podman`、
    x86_64 で arm64 .deb を作るときは `qemu-user-static` も必要
    （Debian/Ubuntu: `sudo apt install qemu-user-static binfmt-support`）
- ドアホン親機と RPi が同じ LAN にある

### ビルド

```bash
make                  # → doorphone-hap_<ver>_arm64.deb
make clean            # stage/ と .deb を削除
make image            # イメージだけ再ビルド
```

`npm install` はビルド用 linux/arm64 コンテナ内で走るため、生成された
`.deb` は `node_modules` 込みの self-contained で、ターゲット側では
ネットワーク不要。

### デプロイ

```bash
scp doorphone-hap_*_arm64.deb user@rpi.local:/tmp/
ssh user@rpi.local 'sudo apt install -y /tmp/doorphone-hap_*_arm64.deb'
```

### HMAC 鍵の配置 (初回のみ)

本リポジトリにはドアホン親機の `/reg` エンドポイント認証用の HMAC 鍵が含まれて
いません。Panasonic アプリから自分で抽出して
`/etc/doorphone-hap/hmac.key` に置く必要があります:

```sh
echo '<APK から抽出した base64 文字列>' | sudo tee /etc/doorphone-hap/hmac.key
sudo chown doorphone-hap:doorphone-hap /etc/doorphone-hap/hmac.key
sudo chmod 640 /etc/doorphone-hap/hmac.key
```

抽出手順は [`research/extract-hmac-key.md`](research/extract-hmac-key.md) 参照。

### ペアリング

HMAC 鍵を置いた後、サービスは「未ペアリング」モードで起動し、Web UI だけが動く。
`http://<rpi>:8080/` を開いて次のいずれかでペアリング:

1. ドアホン親機で「スマホ追加」を押して QR を表示
2. QR 画像を撮影して Web UI にアップロード（または URL 文字列を貼り付け）
3. Web UI がペアリングを完了し `/etc/doorphone-hap/` に `cert.pem` / `privkey.pem` / `unit.json` を書き込む
4. サービスが自動的に KVS WebRTC へ接続、HomeKit mDNS 広告開始

### HomeKit への追加

ペアリングが完了すると Web UI に HomeKit setup QR と setup code が表示される。

- iOS Home app → 「アクセサリを追加」→ QR をスキャン、または
- 「その他のオプション」→ `Doorphone` を選択 → セットアップコード `031-45-154`（既定）を入力

アクセサリは IP Camera カテゴリで公開される。

### CLI

```bash
sudo doorphone-hap status           # ペアリング状態確認
sudo doorphone-hap pair qr.jpg      # 画像からペアリング
sudo doorphone-hap pair https://... # /reg URL 直接指定
sudo doorphone-hap version
```

## 設定

`/etc/doorphone-hap/config.json`（conffile なのでアップグレードしても保持される）:

```json
{
  "accessory": {
    "name": "Doorphone",            // Home app の表示名
    "username": "DC:D0:0F:00:00:01",// HAP の一意 MAC。同 LAN で衝突不可
    "pincode": "031-45-154",        // HomeKit セットアップコード
    "port": 47129                   // HAP の TCP ポート
  },
  "doorphone": {
    "credsPath":    "/etc/doorphone-hap/kvs_creds.json",
    "certPath":     "/etc/doorphone-hap/cert.pem",
    "keyPath":      "/etc/doorphone-hap/privkey.pem",
    "unitInfoPath": "/etc/doorphone-hap/unit.json",
    "videoPort": 5004,              // 内部 UDP (今は使っていない)
    "audioPort": 5006
  },
  "ffmpeg":  { "path": "/usr/bin/ffmpeg" },
  "storage": {
    "persistPath": "/var/lib/doorphone-hap/persist",
    "sdpPath":     "/run/doorphone-hap/doorphone.sdp"
  },
  "web": { "enabled": true, "host": "0.0.0.0", "port": 8080 }
}
```

主な環境変数オーバーライド（`ACC_NAME`, `ACC_MAC`, `ACC_PIN`, `CREDS_PATH`, `WEB_PORT`, …）は
`hap/config.js` 参照。

## プロトコル要点（再発見防止メモ）

実装中に判明した「罠」:

1. **Request_Connect はこちら側の DC へ** — `node-datachannel` の `pc.onDataChannel` で受けた
   ドアホン親機側 DC (`MasterToViewer`) にコマンドを書いても無視される。自分で作成した
   `ViewerToMaster` DC に投げる。
2. **auto-negotiation タイミング** — `pc.onLocalDescription` などは必ず `addTrack` /
   `createDataChannel` の**前**に登録する。
3. **デバイス指定** — 玄関子機のカメラは `DEVICE_DOOR(1), devno=0, TYPE_MONITOR(2)`。
   `DEVICE_CAMERA(2)` は増設網カメラ用で、本機では `REASON_CONNECTION_FAILED` が返る。
4. **CSR Subject は単一 CN** — Panasonic アプリは
   `CN=IoT ApplicationOU=Organizational UnitO=OrganizationC=Country` という
   「OU/O/C が CN の中に埋め込まれた」単一 CN を使う。@peculiar/x509 で手で合わせる。
5. **ffmpeg は `-c:v copy` が鉄板** — iOS Home 側の H264 デコーダは再エンコードで同期を外す。
   ドアホン親機が送る Baseline 42e01f をそのまま SRTP に詰め直すだけで通る。
6. **HomeKit の `reconfigure` を無視する** — 送られるたびに ffmpeg を落とすと ~27 秒で
   live が切れる。何もせず ack だけ返す。
7. **live 再接続時は Request_Connect を再送** — ドアホン親機は 1 回目のセッションが閉じると
   RTP を止める。新しい consumer が付いたタイミングで DC へ Request_Connect を再送して
   ドアホン親機を「再武装」する。
8. **keyframe gating** — 新 consumer は次の IDR が来るまで NAL をドロップし、IDR 到着時に
   cached SPS/PPS + IDR をまとめて書き出す。これで新規 ffmpeg のデコード同期が早い。
9. **snapshot は keyframe キャッシュから** — 常駐 ffmpeg が H264 を食うと live stream の
   バックプレッシャになる。IDR を 1 つバッファしておき、要求時だけ ffmpeg で JPEG 化する
   方式に落ち着いた。応答は 5 秒キャッシュ。
10. **Opus RTP timestamp を自前で書き換える** — Apple HomeKit の Opus 受信は RFC 7587 を
    無視し、RFC 3550 でネゴシエート済 sample rate をクロックに使う。ffmpeg は 48 kHz
    固定で TS を刻む (20 ms = +960) ため、HomeKit は 20 ms パケットを 60 ms と誤解して
    40 ms の無音を挟み、音がブツ切れになる。修正は `hap/streaming.js::createAudioProxy`
    で: ffmpeg → loopback plain RTP → Node が TS を `sample_rate * 0.020` 刻みに書き換え
    → `hap/srtp.js` で AES_CM + HMAC-SHA1-80 を自前計算して iPhone へ送信。
    [go2rtc の `pkg/opus/homekit.go`](https://github.com/AlexxIT/go2rtc/blob/master/pkg/opus/homekit.go)
    が canonical reference。
11. **音声 pacer は hrtime ベースで** — ffmpeg の `-re` や lavfi の native rate pacing は
    ~3% 遅く (測定: 48.5 pkts/s vs 50) 時間とともに iPhone のジッタバッファが枯れる。
    Node 側で `process.hrtime.bigint()` を基準にドリフト補正しつつ 20 ms 刻みで ffmpeg
    stdin に 160 B の mulaw を書き込むと、ドアホン親機 VAD gap も mulaw silence (0xFF) で埋めた
    まま rock-solid な 8000 B/s を維持できる。

## 既知の制約

- `kvs_creds.json` は 10 分で失効する。Node 版 refresher が自動再取得するが、起動直後の
  数秒間は creds が無く source は待機状態になる（ログ `[creds] creds refreshed` 後に接続）。
- RPi 1 台で 1 つのドアホン親機のみ。複数親機対応は未実装（config の分割から必要）。
- Snapshot は最後に live が開いていた時点の映像を 5 秒キャッシュして返す。never-live
  起動直後は 1x1 グレーのプレースホルダ。

## 参考（リバースエンジニアリング時の検証コード）

本番パッケージには同梱していないが、`research/` に以下のスクリプトを残してある
（詳細は `research/README.md`）:

- `research/get_kvs_creds.py` — MQTT 経由で手動 creds 取得（`hap/creds-refresher.js` の元ネタ）
- `research/pair.py` — QR → /reg HMAC までの最小実装（完全なペアリングは `hap/pair.js`）
- `research/node-viewer/viewer3.js` — スタンドアロンな KVS WebRTC viewer（HomeKit 不要、CLI のみ）

## ライセンス

私的利用のみ。ドアホン親機のプロトコルは静的解析由来で Panasonic のサービス仕様としては
公開されていない。
