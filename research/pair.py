#!/usr/bin/env python3
"""
VL-X70AH 「ドアホンコネクトS」ペアリング実行スクリプト

使い方:
  1) 親機でスマホ追加モードにし、画面に QR を表示
  2) iPhone カメラで写真撮影（QR スキャン機能は使わない）
  3) AirDrop 等で Mac に転送（例: ~/c/doorphone/qr.HEIC）
  4) ./pair.py qr.HEIC --hmac-key /path/to/hmac.key

QR URL はワンショット + AWS 一時クレデンシャル有効期限 10 分以内なので、
撮影から実行まで素早く行う。

HMAC 鍵は Panasonic APK から自分で抽出する必要あり — research/extract-hmac-key.md 参照。
"""
import argparse, base64, hmac, hashlib, json, os, ssl, socket, subprocess, sys
from pathlib import Path

DEFAULT_HMAC_KEY_PATH = "/etc/doorphone-hap/hmac.key"


def load_hmac_key(path=None):
    p = path or os.environ.get("HMAC_KEY_PATH") or DEFAULT_HMAC_KEY_PATH
    try:
        raw = Path(p).read_text().strip()
    except FileNotFoundError:
        sys.exit(
            f"ERROR: HMAC key file not found: {p}\n"
            f"  Extract it from the Panasonic APK and write the base64 value there.\n"
            f"  See research/extract-hmac-key.md for the procedure."
        )
    if not raw:
        sys.exit(f"ERROR: HMAC key file is empty: {p}")
    return base64.b64decode(raw)


def decode_qr(path: Path) -> str:
    # HEIC → PNG via macOS sips
    png_path = Path('/tmp/_pair_qr.png')
    if path.suffix.lower() in ('.heic', '.heif'):
        subprocess.run(['sips', '-s', 'format', 'png', str(path), '--out', str(png_path)],
                       check=True, capture_output=True)
    else:
        png_path = path
    from PIL import Image
    from pyzbar.pyzbar import decode, ZBarSymbol
    img = Image.open(png_path)
    results = decode(img, symbols=[ZBarSymbol.QRCODE])
    if not results:
        for scale in (0.5, 0.25, 0.1):
            w, h = img.size
            scaled = img.resize((int(w*scale), int(h*scale)))
            results = decode(scaled, symbols=[ZBarSymbol.QRCODE])
            if results:
                break
    if not results:
        sys.exit('ERROR: QR not found in image')
    return results[0].data.decode()


def hit_registration(url: str, hmac_key: bytes) -> dict:
    assert url.startswith('https://intercom.iot-webrtc.net/reg/'), f'Unexpected URL: {url}'
    host = 'intercom.iot-webrtc.net'
    token = url.rsplit('/', 1)[-1]
    auth = base64.b64encode(hmac.new(hmac_key, token.encode(), hashlib.sha256).digest()).decode()
    ctx = ssl.create_default_context()
    sock = ctx.wrap_socket(socket.create_connection((host, 443), timeout=10), server_hostname=host)
    req = (
        f"GET /reg/{token} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        f"User-Agent: Dalvik/2.1.0\r\n"
        f"x-auth-hash: {auth}\r\n"
        f"Connection: close\r\n\r\n"
    ).encode()
    sock.sendall(req)
    raw = b''
    while True:
        c = sock.recv(8192)
        if not c: break
        raw += c
    sock.close()
    try:
        headers, body = raw.split(b"\r\n\r\n", 1)
    except ValueError:
        sys.exit(f'ERROR: unexpected response: {raw[:200]}')
    status_line = headers.split(b"\r\n", 1)[0].decode()
    if '200' not in status_line:
        sys.exit(f'ERROR: {status_line}\n{body.decode(errors="replace")[:500]}')
    return json.loads(body.decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image', help='path to QR photo (HEIC, JPG, PNG) or /reg URL')
    ap.add_argument('--out', default='pairing_info.json')
    ap.add_argument('--hmac-key', default=None,
                    help=f'HMAC key file (default: $HMAC_KEY_PATH or {DEFAULT_HMAC_KEY_PATH})')
    args = ap.parse_args()
    hmac_key = load_hmac_key(args.hmac_key)
    print('decoding QR...')
    url = decode_qr(Path(args.image))
    print(f'URL: {url}')
    print('fetching registration...')
    info = hit_registration(url, hmac_key)
    Path(args.out).write_text(json.dumps(info, indent=2))
    creds = info['credentials']
    print(f"OK saved {args.out}")
    print(f"  channelName:     {creds['channelName']}")
    print(f"  PeerIdPrefix:    {creds['PeerIdPrefix']}")
    print(f"  modelType:       {creds['modelType']}")
    print(f"  Expiration:      {creds['Expiration']}")
    print(f"  AccessKeyId:     {creds['AccessKeyId']}")
    print()
    print('NEXT: use hap/pair.js to complete pairing via KVS WebRTC')


if __name__ == '__main__':
    main()
