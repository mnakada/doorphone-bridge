# research/

Reverse-engineering scratchwork and reference implementations used to build
the production bridge in `../hap/`. These files are NOT part of the RPi
package and are preserved only to document how each piece of the protocol
was validated.

- **`extract-hmac-key.md`** — how to pull the `/reg` HMAC key out of the
  Panasonic Android app, in case you want to replace the hardcoded value
  in `../hap/pair.js` with one you extracted yourself.

## Python prototypes

- **`get_kvs_creds.py`** — First proof that the AWS IoT MQTT flow works. Uses
  `awscrt` / `awsiot` to connect with mTLS, publish
  `GET_SIGNALING_CHANNEL`, and parse the returned temporary creds.
  Superseded by `../hap/creds-refresher.js` in production, but useful for
  one-off debugging.
- **`pair.py`** — Minimal QR → `/reg/<token>` HMAC prover. Only does the
  cloud registration step (NOT the full KVS pairing / CSR exchange — that
  only exists in `../hap/pair.js`).

## Node prototypes

- **`node-viewer/viewer3.js`** — Standalone KVS WebRTC viewer that drove the
  production pipeline. Logs the received H264 RTP to a file for offline
  inspection. Earlier iterations (`viewer.js` with `@roamhq/wrtc`,
  `viewer2.js` with node-datachannel but the wrong DC role) were removed
  after their lessons were absorbed into this file.
- **`node-viewer/check_codecs.js`** — Tiny script that enumerates
  `@roamhq/wrtc`'s codec capabilities. Confirmed the library can't decode
  H264, which is why we settled on `node-datachannel`.

## Protobuf (Python)

- **`gen/`** — Python bindings generated from `../proto/*.proto` with
  `protoc`. Imported by `pair.py` / `get_kvs_creds.py`.

## Reverse-engineering input artifacts

- **`apks/`** — Original Panasonic APK downloaded with `apkeep`.
- **`apktool-out/`** — `apktool d` output. Smali + resources.
- **`jadx-src/` / `jadx-out/`** — JADX decompiled Java sources. Where the
  Protobuf schemas and the hardcoded HMAC key were found.
- **`extracted/`** — Miscellaneous files extracted from the running AVD.
- **`mitm-logs/`** — mitmproxy capture of the Panasonic app talking to the
  cloud during QR pairing (`flows.mitm`).
- **`ドアホンコネクトS解析.txt`** — Freeform analysis notes.
- **`__pycache__/` / `.venv/`** — Python runtime leftovers.

All of these are kept for traceability only and are gitignored.

## How to run the prototypes (from the project root)

```
cd ..   # back to the project root
source research/.venv/bin/activate
# cert.pem / privkey_ec.pem live under the project root's extracted-state/.
python research/pair.py qr.jpg           # one-shot /reg HMAC test
python research/get_kvs_creds.py         # pulls temp creds via MQTT
node research/node-viewer/viewer3.js     # standalone KVS WebRTC viewer
```

None of these are needed for normal production use — install the `.deb`
built from `../packaging/` instead.
