const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../x-timeline-translator.user.js'), 'utf8');
const endpoint = 'https://translator.example/api/translate';
const tick = () => new Promise((resolve) => setTimeout(resolve, 100));

function setup(t, { stored = { endpoint, targetLanguage: 'zh-CN' }, pathname = '/home' } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main></main></body></html>', {
    url: `https://x.com${pathname}`, runScripts: 'outside-only', virtualConsole: new VirtualConsole(),
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const requests = [];
  const saved = [];
  let menu;
  window.GM_getValue = () => stored;
  window.GM_setValue = (key, value) => saved.push({ key, value });
  window.GM_registerMenuCommand = (label, callback) => { menu = callback; };
  window.GM_xmlhttpRequest = (request) => { requests.push(request); };
  window.eval(source);
  const doc = window.document;
  async function post(html = 'Hello world') {
    const article = doc.createElement('article');
    article.dataset.testid = 'tweet';
    const text = doc.createElement('div');
    text.dataset.testid = 'tweetText';
    text.innerHTML = html;
    article.append(text);
    doc.querySelector('main').append(article);
    await tick();
    return article;
  }
  function respond(index, data = { translatedText: '你好', detectedSourceLanguage: 'en' }, status = 200) {
    requests[index].onload({ status, responseText: JSON.stringify(data) });
  }
  function configure(url = endpoint, language = 'zh-CN') {
    menu();
    doc.querySelector('[name="endpoint"]').value = url;
    doc.querySelector('[name="targetLanguage"]').value = language;
    doc.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  }
  return { window, doc, requests, saved, post, respond, configure, menu: () => menu() };
}

const button = (post) => post.querySelector('.xt-control button');
const status = (post) => post.querySelector('.xt-status').textContent;

test('metadata limits execution to X/Twitter and uses privileged anonymous HTTP', () => {
  assert.match(source, /@match\s+https:\/\/x\.com\/\*/);
  assert.match(source, /@match\s+https:\/\/twitter\.com\/\*/);
  assert.match(source, /@grant\s+GM_xmlhttpRequest/);
  assert.doesNotMatch(source, /@require/);
});

test('does not send text before a click; displays, collapses and reopens a translation', async (t) => {
  const app = setup(t);
  const article = await app.post('Hello<br>world <img alt="😀">');
  assert.equal(app.requests.length, 0);
  button(article).click();
  button(article).click();
  assert.equal(app.requests.length, 1);
  assert.equal(button(article).disabled, true);
  assert.deepEqual(JSON.parse(app.requests[0].data), { text: 'Hello\nworld 😀', targetLanguage: 'zh-CN' });
  assert.equal(app.requests[0].anonymous, true);
  assert.equal(app.requests[0].timeout, 30000);
  assert.equal(app.requests[0].headers.Authorization, undefined);
  app.respond(0);
  await tick();
  assert.equal(article.querySelector('.xt-result').textContent, '你好');
  assert.equal(button(article).disabled, false);
  button(article).click();
  assert.equal(article.querySelector('.xt-result').hidden, true);
  button(article).click();
  assert.equal(article.querySelector('.xt-result').hidden, false);
  assert.equal(app.requests.length, 1);
});

test('deduplicates in-flight requests and reuses cached text across dynamic posts', async (t) => {
  const app = setup(t);
  const first = await app.post();
  const second = await app.post();
  button(first).click();
  button(second).click();
  assert.equal(app.requests.length, 1);
  app.respond(0);
  await tick();
  assert.equal(second.querySelector('.xt-result').textContent, '你好');
  const third = await app.post();
  button(third).click();
  await tick();
  assert.equal(app.requests.length, 1);
  assert.equal(third.querySelector('.xt-result').textContent, '你好');
  assert.equal(first.querySelectorAll('.xt-control').length, 1);
});

test('opens settings when unconfigured and saves language and endpoint', async (t) => {
  const app = setup(t, { stored: null });
  const article = await app.post();
  button(article).click();
  assert.equal(app.requests.length, 0);
  assert.equal(app.doc.querySelector('.xt-overlay').hidden, false);
  app.configure(endpoint, 'ja');
  assert.equal(app.saved.length, 1);
  assert.equal(app.saved[0].value.targetLanguage, 'ja');
  button(article).click();
  assert.equal(JSON.parse(app.requests[0].data).targetLanguage, 'ja');
});

test('changing language during a request discards stale results', async (t) => {
  const app = setup(t);
  const article = await app.post();
  button(article).click();
  app.configure(endpoint, 'ja');
  button(article).click();
  app.respond(0);
  await tick();
  assert.equal(article.querySelector('.xt-result').hidden, true);
  app.respond(1, { translatedText: 'こんにちは', detectedSourceLanguage: 'en' });
  await tick();
  assert.equal(article.querySelector('.xt-result').textContent, 'こんにちは');
  assert.equal(article.querySelector('.xt-result').lang, 'ja');
});

test('endpoint changes do not reuse another backend response', async (t) => {
  const app = setup(t);
  const article = await app.post();
  button(article).click();
  app.respond(0);
  await tick();
  app.configure('https://second.example/api/translate');
  button(article).click();
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].url, 'https://second.example/api/translate');
});

test('recycled tweet text invalidates UI and ignores old responses', async (t) => {
  const app = setup(t);
  const article = await app.post('First');
  button(article).click();
  article.querySelector('[data-testid="tweetText"]').textContent = 'Second';
  await tick();
  app.respond(0);
  await tick();
  assert.equal(article.querySelector('.xt-result').hidden, true);
  button(article).click();
  assert.equal(JSON.parse(app.requests[1].data).text, 'Second');
});

test('handles timeline switches, detached nodes and replacement text nodes', async (t) => {
  const app = setup(t);
  const first = await app.post();
  first.remove();
  const next = await app.post('Following');
  assert.equal(app.doc.querySelectorAll('.xt-control').length, 1);
  next.querySelector('[data-testid="tweetText"]').outerHTML = '<div data-testid="tweetText">Updated</div>';
  await tick();
  assert.equal(next.querySelectorAll('.xt-control').length, 1);
  button(next).click();
  assert.equal(JSON.parse(app.requests[0].data).text, 'Updated');
});

test('only attaches on home timeline and ignores quoted text', async (t) => {
  const app = setup(t, { pathname: '/someone/status/123' });
  const article = await app.post('Original');
  assert.equal(button(article), null);
  app.window.history.pushState({}, '', '/home');
  app.window.dispatchEvent(new app.window.PopStateEvent('popstate'));
  await tick();
  const quote = app.doc.createElement('div');
  quote.setAttribute('role', 'link');
  quote.innerHTML = '<div data-testid="tweetText">Quoted</div>';
  article.append(quote);
  await tick();
  assert.equal(article.querySelectorAll('.xt-control').length, 1);
  button(article).click();
  assert.equal(JSON.parse(app.requests[0].data).text, 'Original');
  app.window.history.pushState({}, '', '/settings');
  app.window.dispatchEvent(new app.window.PopStateEvent('popstate'));
  await tick();
  assert.equal(button(article), null);
});

test('renders untrusted translation as text, not HTML', async (t) => {
  const app = setup(t);
  const article = await app.post();
  button(article).click();
  app.respond(0, { translatedText: '<img src=x onerror="alert(1)">', detectedSourceLanguage: 'en' });
  await tick();
  assert.equal(article.querySelector('.xt-result img'), null);
  assert.equal(article.querySelector('.xt-result').textContent, '<img src=x onerror="alert(1)">');
});

test('reports HTTP, network, timeout and malformed-response errors and permits retry', async (t) => {
  const app = setup(t);
  const article = await app.post();
  const cases = [
    [(r) => r.onload({ status: 429, responseText: '{}' }), /额度/],
    [(r) => r.onload({ status: 404, responseText: '{}' }), /接口不存在/],
    [(r) => r.onerror(), /网络/],
    [(r) => r.ontimeout(), /超时/],
    [(r) => r.onabort(), /取消/],
    [(r) => r.onload({ status: 200, responseText: 'not json' }), /有效 JSON/],
    [(r) => r.onload({ status: 200, responseText: '{}' }), /响应格式/],
  ];
  for (const [fail, message] of cases) {
    button(article).click();
    fail(app.requests.at(-1));
    await tick();
    assert.match(status(article), message);
    assert.equal(button(article).textContent, '重试翻译');
    assert.equal(button(article).disabled, false);
  }
  button(article).click();
  app.respond(app.requests.length - 1);
  await tick();
  assert.equal(article.querySelector('.xt-result').textContent, '你好');
});

test('rejects insecure or credential-bearing URLs, but allows localhost', (t) => {
  const app = setup(t);
  for (const url of ['http://example.com/api', 'https://user:password@example.com/api', 'https://example.com/api?key=abc', 'file:///tmp/test']) {
    app.configure(url);
    assert.equal(app.saved.length, 0);
    assert.notEqual(app.doc.querySelector('[role="alert"]').textContent, '');
  }
  app.configure('http://localhost:8787/api/translate');
  assert.equal(app.saved.length, 1);
});

test('storage failures are visible and do not apply unsaved settings', (t) => {
  const app = setup(t);
  app.window.GM_setValue = () => { throw new app.window.Error('storage unavailable'); };
  app.configure(endpoint, 'ja');
  assert.match(app.doc.querySelector('[role="alert"]').textContent, /storage unavailable/);
  assert.equal(app.doc.querySelector('.xt-overlay').hidden, false);
});

test('limits input length and concurrent requests', async (t) => {
  const app = setup(t);
  const long = await app.post('a'.repeat(20001));
  button(long).click();
  assert.match(status(long), /20000/);
  assert.equal(app.requests.length, 0);
  for (let i = 0; i < 5; i++) {
    const article = await app.post(`Post ${i}`);
    button(article).click();
    if (i === 4) {
      await tick();
      assert.match(status(article), /等待后重试/);
    }
  }
  assert.equal(app.requests.length, 4);
});

test('keeps at most 200 cached translations', async (t) => {
  const app = setup(t);
  const article = await app.post();
  const text = article.querySelector('[data-testid="tweetText"]');
  for (let i = 0; i < 201; i++) {
    text.textContent = `Cache ${i}`;
    button(article).click();
    app.respond(i);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(app.requests.length, 201);
  text.textContent = 'Cache 200';
  button(article).click();
  assert.equal(app.requests.length, 201);
  text.textContent = 'Cache 0';
  button(article).click();
  assert.equal(app.requests.length, 202);
});

test('corrupt saved settings show a warning rather than silently using them', (t) => {
  const app = setup(t, { stored: { endpoint: 'bad', targetLanguage: 'not-a-language' } });
  app.menu();
  assert.match(app.doc.querySelector('[role="alert"]').textContent, /读取设置失败/);
});
