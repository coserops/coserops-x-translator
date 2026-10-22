// ==UserScript==
// @name         X 时间线翻译
// @namespace    coserops/x-timeline-translator
// @version      0.1.0
// @description  按需翻译 X / Twitter 时间线正文，保留原文并支持切换目标语言。
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const STORAGE_KEY = 'x-translator.settings.v1';
  const LANGUAGES = [
    ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'],
    ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'],
    ['de', 'Deutsch'], ['es', 'Español'], ['pt', 'Português'],
    ['ru', 'Русский'], ['ar', 'العربية'],
  ];
  const MAX_CACHE = 200;
  const MAX_CONCURRENT = 4;
  const MAX_TEXT_LENGTH = 20000;
  const states = new Map();
  const cache = new Map();
  const pending = new Map();
  let settings = { endpoint: '', targetLanguage: 'zh-CN' };
  let settingsVersion = 0;
  let timer;
  let initializationError = '';

  function validateEndpoint(value) {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new Error('接口必须使用 HTTPS；本地开发允许 localhost 的 HTTP 地址。');
    }
    if (url.username || url.password || url.hash || url.search) {
      throw new Error('接口地址不能包含账号、密码、查询参数或片段。');
    }
    return url.href;
  }

  try {
    const stored = GM_getValue(STORAGE_KEY, null);
    if (stored !== null) {
      if (!stored || typeof stored !== 'object' ||
          typeof stored.endpoint !== 'string' ||
          !LANGUAGES.some(([code]) => code === stored.targetLanguage)) {
        throw new Error('已保存的设置格式不正确，请重新保存设置。');
      }
      settings = {
        endpoint: stored.endpoint ? validateEndpoint(stored.endpoint) : '',
        targetLanguage: stored.targetLanguage,
      };
    }
  } catch (error) {
    console.error('[X Translator] Settings load failed:', error);
    initializationError = '读取设置失败，请重新配置并保存。';
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  const style = element('style');
  style.textContent = `
    .xt-control, .xt-settings-button, .xt-dialog { font: 14px/1.5 system-ui, sans-serif; }
    .xt-control { margin: 8px 0; color: #536471; }
    .xt-button { font: inherit; color: #0969ad; background: transparent; border: 1px solid #8b98a5;
      border-radius: 8px; padding: 4px 10px; cursor: pointer; }
    .xt-button:disabled { opacity: .65; cursor: wait; }
    .xt-button:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 2px; }
    .xt-result { white-space: pre-wrap; overflow-wrap: anywhere; border-left: 3px solid #1d9bf0;
      padding: 8px 12px; margin-top: 8px; color: inherit; }
    .xt-status { display: block; margin-top: 4px; white-space: pre-wrap; }
    .xt-settings-button { position: fixed; bottom: 18px; left: 16px; z-index: 9999;
      background: #fff; box-shadow: 0 2px 8px #0003; }
    .xt-overlay { position: fixed; inset: 0; background: #0008; z-index: 10000;
      display: grid; place-items: center; padding: 16px; }
    .xt-overlay[hidden], .xt-control [hidden], .xt-settings-button[hidden] { display: none !important; }
    .xt-dialog { background: #fff; color: #17202a; border-radius: 12px; padding: 24px;
      width: min(440px, 100%); box-sizing: border-box; max-height: 90vh; overflow: auto; }
    .xt-dialog label { display: block; margin: 12px 0; }
    .xt-dialog input, .xt-dialog select { display: block; width: 100%; box-sizing: border-box;
      font: inherit; margin-top: 4px; padding: 8px; }
    .xt-dialog button { margin-right: 8px; }
    .xt-dialog p { overflow-wrap: anywhere; }
    @media (prefers-color-scheme: dark) {
      .xt-control { color: #aab8c2; }
      .xt-button { color: #6ec1ff; }
      .xt-dialog, .xt-settings-button { background: #15202b; color: #e7e9ea; }
    }
  `;
  document.head.append(style);

  const settingsButton = element('button', '翻译设置', 'xt-button xt-settings-button');
  settingsButton.type = 'button';
  const overlay = element('div', undefined, 'xt-overlay');
  overlay.hidden = true;
  const form = element('form', undefined, 'xt-dialog');
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'true');
  form.setAttribute('aria-label', '时间线翻译设置');
  const title = element('h2', '时间线翻译设置');
  const endpointLabel = element('label', '翻译接口完整地址');
  const endpointInput = element('input');
  endpointInput.type = 'url';
  endpointInput.required = true;
  endpointInput.placeholder = 'https://your-worker.workers.dev/api/translate';
  endpointInput.name = 'endpoint';
  endpointLabel.append(endpointInput);
  const languageLabel = element('label', '目标语言');
  const languageSelect = element('select');
  languageSelect.name = 'targetLanguage';
  for (const [code, name] of LANGUAGES) {
    const option = element('option', name);
    option.value = code;
    languageSelect.append(option);
  }
  languageLabel.append(languageSelect);
  const notice = element('p', '仅在点击翻译时向此接口发送正文和目标语言。不发送 X 登录凭据。请仅填写可信后端；勿填写翻译供应商 API 密钥。语言支持取决于后端。');
  const formStatus = element('p');
  formStatus.setAttribute('role', 'alert');
  const save = element('button', '保存', 'xt-button');
  save.type = 'submit';
  const cancel = element('button', '取消', 'xt-button');
  cancel.type = 'button';
  form.append(title, endpointLabel, languageLabel, notice, formStatus, save, cancel);
  overlay.append(form);
  document.body.append(settingsButton, overlay);
  let previousFocus;

  function showSettings() {
    previousFocus = document.activeElement;
    endpointInput.value = settings.endpoint;
    languageSelect.value = settings.targetLanguage;
    formStatus.textContent = initializationError;
    overlay.hidden = false;
    endpointInput.focus();
  }

  function closeSettings() {
    overlay.hidden = true;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  }

  settingsButton.addEventListener('click', showSettings);
  GM_registerMenuCommand('设置翻译接口和目标语言', showSettings);
  cancel.addEventListener('click', closeSettings);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeSettings();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSettings();
    }
    if (event.key === 'Tab') {
      const first = endpointInput;
      const last = cancel;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const next = {
        endpoint: validateEndpoint(endpointInput.value.trim()),
        targetLanguage: languageSelect.value,
      };
      if (!LANGUAGES.some(([code]) => code === next.targetLanguage)) {
        throw new Error('请选择有效的目标语言。');
      }
      GM_setValue(STORAGE_KEY, next);
      settings = next;
      settingsVersion++;
      initializationError = '';
      cache.clear();
      for (const state of states.values()) reset(state);
      closeSettings();
    } catch (error) {
      console.error('[X Translator] Settings save failed:', error);
      formStatus.textContent = error instanceof Error ? error.message : '保存失败，请重试。';
    }
  });

  function isTimeline() {
    return location.pathname === '/home' || location.pathname === '/';
  }

  function readText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
    return Array.from(node.childNodes, readText).join('');
  }

  function tweetText(article) {
    return Array.from(article.querySelectorAll('[data-testid="tweetText"]')).find((node) => {
      if (node.closest('article[data-testid="tweet"]') !== article) return false;
      // Quoted posts are usually wrapped in a separate clickable card.
      const card = node.closest('[role="link"]');
      return !card || !article.contains(card);
    });
  }

  function cacheKey(text, config) {
    return JSON.stringify([config.endpoint, config.targetLanguage, text]);
  }

  function requestTranslation(text, config) {
    const key = cacheKey(text, config);
    if (cache.has(key)) {
      const value = cache.get(key);
      cache.delete(key);
      cache.set(key, value);
      return Promise.resolve(value);
    }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= MAX_CONCURRENT) {
      return Promise.reject(new Error('同时翻译的推文过多，请等待后重试。'));
    }
    const version = settingsVersion;
    const request = new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: config.endpoint,
        anonymous: true,
        timeout: 30000,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        data: JSON.stringify({ text, targetLanguage: config.targetLanguage }),
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            const messages = {
              401: '后端要求身份验证，目前脚本未配置认证方式。',
              403: '后端拒绝访问，请检查权限。',
              404: '翻译接口不存在，请检查地址或确认后端已实现翻译接口。',
              413: '推文过长，后端拒绝处理。',
              429: '请求过于频繁或额度不足，请稍后重试。',
            };
            reject(new Error(messages[response.status] || `翻译失败（HTTP ${response.status}），请稍后重试。`));
            return;
          }
          let result;
          try {
            result = JSON.parse(response.responseText);
          } catch {
            reject(new Error('后端未返回有效 JSON，请检查接口地址。'));
            return;
          }
          if (!result || typeof result.translatedText !== 'string' || !result.translatedText.trim() ||
              !(result.detectedSourceLanguage === null || typeof result.detectedSourceLanguage === 'string')) {
            reject(new Error('后端响应格式不正确，需要 translatedText 和 detectedSourceLanguage。'));
            return;
          }
          resolve({ translatedText: result.translatedText, detectedSourceLanguage: result.detectedSourceLanguage });
        },
        onerror() { reject(new Error('网络请求失败，请检查后端和 Tampermonkey 的域名访问授权。')); },
        ontimeout() { reject(new Error('翻译请求超时（30 秒），请重试。')); },
        onabort() { reject(new Error('翻译请求已取消，请重试。')); },
      });
    }).then((result) => {
      if (version === settingsVersion) {
        cache.set(key, result);
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      }
      return result;
    }).finally(() => {
      pending.delete(key);
    });
    pending.set(key, request);
    return request;
  }

  function reset(state) {
    state.version++;
    state.busy = false;
    state.result = null;
    state.button.disabled = false;
    state.button.textContent = '翻译';
    state.button.setAttribute('aria-expanded', 'false');
    state.output.hidden = true;
    state.output.textContent = '';
    state.status.textContent = '';
  }

  async function translate(state) {
    if (!isTimeline() || state.busy) return;
    const text = readText(state.textNode).trim();
    if (text !== state.text) {
      state.text = text;
      reset(state);
    }
    if (!text) {
      state.status.textContent = '没有可翻译的正文。';
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      state.status.textContent = `正文超过 ${MAX_TEXT_LENGTH} 个字符，暂不支持。`;
      return;
    }
    if (!settings.endpoint) {
      state.status.textContent = '请先设置翻译接口。';
      showSettings();
      return;
    }
    if (state.result) {
      state.output.hidden = !state.output.hidden;
      state.button.textContent = state.output.hidden ? '展开译文' : '收起译文';
      state.button.setAttribute('aria-expanded', String(!state.output.hidden));
      return;
    }
    const version = ++state.version;
    const configVersion = settingsVersion;
    state.busy = true;
    state.button.disabled = true;
    state.button.textContent = '翻译中…';
    state.status.textContent = '';
    const current = () => state.version === version && settingsVersion === configVersion &&
      state.root.isConnected && isTimeline() && readText(state.textNode).trim() === text;
    try {
      const result = await requestTranslation(text, { ...settings });
      if (!current()) return;
      state.result = result;
      state.output.textContent = result.translatedText;
      state.output.hidden = false;
      state.output.lang = settings.targetLanguage;
      state.button.textContent = '收起译文';
      state.button.setAttribute('aria-expanded', 'true');
      state.status.textContent = result.detectedSourceLanguage ? `原文语言：${result.detectedSourceLanguage}` : '';
    } catch (error) {
      if (!current()) return;
      console.error('[X Translator] Translation failed:', error);
      state.button.textContent = '重试翻译';
      state.status.textContent = error instanceof Error ? error.message : '翻译失败，请重试。';
    } finally {
      if (state.version === version) {
        state.busy = false;
        state.button.disabled = false;
        if (!current()) reset(state);
      }
    }
  }

  function attach(article, textNode) {
    const root = element('div', undefined, 'xt-control');
    const button = element('button', '翻译', 'xt-button');
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    const output = element('div', undefined, 'xt-result');
    output.hidden = true;
    output.dir = 'auto';
    const status = element('span', undefined, 'xt-status');
    status.setAttribute('role', 'status');
    root.append(button, status, output);
    const state = { root, button, output, status, textNode, text: readText(textNode).trim(), version: 0, busy: false, result: null };
    // Prevent a translation click from triggering the enclosing tweet navigation.
    root.addEventListener('click', (event) => event.stopPropagation());
    button.addEventListener('click', () => translate(state));
    textNode.after(root);
    states.set(article, state);
  }

  function scan() {
    timer = undefined;
    const active = isTimeline();
    settingsButton.hidden = !active;
    for (const [article, state] of states) {
      const textNode = active && article.isConnected && tweetText(article);
      if (!textNode || textNode !== state.textNode || !state.root.isConnected ||
          state.textNode.nextElementSibling !== state.root) {
        state.version++;
        state.root.remove();
        states.delete(article);
      } else {
        const text = readText(textNode).trim();
        if (state.text !== text) {
          state.text = text;
          reset(state);
        }
      }
    }
    if (!active) return;
    for (const article of document.querySelectorAll('main article[data-testid="tweet"]')) {
      if (states.has(article)) continue;
      const textNode = tweetText(article);
      if (textNode && readText(textNode).trim()) attach(article, textNode);
    }
  }

  function scheduleScan() {
    if (timer === undefined) timer = setTimeout(scan, 50);
  }

  new MutationObserver(scheduleScan).observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['data-testid', 'role', 'alt'],
  });
  window.addEventListener('popstate', scheduleScan);
  scan();
})();
