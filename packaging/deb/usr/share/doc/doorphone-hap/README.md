# doorphone-hap

HomeKit bridge for the Panasonic VL-X70AH doorphone.

## First setup

On install the service starts in "unpaired" mode — only the Web UI is live;
nothing is advertised to HomeKit yet.

### Pair with the base station

1. On the doorphone: press "スマホ追加" to show a QR code.
2. Open `http://<rpi-host>:8080/` in a browser **on the same LAN**.
3. Upload the QR photo (or paste the decoded URL) and click *Pair*.
4. On success the UI writes `cert.pem` / `privkey.pem` / `unit.json`
   into `/etc/doorphone-hap/` and prompts to restart the service.

Alternatively from the shell:
```
sudo doorphone-hap pair /path/to/qr.jpg
sudo systemctl restart doorphone-hap
```

### Add to Apple Home

1. Edit `/etc/doorphone-hap/config.json` — change `pincode` and `username`
   (a stable fake MAC for HomeKit identity) if you don't like the defaults.
2. `sudo systemctl restart doorphone-hap`
3. In the Home app: *Add Accessory* → *More options* → pick "Doorphone" →
   enter the setup code.

## Operation

- The service mDNS-advertises itself as `_hap._tcp` on the LAN.
- Credentials live in `/etc/doorphone-hap/` (readable only by the service user).
- Persistent HomeKit state is in `/var/lib/doorphone-hap/persist/`.
- Logs go to the systemd journal.

## Known limitations (v0.0.1)

- No two-way audio yet (HomeKit stream plays synthesized silence).
- Snapshot image is a placeholder (tile shows gray until the live view opens).
- `kvs_creds.json` must be refreshed externally every ~10 minutes.
- No doorbell press notification yet.
- Web UI has no authentication — put it on a trusted LAN or firewall port 8080.
