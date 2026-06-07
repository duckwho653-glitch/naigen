// ==UserScript==
// @name         NAI Batch Generator Standalone
// @namespace    local.nai-batch-generator
// @version      0.5.0
// @description  Standalone NovelAI image batch generator using GM_xmlhttpRequest. Sequential only, no parallel requests.
// @match        https://novelai.net/*
// @match        https://*.novelai.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @connect      image.novelai.net
// @connect      api.novelai.net
// @connect      novelai.net
// @connect      *.novelai.net
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'nai_batch_generator_standalone_v050';
  const PANEL_ID = 'nai-batch-generator-panel';
  const TOGGLE_ID = 'nai-batch-generator-toggle';

  let running = false;
  let selectedDirectoryHandle = null;

  const DEFAULTS = {
    token: '',
    model: 'nai-diffusion-4-5-full',
    prompt: '',
    negative: 'lowres, artistic error, worst quality, bad quality, jpeg artifacts, very displeasing, bad anatomy, bad hands, text, watermark',
    width: 832,
    height: 1216,
    count: 100,
    steps: 28,
    scale: 6.5,
    cfgRescale: 0.3,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
    delayMs: 5000,
    seedMode: 'random',
    seed: '',
    prefix: 'nai_batch',
    downloadSubfolder: 'nai_batch',
    saveMode: 'download',
    ucPreset: 0,
    qualityToggle: false
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function normalizePrompt(text) {
    return String(text || '')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .join(', ');
  }

  function convertSdWeightToNai(tag) {
    const raw = String(tag || '').trim();
    const match = raw.match(/^\((.+?):\s*([0-9]*\.?[0-9]+)\)$/);
    if (match) {
      const inner = match[1].trim();
      const weight = match[2].trim();
      return `${weight}::${inner}::`;
    }
    return raw;
  }

  function normalizeNaiWeightSyntax(prompt) {
    return String(prompt || '')
      .split(',')
      .map(part => convertSdWeightToNai(part))
      .map(part => part.trim())
      .filter(Boolean)
      .join(', ');
  }

  function randomSeed() {
    return Math.floor(Math.random() * 4294967295);
  }

  function getSeed(settings, index) {
    const base = settings.seed === '' || settings.seed === null || settings.seed === undefined
      ? null
      : Number(settings.seed);

    if (settings.seedMode === 'fixed' && Number.isFinite(base)) return base;
    if (settings.seedMode === 'increment' && Number.isFinite(base)) return base + index;
    return randomSeed();
  }

  function sanitizePathPart(value, fallback = 'nai_batch') {
    const text = String(value || '').trim()
      .replace(/[\\:*?"<>|]+/g, '_')
      .replace(/^\.+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 120);
    return text || fallback;
  }

  function getSavedSettings() {
    try {
      const saved = GM_getValue(STORE_KEY, {});
      return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(settings) {
    GM_setValue(STORE_KEY, { ...settings, token: settings.token || '' });
  }

  function log(message) {
    const box = $('nai-log');
    if (!box) return;
    const time = new Date().toLocaleTimeString();
    box.textContent += `[${time}] ${message}\n`;
    box.scrollTop = box.scrollHeight;
  }

  function setStatus(message) {
    const el = $('nai-status');
    if (el) el.textContent = message || '';
  }

  function buildNaiPayload(settings, seed) {
    const cleanPrompt = normalizeNaiWeightSyntax(normalizePrompt(settings.prompt));
    const cleanNegative = normalizeNaiWeightSyntax(normalizePrompt(settings.negative));
    const model = String(settings.model || 'nai-diffusion-4-5-full').trim() || 'nai-diffusion-4-5-full';

    return {
      input: cleanPrompt,
      model,
      action: 'generate',
      parameters: {
        params_version: 3,

        width: Number(settings.width || 832),
        height: Number(settings.height || 1216),
        scale: Number(settings.scale || 6.5),
        cfg_rescale: Number(settings.cfgRescale ?? 0.3),
        sampler: settings.sampler || 'k_euler_ancestral',
        steps: Number(settings.steps || 28),
        n_samples: 1,
        seed,
        noise_schedule: settings.noiseSchedule || 'karras',

        negative_prompt: cleanNegative,
        uc: cleanNegative,
        ucPreset: Number(settings.ucPreset || 0),
        qualityToggle: !!settings.qualityToggle,

        sm: false,
        sm_dyn: false,
        dynamic_thresholding: false,

        controlnet_strength: 1,
        legacy: false,
        legacy_v3_extend: false,
        add_original_image: false,
        uncond_scale: 1,

        deliberate_euler_ancestral_bug: false,
        prefer_brownian: true,

        reference_information_extracted_multiple: [],
        reference_strength_multiple: [],

        v4_prompt: {
          caption: {
            base_caption: cleanPrompt,
            char_captions: []
          },
          use_coords: false,
          use_order: true,
          legacy_uc: false
        },

        v4_negative_prompt: {
          caption: {
            base_caption: cleanNegative,
            char_captions: []
          },
          use_coords: false,
          use_order: true,
          legacy_uc: false
        }
      }
    };
  }

  function bytesToText(bytes, max = 6000) {
    try {
      return new TextDecoder('utf-8', { fatal: false })
        .decode(bytes.slice(0, Math.min(bytes.length, max)))
        .trim();
    } catch (_) {
      return '';
    }
  }

  function detectBinarySignature(bytes) {
    if (!bytes || !bytes.length) return 'empty';
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';

    const head = bytesToText(bytes, 240);
    if (head.startsWith('{') || head.startsWith('[')) return 'json';
    if (head.startsWith('<')) return 'html';
    return 'unknown';
  }

  function errorMessageFromBytes(bytes) {
    const text = bytesToText(bytes, 6000);
    if (!text) return '알 수 없는 오류';

    try {
      const parsed = JSON.parse(text);
      return parsed.error?.message || parsed.message || parsed.error || text;
    } catch (_) {
      return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  function imageBlobFromBytes(bytes, name = 'image') {
    const lower = String(name || '').toLowerCase();
    if (lower.endsWith('.webp')) return { blob: new Blob([bytes], { type: 'image/webp' }), ext: 'webp' };
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return { blob: new Blob([bytes], { type: 'image/jpeg' }), ext: 'jpg' };
    return { blob: new Blob([bytes], { type: 'image/png' }), ext: 'png' };
  }

  function extractImageBlobFromArrayBuffer(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const signature = detectBinarySignature(bytes);

    if (signature === 'zip') {
      if (!window.fflate || !window.fflate.unzipSync) {
        throw new Error('fflate ZIP 라이브러리가 로드되지 않았어. @require 로딩을 확인해줘.');
      }

      const unzipped = window.fflate.unzipSync(bytes);
      const imageEntry = Object.entries(unzipped).find(([name]) => /\.(png|jpg|jpeg|webp)$/i.test(name));

      if (!imageEntry) {
        const textEntry = Object.entries(unzipped).find(([name]) => /\.(txt|json|html)$/i.test(name));
        if (textEntry) throw new Error(errorMessageFromBytes(textEntry[1]));
        throw new Error('ZIP 안에서 이미지 파일을 찾지 못했어.');
      }

      const [name, fileBytes] = imageEntry;
      return imageBlobFromBytes(fileBytes, name);
    }

    if (signature === 'png') return { blob: new Blob([bytes], { type: 'image/png' }), ext: 'png' };
    if (signature === 'jpeg') return { blob: new Blob([bytes], { type: 'image/jpeg' }), ext: 'jpg' };
    if (signature === 'webp') return { blob: new Blob([bytes], { type: 'image/webp' }), ext: 'webp' };

    throw new Error(errorMessageFromBytes(bytes));
  }

  function gmRequestArrayBuffer(details) {
    return new Promise((resolve, reject) => {
      const fn = typeof GM_xmlhttpRequest === 'function'
        ? GM_xmlhttpRequest
        : (GM && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);

      if (!fn) {
        reject(new Error('GM_xmlhttpRequest를 찾지 못했어. Tampermonkey 권한 설정을 확인해줘.'));
        return;
      }

      fn({
        method: details.method || 'GET',
        url: details.url,
        headers: details.headers || {},
        data: details.data,
        responseType: 'arraybuffer',
        timeout: Number(details.timeout || 240000),
        onload: response => {
          const status = Number(response.status || 0);
          const body = response.response;
          if (status >= 200 && status < 300) {
            resolve(body);
            return;
          }

          let message = `HTTP ${status}`;
          try {
            if (body) message += ` — ${errorMessageFromBytes(new Uint8Array(body))}`;
            else if (response.responseText) message += ` — ${String(response.responseText).slice(0, 1000)}`;
          } catch (_) {}
          reject(new Error(message));
        },
        onerror: error => reject(new Error(`GM_xmlhttpRequest network error: ${error?.error || error?.message || '요청 실패'}`)),
        ontimeout: () => reject(new Error('GM_xmlhttpRequest timeout: NAI 응답 대기 시간이 초과됐어.')),
        onabort: () => reject(new Error('GM_xmlhttpRequest aborted: 요청이 중단됐어.'))
      });
    });
  }

  async function generateOne(settings, seed) {
    const payload = buildNaiPayload(settings, seed);
    const token = String(settings.token || '').replace(/^Bearer\s+/i, '').trim();

    const arrayBuffer = await gmRequestArrayBuffer({
      method: 'POST',
      url: 'https://image.novelai.net/ai/generate-image',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      data: JSON.stringify(payload),
      timeout: 300000
    });

    return extractImageBlobFromArrayBuffer(arrayBuffer);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Blob을 Data URL로 변환하지 못했어.'));
      reader.readAsDataURL(blob);
    });
  }

  async function saveBlobWithGmDownload(blob, filename) {
    const url = URL.createObjectURL(blob);

    return new Promise((resolve, reject) => {
      if (typeof GM_download === 'function') {
        try {
          GM_download({
            url,
            name: filename,
            saveAs: false,
            onload: () => {
              setTimeout(() => URL.revokeObjectURL(url), 30000);
              resolve();
            },
            onerror: async err => {
              URL.revokeObjectURL(url);
              // 일부 브라우저/설정에서 blob URL GM_download가 막히면 data URL로 한 번 더 시도.
              try {
                const dataUrl = await blobToDataUrl(blob);
                GM_download({
                  url: dataUrl,
                  name: filename,
                  saveAs: false,
                  onload: () => resolve(),
                  onerror: err2 => reject(new Error(`GM_download 실패: ${err2?.error || err?.error || 'unknown'}`))
                });
              } catch (fallbackErr) {
                reject(fallbackErr);
              }
            }
          });
          return;
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
          return;
        }
      }

      const a = document.createElement('a');
      a.href = url;
      a.download = filename.split('/').pop() || 'nai_image.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      resolve();
    });
  }

  async function saveBlobToDirectory(blob, filename) {
    if (!selectedDirectoryHandle) throw new Error('직접 저장할 폴더가 선택되지 않았어.');
    const safeName = filename.split('/').pop();
    const fileHandle = await selectedDirectoryHandle.getFileHandle(safeName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async function saveBlob(blob, filename, settings) {
    if (settings.saveMode === 'folder' && selectedDirectoryHandle) {
      await saveBlobToDirectory(blob, filename);
      return;
    }
    await saveBlobWithGmDownload(blob, filename);
  }

  function collectSettings() {
    return {
      token: $('nai-token')?.value.trim() || '',
      model: $('nai-model')?.value.trim() || DEFAULTS.model,
      prompt: $('nai-prompt')?.value.trim() || '',
      negative: $('nai-negative')?.value.trim() || '',
      width: Number($('nai-width')?.value || DEFAULTS.width),
      height: Number($('nai-height')?.value || DEFAULTS.height),
      count: Number($('nai-count')?.value || DEFAULTS.count),
      steps: Number($('nai-steps')?.value || DEFAULTS.steps),
      scale: Number($('nai-scale')?.value || DEFAULTS.scale),
      cfgRescale: Number($('nai-cfg-rescale')?.value || DEFAULTS.cfgRescale),
      sampler: $('nai-sampler')?.value || DEFAULTS.sampler,
      noiseSchedule: $('nai-noise-schedule')?.value || DEFAULTS.noiseSchedule,
      delayMs: Number($('nai-delay')?.value || DEFAULTS.delayMs),
      seedMode: $('nai-seed-mode')?.value || DEFAULTS.seedMode,
      seed: $('nai-seed')?.value.trim() || '',
      prefix: $('nai-prefix')?.value.trim() || DEFAULTS.prefix,
      downloadSubfolder: $('nai-download-subfolder')?.value.trim() || DEFAULTS.downloadSubfolder,
      saveMode: $('nai-save-mode')?.value || DEFAULTS.saveMode,
      ucPreset: Number($('nai-uc-preset')?.value || DEFAULTS.ucPreset),
      qualityToggle: !!$('nai-quality-toggle')?.checked
    };
  }

  function validateSettings(settings) {
    if (!settings.token) throw new Error('NAI API Key / Token이 비어 있어.');
    if (!settings.prompt) throw new Error('Positive Prompt가 비어 있어.');
    if (!Number.isFinite(settings.count) || settings.count < 1) throw new Error('Count는 1 이상이어야 해.');
    if (settings.count > 500) throw new Error('안전상 Count는 500 이하로 제한했어.');
    if (!Number.isFinite(settings.width) || !Number.isFinite(settings.height)) throw new Error('Width/Height가 숫자가 아니야.');
    if (settings.width < 64 || settings.height < 64) throw new Error('Width/Height 값이 너무 작아.');
    if (settings.delayMs < 0) throw new Error('Delay는 0 이상이어야 해.');
  }

  async function startBatch() {
    if (running) return;

    const settings = collectSettings();

    try {
      validateSettings(settings);
      saveSettings(settings);

      running = true;
      setStatus('running');
      log(`생성 시작: ${settings.count}장 / 저장 방식: ${settings.saveMode === 'folder' && selectedDirectoryHandle ? '직접 선택 폴더' : '다운로드 폴더'}`);

      const subfolder = sanitizePathPart(settings.downloadSubfolder || settings.prefix, 'nai_batch');
      const prefix = sanitizePathPart(settings.prefix || 'nai_batch', 'nai_batch');

      for (let i = 0; i < settings.count; i++) {
        if (!running) break;

        const index = i + 1;
        const seed = getSeed(settings, i);
        setStatus(`running ${index}/${settings.count}`);
        log(`${index}/${settings.count} 요청 중... seed=${seed}`);

        const { blob, ext } = await generateOne(settings, seed);
        const padded = String(index).padStart(4, '0');
        const baseName = `${prefix}_${padded}_seed-${seed}.${ext}`;
        const filename = settings.saveMode === 'folder' && selectedDirectoryHandle
          ? baseName
          : `${subfolder}/${baseName}`;

        await saveBlob(blob, filename, settings);
        log(`${index}/${settings.count} 저장 완료: ${filename}`);

        if (index < settings.count && settings.delayMs > 0 && running) {
          await sleep(settings.delayMs);
        }
      }

      log(running ? '전체 생성 완료' : '사용자 정지');
    } catch (err) {
      log(`오류: ${err.message || err}`);
    } finally {
      running = false;
      setStatus('stopped');
    }
  }

  function stopBatch() {
    running = false;
    setStatus('stopping...');
    log('정지 요청됨. 현재 요청이 끝난 뒤 멈춰.');
  }

  async function chooseFolder() {
    if (!window.showDirectoryPicker) {
      log('이 브라우저에서는 직접 폴더 선택 기능을 지원하지 않아. 다운로드 하위폴더 저장을 사용해줘.');
      return;
    }

    try {
      selectedDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      $('nai-save-mode').value = 'folder';
      log(`폴더 선택 완료: ${selectedDirectoryHandle.name}`);
    } catch (err) {
      log(`폴더 선택 취소/실패: ${err.message || err}`);
    }
  }

  function fillSettings(settings) {
    $('nai-token').value = settings.token || '';
    $('nai-model').value = settings.model || DEFAULTS.model;
    $('nai-prompt').value = settings.prompt || '';
    $('nai-negative').value = settings.negative || '';
    $('nai-width').value = settings.width ?? DEFAULTS.width;
    $('nai-height').value = settings.height ?? DEFAULTS.height;
    $('nai-count').value = settings.count ?? DEFAULTS.count;
    $('nai-steps').value = settings.steps ?? DEFAULTS.steps;
    $('nai-scale').value = settings.scale ?? DEFAULTS.scale;
    $('nai-cfg-rescale').value = settings.cfgRescale ?? DEFAULTS.cfgRescale;
    $('nai-sampler').value = settings.sampler || DEFAULTS.sampler;
    $('nai-noise-schedule').value = settings.noiseSchedule || DEFAULTS.noiseSchedule;
    $('nai-delay').value = settings.delayMs ?? DEFAULTS.delayMs;
    $('nai-seed-mode').value = settings.seedMode || DEFAULTS.seedMode;
    $('nai-seed').value = settings.seed || '';
    $('nai-prefix').value = settings.prefix || DEFAULTS.prefix;
    $('nai-download-subfolder').value = settings.downloadSubfolder || DEFAULTS.downloadSubfolder;
    $('nai-save-mode').value = settings.saveMode || DEFAULTS.saveMode;
    $('nai-uc-preset').value = settings.ucPreset ?? DEFAULTS.ucPreset;
    $('nai-quality-toggle').checked = !!settings.qualityToggle;
  }

  function addStyles() {
    GM_addStyle(`
      #${TOGGLE_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        background: #6d5dfc;
        color: #fff;
        font: 800 13px system-ui, sans-serif;
        box-shadow: 0 8px 28px rgba(0,0,0,.35);
        cursor: pointer;
      }
      #${PANEL_ID} {
        position: fixed;
        right: 16px;
        bottom: 62px;
        width: min(760px, calc(100vw - 32px));
        max-height: min(840px, calc(100vh - 86px));
        overflow: auto;
        z-index: 2147483647;
        background: #11131a;
        color: #eef0f7;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(0,0,0,.55);
        font: 13px system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        display: none;
      }
      #${PANEL_ID}.open { display: block; }
      #${PANEL_ID} * { box-sizing: border-box; }
      .nai-head {
        position: sticky;
        top: 0;
        background: #11131a;
        z-index: 1;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(255,255,255,.1);
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
      }
      .nai-title { font-weight: 900; font-size: 15px; }
      .nai-body { padding: 14px 16px 16px; }
      .nai-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 10px; }
      .nai-grid.two { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .nai-field { margin-bottom: 10px; }
      .nai-field label { display: block; margin-bottom: 5px; font-size: 11px; font-weight: 800; color: #b9bfd4; }
      #${PANEL_ID} input,
      #${PANEL_ID} textarea,
      #${PANEL_ID} select {
        width: 100%;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 10px;
        background: #0b0d12;
        color: #eef0f7;
        padding: 9px 10px;
        font: 13px system-ui, sans-serif;
        outline: none;
      }
      #${PANEL_ID} textarea { min-height: 92px; resize: vertical; }
      #nai-log {
        margin: 10px 0 0;
        padding: 10px;
        min-height: 110px;
        max-height: 220px;
        overflow: auto;
        white-space: pre-wrap;
        background: #07080c;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 10px;
        color: #d9def2;
      }
      .nai-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .nai-btn {
        border: 0;
        border-radius: 10px;
        padding: 9px 12px;
        background: #343948;
        color: #fff;
        font-weight: 850;
        cursor: pointer;
      }
      .nai-btn.primary { background: #6d5dfc; }
      .nai-btn.danger { background: #b91c1c; }
      .nai-btn.ghost { background: transparent; border: 1px solid rgba(255,255,255,.16); }
      .nai-note { color: #9ca3b8; font-size: 12px; line-height: 1.45; margin: 8px 0 12px; }
      .nai-status { color: #a5b4fc; font-size: 12px; font-weight: 800; }
      .nai-check { display:flex; gap:8px; align-items:center; margin-top: 24px; color:#cbd5e1; }
      .nai-check input { width:auto !important; }
      @media (max-width: 720px) {
        .nai-grid, .nai-grid.two { grid-template-columns: 1fr; }
        #${PANEL_ID} { right: 8px; bottom: 58px; width: calc(100vw - 16px); }
        #${TOGGLE_ID} { right: 8px; }
      }
    `);
  }

  function createPanel() {
    if ($(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="nai-head">
        <div>
          <div class="nai-title">NAI Batch Generator</div>
          <div id="nai-status" class="nai-status">stopped</div>
        </div>
        <button id="nai-close" class="nai-btn ghost" type="button">닫기</button>
      </div>
      <div class="nai-body">
        <div class="nai-note">NovelAI 페이지 위에서만 뜨는 단독 생성기야. 요청은 fetch가 아니라 Tampermonkey GM_xmlhttpRequest로 보냄.</div>

        <div class="nai-field">
          <label>NAI API Key / Token</label>
          <input id="nai-token" type="password" autocomplete="off" placeholder="Bearer 제외하고 토큰만 넣어도 됨">
        </div>

        <div class="nai-grid two">
          <div class="nai-field">
            <label>Model</label>
            <select id="nai-model">
              <option value="nai-diffusion-4-5-full">nai-diffusion-4-5-full</option>
              <option value="nai-diffusion-4-5-curated">nai-diffusion-4-5-curated</option>
              <option value="nai-diffusion-4-full">nai-diffusion-4-full</option>
              <option value="nai-diffusion-3">nai-diffusion-3</option>
            </select>
          </div>
          <div class="nai-field">
            <label>Count</label>
            <input id="nai-count" type="number" min="1" max="500" value="100">
          </div>
        </div>

        <div class="nai-field">
          <label>Positive Prompt</label>
          <textarea id="nai-prompt" placeholder="masterpiece, best quality, 1girl, ..."></textarea>
        </div>

        <div class="nai-field">
          <label>Negative / UC</label>
          <textarea id="nai-negative"></textarea>
        </div>

        <div class="nai-grid">
          <div class="nai-field"><label>Width</label><input id="nai-width" type="number" value="832"></div>
          <div class="nai-field"><label>Height</label><input id="nai-height" type="number" value="1216"></div>
          <div class="nai-field"><label>Steps</label><input id="nai-steps" type="number" value="28"></div>
        </div>

        <div class="nai-grid">
          <div class="nai-field"><label>Guidance Scale</label><input id="nai-scale" type="number" step="0.1" value="6.5"></div>
          <div class="nai-field"><label>Guidance Rescale</label><input id="nai-cfg-rescale" type="number" step="0.05" value="0.3"></div>
          <div class="nai-field"><label>Delay ms</label><input id="nai-delay" type="number" value="5000"></div>
        </div>

        <div class="nai-grid">
          <div class="nai-field">
            <label>Sampler</label>
            <select id="nai-sampler">
              <option value="k_euler_ancestral">k_euler_ancestral</option>
              <option value="k_euler">k_euler</option>
              <option value="k_dpmpp_2m">k_dpmpp_2m</option>
              <option value="k_dpmpp_2s_ancestral">k_dpmpp_2s_ancestral</option>
            </select>
          </div>
          <div class="nai-field">
            <label>Noise Schedule</label>
            <select id="nai-noise-schedule">
              <option value="karras">karras</option>
              <option value="native">native</option>
              <option value="exponential">exponential</option>
            </select>
          </div>
          <div class="nai-field">
            <label>UC Preset</label>
            <select id="nai-uc-preset">
              <option value="0">Heavy UC</option>
              <option value="1">Light UC</option>
              <option value="2">None</option>
              <option value="3">Human Focus UC</option>
              <option value="4">Furry Focus UC</option>
            </select>
          </div>
        </div>

        <div class="nai-grid">
          <div class="nai-field">
            <label>Seed Mode</label>
            <select id="nai-seed-mode">
              <option value="random">매번 랜덤</option>
              <option value="fixed">고정 Seed</option>
              <option value="increment">Seed + 순번</option>
            </select>
          </div>
          <div class="nai-field"><label>Seed</label><input id="nai-seed" type="number" placeholder="비우면 랜덤"></div>
          <label class="nai-check"><input id="nai-quality-toggle" type="checkbox"> Quality Toggle</label>
        </div>

        <div class="nai-grid">
          <div class="nai-field"><label>Filename Prefix</label><input id="nai-prefix" value="nai_batch"></div>
          <div class="nai-field"><label>Downloads Subfolder</label><input id="nai-download-subfolder" value="nai_batch"></div>
          <div class="nai-field">
            <label>Save Mode</label>
            <select id="nai-save-mode">
              <option value="download">Chrome 다운로드 폴더</option>
              <option value="folder">직접 선택한 폴더</option>
            </select>
          </div>
        </div>

        <div class="nai-actions">
          <button id="nai-save" class="nai-btn" type="button">설정 저장</button>
          <button id="nai-choose-folder" class="nai-btn" type="button">폴더 선택</button>
          <button id="nai-start" class="nai-btn primary" type="button">생성 시작</button>
          <button id="nai-stop" class="nai-btn danger" type="button">정지</button>
          <button id="nai-clear-log" class="nai-btn ghost" type="button">로그 지우기</button>
        </div>

        <pre id="nai-log"></pre>
      </div>
    `;

    const toggle = document.createElement('button');
    toggle.id = TOGGLE_ID;
    toggle.type = 'button';
    toggle.textContent = 'NAI Batch';

    document.body.appendChild(panel);
    document.body.appendChild(toggle);

    fillSettings(getSavedSettings());

    toggle.addEventListener('click', () => panel.classList.toggle('open'));
    $('nai-close').addEventListener('click', () => panel.classList.remove('open'));
    $('nai-save').addEventListener('click', () => {
      const settings = collectSettings();
      saveSettings(settings);
      log('설정 저장 완료');
    });
    $('nai-start').addEventListener('click', startBatch);
    $('nai-stop').addEventListener('click', stopBatch);
    $('nai-choose-folder').addEventListener('click', chooseFolder);
    $('nai-clear-log').addEventListener('click', () => { $('nai-log').textContent = ''; });

    if (!window.showDirectoryPicker) {
      $('nai-choose-folder').title = '이 브라우저에서는 직접 폴더 선택을 지원하지 않음';
    }
  }

  addStyles();
  createPanel();
})();
