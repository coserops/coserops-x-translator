const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync('x-translator.user.js', 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 100));
const prefix = 'x-direct.v1.';
function setup(t, { path = '/home', failRead = false, failWrite = false, failWriteAt = 0, saved = [], languages = ['zh-CN'], language = 'zh-CN' } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main></main></body></html>', { url: 'https://x.com' + path, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window: w } = dom;
  const d = w.document;
  function setBrowserLanguage(values, fallback = language) {
    Object.defineProperty(w.navigator, 'languages', { configurable: true, value: values });
    Object.defineProperty(w.navigator, 'language', { configurable: true, value: fallback });
    w.dispatchEvent(new w.Event('languagechange'));
  }
  setBrowserLanguage(languages);

  const store = new Map([[prefix + 'deepseek.key', 'secret-deepseek'], [prefix + 'qwen.key', 'secret-qwen']]);
  for (const [key, value] of saved) store.set(prefix + key, value);
  const requests = [];
  let menu;
  let writes = 0;
  w.GM_getValue = (key, fallback) => { if (failRead) throw Error('secret'); return store.has(key) ? store.get(key) : fallback; };
  w.GM_setValue = (key, value) => { if (failWrite || ++writes === failWriteAt) throw Error('secret'); store.set(key, value); };
  w.GM_registerMenuCommand = (_, cb) => { menu = cb; };
  w.GM_xmlhttpRequest = request => { requests.push(request); return { abort() { request.aborted = true; request.onabort(); } }; };
  w.eval(source);
  async function post(text = 'Hello<br>world <img alt="😀">', grok = true) {
    const a = d.createElement('article'); a.dataset.testid = 'tweet';
    a.innerHTML = '<header><button aria-label="More">…</button>' + (grok ? '<button aria-label="Ask Grok">G</button>' : '') + '</header><div data-testid="tweetText">' + text + '</div><footer><button>Reply</button></footer>';
    d.querySelector('main').append(a); await tick(); return a;
  }
  function respond(index, text = '你好', extra = {}) {
    requests[index].onload({ status: 200, finalUrl: requests[index].url, responseText: JSON.stringify({ choices: [{ message: { content: text } }] }), ...extra });
  }
  function configure(values = {}) {
    menu();
    if (values.provider) { d.querySelector('[name=provider]').value = values.provider; d.querySelector('[name=provider]').dispatchEvent(new w.Event('change')); }
    for (const [key, value] of Object.entries(values)) {
      const input = d.querySelector(`[name="${key}"]`);
      if (input.type === 'checkbox') input.checked = value; else input.value = value;
    }
    if (Object.hasOwn(values, 'apiKey')) d.querySelector('[name=apiKey]').dispatchEvent(new w.Event('input'));
    d.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  }
  return { w, d, store, requests, post, respond, configure, setBrowserLanguage, menu: () => menu() };
}
const disabledCache = { saved: [['translation-cache', JSON.stringify({ schema: 1, enabled: false, limit: 20, epoch: '', entries: [] })]] };
const control = a => a.querySelector('.xt-translate');
const status = app => app.d.querySelector('[role=status]').textContent;
const result = app => app.d.querySelector('.xt-result').textContent;

test('metadata permits custom hosts and contains no external scripts or backend', () => {
  assert.match(source, /@match\s+https:\/\/x.com\/\*/);
  assert.match(source, /@match\s+https:\/\/twitter.com\/\*/);
  const hosts = [...source.matchAll(/@connect\s+(\S+)/g)].map(match => match[1]);
  assert.deepEqual(hosts, ['*']);
  assert.doesNotMatch(source, /@require|console\./);
});

test('strict insertion before own Grok, no duplicates, no quote buttons, late Grok', async t => {
  const app = setup(t); const a = await app.post();
  assert.equal(control(a).nextElementSibling.getAttribute('aria-label'), 'Ask Grok');
  assert.equal(control(a).parentNode.tagName, 'HEADER');
  const quote = app.d.createElement('div'); quote.setAttribute('role', 'link');
  quote.innerHTML = '<article data-testid="tweet"><button title="Grok">G</button><div data-testid="tweetText">quote</div></article>';
  a.append(quote); await tick();
  assert.equal(a.querySelectorAll('.xt-translate').length, 1);
  assert.equal(quote.querySelector('.xt-translate'), null);
  const late = await app.post('Late', false); assert.equal(control(late), null);
  late.querySelector('header').insertAdjacentHTML('beforeend', '<button data-testid="grokButton">G</button>');
  await tick(); assert.equal(control(late).nextElementSibling.dataset.testid, 'grokButton');
  control(late).nextElementSibling.remove(); await tick(); assert.equal(control(late), null);
  const semantic = late.querySelector('button'); semantic.title = 'Grok'; await tick(); assert.ok(control(late));
});

test('extracts line breaks and emoji, excludes nested quoted posts and sends direct DeepSeek request only on click', async t => {
  const app = setup(t); const a = await app.post();
  a.insertAdjacentHTML('beforeend', '<div role="link"><div data-testid="tweetText">QUOTED</div><button aria-label="Grok">G</button></div>');
  await tick(); assert.equal(app.requests.length, 0); control(a).click();
  const req = app.requests[0]; const body = JSON.parse(req.data);
  assert.equal(req.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(req.headers.Authorization, 'Bearer secret-deepseek');
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.equal(req.headers.Cookie, undefined); assert.equal(req.anonymous, true); assert.equal(req.redirect, 'error'); assert.equal(req.timeout, 30000);
  assert.equal(body.model, 'deepseek-flash'); assert.equal(body.stream, false);
  assert.equal(body.messages[1].content, 'Hello\nworld 😀'); assert.match(body.messages[0].content, /zh-Hans-CN/);
  assert.equal(app.d.querySelector('.xt-panel').hidden, false); assert.match(status(app), /正在翻译/);
  app.respond(0, '<img src=x onerror=alert(1)>');
  assert.equal(result(app), '<img src=x onerror=alert(1)>'); assert.equal(app.d.querySelector('.xt-result img'), null);
  assert.equal(app.d.querySelector('.xt-source').textContent, 'Hello\nworld 😀');
  app.d.querySelector('.xt-panel button').click(); assert.equal(app.d.querySelector('.xt-panel').hidden, true);
});

test('Qwen domestic/international direct calls use separate keys, model and language', async t => {
  const app = setup(t); const a = await app.post();
  for (const host of ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com']) {
    app.setBrowserLanguage(['ja']); app.configure({ provider: 'qwen', apiKey: 'secret-qwen', baseURL: `https://${host}/compatible-mode/v1`, model: 'qwen-plus', });
    control(a).click(); const req = app.requests.at(-1);
    assert.equal(req.url, `https://${host}/compatible-mode/v1/chat/completions`);
    assert.equal(req.headers.Authorization, 'Bearer secret-qwen');
    assert.equal(JSON.parse(req.data).model, 'qwen-plus'); assert.match(JSON.parse(req.data).messages[0].content, /into ja/);
    app.respond(app.requests.length - 1);
  }
  assert.equal(app.store.get(prefix + 'deepseek.key'), 'secret-deepseek');
});

test('routes and selected tabs prevent injection outside supported pages', async t => {
  const app = setup(t, { path: '/search' }); const a = await app.post(); assert.equal(control(a), null);
  app.w.history.pushState({}, '', '/home'); app.w.dispatchEvent(new app.w.PopStateEvent('popstate')); await tick(); assert.ok(control(a));
  app.d.querySelector('main').insertAdjacentHTML('afterbegin', '<div role="tablist"><a role="tab" aria-selected="true">Following</a></div>'); await tick(); assert.ok(control(a));
  const tab = app.d.querySelector('[role=tab]'); tab.textContent = 'Custom list'; await tick(); assert.equal(control(a), null);
  tab.textContent = 'For you'; await tick(); assert.ok(control(a)); control(a).click();
  app.w.history.pushState({}, '', '/explore');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(control(a), null); assert.equal(app.d.querySelector('.xt-panel').hidden, true); assert.equal(app.requests[0].aborted, true);
  app.w.history.replaceState({}, '', '/'); app.w.dispatchEvent(new app.w.PopStateEvent('popstate')); await tick(); assert.ok(control(a));
});

test('later clicks win, close invalidates results, recycled nodes read new text', async t => {
  const app = setup(t); const a = await app.post('First'); const b = await app.post('Second');
  control(a).click(); control(b).click(); assert.equal(app.requests[0].aborted, true);
  app.respond(1, '第二'); app.respond(0, '第一'); assert.equal(result(app), '第二');
  b.querySelector('[data-testid=tweetText]').textContent = 'Recycled';
  control(b).click(); assert.equal(JSON.parse(app.requests[2].data).messages[1].content, 'Recycled');
  app.d.querySelector('.xt-panel button').click(); app.respond(2, 'late'); assert.equal(result(app), '');
  b.remove(); await tick(); assert.equal(app.d.querySelectorAll('.xt-translate').length, 1);
});

test('key refilled but never rendered in output, changes cancel requests, clearing keys stops calls', async t => {
  const app = setup(t, disabledCache); const a = await app.post(); app.menu();
  assert.equal(app.d.querySelector('[name=apiKey]').value, 'secret-deepseek');
  app.configure({ apiKey: 'replacement-key' }); control(a).click();
  assert.equal(app.requests[0].headers.Authorization, 'Bearer replacement-key');
  app.configure({ apiKey: 'another-key' }); app.respond(0, 'stale'); assert.equal(result(app), '');
  control(a).click(); app.respond(1, 'another-key secret-qwen'); assert.equal(result(app), '[已隐藏密钥] [已隐藏密钥]');
  assert.doesNotMatch(app.d.body.innerHTML, /another-key|replacement-key|secret-qwen/);
  app.configure({ apiKey: '' }); control(a).click(); assert.equal(app.requests.length, 2); assert.match(status(app), /API Key/);
});

test('HTTPS URL validation rejects credentials, query, fragments and malformed addresses', async t => {
  const app = setup(t); const a = await app.post();
  for (const baseURL of ['http://relay.example/v1', 'https://user:pass@relay.example/v1', 'https://relay.example/v1?key=abc', 'https://relay.example/v1#abc', 'https://relay.example/v1?', 'https://relay.example/v1#', 'not a URL', 'https://relay.example/a b']) {
    app.configure({ baseURL, apiKey: 'new-key' });
    assert.equal(app.d.querySelector('.xt-overlay').hidden, false);
    assert.ok(app.d.querySelector('[role=alert]').textContent);
  }
  control(a).click(); assert.equal(app.requests[0].url, 'https://api.deepseek.com/v1/chat/completions');
});

test('five official providers preserve separate model, endpoint and keys', async t => {
  const app = setup(t); const a = await app.post();
  for (const [provider, base, model] of [
    ['deepseek', 'https://api.deepseek.com/v1', 'deepseek-flash'],
    ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-mt-flash'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3.5-flash-lite'],
    ['openai', 'https://api.openai.com/v1', 'gpt-6-luna'],
    ['grok', 'https://api.x.ai/v1', 'grok-4-1-fast-non-reasoning'],
  ]) {
    app.configure({ provider, apiKey: 'test-' + provider }); control(a).click();
    const req = app.requests.at(-1);
    assert.equal(req.url, base + '/chat/completions');
    assert.equal(req.headers.Authorization, 'Bearer test-' + provider);
    assert.equal(JSON.parse(req.data).model, model);
    assert.equal(req.anonymous, true); assert.equal(req.redirect, 'error');
    assert.equal(app.store.get(prefix + provider + '.config').model, model);
  }
  app.configure({ provider: 'deepseek' }); control(a).click();
  assert.equal(app.requests.at(-1).headers.Authorization, 'Bearer test-deepseek');
});

test('relay paths, custom models and endpoint changes require explicit new credentials', async t => {
  const app = setup(t); const a = await app.post();
  app.configure({ baseURL: 'https://relay.example/api/project/v1' });
  assert.equal(app.d.querySelector('.xt-overlay').hidden, false);
  assert.match(app.d.querySelector('[role=alert]').textContent, /重新输入/);
  control(a).click(); assert.equal(app.requests[0].url, 'https://api.deepseek.com/v1/chat/completions');
  app.configure({ baseURL: 'https://relay.example/api/project/v1', apiKey: 'relay-key', model: 'org/custom-model' });
  control(a).click();
  assert.equal(app.requests.at(-1).url, 'https://relay.example/api/project/v1/chat/completions');
  assert.equal(app.requests.at(-1).headers.Authorization, 'Bearer relay-key');
  assert.equal(JSON.parse(app.requests.at(-1).data).model, 'org/custom-model');
  app.menu(); assert.equal(app.d.querySelector('[name=modelPreset]').value, 'custom');
  assert.equal(app.d.querySelector('[name=model]').value, 'org/custom-model');
  assert.match(app.d.querySelector('.xt-destination').textContent, /relay.example/);
  app.configure({ baseURL: 'https://relay.example/api/project/v1/chat/completions/' });
  control(a).click(); assert.equal(app.requests.at(-1).url, 'https://relay.example/api/project/v1/chat/completions');
  app.configure({ baseURL: 'https://relay.example/other/v1', apiKey: '' });
  const count = app.requests.length; control(a).click(); assert.equal(app.requests.length, count);
  assert.equal(app.store.get(prefix + 'deepseek.key'), '');
});

test('preset and custom model UI persists selections; editing address clears typed key', t => {
  const app = setup(t); app.menu();
  const input = name => app.d.querySelector(`[name=${name}]`);
  input('modelPreset').value = 'deepseek-v4-pro'; input('modelPreset').dispatchEvent(new app.w.Event('change'));
  app.d.querySelector('form').dispatchEvent(new app.w.Event('submit', { cancelable: true }));
  assert.equal(app.store.get(prefix + 'deepseek.config').model, 'deepseek-v4-pro');
  app.menu(); input('modelPreset').value = 'custom'; input('modelPreset').dispatchEvent(new app.w.Event('change'));
  assert.equal(input('model').parentElement.hidden, false); input('model').value = 'relay-model';
  input('apiKey').value = 'typed-key'; input('baseURL').value = 'https://relay.example/v1';
  input('baseURL').dispatchEvent(new app.w.Event('input')); assert.equal(input('apiKey').value, '');
  input('apiKey').value = 'relay-key'; input('apiKey').dispatchEvent(new app.w.Event('input'));
  app.d.querySelector('form').dispatchEvent(new app.w.Event('submit', { cancelable: true }));
  app.menu(); assert.equal(input('model').value, 'relay-model'); assert.equal(input('endpointPreset').value, 'custom');
  input('endpointPreset').value = 'https://api.deepseek.com/v1'; input('endpointPreset').dispatchEvent(new app.w.Event('change'));
  assert.equal(input('baseURL').value, 'https://api.deepseek.com/v1'); assert.equal(input('apiKey').value, '');
  app.d.querySelector('form').dispatchEvent(new app.w.Event('submit', { cancelable: true }));
  assert.equal(app.d.querySelector('.xt-overlay').hidden, true);
  assert.equal(app.store.get(prefix + 'deepseek.key'), '');
});

test('safe HTTP/network/timeout/parse/redirect errors and retry', async t => {
  const app = setup(t); const a = await app.post();
  const errors = [
    req => req.onload({ status: 401, responseText: 'secret-deepseek' }),
    req => req.onload({ status: 429, responseText: 'secret-deepseek' }),
    req => req.onerror({ message: 'secret-deepseek' }),
    req => req.ontimeout(),
    req => req.onload({ status: 200, responseText: 'not JSON secret-deepseek' }),
    req => req.onload({ status: 200, responseText: '{"choices":[]}' }),
    req => req.onload({ status: 200, finalUrl: 'https://evil.example/', responseText: '{}' }),
  ];
  control(a).click();
  for (const error of errors) {
    error(app.requests.at(-1)); assert.doesNotMatch(status(app), /secret-deepseek/); assert.notEqual(status(app), '正在翻译…');
    const retry = [...app.d.querySelectorAll('.xt-panel button')].find(node => node.textContent === '重试');
    assert.equal(retry.hidden, false); retry.click(); assert.match(status(app), /正在翻译/);
  }
  app.respond(app.requests.length - 1); assert.equal(result(app), '你好');
});

test('storage failures are visible and block requests; input length limits', async t => {
  for (const options of [{ failRead: true }, { failWrite: true }]) {
    const app = setup(t, options); const a = await app.post();
    if (options.failWrite) app.configure({ apiKey: 'new-key' });
    control(a).click(); assert.equal(app.requests.length, 0); assert.match(status(app), /存储/);
    assert.doesNotMatch(app.d.body.textContent, /secret/);
  }
  const app = setup(t); const a = await app.post('a'.repeat(20001)); control(a).click(); assert.match(status(app), /20,000/); assert.equal(app.requests.length, 0);
  a.querySelector('[data-testid=tweetText]').textContent = ''; control(a).click(); assert.match(status(app), /没有可翻译/);
});

test('partial endpoint saves never persist the old key with a new endpoint', async t => {
  for (const failWriteAt of [2, 3, 4]) {
    const app = setup(t, { failWriteAt }); const a = await app.post();
    app.configure({ baseURL: 'https://relay.example/v1', apiKey: 'relay-key' });
    const config = app.store.get(prefix + 'deepseek.config');
    if (config?.baseURL === 'https://relay.example/v1') {
      assert.notEqual(app.store.get(prefix + 'deepseek.key'), 'secret-deepseek');
    }
    control(a).click(); assert.equal(app.requests.length, 0); assert.match(status(app), /存储/);
  }
});

test('recommended model lists and defaults preserve Grok and offer custom input', t => {
  const app = setup(t);
  for (const [provider, models, defaultModel] of [
    ['deepseek', ['deepseek-flash', 'deepseek-v4-pro'], 'deepseek-flash'],
    ['qwen', ['qwen-mt-lite', 'qwen-mt-flash', 'qwen-mt-plus'], 'qwen-mt-flash'],
    ['google', ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'], 'gemini-3.5-flash-lite'],
    ['openai', ['gpt-6-luna'], 'gpt-6-luna'],
    ['grok', ['grok-4-1-fast-non-reasoning', 'grok-4-1-fast-reasoning'], 'grok-4-1-fast-non-reasoning'],
  ]) {
    app.configure({ provider }); app.menu();
    const select = app.d.querySelector('[name=modelPreset]');
    assert.deepEqual([...select.options].map(o => o.value), [...models, 'custom']);
    assert.equal(select.value, defaultModel);
    if (provider !== 'grok') assert.match(select.selectedOptions[0].textContent, /首选/);
  }
});

test('Google relay requires new credentials and persists custom model and endpoint', async t => {
  const app = setup(t); const a = await app.post();
  app.configure({ provider: 'google', apiKey: 'google-key' });
  app.configure({ provider: 'google', baseURL: 'https://relay.example/google/v1' });
  assert.match(app.d.querySelector('[role=alert]').textContent, /重新输入/);
  app.setBrowserLanguage(['en-US']); app.configure({ provider: 'google', baseURL: 'https://relay.example/google/v1', apiKey: 'relay-google', model: 'custom-gemini', });
  control(a).click(); const req = app.requests.at(-1);
  assert.equal(req.url, 'https://relay.example/google/v1/chat/completions');
  assert.equal(req.headers.Authorization, 'Bearer relay-google');
  const body = JSON.parse(req.data);
  assert.equal(body.model, 'custom-gemini'); assert.match(body.messages[0].content, /en-US/);
  app.menu(); assert.equal(app.d.querySelector('[name=modelPreset]').value, 'custom');
  assert.equal(app.store.get(prefix + 'google.config').baseURL, 'https://relay.example/google/v1');
  app.respond(0, 'Translation'); assert.equal(result(app), 'Translation');
});

test('Qwen MT sends only original user text and top-level translation options, including relay and Frankfurt', async t => {
  const app = setup(t); const a = await app.post('Hello<br>world');
  for (const [model, targetLanguage, expected, baseURL] of [
    ['qwen-mt-lite', 'zh-CN', 'Chinese', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['qwen-mt-flash', 'ja', 'Japanese', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'],
    ['qwen-mt-plus', 'zh-TW', 'Traditional Chinese', 'https://llm-test.eu-central-1.maas.aliyuncs.com/compatible-mode/v1'],
    ['qwen-mt-flash-custom', 'YUE', 'Cantonese', 'https://relay.example/qwen/v1'],
    ['qwen-mt-lite', 'fa', 'Persian', 'https://relay.example/qwen/v1'],
    ['qwen-mt-plus', 'fa', 'Western Persian', 'https://relay.example/qwen/v1'],
    ['qwen-mt-flash', 'en-US', 'English', 'https://relay.example/qwen/v1'],
  ]) {
    app.setBrowserLanguage([targetLanguage]); app.configure({ provider: 'qwen', model, baseURL, apiKey: 'mt-key' }); control(a).click();
    const req = app.requests.at(-1); const body = JSON.parse(req.data);
    assert.equal(req.url, baseURL + '/chat/completions');
    assert.deepEqual(body, { model, stream: false, messages: [{ role: 'user', content: 'Hello\nworld' }], translation_options: { source_lang: 'auto', target_lang: expected } });
    app.respond(app.requests.length - 1, '译文'); assert.equal(result(app), '译文');
  }
});

test('unsupported browser languages block MT requests but allow credential saving', async t => {
  for (const [model, language] of [['qwen-mt-flash', 'eo'], ['qwen-mt-plus', 'auto'], ['qwen-mt-lite', 'yue'], ['qwen-mt-lite-2026', 'my']]) {
    const app = setup(t, { languages: [language, 'en'] });
    app.configure({ provider: 'qwen', model, apiKey: 'saved-key' });
    assert.equal(app.d.querySelector('.xt-overlay').hidden, true);
    assert.equal(app.store.get(prefix + 'qwen.key'), 'saved-key');
    control(await app.post()).click();
    assert.equal(app.requests.length, 0); assert.match(status(app), /浏览器语言/);
  }
});

test('existing legacy and custom provider settings are never replaced by new defaults', async t => {
  for (const [provider, model] of [['deepseek', 'deepseek-chat'], ['qwen', 'qwen-plus'], ['openai', 'gpt-4o-mini'], ['google', 'org/gemini'], ['grok', 'my-grok']]) {
    const config = { model, baseURL: 'https://relay.example/old/v1' };
    const app = setup(t, { saved: [[provider + '.config', config], [provider + '.key', 'saved-key'], ['settings', { provider, targetLanguage: '自由风格' }]] });
    app.menu(); assert.equal(app.d.querySelector('[name=modelPreset]').value, 'custom');
    assert.equal(app.d.querySelector('[name=model]').value, model);
    control(await app.post()).click(); const req = app.requests[0]; const body = JSON.parse(req.data);
    assert.equal(req.url, config.baseURL + '/chat/completions'); assert.equal(body.model, model);
    assert.equal(req.headers.Authorization, 'Bearer saved-key');
    assert.equal(body.translation_options, undefined); assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /zh-Hans-CN/);
    assert.deepEqual(app.store.get(prefix + provider + '.config'), config);
  }
});

test('independent custom provider starts blank and preserves provider isolation across reloads', async t => {
  const app = setup(t); const a = await app.post(); app.menu();
  const input = name => app.d.querySelector(`[name=${name}]`);
  assert.match(input('provider').querySelector('[value=custom]').textContent, /自定义.*OpenAI 兼容/);
  input('provider').value = 'custom'; input('provider').dispatchEvent(new app.w.Event('change'));
  assert.equal(input('baseURL').value, ''); assert.equal(input('model').value, '');
  assert.equal(input('endpointPreset').value, 'custom'); assert.equal(input('endpointPreset').options.length, 1);
  assert.equal(input('modelPreset').value, 'custom'); assert.equal(input('model').parentElement.hidden, false);
  assert.equal(app.d.querySelector('[role=alert]').textContent, '');
  control(a).click(); assert.equal(app.requests[0].url, 'https://api.deepseek.com/v1/chat/completions');
  app.configure({ provider: 'custom', baseURL: 'https://relay.example:8443/project/v1', model: 'org/model', apiKey: 'custom-key' });
  assert.equal(app.d.querySelector('.xt-overlay').hidden, true);
  control(a).click();
  assert.equal(app.requests.at(-1).url, 'https://relay.example:8443/project/v1/chat/completions');
  assert.equal(app.requests.at(-1).headers.Authorization, 'Bearer custom-key');
  assert.equal(JSON.parse(app.requests.at(-1).data).model, 'org/model');
  assert.equal(JSON.parse(app.requests.at(-1).data).messages.length, 2);
  assert.equal(app.store.get(prefix + 'custom.key'), 'custom-key');
  assert.equal(app.store.get(prefix + 'deepseek.key'), 'secret-deepseek');
  assert.equal(app.store.has(prefix + 'deepseek.config'), false);
  app.configure({ provider: 'qwen' }); control(a).click();
  assert.equal(JSON.parse(app.requests.at(-1).data).model, 'qwen-mt-flash');
  app.configure({ provider: 'custom' }); control(a).click();
  assert.equal(app.requests.at(-1).headers.Authorization, 'Bearer custom-key');
  app.menu(); assert.equal(input('apiKey').value, 'custom-key'); assert.equal(input('model').value, 'org/model');
  const reloaded = setup(t, { saved: [...app.store].map(([key, value]) => [key.slice(prefix.length), value]) });
  control(await reloaded.post()).click(); assert.equal(reloaded.requests[0].headers.Authorization, 'Bearer custom-key');
});

test('blank custom configurations load without global storage errors but cannot request', async t => {
  for (const config of [{ baseURL: '', model: '' }, { baseURL: 'https://relay.example/v1', model: '' }, { baseURL: '', model: 'model' }]) {
    const app = setup(t, { saved: [['settings', { provider: 'custom', targetLanguage: '简体中文' }], ['custom.config', config], ['custom.key', 'custom-key']] });
    const a = await app.post(); control(a).click();
    assert.equal(app.requests.length, 0); assert.match(status(app), /配置不完整.*Base URL.*模型 ID/);
    assert.equal(app.d.querySelector('[role=alert]').textContent, '');
    app.configure({ provider: 'deepseek' }); control(a).click(); assert.equal(app.requests.length, 1);
  }
});

test('custom save rejects invalid endpoints and missing models without changing saved selection', t => {
  const app = setup(t);
  for (const baseURL of ['', 'http://relay.example/v1', 'https://user:password@relay.example/v1', 'https://relay.example/v1?q=1', 'https://relay.example/v1#x', 'https://relay.example/a b', 'not a URL']) {
    app.configure({ provider: 'custom', baseURL, model: 'model', apiKey: 'custom-key' });
    assert.equal(app.d.querySelector('.xt-overlay').hidden, false);
    assert.match(app.d.querySelector('[role=alert]').textContent, /Base URL/);
    assert.equal(app.store.has(prefix + 'custom.config'), false);
  }
  app.configure({ provider: 'custom', baseURL: 'https://relay.example/v1', model: '  ', apiKey: 'custom-key' });
  assert.match(app.d.querySelector('[role=alert]').textContent, /填写模型/);
  assert.equal(app.store.has(prefix + 'custom.config'), false);
});

test('custom endpoint changes enforce key re-entry and allow equivalent completion URLs', async t => {
  const app = setup(t); const a = await app.post();
  app.configure({ provider: 'custom', baseURL: 'https://relay.example/v1', model: 'model' });
  assert.equal(app.store.get(prefix + 'custom.key'), '');
  app.configure({ provider: 'custom', baseURL: 'https://relay.example/v1', model: 'model', apiKey: 'custom-key' });
  app.configure({ baseURL: 'https://relay.example/v1/chat/completions/' });
  assert.equal(app.d.querySelector('.xt-overlay').hidden, true);
  app.configure({ baseURL: 'https://other.example/v1' });
  assert.match(app.d.querySelector('[role=alert]').textContent, /重新输入/);
  control(a).click(); assert.equal(app.requests.at(-1).url, 'https://relay.example/v1/chat/completions');
  app.configure({ baseURL: 'https://other.example/v1', apiKey: 'other-key' });
  control(a).click(); assert.equal(app.requests.at(-1).headers.Authorization, 'Bearer other-key');
  assert.equal(app.requests.at(-1).url, 'https://other.example/v1/chat/completions');
  app.configure({ baseURL: 'https://third.example/v1', apiKey: '' });
  const count = app.requests.length; control(a).click(); assert.equal(app.requests.length, count);
  assert.match(status(app), /API Key/); assert.equal(app.store.get(prefix + 'custom.key'), '');
});

test('custom provider retains model-driven Qwen MT semantics', async t => {
  const app = setup(t); const a = await app.post('Original');
  app.setBrowserLanguage(['ja']); app.configure({ provider: 'custom', baseURL: 'https://relay.example/v1', model: 'qwen-mt-flash', apiKey: 'custom-key' });
  control(a).click(); const body = JSON.parse(app.requests[0].data);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Original' }]);
  assert.deepEqual(body.translation_options, { source_lang: 'auto', target_lang: 'Japanese' });
});

const logs = app => [...app.d.querySelectorAll('.xt-call')].map(node => node.textContent);
test('404 diagnostics include snapshot, timing, status, safe message and allowlisted request ID', async t => {
  const app = setup(t); const a = await app.post('Private original');
  app.setBrowserLanguage(['en-US']); app.configure({ baseURL: 'https://relay.example:8443/project/v1/', model: 'missing-model', apiKey: 'relay-key', });
  control(a).click();
  assert.match(logs(app)[0], /请求中/);
  app.requests[0].onload({ status: 404, responseText: JSON.stringify({ error: { message: 'Unknown missing-model relay-key secret-qwen' } }), responseHeaders: 'Authorization: ignored-secret\r\nX-Request-ID: trace-relay-key-secret-qwen\r\nOther: private' });
  const log = logs(app)[0];
  for (const expected of ['https://relay.example:8443/project/v1/chat/completions', 'missing-model', 'en-US', 'HTTP 状态：404', '错误类型：http', 'Unknown', 'Request ID：trace-', 'Base URL', '/chat/completions']) assert.ok(log.includes(expected), expected);
  assert.match(log, /开始时间：\d{4}-.*Z/); assert.match(log, /耗时：\d+ ms/);
  assert.doesNotMatch(log, /relay-key|secret-qwen|ignored-secret|Private original|Authorization|Other:/);
  assert.doesNotMatch(status(app), /relay-key|secret-qwen/);
  assert.equal(app.d.querySelector('.xt-diagnostics').tagName, 'DETAILS');
});

test('diagnostics record success, transport failures, abort and immutable stale cancellation', async t => {
  const app = setup(t, disabledCache); const a = await app.post();
  control(a).click(); app.respond(0, 'done', { responseHeaders: 'request-id: success-123' });
  assert.match(logs(app)[0], /状态：成功/); assert.match(logs(app)[0], /HTTP 状态：200/); assert.match(logs(app)[0], /success-123/);
  for (const [callback, type] of [['onerror', 'network'], ['ontimeout', 'timeout'], ['onabort', 'abort']]) {
    control(a).click(); app.requests.at(-1)[callback]({ message: 'secret-deepseek' });
    assert.match(logs(app)[0], new RegExp(`错误类型：${type}`)); assert.match(logs(app)[0], /HTTP 状态：未收到/);
  }
  control(a).click(); const old = app.requests.length - 1;
  control(a).click(); const cancelled = logs(app)[1];
  assert.match(cancelled, /状态：已取消/);
  app.respond(app.requests.length - 1, 'latest'); app.respond(old, 'stale');
  assert.equal(result(app), 'latest'); assert.equal(logs(app)[1], cancelled);
  app.w.GM_xmlhttpRequest = () => { throw Error('secret-deepseek'); };
  control(a).click(); assert.match(logs(app)[0], /错误类型：request/);
});

test('all diagnostic fields and responses scrub historical keys after rotation and never render HTML', async t => {
  const app = setup(t); const a = await app.post();
  control(a).click(); app.configure({ apiKey: 'new-key' });
  app.respond(0, 'secret-deepseek'); assert.equal(result(app), '');
  app.setBrowserLanguage(['eo']); app.configure({ model: 'model-secret-deepseek', baseURL: 'https://relay.example/secret-deepseek', apiKey: 'new-key' });
  control(a).click();
  app.requests.at(-1).onload({ status: 404, responseHeaders: 'X-Request-ID: secret-deepseek new-key secret-qwen', responseText: JSON.stringify({ error: { message: '<img src=x onerror=alert(1)> secret-deepseek new-key secret-qwen ' + 'x'.repeat(1000) } }) });
  assert.doesNotMatch(logs(app).join(' '), /secret-deepseek|new-key|secret-qwen/);
  assert.doesNotMatch(status(app), /secret-deepseek|new-key|secret-qwen/);
  assert.equal(app.d.querySelector('.xt-diagnostics img'), null);
  assert.match(logs(app)[0], /<img/); assert.ok(logs(app)[0].length < 1500);
  control(a).click(); app.requests.at(-1).onload({ status: 502, responseText: '<script>secret-deepseek</script>' });
  assert.match(logs(app)[0], /响应不是 JSON/); assert.equal(app.d.querySelector('.xt-diagnostics script'), null);
  control(a).click(); app.respond(app.requests.length - 1, 'secret-deepseek new-key secret-qwen');
  assert.equal(result(app), '[已隐藏密钥] [已隐藏密钥] [已隐藏密钥]');
});

test('logs are bounded, clearable while pending, and never persisted', async t => {
  const app = setup(t, disabledCache); const a = await app.post('Never stored');
  const before = [...app.store];
  for (let i = 0; i < 22; i++) { control(a).click(); app.respond(i, 'done', { responseHeaders: `x-request-id: trace-${i}` }); }
  assert.equal(logs(app).length, 20); assert.match(logs(app)[0], /trace-21/); assert.match(logs(app)[19], /trace-2/);
  control(a).click();
  [...app.d.querySelectorAll('.xt-panel button')].find(node => node.textContent === '清空调用记录').click();
  assert.equal(logs(app).length, 0); app.respond(22); assert.equal(logs(app).length, 0);
  assert.deepEqual([...app.store], before);
  control(a).click(); assert.equal(logs(app).length, 1);
});

 test('Aliyun workspace missing prefixes are repaired without changing relay paths', async t => {
  const host = 'https://ws-example.cn-beijing.maas.aliyuncs.com';
  for (const path of ['', '/', '/chat/completions', '/compatible-mode/v1', '/compatible-mode/v1/chat/completions']) {
    const app = setup(t, { saved: [
      ['settings', { provider: 'qwen', targetLanguage: '简体中文' }],
      ['qwen.config', { model: 'qwen-mt-flash', baseURL: host + path }],
    ] });
    control(await app.post()).click();
    assert.equal(app.requests[0].url, host + '/compatible-mode/v1/chat/completions');
    app.menu();
    assert.ok(app.d.querySelector('form').textContent.includes(host + '/compatible-mode/v1/chat/completions'));
  }
 });

test('runtime version is visible in panel and diagnostics and matches metadata', async t => {
  const app = setup(t);
  control(await app.post()).click();
  const version = source.match(/@version\s+(\S+)/)[1];
  assert.equal(app.d.querySelector('.xt-panel h2').textContent, '推文翻译');
  assert.equal(app.d.querySelector('.xt-version').textContent, version);
  assert.ok(app.d.querySelector('.xt-panel').textContent.includes('脚本版本：' + version));
});

test('reading panel exposes loading/success/error states and restores source focus after retry', async t => {
  const app = setup(t); const a = await app.post(); const trigger = control(a);
  const panel = app.d.querySelector('.xt-panel');
  const close = panel.querySelector('.xt-close');
  const state = panel.querySelector('[role=status]');
  const translated = panel.querySelector('.xt-result');
  trigger.focus(); trigger.click();
  assert.equal(app.d.activeElement, close);
  assert.equal(state.dataset.state, 'loading'); assert.equal(translated.getAttribute('aria-busy'), 'true');
  app.requests[0].onerror();
  assert.equal(state.dataset.state, 'error'); assert.equal(translated.getAttribute('aria-busy'), 'false');
  const retry = [...panel.querySelectorAll('button')].find(node => node.textContent === '重试');
  retry.focus(); retry.click(); app.respond(1);
  assert.equal(state.dataset.state, 'success'); assert.equal(translated.getAttribute('aria-busy'), 'false');
  close.focus(); close.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel.hidden, true); assert.equal(app.d.activeElement, trigger);
  assert.ok(panel.querySelector('.xt-header')); assert.ok(panel.querySelector('.xt-content .xt-source'));
});

test('settings traps focus without trapping dismissal and restores scroll and opener', async t => {
  const app = setup(t); control(await app.post()).click();
  const settings = [...app.d.querySelectorAll('.xt-panel button')].find(node => node.textContent === '设置');
  settings.focus(); app.d.body.style.overflow = 'clip'; settings.click();
  const first = app.d.querySelector('[name=provider]');
  const cancel = [...app.d.querySelectorAll('.xt-settings button')].find(node => node.textContent === '取消');
  const press = (key, shiftKey = false) => app.d.activeElement.dispatchEvent(new app.w.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  assert.equal(app.d.activeElement, first); assert.equal(app.d.body.style.overflow, 'hidden');
  press('Tab', true); assert.equal(app.d.activeElement, cancel);
  press('Tab'); assert.equal(app.d.activeElement, first);
  settings.focus(); assert.equal(app.d.activeElement, first);
  app.d.querySelector('[name=apiKey]').value = 'unsaved-value';
  press('Escape');
  assert.equal(app.d.querySelector('.xt-overlay').hidden, true);
  assert.equal(app.d.querySelector('.xt-panel').hidden, false);
  assert.equal(app.d.activeElement, settings); assert.equal(app.d.body.style.overflow, 'clip');
  assert.equal(app.d.querySelector('[name=apiKey]').value, '');
  settings.click(); cancel.click(); assert.equal(app.d.activeElement, settings);
});

test('settings errors receive focus, custom fields toggle and save restores opener', async t => {
  const app = setup(t); const a = await app.post(); control(a).focus(); app.menu();
  const model = app.d.querySelector('[name=model]'); const preset = app.d.querySelector('[name=modelPreset]');
  assert.equal(model.parentElement.hidden, true);
  preset.value = 'custom'; preset.dispatchEvent(new app.w.Event('change'));
  assert.equal(model.parentElement.hidden, false);
  model.value = '';
  app.d.querySelector('form').dispatchEvent(new app.w.Event('submit', { cancelable: true }));
  assert.equal(app.d.activeElement, app.d.querySelector('[role=alert]'));
  model.value = 'custom-model';
  app.d.querySelector('form').dispatchEvent(new app.w.Event('submit', { cancelable: true }));
  assert.equal(app.d.activeElement, control(a)); assert.equal(app.d.body.style.overflow, '');
  assert.equal(app.d.querySelector('.xt-overlay').hidden, true);
});

test('saved password visibility resets on provider switch and reopen; blank save clears only selected key', t => {
  const app = setup(t); app.menu();
  const key = app.d.querySelector('[name=apiKey]');
  const eye = app.d.querySelector('.xt-key-toggle');
  const provider = app.d.querySelector('[name=provider]');
  assert.equal(key.value, 'secret-deepseek'); assert.equal(key.type, 'password');
  assert.equal(eye.getAttribute('aria-pressed'), 'false'); assert.equal(eye.getAttribute('aria-label'), '显示 API Key');
  eye.click(); assert.equal(key.type, 'text'); assert.equal(eye.getAttribute('aria-pressed'), 'true');
  assert.equal(eye.getAttribute('aria-label'), '隐藏 API Key');
  eye.click(); assert.equal(key.type, 'password'); eye.click();
  provider.value = 'qwen'; provider.dispatchEvent(new app.w.Event('change'));
  assert.equal(key.type, 'password'); assert.equal(key.value, 'secret-qwen');
  eye.click(); app.menu(); assert.equal(key.type, 'password'); assert.equal(key.value, 'secret-deepseek');
  assert.equal(app.d.querySelector('[name=clearKey]'), null);
  app.configure({ apiKey: '   ' }); app.menu(); assert.equal(key.value, '');
  assert.equal(app.store.get(prefix + 'deepseek.key'), ''); assert.equal(app.store.get(prefix + 'qwen.key'), 'secret-qwen');
});

test('programmatic endpoint changes cannot reuse autofill or entry for another address; same key re-entry authorizes', t => {
  const app = setup(t); app.menu();
  const key = app.d.querySelector('[name=apiKey]'); const base = app.d.querySelector('[name=baseURL]');
  const submit = () => app.d.querySelector('form').dispatchEvent(new app.w.Event('submit', { cancelable: true }));
  key.dispatchEvent(new app.w.Event('input'));
  base.value = 'https://relay.example/v1'; submit();
  assert.match(app.d.querySelector('[role=alert]').textContent, /重新输入/);
  assert.equal(app.store.has(prefix + 'deepseek.config'), false);
  key.value = 'secret-deepseek'; key.dispatchEvent(new app.w.Event('input')); submit();
  assert.equal(app.store.get(prefix + 'deepseek.config').baseURL, base.value);
  assert.equal(app.store.get(prefix + 'deepseek.key'), 'secret-deepseek');
  app.menu(); base.value = 'https://other.example/v1'; base.dispatchEvent(new app.w.Event('input'));
  assert.equal(key.value, ''); key.value = 'secret-deepseek'; submit();
  assert.match(app.d.querySelector('[role=alert]').textContent, /重新输入/);
  key.dispatchEvent(new app.w.Event('input')); base.value = 'https://third.example/v1'; submit();
  assert.equal(app.store.get(prefix + 'deepseek.config').baseURL, 'https://relay.example/v1');
});

test('browser preference overrides malformed legacy targets and saves provider only', async t => {
  for (const targetLanguage of [null, {}, 42, 'English (UK)']) {
    const app = setup(t, { languages: ['ja', 'en-US'], saved: [['settings', { provider: 'qwen', targetLanguage }]] });
    app.menu();
    assert.equal(app.d.querySelector('[name=targetLanguage]'), null);
    assert.equal(app.d.querySelector('[name=languagePreset]'), null);
    assert.equal(app.d.querySelector('[name=browserLanguage]').value, 'ja');
    assert.equal(app.d.querySelector('[name=browserLanguage]').readOnly, true);
    app.configure();
    assert.deepEqual(JSON.parse(JSON.stringify(app.store.get(prefix + 'settings'))), { provider: 'qwen' });
    control(await app.post()).click();
    assert.equal(JSON.parse(app.requests[0].data).translation_options.target_lang, 'Japanese');
  }
});

 test('credential reveal is a labelled, isolated control and language help follows both input modes', t => {
  const app = setup(t); app.menu();
  const key = app.d.querySelector('[name=apiKey]');
  const eye = app.d.querySelector('.xt-key-toggle');
  assert.equal(key.labels.length, 1);
  assert.equal(eye.closest('label'), null);
  assert.equal(eye.parentElement, key.parentElement);
  assert.equal(eye.querySelector('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(key.getAttribute('autocapitalize'), 'none');
  eye.focus(); eye.click();
  assert.equal(app.d.activeElement, eye);
  assert.equal(key.type, 'text');
  assert.ok(!app.d.querySelector('form').textContent.includes(key.value));
  assert.ok(!eye.outerHTML.includes(key.value));
  for (const name of ['browserLanguage']) {
    const input = app.d.querySelector(`[name=${name}]`);
    assert.equal(input.labels.length, 1);
    assert.match(app.d.getElementById(input.getAttribute('aria-describedby')).textContent, /原文自动识别/);
  }
  app.d.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(key.value, ''); assert.equal(key.type, 'password');
});

test('status pages translate the main post and dynamically loaded replies next to their own Grok', async t => {
  const app = setup(t, { path: '/minchoi/status/2113473131914445206' });
  app.d.querySelector('main').insertAdjacentHTML('afterbegin', '<div role="tablist"><a role="tab" aria-selected="true">Replies</a></div>');
  const main = await app.post('Main post');
  const reply = await app.post('Reply text');
  for (const article of [main, reply]) {
    assert.equal(control(article).nextElementSibling.getAttribute('aria-label'), 'Ask Grok');
    assert.equal(article.querySelectorAll('.xt-translate').length, 1);
  }
  control(main).click();
  assert.equal(JSON.parse(app.requests[0].data).messages[1].content, 'Main post');
  control(reply).click();
  assert.equal(JSON.parse(app.requests[1].data).messages[1].content, 'Reply text');
  const late = await app.post('Late reply', false);
  assert.equal(control(late), null);
  late.querySelector('header').insertAdjacentHTML('beforeend', '<button title="Grok">G</button>');
  await tick(); assert.ok(control(late));
  main.insertAdjacentHTML('beforeend', '<div role="link"><article data-testid="tweet"><button title="Grok">G</button><div data-testid="tweetText">Quoted</div></article></div>');
  await tick(); assert.equal(main.querySelectorAll('.xt-translate').length, 1);
  app.w.history.pushState({}, '', '/i/web/status/123');
  app.w.dispatchEvent(new app.w.PopStateEvent('popstate')); await tick(); assert.ok(control(main));
  app.w.history.pushState({}, '', '/search');
  app.w.dispatchEvent(new app.w.PopStateEvent('popstate')); await tick();
  assert.equal(app.d.querySelectorAll('.xt-translate').length, 0);
});

const forceButton = app => app.d.querySelector('.xt-force');
test('local detector normalizes target aliases and conservatively validates source hints', () => {
  const start = source.indexOf('  const mtLanguages');
  const end = source.indexOf('  function isMachineTranslationModel');
  const { sameLanguage, normalizeLanguage } = new Function(source.slice(start, end) + ';return {sameLanguage, normalizeLanguage};')();
  const english = 'This is a sufficiently long English sentence.';
  for (const target of ['en', 'English', '英文', '英语', 'en-GB']) assert.equal(sameLanguage(english, 'en-US', target), true);
  for (const lang of ['', 'English', 'en-invalid', 'unknown', 'en-ZZ', 'en-Hans', 'und', 'fr']) assert.equal(sameLanguage(english, lang, 'English'), false, lang);
  for (const text of ['Hi', 'Hello world', 'Hello 你好 this is a mixed sentence', 'これは日本語だけの文章です', '中文漢字測試內容不應判定英語']) assert.equal(sameLanguage(text, 'en', 'English'), false, text);
  for (const lang of ['zh', 'zh-TW', 'zh-Hant', 'Hant']) assert.equal(sameLanguage('這是一段足夠長度的中文測試文章', lang, '简体中文'), false);
  assert.equal(sameLanguage('这是一段足够长度的中文测试文章', 'zh-Hans', '简体中文'), true);
  assert.equal(sameLanguage('這是一段足夠長度的中文測試文章', 'zh-TW', 'Traditional Chinese'), true);
  assert.equal(normalizeLanguage('zh-Hant-CN', true), '');
  assert.equal(normalizeLanguage('zh_tw'), 'zh-Hant');
  assert.equal(sameLanguage('日本語中文漢字測試內容', 'ja', 'ja'), false);
  assert.equal(sameLanguage('これはとてもわかりやすい日本語の文章です', '', '日本語'), true);
  assert.equal(sameLanguage('이것은충분히길게작성된한국어문장입니다', '', 'ko'), true);
  assert.equal(sameLanguage(english, '', 'English'), false);
});

test('English metadata skips without key or HTTP log; force uses normal flow and never leaks bypass', async t => {
  const app = setup(t, { languages: ['en-US'], saved: [['settings', { provider: 'deepseek', targetLanguage: 'English' }], ['deepseek.key', '']] });
  const a = await app.post('This is a sufficiently long English sentence.');
  a.querySelector('[data-testid=tweetText]').lang = 'en';
  control(a).click();
  assert.equal(app.requests.length, 0); assert.equal(logs(app).length, 0);
  assert.equal(status(app), '原文已是浏览器语言，未发送请求');
  assert.equal(result(app), ''); assert.equal(forceButton(app).hidden, false);
  assert.equal(app.d.querySelector('.xt-overlay').hidden, true);
  forceButton(app).click(); assert.match(status(app), /API Key/); assert.equal(forceButton(app).hidden, true);
  app.configure({ apiKey: 'force-key' }); control(a).click(); forceButton(app).click();
  assert.equal(app.requests.length, 1); assert.equal(app.requests[0].headers.Authorization, 'Bearer force-key');
  control(a).click(); assert.equal(app.requests.length, 1); assert.equal(app.requests[0].aborted, true);
  app.respond(0, 'late'); assert.equal(status(app), '原文已是浏览器语言，未发送请求'); assert.equal(result(app), '');
  app.d.querySelector('.xt-close').click(); assert.equal(forceButton(app).hidden, true);
  control(a).click(); app.setBrowserLanguage(['zh-CN']); app.configure({ });
  assert.equal(forceButton(app).hidden, true); forceButton(app).click(); assert.equal(app.requests.length, 1);
  const retry = [...app.d.querySelectorAll('.xt-panel button')].find(node => node.textContent === '重试');
  retry.click(); assert.equal(app.requests.length, 2); assert.match(JSON.parse(app.requests[1].data).messages[0].content, /zh-Hans-CN/);
});

test('reply own metadata excludes quote and document language; recycled posts re-read lang', async t => {
  const app = setup(t, { path: '/user/status/123' }); app.setBrowserLanguage(['en-US']); app.configure({ });
  app.d.documentElement.lang = 'en';
  const a = await app.post('This is a sufficiently long English sentence.');
  a.insertAdjacentHTML('afterbegin', '<div role="link"><div data-testid="tweetText" lang="en">Quoted English sentence</div></div>');
  control(a).click(); assert.equal(app.requests.length, 1);
  const own = a.querySelector(':scope > [data-testid=tweetText]'); own.lang = 'en-US';
  control(a).click(); assert.equal(app.requests.length, 1); assert.equal(forceButton(app).hidden, false);
  forceButton(app).click(); assert.equal(app.requests.length, 2);
  const b = await app.post('Another sufficiently long English sentence here.'); b.querySelector('[data-testid=tweetText]').lang = 'en';
  control(b).click(); assert.equal(app.requests.length, 2); assert.equal(forceButton(app).hidden, false);
  own.lang = 'fr'; control(a).click(); assert.equal(app.requests.length, 3);
});

test('uncertain Chinese variants, mixed scripts, short and metadata-free posts still request', async t => {
  const app = setup(t); const a = await app.post(); const text = a.querySelector('[data-testid=tweetText]');
  for (const [lang, content, target] of [
    ['en', 'This is a sufficiently long English sentence.', 'zh-CN'],
    ['zh-Hant', '這是一段足夠長度的中文測試文章', 'zh-Hans'],
    ['zh', '这是一段足够长度的中文测试文章', 'zh-CN'],
    ['zh', '這是一段足夠長度的中文測試文章', 'zh-TW'],
    ['en', 'This is mixed 中文内容 and English text.', 'en'],
    ['', 'This is a sufficiently long English sentence.', 'en'],
    ['ja', '日本語中文漢字測試內容', 'ja'],
    ['en', 'Hi', 'en'],
  ]) {
    app.setBrowserLanguage([target]); text.lang = lang; text.textContent = content;
    const count = app.requests.length; control(a).click(); assert.equal(app.requests.length, count + 1);
    assert.equal(forceButton(app).hidden, true);
  }
});

test('malformed transport status is rejected even when response content looks valid', async t => {
  const app = setup(t);
  const article = await app.post();
  for (const httpStatus of [undefined, '200', NaN, 200.5]) {
    control(article).click();
    app.respond(app.requests.length - 1, 'Must not display', { status: httpStatus });
    assert.equal(result(app), '');
    assert.match(logs(app)[0], /错误类型：invalid-response/);
    assert.match(status(app), /无效响应/);
  }
});

test('manager abort exceptions remain visible without leaking secrets or accepting stale results', async t => {
  const app = setup(t);
  app.w.GM_xmlhttpRequest = request => {
    app.requests.push(request);
    return { abort() { throw new Error('secret-deepseek'); } };
  };
  const article = await app.post();
  control(article).click();
  control(article).click();
  const cancelledLog = logs(app)[1];
  assert.match(cancelledLog, /状态：已取消/);
  assert.match(cancelledLog, /取消网络请求失败/);
  assert.doesNotMatch(cancelledLog, /secret-deepseek/);
  app.respond(1, 'Latest translation');
  app.respond(0, 'Stale translation');
  assert.equal(result(app), 'Latest translation');
  assert.equal(logs(app)[1], cancelledLog);
});

test('inherited object names are not accepted as stored provider identifiers', async t => {
  const app = setup(t, { saved: [
    ['settings', { provider: 'toString', targetLanguage: 'English' }],
  ] });
  control(await app.post()).click();
  assert.equal(app.requests.length, 0);
  assert.match(status(app), /存储/);
  assert.equal(app.d.querySelector('[name=provider]').value, 'deepseek');
});


test('browser locale canonicalization preserves Chinese variants and maps MT aliases', async t => {
  const app = setup(t); app.configure({ provider: 'qwen' }); const article = await app.post();
  for (const [locale, expected] of [
    ['en-US', 'English'], ['ja', 'Japanese'], ['zh-CN', 'Chinese'], ['zh-SG', 'Chinese'],
    ['zh-Hans', 'Chinese'], ['zh', 'Chinese'], ['zh-TW', 'Traditional Chinese'],
    ['zh-HK', 'Traditional Chinese'], ['zh-MO', 'Traditional Chinese'], ['zh-Hant', 'Traditional Chinese'],
    ['zh-Hant-CN', 'Traditional Chinese'], ['nb-NO', 'Norwegian Bokmål'], ['nn-NO', 'Norwegian Nynorsk'],
    ['tl-PH', 'Tagalog'], ['fil-PH', 'Tagalog'],
  ]) {
    app.setBrowserLanguage([locale, 'en']); control(article).click();
    assert.equal(JSON.parse(app.requests.at(-1).data).translation_options.target_lang, expected, locale);
  }
});

test('browser preference fallback and ordinary models preserve valid uncommon locales', async t => {
  for (const [languages, fallback, expected] of [[[], 'ja', 'ja'], [undefined, 'en-US', 'en-US'], [['', '  ', 'eo'], 'ja', 'eo'], [['es-MX', 'ja'], 'en', 'es-MX']]) {
    const app = setup(t, { language: fallback }); app.setBrowserLanguage(languages, fallback);
    app.menu(); assert.equal(app.d.querySelector('[name=browserLanguage]').value, expected);
    control(await app.post()).click();
    assert.ok(JSON.parse(app.requests[0].data).messages[0].content.includes('into ' + expected + '.'));
    assert.ok(logs(app)[0].includes('浏览器语言：' + expected));
  }
});

test('invalid or missing browser language is visible before network but credentials remain saveable', async t => {
  for (const [languages, language] of [[[], ''], [[], undefined], [['en_US', 'ja'], 'en'], [['und'], 'ja']]) {
    const app = setup(t); app.setBrowserLanguage(languages, language ?? '');
    app.menu(); assert.match(app.d.querySelector('[name=browserLanguage]').value, /浏览器语言缺失或无效/);
    app.configure({ apiKey: 'new-key' }); assert.equal(app.store.get(prefix + 'deepseek.key'), 'new-key');
    control(await app.post()).click(); assert.equal(app.requests.length, 0);
    assert.match(status(app), /浏览器语言缺失或无效/); assert.equal(forceButton(app).hidden, true);
  }
});

test('languagechange updates display, cancels pending work and invalidates results and force state', async t => {
  const app = setup(t); const article = await app.post('This is a sufficiently long English sentence.');
  article.querySelector('[data-testid=tweetText]').lang = 'en';
  control(article).click(); app.menu(); app.setBrowserLanguage(['ja']);
  assert.equal(app.requests[0].aborted, true);
  assert.equal(app.d.querySelector('[name=browserLanguage]').value, 'ja');
  app.respond(0, 'stale'); assert.equal(result(app), '');
  app.d.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  control(article).click(); assert.match(JSON.parse(app.requests[1].data).messages[0].content, /into ja/);
  app.respond(1, '日本語'); app.setBrowserLanguage(['en-US']); assert.equal(result(app), '');
  control(article).click(); assert.equal(forceButton(app).hidden, false);
  app.setBrowserLanguage(['zh-TW']); assert.equal(forceButton(app).hidden, true);
  forceButton(app).click(); assert.equal(app.requests.length, 2);
  control(article).click(); assert.match(JSON.parse(app.requests[2].data).messages[0].content, /zh-Hant-TW/);
});

const cacheData = app => JSON.parse(app.store.get(prefix + 'translation-cache'));
const cacheChange = (app, name, value) => {
  app.menu();
  const input = app.d.querySelector(`[name=${name}]`);
  if (input.type === 'checkbox') input.checked = value; else input.value = value;
  input.dispatchEvent(new app.w.Event('change'));
  app.d.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};
const clearCache = app => { app.menu(); app.d.querySelector('.xt-clear-cache').click(); };
const reloadCache = app => [...app.store].map(([key, value]) => [key.slice(prefix.length), value]);

test('cache persists across reload, second click and cleared keys without fake diagnostics', async t => {
  const app = setup(t); const article = await app.post('Original');
  control(article).click(); app.respond(0, 'Translated');
  const completed = cacheData(app).entries[0].completedAt;
  control(article).click(); assert.equal(app.requests.length, 1); assert.equal(status(app), '已读取缓存');
  assert.equal(logs(app).length, 1); assert.equal(cacheData(app).entries[0].completedAt, completed);
  assert.ok(cacheData(app).entries[0].usedAt > completed);
  app.configure({ apiKey: '' }); control(article).click();
  assert.equal(status(app), '已读取缓存'); assert.equal(app.requests.length, 1);
  const next = setup(t, { saved: reloadCache(app) }); control(await next.post('Original')).click();
  assert.equal(result(next), 'Translated'); assert.equal(next.requests.length, 0); assert.equal(logs(next).length, 0);
  assert.equal(next.d.querySelector('.xt-overlay').hidden, true);
});

test('cache exact identity includes source hint, browser region, provider, model, normalized endpoint and rules', async t => {
  const app = setup(t); const article = await app.post('Original'); const node = article.querySelector('[data-testid=tweetText]');
  const send = () => { const count = app.requests.length; control(article).click(); assert.equal(app.requests.length, count + 1); app.respond(count, 'result-' + count); };
  send(); node.lang = 'en'; send(); node.textContent = 'Changed'; send();
  app.setBrowserLanguage(['zh-SG']); send(); app.configure({ model: 'other' }); send();
  app.configure({ baseURL: 'https://relay.example/v1', apiKey: 'relay-key' }); send();
  app.configure({ baseURL: 'https://relay.example/v1/chat/completions/' });
  control(article).click(); assert.equal(status(app), '已读取缓存');
  app.configure({ provider: 'qwen', model: 'other', baseURL: 'https://relay.example/v1', apiKey: 'qwen-key' }); send();
  const cache = cacheData(app); cache.entries[0].identity[6] = 999;
  app.store.set(prefix + 'translation-cache', JSON.stringify(cache)); send();
  assert.match(status(app), /缓存.*损坏/);
});

test('LRU defaults to 20, updates reuse, supports all limits and immediately evicts on lowering', async t => {
  const app = setup(t); const article = await app.post(); const node = article.querySelector('[data-testid=tweetText]');
  const translateNumber = n => { node.textContent = 'source-' + n; control(article).click(); };
  for (let n = 0; n < 20; n++) { translateNumber(n); app.respond(n, 'result-' + n); }
  assert.equal(cacheData(app).limit, 20); assert.equal(cacheData(app).entries.length, 20);
  translateNumber(0); translateNumber(20); app.respond(20);
  assert.equal(cacheData(app).entries.length, 20);
  assert.ok(cacheData(app).entries.some(entry => entry.identity[0] === 'source-0'));
  assert.ok(!cacheData(app).entries.some(entry => entry.identity[0] === 'source-1'));
  for (const limit of [100, 50, 20, 10]) { cacheChange(app, 'cacheLimit', limit); assert.equal(cacheData(app).limit, limit); }
  assert.equal(cacheData(app).entries.length, 10);
  assert.equal(cacheData(app).entries[0].identity[0], 'source-12');
});

test('clear and disable are independent, confirm cancellation preserves data; stale tabs do not resurrect records', async t => {
  const app = setup(t); const article = await app.post('Original');
  control(article).click(); app.respond(0); const before = app.store.get(prefix + 'translation-cache');
  let confirmations = 0; app.w.confirm = message => { confirmations++; assert.match(message, /删除.*原文.*译文/); return false; };
  cacheChange(app, 'cacheEnabled', false); assert.equal(confirmations, 1);
  assert.equal(app.store.get(prefix + 'translation-cache'), before);
  app.w.confirm = () => true; cacheChange(app, 'cacheEnabled', false);
  assert.equal(cacheData(app).enabled, false); assert.equal(cacheData(app).entries.length, 0);
  control(article).click(); app.respond(1); assert.equal(cacheData(app).entries.length, 0);
  cacheChange(app, 'cacheEnabled', true); control(article).click(); app.respond(2);
  clearCache(app); assert.equal(cacheData(app).entries.length, 0); assert.equal(app.store.get(prefix + 'deepseek.key'), 'secret-deepseek');
  control(article).click(); clearCache(app); app.respond(3); assert.equal(cacheData(app).entries.length, 0);
  // A different tab's write is observed at the very next lookup, not merged from old memory.
  app.store.set(prefix + 'translation-cache', before); control(article).click(); assert.equal(status(app), '已读取缓存');
  app.store.set(prefix + 'translation-cache', JSON.stringify({ ...cacheData(app), entries: [], epoch: 'another-tab' }));
  control(article).click(); assert.equal(app.requests.length, 5);
});

test('cache corruption is isolated and explicit, clear recovers without credential changes', async t => {
  const cases = ['{', '{}', 'null', JSON.stringify({ schema: 1, enabled: true, limit: 7, epoch: '', entries: [] }),
    JSON.stringify({ schema: 1, enabled: true, limit: 20, epoch: '', entries: Array(21).fill({}) })];
  for (const value of cases) {
    const app = setup(t, { saved: [['translation-cache', value]] }); const article = await app.post();
    control(article).click(); app.respond(0, 'success'); assert.equal(result(app), 'success'); assert.match(status(app), /缓存.*损坏/);
    clearCache(app); assert.equal(cacheData(app).entries.length, 0); assert.equal(app.store.get(prefix + 'deepseek.key'), 'secret-deepseek');
    control(article).click(); app.respond(1); assert.equal(cacheData(app).entries.length, 1);
  }
});

test('cache-only read/write exceptions do not poison credential settings or hide successes', async t => {
  for (const operation of ['GM_getValue', 'GM_setValue']) {
    const app = setup(t); const original = app.w[operation];
    app.w[operation] = (key, value) => { if (key === prefix + 'translation-cache') throw Error('secret-deepseek'); return original(key, value); };
    const article = await app.post(); control(article).click(); app.respond(0, 'success');
    assert.equal(result(app), 'success'); assert.match(status(app), /缓存存储/); assert.doesNotMatch(status(app), /secret/);
    app.configure({ apiKey: 'replacement' }); assert.equal(app.store.get(prefix + 'deepseek.key'), 'replacement');
    app.w[operation] = original; control(article).click(); app.respond(1); assert.equal(cacheData(app).entries.length, 1);
    app.w.GM_setValue = () => { throw Error('secret'); }; control(article).click();
    assert.equal(result(app), '你好'); assert.match(status(app), /已读取缓存.*缓存存储/); assert.equal(app.requests.length, 2);
  }
});

test('cache UTF8 entry and total limits evict rather than truncate successful output', async t => {
  const app = setup(t); const article = await app.post(); const node = article.querySelector('[data-testid=tweetText]');
  control(article).click(); const oversized = '界'.repeat(90000); app.respond(0, oversized);
  assert.equal(result(app), oversized); assert.match(status(app), /单条缓存大小/); assert.equal(app.store.has(prefix + 'translation-cache'), false);
  const translation = '界'.repeat(80000);
  for (let n = 0; n < 12; n++) { node.textContent = 'source-' + n; control(article).click(); app.respond(n + 1, translation); }
  const raw = app.store.get(prefix + 'translation-cache'); const cache = JSON.parse(raw);
  assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024); assert.ok(cache.entries.length < 12);
  assert.ok(cache.entries.every(entry => Buffer.byteLength(JSON.stringify(entry)) <= 256 * 1024));
  assert.ok(cache.entries.every(entry => entry.result === translation));
  app.store.set(prefix + 'translation-cache', ' '.repeat(2 * 1024 * 1024 + 1));
  control(article).click(); app.respond(13); assert.match(status(app), /缓存.*损坏/);
});

test('cache stores no credentials, request objects or stale/failed results and preserves snapshot source', async t => {
  const app = setup(t); const article = await app.post('Original'); const node = article.querySelector('[data-testid=tweetText]');
  control(article).click(); node.textContent = 'Mutated without click'; app.respond(0, 'secret-deepseek secret-qwen');
  let raw = app.store.get(prefix + 'translation-cache');
  assert.doesNotMatch(raw, /secret-deepseek|secret-qwen|Authorization|headers|responseText/);
  assert.equal(cacheData(app).entries[0].identity[0], 'Original');
  node.textContent = 'secret-deepseek'; control(article).click(); app.respond(1, 'safe');
  assert.match(status(app), /敏感值/); assert.equal(cacheData(app).entries.length, 1);
  node.textContent = 'Pending'; control(article).click(); app.configure({ model: 'changed' }); app.respond(2, 'stale');
  control(article).click(); app.requests[3].onerror();
  control(article).click(); app.d.querySelector('.xt-close').click(); app.respond(4, 'closed');
  assert.equal(cacheData(app).entries.length, 1);
});

test('explicit retranslate bypasses both cache and same-language skip for one action', async t => {
  const app = setup(t, { languages: ['en-US'] }); const article = await app.post('This is a sufficiently long English sentence.');
  article.querySelector('[data-testid=tweetText]').lang = 'en'; control(article).click();
  assert.equal(app.requests.length, 0); forceButton(app).click(); app.respond(0, 'forced');
  control(article).click(); assert.equal(status(app), '已读取缓存'); assert.equal(app.requests.length, 1);
  app.d.querySelector('.xt-retranslate').click(); assert.equal(app.requests.length, 2); app.respond(1, 'fresh');
  control(article).click(); assert.equal(result(app), 'fresh'); assert.equal(app.requests.length, 2); assert.equal(logs(app).length, 2);
});

test('main posts and comments cache their own text independently, ignoring quotes', async t => {
  const app = setup(t, { path: '/user/status/123' }); const main = await app.post('Main'); const reply = await app.post('Reply');
  main.insertAdjacentHTML('beforeend', '<div role="link"><div data-testid="tweetText">Quoted</div></div>');
  control(main).click(); app.respond(0, '主帖'); control(reply).click(); app.respond(1, '评论');
  control(main).click(); assert.equal(result(app), '主帖'); control(reply).click(); assert.equal(result(app), '评论');
  assert.equal(app.requests.length, 2); assert.deepEqual(cacheData(app).entries.map(entry => entry.identity[0]).sort(), ['Main', 'Reply']);
});

test('success merges latest persisted entries instead of overwriting another tab', async t => {
  const app = setup(t); const article = await app.post('First');
  control(article).click(); app.respond(0, 'first');
  article.querySelector('[data-testid=tweetText]').textContent = 'Second'; control(article).click();
  const latest = cacheData(app); const other = structuredClone(latest.entries[0]); other.identity[0] = 'Other tab';
  latest.entries.push(other); app.store.set(prefix + 'translation-cache', JSON.stringify(latest));
  app.respond(1, 'second');
  assert.deepEqual(cacheData(app).entries.map(entry => entry.identity[0]).sort(), ['First', 'Other tab', 'Second']);
});

test('malformed bounded records fail safe and redacted configuration identity is not stored', async t => {
  const app = setup(t); const article = await app.post('Original'); control(article).click(); app.respond(0);
  const valid = cacheData(app);
  for (const change of [entry => entry.usedAt = -1, entry => entry.result = {}, entry => entry.identity[5] = 'http://unsafe.test', entry => entry.identity[0] = '', entry => entry.result = '界'.repeat(90000)]) {
    const broken = structuredClone(valid); change(broken.entries[0]);
    app.store.set(prefix + 'translation-cache', JSON.stringify(broken));
    control(article).click(); app.respond(app.requests.length - 1); assert.match(status(app), /缓存.*损坏/);
  }
  clearCache(app); app.configure({ model: 'secret-deepseek-model' }); control(article).click(); app.respond(app.requests.length - 1);
  assert.match(status(app), /敏感值/); assert.equal(cacheData(app).entries.length, 0);
});


test('profile feeds inject beside own Grok across tabs and SPA navigation', async t => {
  const app = setup(t, { path: '/airejectlist' });
  app.d.querySelector('main').insertAdjacentHTML('afterbegin', '<div role="tablist"><a role="tab" aria-selected="true">Posts</a></div>');
  const article = await app.post('Profile post');
  assert.equal(control(article).nextElementSibling.getAttribute('aria-label'), 'Ask Grok');
  control(article).click();
  assert.equal(JSON.parse(app.requests[0].data).messages[1].content, 'Profile post');
  app.respond(0);
  for (const path of ['/airejectlist/', '/airejectlist/with_replies', '/airejectlist/media', '/airejectlist/likes', '/airejectlist/highlights', '/airejectlist/articles']) {
    app.w.history.pushState({}, '', path);
    app.w.dispatchEvent(new app.w.PopStateEvent('popstate'));
    await tick();
    assert.equal(article.querySelectorAll('.xt-translate').length, 1, path);
  }
  const late = await app.post('Late profile post', false);
  late.querySelector('header').insertAdjacentHTML('beforeend', '<button title="Grok">G</button>');
  await tick();
  assert.equal(control(late).nextElementSibling.title, 'Grok');
  for (const path of ['/search', '/explore', '/notifications', '/messages', '/settings', '/i', '/grok', '/airejectlist/followers', '/airejectlist/unknown']) {
    app.w.history.pushState({}, '', path);
    app.w.dispatchEvent(new app.w.PopStateEvent('popstate'));
    await tick();
    assert.equal(control(article), null, path);
  }
  app.w.history.pushState({}, '', '/airejectlist');
  app.w.dispatchEvent(new app.w.PopStateEvent('popstate'));
  await tick();
  assert.ok(control(article));
});


test('floating launcher opens the panel on any route without requests and restores focus', async t => {
  const app = setup(t, { path: '/search' });
  const launcher = app.d.querySelector('.xt-launcher');
  const panel = app.d.querySelector('.xt-panel');
  assert.equal(launcher.getAttribute('aria-controls'), panel.id);
  assert.equal(panel.hidden, true);
  launcher.click();
  await tick();
  assert.equal(panel.hidden, false);
  assert.match(status(app), /点击推文旁/);
  assert.equal(app.d.activeElement, app.d.querySelector('.xt-close'));
  assert.equal(app.requests.length, 0);
  app.w.document.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel.hidden, true);
  assert.equal(app.d.activeElement, launcher);
  launcher.click();
  await tick();
  assert.equal(panel.hidden, false);
  assert.equal(app.d.querySelectorAll('.xt-launcher').length, 1);
});

test('floating launcher reopens existing results without retranslating or clearing them', async t => {
  const app = setup(t);
  const article = await app.post();
  control(article).click();
  app.respond(0, '已有译文');
  app.d.querySelector('.xt-close').click();
  app.d.querySelector('.xt-launcher').click();
  await tick();
  assert.equal(app.d.querySelector('.xt-panel').hidden, false);
  assert.equal(result(app), '已有译文');
  assert.equal(app.requests.length, 1);
  assert.equal(app.d.querySelector('.xt-source').textContent, 'Hello\nworld 😀');
});

test('floating launcher tracks the bottom-right Grok button, resize and removal', async t => {
  const app = setup(t);
  const launcher = app.d.querySelector('.xt-launcher');
  const article = await app.post();
  const rect = () => ({ width: 56, height: 56, top: app.w.innerHeight - 80, bottom: app.w.innerHeight - 24, right: app.w.innerWidth - 24 });
  article.querySelector('[aria-label="Ask Grok"]').getBoundingClientRect = rect;
  app.w.dispatchEvent(new app.w.Event('resize'));
  await tick();
  assert.equal(launcher.style.bottom, '');
  const grok = app.d.createElement('button');
  grok.dataset.testid = 'GrokDrawer';
  grok.getBoundingClientRect = rect;
  app.d.body.append(grok);
  await tick();
  assert.equal(launcher.style.right, '24px');
  assert.equal(launcher.style.bottom, '92px');
  grok.getBoundingClientRect = () => ({ width: 56, height: 56, top: app.w.innerHeight - 110, bottom: app.w.innerHeight - 54, right: app.w.innerWidth - 32 });
  app.w.dispatchEvent(new app.w.Event('resize'));
  await tick();
  assert.equal(launcher.style.right, '32px');
  assert.equal(launcher.style.bottom, '122px');
  grok.remove();
  await tick();
  assert.equal(launcher.style.right, '');
  assert.equal(launcher.style.bottom, '');
});


test('retry from a launcher-opened panel stays visible outside tweet routes', async t => {
  const app = setup(t);
  const article = await app.post();
  control(article).click();
  app.requests[0].onerror();
  app.d.querySelector('.xt-close').click();
  app.w.history.pushState({}, '', '/search');
  app.w.dispatchEvent(new app.w.PopStateEvent('popstate'));
  await tick();
  app.d.querySelector('.xt-launcher').click();
  [...app.d.querySelectorAll('.xt-panel button')].find(node => node.textContent === '重试').click();
  await tick();
  assert.equal(app.d.querySelector('.xt-panel').hidden, false);
  assert.equal(app.requests.length, 2);
  assert.notEqual(app.requests[1].aborted, true);
  app.respond(1);
  assert.equal(result(app), '你好');
});


test('userscript update version matches the displayed version', () => {
  const metadataVersion = source.match(/@version\s+(\S+)/)[1];
  const displayedVersion = source.match(/const SCRIPT_VERSION = '([^']+)'/)[1];
  assert.equal(metadataVersion, displayedVersion);
});

test('floating launcher and panel recover after page removes injected UI', async t => {
  const app = setup(t);
  const launcher = app.d.querySelector('.xt-launcher');
  const panel = app.d.querySelector('.xt-panel');
  const overlay = app.d.querySelector('.xt-overlay');
  const style = [...app.d.querySelectorAll('style')].find(node => node.textContent.includes('.xt-launcher'));
  launcher.remove();
  panel.remove();
  overlay.remove();
  style.remove();
  await tick();
  assert.equal(launcher.isConnected, true);
  assert.equal(panel.isConnected, true);
  assert.equal(overlay.isConnected, true);
  assert.equal(style.isConnected, true);
  assert.equal(app.d.querySelectorAll('.xt-launcher').length, 1);
  assert.equal(launcher.textContent, '译');
  launcher.click();
  await tick();
  assert.equal(panel.hidden, false);
  assert.equal(app.requests.length, 0);
});


test('branding embeds the exact repository logo and preserves accessible controls', t => {
  const app = setup(t);
  const expected = 'data:image/png;base64,' + fs.readFileSync('logo.png').toString('base64');
  const logos = [...app.d.querySelectorAll('.xt-brand-logo')];
  assert.equal(logos.length, 3);
  for (const logo of logos) {
    assert.equal(logo.src, expected);
    assert.equal(logo.alt, '');
    assert.equal(logo.hasAttribute('width'), true);
    assert.equal(logo.hasAttribute('height'), true);
  }
  assert.equal(app.d.querySelector('.xt-panel .xt-brand-name span').textContent, 'CoserOps');
  assert.equal(app.d.querySelector('.xt-settings .xt-brand-name span').textContent, 'CoserOps');
  assert.equal(app.d.querySelector('.xt-launcher').getAttribute('aria-label'), '打开翻译面板');
  assert.equal(app.d.querySelectorAll('.xt-card-heading h3').length, 2);
  assert.equal(app.requests.length, 0);
});


test('author contact links appear in both surfaces without submitting or requesting translations', t => {
  const app = setup(t);
  const contacts = [...app.d.querySelectorAll('.xt-contact a')];
  assert.equal(contacts.length, 2);
  assert.ok(app.d.querySelector('.xt-content > .xt-contact a'));
  assert.ok(app.d.querySelector('.xt-form-body > .xt-contact a'));
  for (const link of contacts) {
    assert.equal(link.textContent, 'X @coserops');
    assert.equal(link.href, 'https://x.com/coserops');
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.match(link.getAttribute('aria-label'), /新标签页/);
  }
  app.menu();
  const contact = contacts[1];
  contact.focus();
  assert.equal(app.d.activeElement, contact);
  contact.addEventListener('click', event => event.preventDefault());
  contact.click();
  assert.equal(app.d.querySelector('.xt-overlay').hidden, false);
  assert.equal(app.requests.length, 0);
  contact.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(app.d.querySelector('.xt-overlay').hidden, true);
});


test('contact orbit is continuous with static accessible fallbacks', t => {
  const app = setup(t);
  const css = [...app.d.querySelectorAll('style')].map(node => node.textContent).join('\n');
  assert.match(css, /\.xt-contact-label::after,\.xt-contact a::after\s*\{[^}]*pointer-events:none/);
  assert.match(css, /@supports\(offset-path:inset\(0 round 12px\)\)\s*\{\s*\.xt-contact-label::after,\.xt-contact a::after\s*\{[^}]*animation:xt-contact-orbit 5s linear infinite/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\s*\{[^}]*\.xt-contact-label::after,\.xt-contact a::after\s*\{\s*animation:none!important/);
  assert.match(css, /@media\(forced-colors:active\)\s*\{[^}]*\}[^}]*\}\s*\.xt-contact-label::after,\.xt-contact a::after\s*\{ display:none \}/);
  assert.equal(app.d.querySelectorAll('.xt-contact-label').length, 2);
  for (const label of app.d.querySelectorAll('.xt-contact-label')) {
    assert.equal(label.textContent, '联系作者');
    assert.equal(app.w.getComputedStyle(label).position, 'relative');
    assert.equal(app.w.getComputedStyle(label).fontSize, '14px');
  }
  assert.equal(app.w.getComputedStyle(app.d.querySelector('.xt-contact')).fontSize, '14px');
  assert.equal(app.w.getComputedStyle(app.d.querySelector('.xt-contact a')).fontSize, '15px');
});
