<template>
  <section class="card">
    <h2>NAS バックアップ</h2>
    <p class="muted small">
      親機の録画を定期的に NAS（CIFS/SMB 共有）へコピーします。コピー時は親機に一瞬
      「スマホで使用中」と表示されることがあります。
    </p>

    <p v-if="error" class="fail">{{ error }}</p>

    <form v-if="cfg" @submit.prevent="save">
      <label class="switch">
        <input type="checkbox" v-model="cfg.enabled"> NAS バックアップを有効にする
      </label>

      <fieldset :disabled="!cfg.enabled">
        <h3>NAS 設定</h3>
        <label>ネットワークPATH（<code>//server/共有/フォルダ</code>）</label>
        <input type="text" v-model.trim="cfg.server" placeholder="//192.168.0.10/share/doorphone">

        <div class="row">
          <div>
            <label>アカウント</label>
            <input type="text" v-model.trim="cfg.user" autocomplete="username">
          </div>
          <div>
            <label>パスワード</label>
            <input type="password" v-model="cfg.password" :placeholder="cfg.hasPassword ? '（設定済み：変更する場合のみ入力）' : ''" autocomplete="new-password">
          </div>
          <div class="narrow">
            <label>SMB</label>
            <select v-model="cfg.vers">
              <option value="3.0">3.0</option>
              <option value="2.1">2.1</option>
              <option value="2.0">2.0</option>
              <option value="1.0">1.0</option>
            </select>
          </div>
        </div>

        <h3>録画設定</h3>
        <label>保存するPATH（strftime 書式。拡張子は自動付加）</label>
        <input type="text" v-model.trim="cfg.pathTemplate" placeholder="%Y%m%d/%H%M%S">

        <div class="row">
          <div class="narrow">
            <label>確認の間隔（分）</label>
            <input type="number" v-model.number="cfg.intervalMinutes" min="5">
          </div>
          <div class="narrow">
            <label>初回の遡り日数</label>
            <input type="number" v-model.number="cfg.backfillDays" min="0">
          </div>
          <div>
            <label class="switch inline">
              <input type="checkbox" v-model="cfg.thumbnails"> サムネイル(JPG)も保存
            </label>
          </div>
        </div>

        <label class="switch">
          <input type="checkbox" v-model="cfg.remove"> ファイルの自動削除（NAS 上のコピーを対象）
        </label>
        <div v-if="cfg.remove" class="row">
          <div class="narrow">
            <label>保存日数</label>
            <input type="number" v-model.number="cfg.removeDays" min="1">
          </div>
        </div>
      </fieldset>

      <p class="actions">
        <button type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
        <button type="button" class="secondary" @click="syncNow" :disabled="syncing || running || !cfg.enabled">
          {{ (syncing || running) ? '同期中…' : '今すぐ同期' }}
        </button>
        <span v-if="savedMsg" class="ok small">{{ savedMsg }}</span>
      </p>
    </form>

    <p v-else-if="!error" class="muted">読み込み中…</p>

    <div v-if="running || note || hasResult" class="status">
      <h3>直近の同期</h3>
      <p v-if="running" class="small muted">
        同期を実行中です…（親機から順にダウンロードします）
        <template v-if="progress && progress.total">
          {{ progress.copied + progress.failed }} / {{ progress.total }} 件<template v-if="progress.failed">（スキップ {{ progress.failed }} 件）</template>
        </template>
      </p>
      <p v-else-if="note" class="small muted">{{ note }}</p>
      <p v-else-if="hasResult" class="small">
        {{ fmt(status.at) }}：
        <span :class="status.ok ? 'ok' : 'fail'">{{ status.ok ? '成功' : '失敗' }}</span>
        — コピー {{ status.copied }} 件<template v-if="status.failed"> ／スキップ {{ status.failed }} 件</template><template v-if="status.error">／{{ status.error }}</template>
        <template v-if="status.note === 'live-busy'">（ライブ視聴中のため中断）</template>
      </p>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';

const cfg = ref(null);
const status = ref(null);
const running = ref(false);
const progress = ref(null);
const note = ref('');
const error = ref('');
const saving = ref(false);
const syncing = ref(false);
const savedMsg = ref('');
let pollTimer = null;

// A run result has a numeric copied count; the early-return shapes
// ({skipped:'...'}) do not and are shown via `note` instead.
const hasResult = computed(() => status.value && typeof status.value.copied === 'number');

const SKIP_MSG = {
  'already-running': 'すでに同期を実行中です。',
  'disabled': 'NAS バックアップは無効です。',
  'bad-server': 'ネットワークPATH が不正です（//server/共有/... の形式で入力してください）。',
};

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function load() {
  error.value = '';
  try {
    const r = await fetch('/api/nas');
    const b = await r.json();
    if (!r.ok) { error.value = b.error || `HTTP ${r.status}`; return; }
    cfg.value = { password: '', ...b.config };
    applyStatus(b);
  } catch (e) {
    error.value = '設定を取得できませんでした: ' + (e.message || e);
  }
}

// Update only the status part of an /api/nas response. The form (cfg) is
// left alone so polling never clobbers what the user is editing.
function applyStatus(b) {
  const prevAt = status.value && status.value.at;
  running.value = !!b.running;
  progress.value = b.progress || null;
  if (b.status) status.value = b.status;
  // A new run started or finished since the last "skipped" notice: the
  // notice is stale, show the live state instead.
  if (running.value || (b.status && b.status.at !== prevAt)) note.value = '';
}

// Keep "直近の同期" current without a reload: scheduled (interval) runs start
// and finish on the server on their own. Poll fast while a run is in flight,
// slowly otherwise, and not at all while the tab is hidden.
const POLL_RUNNING_MS = 3000;
const POLL_IDLE_MS = 20000;
let stopped = false;

async function poll() {
  pollTimer = null;
  if (stopped) return;
  if (!document.hidden) {
    try {
      const r = await fetch('/api/nas');
      if (r.ok) applyStatus(await r.json());
    } catch (_) {}
  }
  schedulePoll();
}

function schedulePoll(ms) {
  if (stopped) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms ?? (running.value || syncing.value ? POLL_RUNNING_MS : POLL_IDLE_MS));
}

function startPoll() { schedulePoll(POLL_RUNNING_MS); }

function onVisible() { if (!document.hidden) schedulePoll(0); }

async function save() {
  saving.value = true;
  savedMsg.value = '';
  error.value = '';
  try {
    const r = await fetch('/api/nas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg.value),
    });
    const b = await r.json();
    if (!r.ok) { error.value = b.error || `HTTP ${r.status}`; return; }
    cfg.value = { password: '', ...b.config };
    savedMsg.value = '保存しました';
    setTimeout(() => (savedMsg.value = ''), 3000);
  } catch (e) {
    error.value = '保存できませんでした: ' + (e.message || e);
  } finally {
    saving.value = false;
  }
}

async function syncNow() {
  syncing.value = true;
  error.value = '';
  note.value = '';
  // The POST only answers when the run ends; poll meanwhile to show progress.
  startPoll();
  try {
    const r = await fetch('/api/nas/sync', { method: 'POST' });
    const b = await r.json();
    if (!r.ok) { error.value = b.error || `HTTP ${r.status}`; return; }
    const s = b.status;
    if (s && typeof s.skipped === 'string') {
      // Early return (already-running / disabled / bad-server): not a result.
      note.value = SKIP_MSG[s.skipped] || `同期をスキップしました（${s.skipped}）`;
      if (s.skipped === 'already-running') { running.value = true; startPoll(); }
    } else {
      status.value = s;
    }
  } catch (e) {
    error.value = '同期を実行できませんでした: ' + (e.message || e);
  } finally {
    syncing.value = false;
  }
}

onMounted(async () => {
  await load();
  schedulePoll();
  document.addEventListener('visibilitychange', onVisible);
});
onUnmounted(() => {
  stopped = true;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  document.removeEventListener('visibilitychange', onVisible);
});
</script>

<style scoped>
.small { font-size: 13px; }
form { margin-top: .5rem; }
fieldset { border: 1px solid #e0e0e0; border-radius: 6px; padding: .5rem 1rem 1rem; margin: .5rem 0; }
fieldset[disabled] { opacity: .55; }
h3 { margin: 1rem 0 .4rem; font-size: 1rem; }
label { display: block; margin: .6rem 0 .2rem; font-size: 14px; }
label.switch { display: flex; align-items: center; gap: .5rem; margin: .8rem 0; font-size: 15px; }
label.switch.inline { margin-top: 1.9rem; }
input[type=text], input[type=password], input[type=number], select {
  width: 100%; box-sizing: border-box; padding: .4rem .5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;
}
.row { display: flex; gap: .75rem; flex-wrap: wrap; }
.row > div { flex: 1; min-width: 140px; }
.row > div.narrow { flex: 0 0 110px; min-width: 90px; }
.actions { display: flex; align-items: center; gap: .75rem; margin-top: 1rem; }
button.secondary { background: #fff; color: #0b3d91; border: 1px solid #0b3d91; }
button.secondary:hover:not(:disabled) { background: #eef3fb; }
.status { margin-top: 1rem; border-top: 1px solid #eee; padding-top: .5rem; }
.ok { color: #0a7d28; }
.fail { color: #c00; }
</style>
