import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AGENT_ROLES = ['coordinator', 'developer', 'reviewer', 'researcher'];
export const MODELS = ['deepseek-v4', 'deepseek-v4-mini', 'deepseek-reasoner'];
export const PRIORITIES = ['high', 'normal', 'low'];

const PRIORITY_WEIGHT = { high: 0, normal: 1, low: 2 };
const MAX_AGENTS = 12;
const MAX_TASKS = 200;
const MAX_ACTIVITY = 80;
const FAILURE_RATE = 0.12;

export class StoreError extends Error {
  constructor(message, { code = 'bad_request', status = 400 } = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

const minutes = (n) => n * 60_000;
const hours = (n) => n * 3_600_000;

function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function text(value, { field, min = 1, max = 80 }) {
  if (typeof value !== 'string') {
    throw new StoreError(`${field}不能为空`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) throw new StoreError(`${field}不能为空`);
  if (trimmed.length > max) throw new StoreError(`${field}不能超过 ${max} 个字符`);
  return trimmed;
}

function oneOf(value, allowed, { field, fallback }) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new StoreError(`请选择${field}`);
  }
  if (!allowed.includes(value)) throw new StoreError(`${field}无效`);
  return value;
}

function createActivity(now, level, message) {
  return { id: newId('act'), at: now, level, message };
}

/**
 * Seed data makes the console useful on first launch: one agent working, a
 * short queue, two completed tasks and a little history.
 */
export function createInitialState(now = Date.now()) {
  const agents = [
    {
      id: 'agent-ada',
      name: 'Ada',
      role: 'coordinator',
      model: 'deepseek-v4',
      enabled: true,
      currentTaskId: 'task-router',
      createdAt: now - hours(72),
      lastActiveAt: now - 5_000,
      stats: { done: 18, failed: 1 },
    },
    {
      id: 'agent-hermes',
      name: 'Hermes',
      role: 'developer',
      model: 'deepseek-v4-mini',
      enabled: true,
      currentTaskId: null,
      createdAt: now - hours(48),
      lastActiveAt: now - minutes(3),
      stats: { done: 42, failed: 2 },
    },
    {
      id: 'agent-nova',
      name: 'Nova',
      role: 'reviewer',
      model: 'deepseek-reasoner',
      enabled: true,
      currentTaskId: null,
      createdAt: now - hours(30),
      lastActiveAt: now - minutes(12),
      stats: { done: 11, failed: 0 },
    },
  ];

  const tasks = [
    {
      id: 'task-router',
      title: '重构工单路由与优先级调度',
      description: '梳理评估、分流与重试路径，补齐优先级队列的边界用例。',
      status: 'running',
      priority: 'high',
      agentId: 'agent-ada',
      progress: 42,
      createdAt: now - minutes(9),
      startedAt: now - minutes(7),
      finishedAt: null,
    },
    {
      id: 'task-ratelimit',
      title: '补齐 GitHub Source 的限流重试',
      description: '对 429 响应做指数退避，并记录可观测的退避次数。',
      status: 'queued',
      priority: 'high',
      agentId: null,
      progress: 0,
      createdAt: now - minutes(5),
      startedAt: null,
      finishedAt: null,
    },
    {
      id: 'task-report',
      title: '汇总本周 agent 运行报告',
      description: '按 agent 与任务类型聚合完成率、平均耗时与失败原因。',
      status: 'queued',
      priority: 'low',
      agentId: null,
      progress: 0,
      createdAt: now - minutes(3),
      startedAt: null,
      finishedAt: null,
    },
    {
      id: 'task-audit',
      title: '梳理 Executor 的暂停语义',
      description: '确认暂停期间新触发与排队任务的边界，并补上状态说明。',
      status: 'queued',
      priority: 'normal',
      agentId: null,
      progress: 0,
      createdAt: now - minutes(2),
      startedAt: null,
      finishedAt: null,
    },
    {
      id: 'task-smoke',
      title: '给默认分支加一条冒烟检查',
      description: '覆盖控制台 API 与静态页面，让每次合并都有最小回归。',
      status: 'queued',
      priority: 'normal',
      agentId: null,
      progress: 0,
      createdAt: now - minutes(1),
      startedAt: null,
      finishedAt: null,
    },
    {
      id: 'task-prompt',
      title: '整理 Prompt 版本迁移记录',
      description: '将已覆盖的默认段落、变更原因与回滚方式归档。',
      status: 'queued',
      priority: 'low',
      agentId: null,
      progress: 0,
      createdAt: now - minutes(1),
      startedAt: null,
      finishedAt: null,
    },
    {
      id: 'task-feishu',
      title: '接入飞书审批结果通知',
      description: '审批通过或驳回后，在原始话题内回一条简短结果。',
      status: 'done',
      priority: 'normal',
      agentId: 'agent-hermes',
      progress: 100,
      createdAt: now - hours(2),
      startedAt: now - hours(2) + minutes(4),
      finishedAt: now - minutes(40),
    },
    {
      id: 'task-timeout',
      title: '修复 PR 检查超时',
      description: '定位慢检查并给超时设置上限，避免整条流水线被拖住。',
      status: 'failed',
      priority: 'normal',
      agentId: 'agent-hermes',
      progress: 100,
      createdAt: now - hours(3),
      startedAt: now - hours(3) + minutes(2),
      finishedAt: now - hours(2) - minutes(20),
    },
  ];

  const activity = [
    createActivity(now - minutes(9), 'info', '「重构工单路由与优先级调度」已加入队列'),
    createActivity(now - minutes(7), 'info', 'Ada 开始执行「重构工单路由与优先级调度」'),
    createActivity(now - minutes(5), 'info', '「补齐 GitHub Source 的限流重试」已加入队列'),
    createActivity(now - minutes(3), 'info', '「汇总本周 agent 运行报告」已加入队列'),
    createActivity(now - minutes(2), 'info', '「梳理 Executor 的暂停语义」已加入队列'),
    createActivity(now - minutes(1), 'info', '「给默认分支加一条冒烟检查」已加入队列'),
    createActivity(now - minutes(1), 'info', '「整理 Prompt 版本迁移记录」已加入队列'),
    createActivity(now - minutes(40), 'success', 'Hermes 完成「接入飞书审批结果通知」'),
    createActivity(now - hours(2) - minutes(20), 'error', 'Hermes 执行「修复 PR 检查超时」失败'),
  ];

  return { version: 1, agents, tasks, activity };
}

export class Store {
  constructor(filePath, { now = () => Date.now(), random = Math.random } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : null;
    this.now = now;
    this.random = random;
    this.state = this.#load() ?? createInitialState(this.now());
  }

  #load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(parsed?.agents) || !Array.isArray(parsed?.tasks)) return null;
      parsed.activity = Array.isArray(parsed.activity) ? parsed.activity : [];
      return parsed;
    } catch {
      return null;
    }
  }

  #save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(temp, this.filePath);
  }

  #agent(id) {
    const agent = this.state.agents.find((item) => item.id === id);
    if (!agent) throw new StoreError('Agent 不存在', { code: 'not_found', status: 404 });
    return agent;
  }

  #task(id) {
    const task = this.state.tasks.find((item) => item.id === id);
    if (!task) throw new StoreError('任务不存在', { code: 'not_found', status: 404 });
    return task;
  }

  #log(level, message) {
    this.state.activity.unshift(createActivity(this.now(), level, message));
    this.state.activity = this.state.activity.slice(0, MAX_ACTIVITY);
  }

  #status(agent) {
    if (!agent.enabled) return 'offline';
    return agent.currentTaskId ? 'busy' : 'idle';
  }

  #publicAgent(agent) {
    const { done, failed } = agent.stats;
    const total = done + failed;
    return {
      ...agent,
      status: this.#status(agent),
      successRate: total === 0 ? null : Math.round((done / total) * 100),
    };
  }

  snapshot() {
    const now = this.now();
    const agents = this.state.agents
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((agent) => this.#publicAgent(agent));

    const tasks = this.state.tasks
      .slice()
      .sort((a, b) => {
        const rank = { running: 0, queued: 1 }[a.status] ?? 2;
        const otherRank = { running: 0, queued: 1 }[b.status] ?? 2;
        if (rank !== otherRank) return rank - otherRank;
        if (rank === 0) return (a.startedAt ?? 0) - (b.startedAt ?? 0);
        if (rank === 1) {
          const byPriority =
            (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1);
          return byPriority !== 0 ? byPriority : a.createdAt - b.createdAt;
        }
        return (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt);
      })
      .slice(0, 40);

    const countBy = (status) =>
      this.state.tasks.filter((task) => task.status === status).length;
    const done24h = this.state.tasks.filter(
      (task) => task.status === 'done' && (task.finishedAt ?? 0) > now - 24 * 3_600_000,
    ).length;
    const failed24h = this.state.tasks.filter(
      (task) => task.status === 'failed' && (task.finishedAt ?? 0) > now - 24 * 3_600_000,
    ).length;

    return {
      updatedAt: now,
      agents,
      tasks,
      activity: this.state.activity
        .slice()
        .sort((a, b) => b.at - a.at)
        .slice(0, 24),
      stats: {
        agents: {
          total: agents.length,
          online: agents.filter((agent) => agent.status !== 'offline').length,
          busy: agents.filter((agent) => agent.status === 'busy').length,
          idle: agents.filter((agent) => agent.status === 'idle').length,
          offline: agents.filter((agent) => agent.status === 'offline').length,
        },
        tasks: {
          running: countBy('running'),
          queued: countBy('queued'),
          done24h,
          failed24h,
        },
      },
    };
  }

  addAgent(input = {}) {
    const name = text(input.name, { field: '名称', max: 24 });
    if (this.state.agents.length >= MAX_AGENTS) {
      throw new StoreError(`最多支持 ${MAX_AGENTS} 个 Agent`, { status: 409 });
    }
    if (this.state.agents.some((agent) => agent.name.toLowerCase() === name.toLowerCase())) {
      throw new StoreError(`Agent「${name}」已存在`, { code: 'conflict', status: 409 });
    }
    const role = oneOf(input.role, AGENT_ROLES, { field: '角色', fallback: 'developer' });
    const model = oneOf(input.model, MODELS, { field: '模型', fallback: 'deepseek-v4' });
    const now = this.now();
    const agent = {
      id: newId('agent'),
      name,
      role,
      model,
      enabled: true,
      currentTaskId: null,
      createdAt: now,
      lastActiveAt: now,
      stats: { done: 0, failed: 0 },
    };
    this.state.agents.push(agent);
    this.#log('success', `Agent「${name}」已上线，等待任务`);
    this.#save();
    return this.#publicAgent(agent);
  }

  startAgent(id) {
    const agent = this.#agent(id);
    if (agent.enabled) return this.#publicAgent(agent);
    agent.enabled = true;
    agent.lastActiveAt = this.now();
    this.#log('success', `Agent「${agent.name}」已启动`);
    this.#save();
    return this.#publicAgent(agent);
  }

  stopAgent(id) {
    const agent = this.#agent(id);
    if (!agent.enabled) return this.#publicAgent(agent);
    agent.enabled = false;
    agent.lastActiveAt = this.now();
    const running = this.state.tasks.find(
      (task) => task.status === 'running' && task.agentId === agent.id,
    );
    if (running) {
      running.status = 'queued';
      running.progress = 0;
      running.agentId = null;
      running.startedAt = null;
      this.#log('warn', `Agent「${agent.name}」已停止，「${running.title}」重新排队`);
    } else {
      this.#log('warn', `Agent「${agent.name}」已停止`);
    }
    for (const task of this.state.tasks) {
      if (task.status === 'queued' && task.agentId === agent.id) task.agentId = null;
    }
    agent.currentTaskId = null;
    this.#save();
    return this.#publicAgent(agent);
  }

  removeAgent(id) {
    const agent = this.#agent(id);
    if (agent.currentTaskId) {
      throw new StoreError('Agent 正在执行任务，请先停止', { code: 'conflict', status: 409 });
    }
    this.state.agents = this.state.agents.filter((item) => item.id !== id);
    for (const task of this.state.tasks) {
      if (task.status === 'queued' && task.agentId === id) task.agentId = null;
    }
    this.#log('info', `Agent「${agent.name}」已移除`);
    this.#save();
  }

  addTask(input = {}) {
    const title = text(input.title, { field: '任务标题', max: 100 });
    const description =
      typeof input.description === 'string' ? input.description.trim().slice(0, 500) : '';
    const priority = oneOf(input.priority, PRIORITIES, { field: '优先级', fallback: 'normal' });
    let agentId = null;
    if (input.agentId) {
      const agent = this.#agent(input.agentId);
      agentId = agent.id;
    }
    if (this.state.tasks.filter((task) => ['queued', 'running'].includes(task.status)).length >= MAX_TASKS) {
      throw new StoreError('任务队列已满，请稍后再试', { status: 409 });
    }
    const task = {
      id: newId('task'),
      title,
      description,
      status: 'queued',
      priority,
      agentId,
      progress: 0,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.state.tasks.push(task);
    const target = agentId ? `，指定 ${this.#agent(agentId).name}` : '';
    this.#log('info', `「${title}」已加入队列${target}`);
    this.#save();
    return task;
  }

  cancelTask(id) {
    const task = this.#task(id);
    if (!['queued', 'running'].includes(task.status)) {
      throw new StoreError('只有排队中或运行中的任务可以取消', { code: 'conflict', status: 409 });
    }
    const agent = task.agentId ? this.state.agents.find((item) => item.id === task.agentId) : null;
    if (agent?.currentTaskId === task.id) agent.currentTaskId = null;
    task.status = 'cancelled';
    task.progress = task.progress ?? 0;
    task.finishedAt = this.now();
    this.#log('warn', `「${task.title}」已取消`);
    this.#save();
    return task;
  }

  retryTask(id) {
    const task = this.#task(id);
    if (!['failed', 'cancelled'].includes(task.status)) {
      throw new StoreError('只有失败或已取消的任务可以重试', { code: 'conflict', status: 409 });
    }
    task.status = 'queued';
    task.progress = 0;
    task.agentId = null;
    task.startedAt = null;
    task.finishedAt = null;
    this.#log('info', `「${task.title}」已重新排队`);
    this.#save();
    return task;
  }

  /**
   * Advance the simulated runtime by one tick: running tasks make progress and
   * idle agents pick up queued work. Returns true when anything changed.
   */
  tick() {
    const now = this.now();
    let changed = false;

    for (const task of this.state.tasks.filter((item) => item.status === 'running')) {
      const agent = this.state.agents.find((item) => item.id === task.agentId);
      if (!agent || !agent.enabled) {
        task.status = 'queued';
        task.progress = 0;
        task.agentId = null;
        task.startedAt = null;
        if (agent) agent.currentTaskId = null;
        changed = true;
        continue;
      }
      task.progress = Math.min(100, (task.progress ?? 0) + 6 + Math.floor(this.random() * 14));
      agent.lastActiveAt = now;
      changed = true;
      if (task.progress < 100) continue;

      const failed = this.random() < FAILURE_RATE;
      task.status = failed ? 'failed' : 'done';
      task.finishedAt = now;
      agent.currentTaskId = null;
      agent.stats[failed ? 'failed' : 'done'] += 1;
      this.#log(
        failed ? 'error' : 'success',
        failed
          ? `${agent.name} 执行「${task.title}」失败`
          : `${agent.name} 完成「${task.title}」`,
      );
    }

    const idleAgents = this.state.agents
      .filter((agent) => agent.enabled && !agent.currentTaskId)
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const agent of idleAgents) {
      const candidates = this.state.tasks
        .filter(
          (task) =>
            task.status === 'queued' && (task.agentId === null || task.agentId === agent.id),
        )
        .sort((a, b) => {
          const byPriority =
            (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1);
          return byPriority !== 0 ? byPriority : a.createdAt - b.createdAt;
        });
      const task = candidates[0];
      if (!task) break;
      task.status = 'running';
      task.agentId = agent.id;
      task.startedAt = now;
      task.progress = Math.min(100, 2 + Math.floor(this.random() * 8));
      agent.currentTaskId = task.id;
      agent.lastActiveAt = now;
      this.#log('info', `${agent.name} 开始执行「${task.title}」`);
      changed = true;
    }

    if (changed) this.#save();
    return changed;
  }
}
