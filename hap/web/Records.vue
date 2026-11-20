<template>
  <section class="card">
    <div class="rec-head">
      <h2>録画一覧</h2>
      <button class="secondary" @click="reload" :disabled="loading">再読み込み</button>
    </div>
    <p class="muted small">
      ドアホン親機に保存されている録画です。表示中は親機に「スマホで使用中です」と表示されることがあります。
    </p>

    <p v-if="error" class="fail">
      {{ error }}
      <button v-if="errorRetry" class="secondary" @click="errorRetry">再試行</button>
    </p>

    <template v-for="group in groups" :key="group.date">
      <h3 class="date">{{ group.date }}</h3>
      <div class="grid">
        <button v-for="r in group.items" :key="r.id" class="rec" @click="open(r)" :title="r.triggerLabel">
          <div class="thumb">
            <img :src="'/api/records/thumb/' + r.thumbId" loading="lazy" alt="" @error="onThumbError">
            <span v-if="r.unread" class="dot" title="未読"></span>
            <span v-if="r.triggerLabel" class="badge" :class="'t-' + r.trigger">{{ r.triggerLabel }}</span>
          </div>
          <div class="meta">
            <span class="time">{{ fmtTime(r.time) }}</span>
            <span class="device">{{ r.device }}<template v-if="r.faceTag"> · {{ r.faceTag }}</template></span>
            <span v-if="r.videoCached" class="cached" title="RPi に保存済み（すぐ再生できます）">●</span>
          </div>
        </button>
      </div>
    </template>

    <p v-if="loading" class="muted">読み込み中…</p>
    <p v-else-if="!records.length && !error" class="muted">録画はありません。</p>
    <p v-if="hasNext && !loading"><button class="secondary" @click="loadMore">さらに読み込む</button></p>
  </section>

  <div v-if="current" class="modal" @click.self="close">
    <div class="player">
      <div class="player-head">
        <span>{{ fmtDate(current.time) }} {{ fmtTime(current.time) }}　{{ current.device }}
          <span v-if="current.triggerLabel" class="badge inline" :class="'t-' + current.trigger">{{ current.triggerLabel }}</span>
        </span>
        <button class="close" @click="close" aria-label="閉じる">×</button>
      </div>
      <p v-if="videoLoading && !videoError" class="muted loading">
        録画を取得中…（初回は親機からのダウンロードに数秒かかります）
      </p>
      <p v-if="videoError" class="fail">{{ videoError }}</p>
      <video
        v-show="!videoError"
        ref="videoEl"
        :src="videoSrc"
        controls autoplay playsinline
        @canplay="videoLoading = false"
        @error="onVideoError"
      ></video>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';

const PAGE = 20;
const records = ref([]);
const hasNext = ref(false);
const loading = ref(false);
const error = ref('');
const errorRetry = ref(null);

const current = ref(null);
const videoSrc = ref('');
const videoLoading = ref(false);
const videoError = ref('');
const videoEl = ref(null);

const WD = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const groups = computed(() => {
  const out = [];
  for (const r of records.value) {
    const date = fmtDate(r.time) || '日時不明';
    let g = out[out.length - 1];
    if (!g || g.date !== date) { g = { date, items: [] }; out.push(g); }
    g.items.push(r);
  }
  return out;
});

async function fetchPage(offset) {
  const res = await fetch(`/api/records?offset=${offset}&limit=${PAGE}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error || `HTTP ${res.status}`);
    e.code = body.code;
    throw e;
  }
  return body;
}

async function load(offset) {
  loading.value = true;
  error.value = '';
  errorRetry.value = null;
  try {
    const body = await fetchPage(offset);
    records.value = offset === 0 ? body.records : records.value.concat(body.records);
    hasNext.value = body.hasNext;
  } catch (e) {
    error.value = e.code === 'LIVE_BUSY'
      ? 'Apple Home でライブ映像を表示中のため、録画を読み込めません。ライブを閉じてから再試行してください。'
      : '録画一覧を取得できませんでした: ' + e.message;
    errorRetry.value = () => load(offset);
  } finally {
    loading.value = false;
  }
}
const reload = () => load(0);
const loadMore = () => load(records.value.length);

function onThumbError(e) {
  // Leave a neutral box; the server may have been busy (live view).
  e.target.style.visibility = 'hidden';
}

async function open(r) {
  current.value = r;
  videoError.value = '';
  videoLoading.value = true;
  videoSrc.value = '/api/records/video/' + r.id;
  r.unread = false;
  await nextTick();
}

async function onVideoError() {
  if (!videoSrc.value) return;
  // <video> gives no details; ask the endpoint for its JSON error.
  try {
    const res = await fetch(videoSrc.value, { headers: { Range: 'bytes=0-0' } });
    if (res.ok) { videoError.value = 'このブラウザでは再生できませんでした。'; return; }
    const body = await res.json().catch(() => ({}));
    videoError.value = res.status === 409
      ? 'Apple Home でライブ映像を表示中のため、録画を取得できません。'
      : (body.error || `録画を取得できませんでした (HTTP ${res.status})`);
  } catch (e) {
    videoError.value = '録画を取得できませんでした: ' + (e.message || e);
  } finally {
    videoLoading.value = false;
  }
}

function close() {
  try { videoEl.value && videoEl.value.pause(); } catch (_) {}
  if (current.value) {
    const r = records.value.find(x => x.id === current.value.id);
    if (r && !videoError.value) r.videoCached = true;
  }
  current.value = null;
  videoSrc.value = '';
}

onMounted(reload);
</script>

<style scoped>
.rec-head { display: flex; justify-content: space-between; align-items: center; }
.rec-head h2 { margin: 0; }
.small { font-size: 13px; }
.date { font-size: 1rem; margin: 1.2rem 0 .5rem; color: #333; border-bottom: 1px solid #eee; padding-bottom: .25rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: .75rem; }
.rec {
  background: #fafafa; color: inherit; border: 1px solid #ddd; border-radius: 6px;
  padding: 0; text-align: left; overflow: hidden; cursor: pointer;
}
.rec:hover { background: #f0f4fb; border-color: #0b3d91; }
.thumb { position: relative; aspect-ratio: 16 / 9; background: #ddd; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dot { position: absolute; top: 6px; right: 6px; width: 10px; height: 10px; border-radius: 50%; background: #e33; box-shadow: 0 0 0 2px #fff; }
.badge {
  position: absolute; left: 6px; bottom: 6px; font-size: 11px; padding: 1px 6px; border-radius: 3px;
  background: rgba(0, 0, 0, .65); color: #fff;
}
.badge.inline { position: static; margin-left: .4rem; vertical-align: middle; }
.t-TRIGGER_INCOMINGCALL, .t-TRIGGER_DELIVERY_INCOMINGCALL { background: #0b6bcb; }
.t-TRIGGER_INTRUSION, .t-TRIGGER_LOITERING { background: #c0392b; }
.t-TRIGGER_CAMERAMOTION { background: #d68910; }
.meta { display: flex; gap: .4rem; align-items: baseline; padding: .35rem .5rem; font-size: 13px; }
.time { font-weight: 600; }
.device { color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.cached { color: #090; font-size: 10px; }
button.secondary { background: #fff; color: #0b3d91; border: 1px solid #0b3d91; padding: .3rem .8rem; }
button.secondary:hover { background: #eef3fb; }

.modal {
  position: fixed; inset: 0; background: rgba(0, 0, 0, .7);
  display: flex; align-items: center; justify-content: center; z-index: 10; padding: 1rem;
}
.player { background: #000; border-radius: 6px; width: min(960px, 100%); overflow: hidden; }
.player-head { display: flex; justify-content: space-between; align-items: center; color: #fff; padding: .5rem .75rem; font-size: 14px; }
.player video { width: 100%; display: block; background: #000; aspect-ratio: 16 / 9; }
.player .loading, .player .fail { padding: .5rem .75rem; margin: 0; }
.player .loading { color: #ccc; }
button.close { background: transparent; font-size: 1.5rem; line-height: 1; padding: 0 .4rem; }
button.close:hover { background: #333; }
</style>
