'use strict';

const STATUS_TEXT = {
  healthy: '正常',
  warning: '警告',
  critical: '异常',
};

const STATUS_CLASS = {
  healthy: 'status-healthy',
  warning: 'status-warning',
  critical: 'status-critical',
};

const CHARTS = [
  { id: 'cpuChart', title: 'CPU', key: 'cpu', unit: '%', color: '#38bdf8', min: 0, max: 100 },
  { id: 'loadChart', title: '负载', key: 'load1', unit: '', color: '#f59e0b' },
  { id: 'memoryChart', title: '内存', key: 'memory', unit: '%', color: '#22c55e', min: 0, max: 100 },
  { id: 'diskChart', title: '磁盘', key: 'disk', unit: '%', color: '#a78bfa', min: 0, max: 100 },
  { id: 'networkInChart', title: '网络入站', key: 'net_in', unit: ' Mbps', color: '#2dd4bf' },
  { id: 'networkOutChart', title: '网络出站', key: 'net_out', unit: ' Mbps', color: '#fb7185' },
];

const state = {
  status: null,
  history: [],
  statusTimer: null,
  historyTimer: null,
};

const $ = (id) => document.getElementById(id);

function fmt(value, digits = 1) {
  if (value === null || value === undefined || value === '') return '--';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number.toFixed(digits).replace(/\.0+$/, '');
}

function fmtPercent(value) {
  return `${fmt(value)}%`;
}

function fmtMbps(value) {
  return fmt(value, 2);
}

function fmtTime(iso) {
  if (!iso) return '--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function statusKind(value) {
  if (value === 'healthy') return 'healthy';
  if (value === 'warning') return 'warning';
  if (value === 'critical') return 'critical';
  return 'unknown';
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value ?? '--';
}

function setOverallStatus(status) {
  const kind = statusKind(status);
  const node = $('overallStatus');
  node.className = `status-badge ${STATUS_CLASS[kind] || 'status-unknown'}`;
  node.textContent = STATUS_TEXT[kind] || '等待数据';
}

function tableStatusClass(ok, warning = false) {
  if (ok) return 'pill pill-ok';
  if (warning) return 'pill pill-warn';
  return 'pill pill-bad';
}

function renderStatus(status) {
  state.status = status;
  setOverallStatus(status.overall_status);
  setText('updatedAt', fmtTime(status.time));

  setText('cpuPercent', fmtPercent(status.cpu?.percent));
  setText('cpuMeta', `${fmt(status.cpu?.cores, 0)} 核心`);
  setText('loadValue', `${fmt(status.load?.load1, 2)} / ${fmt(status.load?.load5, 2)} / ${fmt(status.load?.load15, 2)}`);
  setText('memoryPercent', fmtPercent(status.memory?.percent));
  setText('memoryMeta', `${status.memory?.used || '--'} / ${status.memory?.total || '--'}`);
  setText('diskPercent', fmtPercent(status.disk?.percent));
  setText('diskMeta', `${status.disk?.used || '--'} / ${status.disk?.total || '--'}`);
  setText('networkIn', fmtMbps(status.network?.in_rate_mbps));
  setText('networkOut', fmtMbps(status.network?.out_rate_mbps));
  setText('cumulativeRx', status.network?.cumulative_rx || '--');
  setText('cumulativeTx', status.network?.cumulative_tx || '--');
  setText('networkInterface', `接口：${status.network?.interface || '--'}`);
  setText('uptime', status.system?.uptime || '--');
  setText('systemMeta', `${fmt(status.system?.process_count, 0)} 进程`);

  renderHealth(status.health_checks || []);
  renderDocker(status.docker || []);
}

function renderHealth(checks) {
  const tbody = $('healthTable');
  setText('healthSummary', `${checks.length} 项检查`);

  if (!checks.length) {
    tbody.innerHTML = '<tr><td colspan="5">暂无健康检查数据</td></tr>';
    return;
  }

  tbody.innerHTML = checks.map((check) => {
    const ok = !check.error && check.status >= 200 && check.status < 400;
    const label = check.status ? `HTTP ${check.status}` : '无响应';
    return `
      <tr>
        <td>${escapeHtml(check.name || '--')}</td>
        <td>${escapeHtml(check.url || '--')}</td>
        <td><span class="${tableStatusClass(ok)}">${escapeHtml(label)}</span></td>
        <td>${fmt(check.latency_ms, 0)} ms</td>
        <td>${escapeHtml(check.error || '无')}</td>
      </tr>
    `;
  }).join('');
}

function renderDocker(containers) {
  const tbody = $('dockerTable');
  setText('dockerSummary', `${containers.length} 个服务`);

  if (!containers.length) {
    tbody.innerHTML = '<tr><td colspan="4">暂无 Docker 服务数据</td></tr>';
    return;
  }

  tbody.innerHTML = containers.map((container) => {
    const running = container.status === 'running';
    const health = container.health || 'unknown';
    const healthOk = health === 'healthy' || health === 'unknown' || health === 'none';
    return `
      <tr>
        <td>${escapeHtml(container.name || '--')}</td>
        <td><span class="${tableStatusClass(running)}">${escapeHtml(container.status || '--')}</span></td>
        <td><span class="${tableStatusClass(healthOk, health === 'starting')}">${escapeHtml(health)}</span></td>
        <td>${escapeHtml(container.uptime || '--')}</td>
      </tr>
    `;
  }).join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function scaleCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width * dpr));
  const height = Math.max(180, Math.floor(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  return { width, height, dpr };
}

function drawChart(config) {
  const canvas = $(config.id);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const { width, height, dpr } = scaleCanvas(canvas);
  const pad = {
    left: 38 * dpr,
    right: 14 * dpr,
    top: 18 * dpr,
    bottom: 28 * dpr,
  };
  const points = state.history
    .map((point) => ({ time: point.time, value: Number(point[config.key]) }))
    .filter((point) => Number.isFinite(point.value));

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#121722';
  ctx.fillRect(0, 0, width, height);

  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const values = points.map((point) => point.value);
  const rawMax = Math.max(...values, config.max ?? 1);
  const max = config.max ?? Math.max(1, Math.ceil(rawMax * 1.2));
  const min = config.min ?? 0;
  const span = Math.max(max - min, 1);

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1 * dpr;
  ctx.font = `${11 * dpr}px sans-serif`;
  ctx.fillStyle = '#9aa7b7';

  for (let i = 0; i <= 3; i += 1) {
    const y = pad.top + (chartHeight / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();

    const labelValue = max - ((span / 3) * i);
    ctx.fillText(`${fmt(labelValue, config.unit ? 0 : 2)}${config.unit}`, 6 * dpr, y + 4 * dpr);
  }

  if (points.length < 2) {
    ctx.fillStyle = '#9aa7b7';
    ctx.textAlign = 'center';
    ctx.fillText('等待历史数据', width / 2, height / 2);
    ctx.textAlign = 'left';
    return;
  }

  const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  gradient.addColorStop(0, `${config.color}55`);
  gradient.addColorStop(1, `${config.color}00`);

  const xy = points.map((point, index) => {
    const x = pad.left + (chartWidth * index) / Math.max(points.length - 1, 1);
    const y = pad.top + chartHeight - ((point.value - min) / span) * chartHeight;
    return { x, y };
  });

  ctx.beginPath();
  xy.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.lineTo(xy[xy.length - 1].x, height - pad.bottom);
  ctx.lineTo(xy[0].x, height - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  xy.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = config.color;
  ctx.lineWidth = 2.2 * dpr;
  ctx.stroke();

  const latest = points[points.length - 1];
  ctx.fillStyle = config.color;
  ctx.beginPath();
  ctx.arc(xy[xy.length - 1].x, xy[xy.length - 1].y, 3.5 * dpr, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#edf2f7';
  ctx.textAlign = 'right';
  ctx.fillText(`${fmt(latest.value, config.unit ? 1 : 2)}${config.unit}`, width - pad.right, 14 * dpr);
  ctx.textAlign = 'left';
}

function renderCharts() {
  CHARTS.forEach(drawChart);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

async function loadStatus() {
  const data = await fetchJson('/api/status');
  renderStatus(data);
}

async function loadHistory() {
  const data = await fetchJson('/api/history');
  state.history = Array.isArray(data.points) ? data.points : [];
  renderCharts();
}

async function refreshNow() {
  const button = $('refreshButton');
  button.disabled = true;
  button.textContent = '刷新中';
  try {
    const data = await fetchJson('/api/check-now');
    renderStatus(data);
    await loadHistory();
  } catch (error) {
    console.error(error);
    setOverallStatus('critical');
  } finally {
    button.disabled = false;
    button.textContent = '立即刷新';
  }
}

async function tickStatus() {
  try {
    await loadStatus();
  } catch (error) {
    console.error(error);
    setOverallStatus('critical');
  }
}

async function tickHistory() {
  try {
    await loadHistory();
  } catch (error) {
    console.error(error);
  }
}

function start() {
  $('refreshButton').addEventListener('click', refreshNow);
  window.addEventListener('resize', renderCharts);
  tickStatus();
  tickHistory();
  state.statusTimer = window.setInterval(tickStatus, 1000);
  state.historyTimer = window.setInterval(tickHistory, 30000);
}

document.addEventListener('DOMContentLoaded', start);
