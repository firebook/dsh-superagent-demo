const ROLE_LABELS = {
  coordinator: '协调者',
  developer: '开发者',
  reviewer: '评审者',
  researcher: '研究员',
};

const PRIORITY_LABELS = { high: '高', normal: '普通', low: '低' };

const TASK_STATUS_LABELS = {
  queued: '排队中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const AGENT_STATUS_LABELS = { busy: '忙碌', idle: '待命', offline: '已停止' };

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'queued', label: '排队' },
  { key: 'running', label: '运行中' },
  { key: 'finished', label: '已结束' },
];

const FINISHED_STATUSES = new Set(['done', 'failed', 'cancelled']);
const POLL_INTERVAL_MS = 1500;

const state = {
  data: null,
  filter: 'all',
  connection: 'connecting',
  toastTimer: null,
};

const $ = (selector) => document.querySelector(selector);

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );

const initials = (name) => (name ? Array.from(name.trim())[0].toUpperCase() : '?');

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatRelative(timestamp) {
  if (!timestamp) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

function formatAbsolute(timestamp) {
  return timestamp ? dateTimeFormatter.format(new Date(timestamp)) : '';
}

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(pathname, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
  return payload.data;
}

/* ---------- Rendering ---------- */

function renderConnection() {
  const connection = $('#connection');
  connection.dataset.state = state.connection;
  $('#connection-text').textContent =
    state.connection === 'live'
      ? '本地运行时在线'
      : state.connection === 'down'
        ? '连接中断，重试中'
        : '连接中';
}

function renderKpis() {
  if (!state.data) return;
  const { agents, tasks } = state.data.stats;
  $('#kpis').innerHTML = `
    <div class="kpi">
      <span class="kpi-label">在线 Agent</span>
      <strong class="kpi-value">${agents.online}<small> / ${agents.total}</small></strong>
      <span class="kpi-foot">${agents.busy} 个忙碌 · ${agents.idle} 个待命</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">运行中任务</span>
      <strong class="kpi-value">${tasks.running}</strong>
      <span class="kpi-foot">${agents.busy} 个 Agent 正在执行</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">排队任务</span>
      <strong class="kpi-value">${tasks.queued}</strong>
      <span class="kpi-foot">${tasks.queued > 0 ? '空闲 Agent 会自动领取' : '队列已清空'}</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">今日完成</span>
      <strong class="kpi-value">${tasks.done24h}</strong>
      <span class="kpi-foot">${tasks.failed24h} 个任务失败</span>
    </div>
  `;
}

function agentById(id) {
  return state.data?.agents.find((agent) => agent.id === id) ?? null;
}

function renderAgentCard(agent, index) {
  const currentTask = state.data.tasks.find((task) => task.id === agent.currentTaskId) ?? null;
  const statusLabel = AGENT_STATUS_LABELS[agent.status] ?? agent.status;
  const avatarClass = `avatar avatar-${index % 5}`;
  const work = currentTask
    ? `
        <p class="work-label">当前任务</p>
        <p class="work-title" title="${escapeHtml(currentTask.title)}">${escapeHtml(currentTask.title)}</p>
        <progress class="progress" max="100" value="${Number(currentTask.progress) || 0}" aria-label="任务进度 ${Number(currentTask.progress) || 0}%"></progress>
        <p class="work-meta"><span>${currentTask.priority === 'high' ? '高优先级' : currentTask.priority === 'low' ? '低优先级' : '普通优先级'}</span><span>${Number(currentTask.progress) || 0}%</span></p>
      `
    : `<span>${agent.status === 'offline' ? '已停止 · 启动后重新上线待命' : '待命中 · 已就绪，等待新任务'}</span>`;

  const actions =
    agent.status === 'offline'
      ? `
          <button class="btn ghost small" type="button" data-action="start-agent" data-id="${escapeHtml(agent.id)}">启动</button>
          <button class="btn quiet small danger" type="button" data-action="remove-agent" data-id="${escapeHtml(agent.id)}">移除</button>
        `
      : `<button class="btn ghost small" type="button" data-action="stop-agent" data-id="${escapeHtml(agent.id)}">停止</button>`;

  return `
    <article class="agent-card">
      <div class="agent-top">
        <span class="${avatarClass}" aria-hidden="true">${escapeHtml(initials(agent.name))}</span>
        <div class="agent-id">
          <h3 title="${escapeHtml(agent.name)}">${escapeHtml(agent.name)}</h3>
          <p>${ROLE_LABELS[agent.role] ?? agent.role} · <code>${escapeHtml(agent.model)}</code></p>
        </div>
        <span class="pill ${agent.status}"><i aria-hidden="true"></i>${statusLabel}</span>
      </div>
      <div class="agent-work" ${currentTask ? '' : 'data-empty="true"'}>${work}</div>
      <div class="agent-stats">
        <div><strong>${agent.stats.done}</strong><span>完成</span></div>
        <div><strong>${agent.stats.failed}</strong><span>失败</span></div>
        <div><strong>${agent.successRate === null ? '—' : `${agent.successRate}%`}</strong><span>成功率</span></div>
      </div>
      <div class="agent-actions">${actions}</div>
    </article>
  `;
}

function renderAgents() {
  if (!state.data) {
    if (state.connection === 'down') {
      $('#agents-summary').textContent = '';
      $('#agent-grid').innerHTML =
        '<div class="empty-state">无法连接本地运行时。请确认终端中的 <code>npm start</code> 仍在运行，页面会自动重试。</div>';
    }
    return;
  }
  const { agents } = state.data;
  $('#agents-summary').textContent = agents.length
    ? `${state.data.stats.agents.online} / ${agents.length} 在线 · ${state.data.stats.agents.busy} 个忙碌`
    : '';

  $('#agent-grid').innerHTML = agents.length
    ? agents.map(renderAgentCard).join('')
    : '<div class="empty-state">还没有 Agent。点击右上角「新建 Agent」创建第一个。</div>';
}

function taskMatchesFilter(task) {
  if (state.filter === 'all') return true;
  if (state.filter === 'finished') return FINISHED_STATUSES.has(task.status);
  return task.status === state.filter;
}

function renderFilters() {
  const container = $('#task-filters');
  if (container.children.length === 0) {
    container.innerHTML = FILTERS.map(
      (filter) =>
        `<button type="button" role="tab" data-filter="${filter.key}">${filter.label}<span class="count"></span></button>`,
    ).join('');
  }
  const tasks = state.data?.tasks ?? [];
  const counts = {
    all: tasks.length,
    queued: tasks.filter((task) => task.status === 'queued').length,
    running: tasks.filter((task) => task.status === 'running').length,
    finished: tasks.filter((task) => FINISHED_STATUSES.has(task.status)).length,
  };
  for (const button of container.querySelectorAll('[data-filter]')) {
    const key = button.dataset.filter;
    button.setAttribute('aria-selected', String(key === state.filter));
    button.querySelector('.count').textContent = counts[key];
  }
}

function renderTaskRow(task) {
  const agent = task.agentId ? agentById(task.agentId) : null;
  const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
  const status = task.status;
  const actions =
    status === 'queued' || status === 'running'
      ? `<button class="btn quiet small" type="button" data-action="cancel-task" data-id="${escapeHtml(task.id)}">取消</button>`
      : status === 'failed' || status === 'cancelled'
        ? `<button class="btn quiet small" type="button" data-action="retry-task" data-id="${escapeHtml(task.id)}">重试</button>`
        : '<span class="muted">—</span>';

  return `
    <tr>
      <td>
        <div class="task-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</div>
        ${task.description ? `<div class="task-desc" title="${escapeHtml(task.description)}">${escapeHtml(task.description)}</div>` : ''}
      </td>
      <td><span class="priority ${task.priority}">${PRIORITY_LABELS[task.priority] ?? task.priority}</span></td>
      <td>
        ${
          agent
            ? `<span class="agent-chip"><span class="mini-avatar" aria-hidden="true">${escapeHtml(initials(agent.name))}</span>${escapeHtml(agent.name)}</span>`
            : task.agentId
              ? '<span class="muted">已移除</span>'
              : '<span class="muted">自动分配</span>'
        }
      </td>
      <td><span class="pill ${status}"><i aria-hidden="true"></i>${TASK_STATUS_LABELS[status] ?? status}</span></td>
      <td>
        <div class="progress-cell">
          <progress class="progress ${status}" max="100" value="${progress}" aria-label="任务进度 ${progress}%"></progress>
          <span class="progress-text">${progress}%</span>
        </div>
      </td>
      <td><div class="task-actions">${actions}</div></td>
    </tr>
  `;
}

function renderTasks() {
  renderFilters();
  if (!state.data) {
    if (state.connection === 'down') {
      $('#task-body').innerHTML =
        '<tr><td colspan="6"><div class="empty-state">无法读取任务，正在重试连接。</div></td></tr>';
    }
    return;
  }
  const tasks = state.data.tasks.filter(taskMatchesFilter);
  $('#task-body').innerHTML = tasks.length
    ? tasks.map(renderTaskRow).join('')
    : `<tr><td colspan="6"><div class="empty-state">${
        state.filter === 'all' ? '队列是空的，新建一个任务试试。' : '这个状态下没有任务。'
      }</div></td></tr>`;
}

function renderActivity() {
  if (!state.data) {
    if (state.connection === 'down') {
      $('#activity-list').innerHTML = '<li class="empty-state">无法读取活动，正在重试连接。</li>';
    }
    return;
  }
  const activity = state.data.activity;
  $('#activity-list').innerHTML = activity.length
    ? activity
        .map(
          (item) => `
            <li class="activity-item" data-level="${escapeHtml(item.level)}">
              <span class="activity-dot" aria-hidden="true"></span>
              <div>
                <p>${escapeHtml(item.message)}</p>
                <time datetime="${new Date(item.at).toISOString()}" title="${escapeHtml(formatAbsolute(item.at))}">${formatRelative(item.at)}</time>
              </div>
            </li>
          `,
        )
        .join('')
    : '<li class="empty-state">还没有活动记录。</li>';
}

function render() {
  renderConnection();
  renderKpis();
  renderAgents();
  renderTasks();
  renderActivity();
}

/* ---------- Data ---------- */

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state.data = await api('/api/overview');
    state.connection = 'live';
  } catch {
    state.connection = 'down';
  } finally {
    refreshing = false;
    render();
  }
}

function showToast(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.dataset.type = type;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function showFormError(id, message) {
  const element = $(`#${id}`);
  element.textContent = message;
  element.hidden = false;
}

function clearFormError(id) {
  const element = $(`#${id}`);
  element.textContent = '';
  element.hidden = true;
}

async function runAction(button, action, successMessage) {
  button.disabled = true;
  try {
    await action();
    showToast(successMessage);
    await refresh();
  } catch (error) {
    showToast(error.message, 'error');
    button.disabled = false;
  }
}

/* ---------- Dialogs ---------- */

function openAgentDialog() {
  const form = $('#agent-form');
  form.reset();
  clearFormError('agent-error');
  $('#agent-submit').disabled = false;
  $('#agent-submit').textContent = '创建 Agent';
  $('#agent-dialog').showModal();
  $('#agent-name').focus();
}

function openTaskDialog() {
  const form = $('#task-form');
  form.reset();
  clearFormError('task-error');
  $('#task-submit').disabled = false;
  $('#task-submit').textContent = '加入队列';

  const select = $('#task-agent');
  const agents = (state.data?.agents ?? []).filter((agent) => agent.status !== 'offline');
  select.innerHTML = [
    '<option value="">自动分配（空闲 Agent 接单）</option>',
    ...agents.map(
      (agent) =>
        `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)} · ${ROLE_LABELS[agent.role] ?? agent.role}</option>`,
    ),
  ].join('');

  $('#task-dialog').showModal();
  $('#task-title').focus();
}

async function submitAgent(event) {
  event.preventDefault();
  const name = $('#agent-name').value.trim();
  if (!name) {
    showFormError('agent-error', '请填写 Agent 名称。');
    $('#agent-name').focus();
    return;
  }

  const submit = $('#agent-submit');
  submit.disabled = true;
  submit.textContent = '创建中…';
  clearFormError('agent-error');
  try {
    await api('/api/agents', {
      method: 'POST',
      body: { name, role: $('#agent-role').value, model: $('#agent-model').value },
    });
    $('#agent-dialog').close();
    showToast(`Agent「${name}」已创建`);
    await refresh();
  } catch (error) {
    showFormError('agent-error', error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = '创建 Agent';
  }
}

async function submitTask(event) {
  event.preventDefault();
  const title = $('#task-title').value.trim();
  if (!title) {
    showFormError('task-error', '请填写任务标题。');
    $('#task-title').focus();
    return;
  }

  const submit = $('#task-submit');
  submit.disabled = true;
  submit.textContent = '提交中…';
  clearFormError('task-error');
  try {
    await api('/api/tasks', {
      method: 'POST',
      body: {
        title,
        description: $('#task-description').value,
        priority: $('#task-priority').value,
        agentId: $('#task-agent').value || null,
      },
    });
    $('#task-dialog').close();
    showToast(`「${title}」已加入队列`);
    await refresh();
  } catch (error) {
    showFormError('task-error', error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = '加入队列';
  }
}

/* ---------- Wiring ---------- */

document.addEventListener('click', (event) => {
  const closer = event.target.closest('[data-close-dialog]');
  if (closer) {
    closer.closest('dialog')?.close();
    return;
  }

  const filterButton = event.target.closest('[data-filter]');
  if (filterButton) {
    state.filter = filterButton.dataset.filter;
    renderTasks();
    return;
  }

  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;

  const { action, id } = actionButton.dataset;
  if (action === 'start-agent') {
    runAction(actionButton, () => api(`/api/agents/${id}/start`, { method: 'POST' }), 'Agent 已启动');
  } else if (action === 'stop-agent') {
    runAction(actionButton, () => api(`/api/agents/${id}/stop`, { method: 'POST' }), 'Agent 已停止');
  } else if (action === 'remove-agent') {
    if (!window.confirm('移除该 Agent？它的历史统计不会保留。')) return;
    runAction(actionButton, () => api(`/api/agents/${id}`, { method: 'DELETE' }), 'Agent 已移除');
  } else if (action === 'cancel-task') {
    runAction(actionButton, () => api(`/api/tasks/${id}/cancel`, { method: 'POST' }), '任务已取消');
  } else if (action === 'retry-task') {
    runAction(actionButton, () => api(`/api/tasks/${id}/retry`, { method: 'POST' }), '任务已重新排队');
  }
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const form = dialog.querySelector('form');
    if (form) {
      const bounds = form.getBoundingClientRect();
      const inside =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;
      if (inside) return;
    }
    dialog.close();
  });
}

$('#add-agent-button').addEventListener('click', openAgentDialog);
$('#add-task-button').addEventListener('click', openTaskDialog);
$('#agent-form').addEventListener('submit', submitAgent);
$('#task-form').addEventListener('submit', submitTask);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

refresh();
setInterval(refresh, POLL_INTERVAL_MS);
