import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../server/index.js';
import { Store } from '../server/store.js';

const NOW = 1_700_000_000_000;

async function withServer(callback) {
  const store = new Store(null, { now: () => NOW, random: () => 0.5 });
  const server = createServer({ store, simulate: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await callback({ base, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function json(response) {
  return response.json();
}

test('overview endpoint returns the console snapshot', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/overview`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const payload = await json(response);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.agents.length, 3);
    assert.ok(payload.data.stats.tasks.queued >= 1);
  });
});

test('agent and task endpoints support the console workflow', async () => {
  await withServer(async ({ base }) => {
    let response = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Orion', role: 'reviewer', model: 'deepseek-v4-mini' }),
    });
    assert.equal(response.status, 201);
    const created = (await json(response)).data;
    assert.equal(created.name, 'Orion');

    response = await fetch(`${base}/api/agents/${created.id}/stop`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await json(response)).data.status, 'offline');

    response = await fetch(`${base}/api/agents/${created.id}/start`, { method: 'POST' });
    assert.equal((await json(response)).data.status, 'idle');

    response = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '验证 API', priority: 'high', agentId: created.id }),
    });
    assert.equal(response.status, 201);
    const task = (await json(response)).data;
    assert.equal(task.status, 'queued');
    assert.equal(task.agentId, created.id);

    response = await fetch(`${base}/api/tasks/${task.id}/cancel`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await json(response)).data.status, 'cancelled');

    response = await fetch(`${base}/api/tasks/${task.id}/retry`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await json(response)).data.status, 'queued');

    response = await fetch(`${base}/api/agents/${created.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
  });
});

test('request validation returns actionable JSON errors', async () => {
  await withServer(async ({ base }) => {
    let response = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    assert.equal(response.status, 400);
    let payload = await json(response);
    assert.equal(payload.ok, false);
    assert.match(payload.error.message, /名称/);

    response = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(response.status, 400);

    response = await fetch(`${base}/api/tasks/missing/cancel`, { method: 'POST' });
    assert.equal(response.status, 404);

    response = await fetch(`${base}/api/nope`);
    assert.equal(response.status, 404);
  });
});

test('static assets and the console shell are served', async () => {
  await withServer(async ({ base }) => {
    let response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /Agent Console/);
    assert.match(html, /智能体管理控制台/);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);

    response = await fetch(`${base}/app.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/javascript/);

    response = await fetch(`${base}/../server/index.js`);
    assert.notEqual(response.status, 200);

    response = await fetch(`${base}/missing-page`);
    assert.equal(response.status, 404);
  });
});
