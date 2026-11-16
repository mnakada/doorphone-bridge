#!/usr/bin/env python3
"""
Phase 1 prove-out: MQTT mTLS を使って親機から KVS WebRTC 用の AWS 一時クレデンシャルを貰う。

アーキテクチャ（[[live-view-flow]] + manager/b.java 解析結果）:
  1. AWS IoT MQTT に client cert (mTLS) で接続
  2. topic `doorphone/comm/<親機unitId>` を subscribe
  3. 同 topic に `{to: 親機, from: スマホ, data: {command: "GET_SIGNALING_CHANNEL"}}` を publish
  4. 親機が同 topic に `{to: スマホ, from: 親機, data: {command: "NOTIFY_KVS_CREDENTIAL", payload: "{...}"}}` を返す
  5. payload JSON を復号して AWS creds + channelName を取得
"""
import json, time, threading
from awscrt import mqtt, io
from awsiot import mqtt_connection_builder

ENDPOINT     = "d02819672h9iuly6ai747-ats.iot.ap-northeast-1.amazonaws.com"
UNIT_ID      = "DP_MWE720_6HACF001488_69e854f8-bfdf-11d3-b002-bc3e0b402258"
APP_ID       = "SP_e4e04fa2-a85a-4d94-878c-e53c90c9e1a7"
CERT_PATH    = "extracted-state/cert.pem"
KEY_PATH     = "extracted-state/privkey_ec.pem"
TOPIC        = f"doorphone/comm/{UNIT_ID}"

got_creds = threading.Event()
creds = {}

def on_message(topic, payload, dup, qos, retain, **kwargs):
    text = payload.decode('utf-8', errors='replace')
    print(f"\n<<< RECV topic={topic} msg={text[:400]}")
    try:
        msg = json.loads(text)
        if msg.get("to") != APP_ID:
            print(f"    (not for us; to={msg.get('to')})")
            return
        data = msg.get("data") or {}
        if isinstance(data, str):
            data = json.loads(data)
        cmd = data.get("command","")
        print(f"    command={cmd}")
        if cmd == "NOTIFY_KVS_CREDENTIAL":
            payload_str = data.get("payload","")
            inner = json.loads(payload_str) if isinstance(payload_str, str) else payload_str
            print(f"    KVS payload: {json.dumps(inner, indent=2, ensure_ascii=False)[:800]}")
            if inner.get("channelName"):
                creds.update(inner)
                got_creds.set()
            else:
                print(f"    No channelName in payload (error? {inner.get('error')})")
    except Exception as e:
        print(f"    parse error: {e}")

def main():
    event_loop_group = io.EventLoopGroup(1)
    host_resolver   = io.DefaultHostResolver(event_loop_group)
    client_bootstrap= io.ClientBootstrap(event_loop_group, host_resolver)
    conn = mqtt_connection_builder.mtls_from_path(
        endpoint=ENDPOINT,
        port=8883,
        cert_filepath=CERT_PATH,
        pri_key_filepath=KEY_PATH,
        client_bootstrap=client_bootstrap,
        client_id=APP_ID,
        clean_session=True,
        keep_alive_secs=30,
    )
    print(f"Connecting to {ENDPOINT} as client_id={APP_ID} ...")
    conn.connect().result()
    print("connected")

    sub_fut, packet_id = conn.subscribe(topic=TOPIC, qos=mqtt.QoS.AT_MOST_ONCE, callback=on_message)
    sub_fut.result()
    print(f"subscribed to {TOPIC}")

    req = {
        "to":   UNIT_ID,
        "from": APP_ID,
        "data": {
            "command": "GET_SIGNALING_CHANNEL",
            "payload": None,
        },
    }
    body = json.dumps(req)
    print(f">>> PUB {body}")
    pub_fut, pub_id = conn.publish(topic=TOPIC, payload=body, qos=mqtt.QoS.AT_MOST_ONCE)
    pub_fut.result()

    if got_creds.wait(timeout=20):
        print("\nGOT KVS CREDS ✓")
        with open("extracted-state/kvs_creds.json","w") as f:
            json.dump(creds, f, indent=2)
        print("saved extracted-state/kvs_creds.json")
    else:
        print("\nTIMEOUT waiting for NOTIFY_KVS_CREDENTIAL")

    conn.disconnect().result()

if __name__ == "__main__":
    main()
