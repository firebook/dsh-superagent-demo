import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store, StoreError, createInitialState } from '../server/store.js';

const NOW = 1_700_000_000_000;

function createStore({ now = () => NOW, random = () => 0.5 } = {}) {
  return new Store(null, { now, random });
}

test('seed state gives an immediately useful console', () => {
  const snapshot = createStore().snapshot();
  assert.equal(snapshot.agents.length, 3);
  assert.equal(snapshot.agents.filter((agent) => agent.status === 'busy').length, 1);
  assert.equal(snapshot.agents.filter((agent) => agent.status === 'idle').length, 2);
  assert.equal(snapshot.stats.agents.online, 3);
  assert.equal(snapshot.stats.agents.total, 3);
  assert.ok(snapshot.stats.tasks.queued >= 1);
  assert.ok(snapshot.tasks.some((task) => task.status === 'running'));
  assert.ok(snapshot.activity.length > 0);
  assert.ok(snapshot.tasks.every((task) => typeof task.title === 'string' && task.title.length > 0));
  assert.ok(createInitialState(NOW).agents.every((agent) => agent.id && agent.model));
});

test('agents can be created, started, stopped and removed', () => {
  const store = createStore();

  const agent = store.addAgent({ name: '  Orion  ', role: 'researcher', model: 'deepseek-v4' });
  assert.equal(agent.name, 'Orion');
  assert.equal(agent.status, 'idle');
  assert.equal(agent.successRate, null);
  assert.match(agent.id, /^agent-/);

  assert.throws(
    () => store.addAgent({ name: 'orion', role: 'developer', model: 'deepseek-v4' }),
    (error) => error instanceof StoreError && error.status === 409,
  );
  assert.throws(
    () => store.addAgent({ name: '', role: 'developer', model: 'deepseek-v4' }),
    (error) => error instanceof StoreError && error.status === 400,
  );

  assert.equal(store.stopAgent(agent.id).status, 'offline');
  assert.equal(store.startAgent(agent.id).status, 'idle');

  store.removeAgent(agent.id);
  assert.equal(store.snapshot().agents.some((item) => item.id === agent.id), false);
});

test('stopping a busy agent requeues its running task', () => {
  const store = createStore();
  const stopped = store.stopAgent('agent-ada');
  assert.equal(stopped.status, 'offline');

  const snapshot = store.snapshot();
  assert.equal(snapshot.tasks.some((task) => task.status === 'running' && task.agentId === 'agent-ada'), false);
  const requeued = snapshot.tasks.find((task) => task.id === 'task-router');
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.progress, 0);
  assert.equal(requeued.agentId, null);
});

test('a busy agent cannot be removed', () => {
  const store = createStore();
  assert.throws(
    () => store.removeAgent('agent-ada'),
    (error) => error instanceof StoreError && error.status === 409,
  );
});

test('queued work is picked up by an idle agent and finishes', () => {
  let now = NOW;
  const store = createStore({ now: () => now, random: () => 0.5 });
  const task = store.addTask({ title: '测试自动调度', priority: 'high' });

  store.tick();
  let current = store.snapshot().tasks.find((item) => item.id === task.id);
  assert.equal(current.status, 'running');
  assert.ok(current.agentId);
  const worker = current.agentId;

  for (let index = 0; index < 20 && current.status === 'running'; index += 1) {
    now += 1000;
    store.tick();
    current = store.snapshot().tasks.find((item) => item.id === task.id);
  }
  assert.equal(current.status, 'done');
  assert.equal(current.progress, 100);

  const agent = store.snapshot().agents.find((item) => item.id === worker);
  assert.ok(agent.stats.done >= 12);
  assert.notEqual(agent.currentTaskId, task.id);
});

test('task failures mark the agent and can be retried', () => {
  let now = NOW;
  const store = createStore({ now: () => now, random: () => 0 });
  const task = store.addTask({ title: '必定失败的任务', priority: 'high' });

  for (let index = 0; index < 40; index += 1) {
    now += 1000;
    store.tick();
  }

  let current = store.snapshot().tasks.find((item) => item.id === task.id);
  assert.equal(current.status, 'failed');
  assert.equal(current.progress, 100);

  const retried = store.retryTask(task.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.progress, 0);
  assert.throws(
    () => store.retryTask(task.id),
    (error) => error instanceof StoreError && error.status === 409,
  );
});

test('queued and running tasks can be cancelled', () => {
  const store = createStore();
  const queued = store.addTask({ title: '排队中取消', priority: 'low' });
  assert.equal(store.cancelTask(queued.id).status, 'cancelled');
  assert.throws(
    () => store.cancelTask(queued.id),
    (error) => error instanceof StoreError && error.status === 409,
  );

  const running = store.snapshot().tasks.find((task) => task.status === 'running');
  store.cancelTask(running.id);
  const agent = store.snapshot().agents.find((item) => item.id === running.agentId);
  assert.equal(agent.status, 'idle');
  assert.equal(agent.currentTaskId, null);
});

test('tasks can target a specific agent', () => {
  const store = createStore();
  const task = store.addTask({ title: '指定 Agent', agentId: 'agent-nova' });
  store.tick();
  const current = store.snapshot().tasks.find((item) => item.id === task.id);
  assert.equal(current.agentId, 'agent-nova');
});

test('state survives a restart through the JSON file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-'));
  const file = path.join(directory, 'state.json');
  try {
    const store = new Store(file, { now: () => NOW, random: () => 0.5 });
    store.addAgent({ name: 'Persisted', role: 'reviewer', model: 'deepseek-reasoner' });

    const reloaded = new Store(file, { now: () => NOW, random: () => 0.5 });
    const snapshot = reloaded.snapshot();
    assert.ok(snapshot.agents.some((agent) => agent.name === 'Persisted'));
    assert.ok(snapshot.activity.some((item) => item.message.includes('Persisted')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unknown identifiers report a 404', () => {
  const store = createStore();
  assert.throws(
    () => store.startAgent('agent-missing'),
    (error) => error instanceof StoreError && error.status === 404,
  );
  assert.throws(
    () => store.cancelTask('task-missing'),
    (error) => error instanceof StoreError && error.status === 404,
  );
});
