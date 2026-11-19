<template>
  <div class="title">
    <div>{{ state.appName }}</div>
    <div class="version" v-if="state.version">Ver.{{ state.version }}</div>
  </div>

  <main>
    <section v-if="restarting" class="card">
      <p class="ok">✓ ペアリング完了。新しい証明書を読み込むためサービスを再起動しています…</p>
      <p class="muted">数秒で自動的に再接続します。</p>
    </section>

    <section v-if="showPairForm" class="card">
      <h2>親機とのペアリング</h2>
      <p>
        ドアホン親機で「スマホ追加」を押して QR を表示し、画像をアップロードするか、
        デコード済みの URL (<code>https://intercom.iot-webrtc.net/reg/...</code>) を貼り付けてください。
      </p>
      <form @submit="submitPair">
        <label>QR 画像ファイル</label>
        <input type="file" accept="image/*" @change="onQrChange" :disabled="pairing || decoding">
        <p v-if="decoding" class="muted">QR を解析中…</p>
        <p v-else-if="decodeMsg" :class="decodeMsg.ok ? 'ok' : 'fail'">{{ decodeMsg.text }}</p>

        <label>— または — QR の URL</label>
        <input type="text" v-model="qrUrl" placeholder="https://intercom.iot-webrtc.net/reg/..." :disabled="pairing">

        <label>プロファイル名(親機に表示される名前)</label>
        <input type="text" v-model="profileName" :disabled="pairing">

        <p><button type="submit" :disabled="pairing">{{ pairing ? 'ペアリング中…' : 'ペアリング開始' }}</button></p>
      </form>

      <pre v-if="pairLog">{{ pairLog }}</pre>
      <p v-if="pairResult && pairResult.ok" class="ok">
        ✓ ペアリング完了。Unit ID: <code>{{ pairResult.info.unitDeviceId }}</code>
      </p>
      <p v-else-if="pairResult" class="fail">✗ 失敗: {{ pairResult.error }}</p>
    </section>

    <section v-if="showHomeKitPanel" class="card">
      <h2>Apple Home への追加</h2>
      <p>
        以下の QR コードをスキャンするか、iOS の Home アプリで「アクセサリを追加」→「その他のオプション」→
        <code>{{ state.accessoryName }}</code> を選んでください。
      </p>
      <div class="hk-row">
        <div v-html="state.setupQrSvg"></div>
        <div>
          <p>セットアップコード</p>
          <p class="pincode">{{ state.pincode }}</p>
          <p class="muted" style="font-size:12px">URI: <code>{{ state.setupUri }}</code></p>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>ペアリング状況</h2>
      <p>
        <span v-if="state.paired" class="ok">✓ ドアホン親機: ペアリング済み</span>
        <span v-else class="fail">✗ ドアホン親機: 未ペアリング</span>
      </p>
      <p>
        <span v-if="state.hkConnected" class="ok">✓ Apple Home: 登録済み</span>
        <span v-else class="muted">— Apple Home: 未登録</span>
      </p>
      <p class="muted file-chips">
        <template v-for="(ok, name) in state.files" :key="name">
          <span :class="ok ? 'ok' : 'muted'">{{ ok ? '✓ ' : '— ' }}</span>
          <span :class="ok ? 'ok' : 'muted'">{{ name }}</span>
          <br>
        </template>
      </p>
      <p class="muted" v-if="state.unit">
        Unit: <code>{{ state.unit.unitDeviceId }}</code><br>
        ペアリング日: <code>{{ state.unit.pairedAt }}</code>
      </p>
    </section>
  </main>
</template>

<script setup>
import { reactive, ref, computed, onMounted, onUnmounted } from 'vue';

const state = reactive({
  appName: 'Doorphone Bridge',
  version: '',
  paired: false,
  hkConnected: false,
  accessoryName: '',
  pincode: '',
  setupUri: '',
  setupQrSvg: '',
  files: {},
  unit: null,
});

const pairing = ref(false);
const pairLog = ref('');
const pairResult = ref(null);
// Set after RESULT_OK: the server restarts itself; cleared once SSE
// reconnects to the new process (its first event has _reason 'init').
const restarting = ref(false);
let sawDisconnect = false;
const qrFile = ref(null);
const qrUrl = ref('');
const profileName = ref('Doorphone Bridge');

const showPairForm = computed(() => !state.paired);
const showHomeKitPanel = computed(() => state.paired && !state.hkConnected);

async function refresh() {
  try {
    const r = await fetch('/api/state');
    if (!r.ok) return;
    Object.assign(state, await r.json());
  } catch (_) {}
}

const decoding = ref(false);
const decodeMsg = ref(null);

// Decode the QR in the browser and put the URL into the text field; the
// server then never sees the image. Uses the native BarcodeDetector when the
// browser has one, otherwise jsQR (/jsqr.js) over several sizes / crops.
async function decodeQrInBrowser(file) {
  const bmp = await createImageBitmap(file);
  try {
    // 1) Native detector (Chrome/Edge/Android, recent Safari): most robust.
    if ('BarcodeDetector' in window) {
      try {
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        const found = await det.detect(bmp);
        if (found && found[0] && found[0].rawValue) return found[0].rawValue;
      } catch (_) { /* fall through to jsQR */ }
    }
    if (typeof window.jsQR !== 'function') throw new Error('jsQR not loaded');
    // 2) jsQR over a few sizes of the whole photo and of a centre crop (the
    //    QR on the base's screen often fills only the middle of the frame).
    const W = bmp.width, H = bmp.height;
    const variants = [];
    for (const target of [1200, 1800, 800, 2600]) variants.push({ crop: 1, target });
    for (const target of [1200, 800]) variants.push({ crop: 0.6, target });
    for (const { crop, target } of variants) {
      const sw = Math.round(W * crop), sh = Math.round(H * crop);
      const sx = Math.round((W - sw) / 2), sy = Math.round((H - sh) / 2);
      const scale = Math.min(1, target / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      const code = window.jsQR(data, w, h, { inversionAttempts: 'attemptBoth' });
      if (code && code.data) return code.data;
    }
  } finally {
    bmp.close?.();
  }
  return null;
}

async function onQrChange(e) {
  const file = e.target.files[0] || null;
  qrFile.value = file;
  decodeMsg.value = null;
  if (!file) return;
  decoding.value = true;
  try {
    const text = await decodeQrInBrowser(file);
    if (text) {
      qrUrl.value = text;
      qrFile.value = null; // URL is enough; don't upload the image
      decodeMsg.value = text.startsWith('https://intercom.iot-webrtc.net/reg/')
        ? { ok: true, text: '✓ QR を読み取りました' }
        : { ok: false, text: '読み取った内容がペアリング用 URL ではありません: ' + text };
    } else {
      decodeMsg.value = { ok: false, text: 'ブラウザで QR を読み取れませんでした。このまま開始するとサーバー側でも解析を試みます。読み取れない場合は QR が画面いっぱいに写るように撮り直してください。' };
    }
  } catch (err) {
    decodeMsg.value = { ok: false, text: 'ブラウザでの解析に失敗しました（' + (err.message || err) + '）。サーバー側で解析します。' };
  } finally {
    decoding.value = false;
  }
}

async function submitPair(e) {
  e.preventDefault();
  if (pairing.value) return;
  if (!qrFile.value && !qrUrl.value) {
    pairResult.value = { ok: false, error: 'QR 画像または URL を指定してください。' };
    return;
  }
  pairing.value = true;
  pairLog.value = '';
  pairResult.value = null;

  const fd = new FormData();
  // Prefer the URL (typed or decoded in the browser); upload the image only
  // as a fallback when client-side decoding failed.
  if (qrUrl.value) fd.append('url', qrUrl.value);
  else if (qrFile.value) fd.append('qr', qrFile.value);
  fd.append('profile_name', profileName.value || 'Doorphone Bridge');

  try {
    const res = await fetch('/api/pair', { method: 'POST', body: fd });
    if (!res.ok || !res.body) {
      pairResult.value = { ok: false, error: `HTTP ${res.status}` };
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('RESULT_OK ')) {
          try { pairResult.value = { ok: true, info: JSON.parse(line.slice(10)) }; }
          catch (_) { pairResult.value = { ok: true, info: {} }; }
          restarting.value = true;
          sawDisconnect = false;
        } else if (line.startsWith('RESULT_FAIL ')) {
          pairResult.value = { ok: false, error: line.slice(12) };
        } else if (line) {
          pairLog.value += line + '\n';
        }
      }
    }
    await refresh();
  } catch (err) {
    pairResult.value = { ok: false, error: String(err.message || err) };
  } finally {
    pairing.value = false;
  }
}

// Push updates via SSE so pair/unpair events reach the UI immediately.
// The slow fallback poll only runs if the EventSource drops silently.
let es = null;
let reconnectTimer = null;
function openEvents() {
  try { es && es.close(); } catch (_) {}
  es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    try {
      const s = JSON.parse(e.data);
      Object.assign(state, s);
      if (restarting.value && sawDisconnect && s._reason === 'init') restarting.value = false;
    } catch (_) {}
  });
  es.onerror = () => {
    if (restarting.value) sawDisconnect = true;
    try { es.close(); } catch (_) {}
    es = null;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; openEvents(); }, 3000);
  };
}

let fallbackTimer = null;
onMounted(() => {
  refresh();
  openEvents();
  fallbackTimer = setInterval(refresh, 30_000);
});
onUnmounted(() => {
  try { es && es.close(); } catch (_) {}
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (fallbackTimer) clearInterval(fallbackTimer);
});
</script>

<style scoped>
.title {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  padding: 0 24px 8px 24px;
  height: 60px;
  color: #fff;
  background: #0b3d91;
  font-size: 2rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.title .version { font-size: 1.5rem; font-weight: 400; opacity: 0.9; }

main {
  max-width: 720px;
  margin: 1.5rem auto 3rem;
  padding: 0 1rem;
}

.card {
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 1rem 1.25rem;
  margin: 1rem 0;
}
.card h2 { font-size: 1.15rem; margin: 0 0 .75rem; }

.ok { color: #090; }
.fail { color: #c00; }
.muted { color: #777; }

code {
  background: #f0f0f0;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 90%;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
pre {
  background: #111;
  color: #0f0;
  padding: .5rem;
  overflow: auto;
  max-height: 20rem;
  font-size: 12px;
  white-space: pre-wrap;
  border-radius: 4px;
}

label { display: block; margin: .6rem 0 .2rem; font-weight: 500; }
input[type=file],
input[type=text] {
  font: inherit;
  padding: .4rem .5rem;
  width: 100%;
  max-width: 460px;
  border: 1px solid #bbb;
  border-radius: 4px;
}
input[type=text]:focus,
input[type=file]:focus { outline: 2px solid #0b3d91; outline-offset: 1px; }

button {
  background: #0b3d91;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: .5rem 1.2rem;
  cursor: pointer;
  font: inherit;
}
button:hover { background: #164a9f; }
button:disabled { background: #888; cursor: not-allowed; }

.pincode {
  font-size: 1.6rem;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  letter-spacing: 2px;
  margin: .25rem 0;
}
.hk-row { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; }

.file-chips code { margin-right: 4px; }
.file-chips .ok { margin-right: 2px; }
</style>
