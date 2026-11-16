# HMAC 鍵の抽出手順

`/reg/<token>` エンドポイントは `x-auth-hash` ヘッダに HMAC-SHA256 の署名を
要求します。鍵は Panasonic アプリ「ドアホンコネクト S」のバイナリに埋め
込まれた固定値で、全ユーザ共通です。本リポジトリは便宜上 `hap/pair.js` と
`research/pair.py` にその値をハードコードしていますが、公開配布する場合は
各自で抽出した値に差し替える方針が無難です (法的グレー回避)。

抽出手順自体は 5 分程度です。

## 1. APK を入手

### 方法 A: 自分の Android 端末から pull する (推奨)

Google Play からインストールした端末で:

```sh
PKG=com.panasonic.doorphone_connect_s
adb shell pm path "$PKG"
# → package:/data/app/.../base.apk  と表示される
adb pull <表示されたパス> ./DoorphoneConnectS.apk
```

### 方法 B: `apkeep` で取得する

[`apkeep`](https://github.com/EFForg/apkeep) は Google Play から APK を直接
取得できる CLI。split APK (ABI / 言語 / dpi 別) が複数ファイルで降ってくる
ので、`com.panasonic.doorphoneconnects.apk` (base) を使えばよい。

```sh
brew install apkeep
apkeep -a com.panasonic.doorphoneconnects ./apks/
```

認証情報は `~/.config/apkeep/apkeep.ini` または作業ディレクトリの
`.apkeep.ini` に書く:

```ini
[google]
email = your-google-account@example.com
aas_token = aas_et/XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
accept_tos = true
```

`aas_token` は Google Play 用の長期トークン。取得方法はいずれか:

- **Chrome DevTools 経由 (今回使った方法、推奨)**
  1. Chrome で <https://accounts.google.com/EmbeddedSetup> を開く
     （Android 端末の初期セットアップに使われる OAuth フロー）
  2. DevTools を開いて *Application* → *Cookies* → `google.com` を選択
  3. ログインを完了させる
  4. Cookie 一覧から **`oauth_token`** を探す
     （値は `oauth2_4/...` で始まる長い文字列）
  5. この値を使って `aas_token` に交換:
     ```sh
     curl -s https://android.clients.google.com/auth \
       -d "accountType=HOSTED_OR_GOOGLE&Email=<自分のアドレス>&has_permission=1" \
       -d "service=ac2dm&source=android&androidId=0000000000000000" \
       -d "Token=<上記 oauth_token>"
     # → "Token=aas_et/..." の行が返ってくる
     ```
- Python の [`gpapi`](https://pypi.org/project/gpapi/) で OAuth 済み
  端末の token を取得
- Aurora Store / AuroraOSS 系ツールで token をエクスポート
- `apkeep --help` 内の「Authentication」セクションの手順

### 認証情報の取扱い

`.apkeep.ini` の `aas_token` は Google アカウントへの長期アクセス権
(Play Store, device management 等) に相当します。**絶対に公開 repo に
commit しない** こと。本リポジトリの `.gitignore` では
`research/.apkeep.ini` を除外しています。

### 方法 C: APKMirror 等の APK ミラーサイト

Firebase / セキュリティ回避署名の都合で推奨しません。方法 A/B で取得できないときのみ。

## 2. 逆コンパイル

### jadx (推奨 — Java ソースが読める)

```sh
brew install jadx                # macOS
# apt install jadx               # Debian
jadx DoorphoneConnectS.apk -d ./jadx-out
```

### apktool (バックアップ — Smali のみ)

```sh
brew install apktool
apktool d DoorphoneConnectS.apk -o ./apktool-out
```

## 3. HMAC 鍵を特定

### jadx を使った場合

```sh
grep -r 'Base64.decode' jadx-out/sources/com/panasonic/ \
  | grep -E 'PairingManager' | head
```

典型的な出力:

```
jadx-out/sources/com/panasonic/newpf/unit/PairingManager.java:210:
  byte[] bArrDecode = Base64.decode("C7OMO8OTek051QcyrzclruhaIH...2A==", 0);
```

引用符内の 44 ~ 88 文字の base64 文字列が **HMAC 鍵** です。前後の文脈
(`setRequestProperty("x-auth-hash", ...)` や `javax.crypto.Mac.getInstance("HmacSHA256")`)
を確認すればペアリング用の鍵で間違いありません。

### apktool を使った場合

Smali 中のリテラルを探す:

```sh
grep -rE 'const-string.*"[A-Za-z0-9+/=]{40,}"' apktool-out/smali*/com/panasonic/ \
  | grep -A1 PairingManager
```

## 4. 設定

抽出した base64 文字列をそのまま 1 行のテキストファイルとして保存するだけ。
コード側 (`hap/pair.js` / `research/pair.py`) は既にこのファイルを読み込む
ように作ってあります。

### 本番 (RPi): `/etc/doorphone-hap/hmac.key`

```sh
echo 'C7OMO8OT...2A==' | sudo tee /etc/doorphone-hap/hmac.key
sudo chown doorphone-hap:doorphone-hap /etc/doorphone-hap/hmac.key
sudo chmod 640 /etc/doorphone-hap/hmac.key
```

### 開発時 (Mac): 任意のパス

`HMAC_KEY_PATH` 環境変数で位置を上書き、または `--hmac-key` 引数で渡す:

```sh
export HMAC_KEY_PATH=/Users/me/doorphone/hmac.key
echo 'C7OMO8OT...2A==' > "$HMAC_KEY_PATH"
# あるいは
node hap/pair.js qr.jpg --hmac-key ./hmac.key
python research/pair.py qr.jpg --hmac-key ./hmac.key
```

### 探索順序

`hap/pair.js` と `research/pair.py` は同じ順に探します:

1. CLI オプション `--hmac-key <path>`
2. 環境変数 `HMAC_KEY_PATH`
3. デフォルト `/etc/doorphone-hap/hmac.key`

ファイルの中身は **base64 文字列 1 行** (改行・空白は trim される)。

## 5. 動作確認

```sh
sudo doorphone-hap pair https://intercom.iot-webrtc.net/reg/<token>
```

`401 Unauthorized` が返るなら鍵が間違っています。
`200 OK` + `credentials` JSON が返れば成功です。

## 法的・倫理的な留意点

- 自分が所有している親機 (購入したハードウェア) との interop 目的で
  APK を逆コンパイルすることは、日本の著作権法第 30 条の 4
  (情報解析目的) / 米国 DMCA の interoperability exception で
  概ね適法とされています。
- 抽出した鍵を使って他ユーザの親機を無断で操作することは不法行為に
  当たり得ます。
- 本手順は Panasonic のサービス利用規約に抵触する可能性があります。
  自己責任でご利用ください。
