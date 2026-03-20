// ── NILAM Auto-Entry Frontend ──────────────────────
const API = '';
let isRunning = false;
let pollTimer = null;
let intervalMs = 600000;
let lastLogTimestamp = 0;
let limitCountdownTimer = null;
let monitorInterval = null;

// ── Init ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    fetchStatus();
    refreshHistory();
    startPolling();
});

// ── Polling ────────────────────────────────────────
function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchStatus, 3000);
}

async function fetchStatus() {
    try {
        const res = await fetch(`${API}/api/status`);
        const data = await res.json();
        updateUI(data);
    } catch (err) {
        console.error('Status fetch error:', err);
    }
}

function updateUI(data) {
    const prevRunning = isRunning;
    isRunning = data.running;
    intervalMs = data.intervalMs || 600000;

    // Global Status Badge
    const badge = document.getElementById('statusBadge');
    if (badge) {
        const statusText = badge.querySelector('.status-text');
        if (isRunning) {
            badge.className = 'global-status running';
            statusText.textContent = 'AKTIF';
        } else {
            badge.className = 'global-status';
            statusText.textContent = 'TERPUTUS';
        }
    }

    // Main Control Button
    const btn = document.getElementById('mainBtn');
    if (btn) {
        const btnIcon = document.getElementById('btnIcon');
        const btnText = document.getElementById('btnText');
        if (isRunning) {
            btn.className = 'btn-main running';
            btnIcon.textContent = '⏹';
            btnText.textContent = 'HENTIKAN';
        } else {
            btn.className = 'btn-main';
            btnIcon.textContent = '🚀';
            btnText.textContent = 'MULAKAN';
        }
    }

    // Sync settings input with server truth (if not being edited)
    const intervalInput = document.getElementById('intervalMin');
    if (intervalInput && document.activeElement !== intervalInput) {
        const serverMins = Math.floor(intervalMs / 60000);
        if (parseInt(intervalInput.value) !== serverMins) {
            intervalInput.value = serverMins;
        }
    }

    // Stats with animation
    animateValue('statSubmitted', data.stats?.totalSubmitted || 0);
    animateValue('statFetched', data.stats?.totalFetched || 0);
    animateValue('statErrors', data.stats?.errors || 0);

    // Daily limit banner
    const banner = document.getElementById('dailyLimitBanner');
    if (data.dailyLimit && data.dailyLimit.reached) {
        if (banner) banner.style.display = 'flex';
        startLimitCountdown(data.dailyLimit.resumesInMs);
    } else {
        if (banner) banner.style.display = 'none';
        if (limitCountdownTimer) { clearInterval(limitCountdownTimer); limitCountdownTimer = null; }
    }

    // Current Article & Step Indicator
    const currentSection = document.getElementById('currentArticleSection');
    if (data.stats && data.stats.currentArticle) {
        currentSection.style.display = 'block';
        document.getElementById('currentTitle').textContent = data.stats.currentArticle.title;
        document.getElementById('currentUrl').href = data.stats.currentArticle.url;
        
        // Update Steps
        const currentStep = data.stats.currentStep || 0;
        for (let i = 1; i <= 4; i++) {
            const stepEl = document.getElementById(`step${i}`);
            if (i < currentStep) {
                stepEl.className = 'step completed';
            } else if (i === currentStep) {
                stepEl.className = 'step active';
            } else {
                stepEl.className = 'step';
            }
        }
    } else {
        currentSection.style.display = 'none';
    }

    // Activity log
    if (data.log && data.log.length > 0) {
        renderLog(data.log);
    }
}

function startLimitCountdown(resumesInMs) {
    if (limitCountdownTimer) return; // already running
    let msLeft = resumesInMs;
    function updateCountdown() {
        const el = document.getElementById('limitCountdown');
        if (!el) return;
        if (msLeft <= 0) {
            el.textContent = 'Menunggu reset automasi...';
            clearInterval(limitCountdownTimer);
            limitCountdownTimer = null;
            return;
        }
        const h = Math.floor(msLeft / 3600000);
        const m = Math.floor((msLeft % 3600000) / 60000);
        const s = Math.floor((msLeft % 60000) / 1000);
        el.textContent = `Reset dalam: ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        msLeft -= 1000;
    }
    updateCountdown();
    limitCountdownTimer = setInterval(updateCountdown, 1000);
}

function animateValue(id, end) {
    const el = document.getElementById(id);
    const start = parseInt(el.textContent) || 0;
    if (start === end) return;
    
    const duration = 1000;
    const startTime = performance.now();
    
    function update(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out quad
        const ease = 1 - (1 - progress) * (1 - progress);
        const current = Math.floor(start + (end - start) * ease);
        el.textContent = current;
        if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
}

function renderLog(entries) {
    const container = document.getElementById('logContainer');
    if (!entries || entries.length === 0) return;

    // Filter for truly new entries
    const newEntries = entries.filter(e => new Date(e.time).getTime() > lastLogTimestamp);
    if (newEntries.length === 0) return;

    // If it was empty placeholder, clear it
    if (container.querySelector('.log-empty')) {
        container.innerHTML = '';
    }

    newEntries.forEach(entry => {
        const timestamp = new Date(entry.time).getTime();
        if (timestamp > lastLogTimestamp) lastLogTimestamp = timestamp;

        const timeStr = new Date(entry.time).toLocaleTimeString('ms-MY', { hour12: false });
        let msg = entry.msg;
        msg = msg.replace(/\b(https?:\/\/\S+)/g, '<a href="$1" target="_blank" style="color:var(--primary-light)">link ↗</a>');
        
        const div = document.createElement('div');
        div.className = `log-entry ${entry.type || 'info'}`;
        div.innerHTML = `
            <span class="log-time">${timeStr}</span>
            <span class="log-msg">${msg}</span>
        `;
        container.prepend(div);
    });
}

// ── Controls ───────────────────────────────────────
async function toggleAutomation() {
    const endpoint = isRunning ? '/api/stop' : '/api/start';
    try {
        const res = await fetch(`${API}${endpoint}`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            fetchStatus();
            if (!isRunning) {
                setTimeout(refreshHistory, 15000);
            }
        }
    } catch (err) {
        console.error('Toggle error:', err);
    }
}

function clearLog() {
    document.getElementById('logContainer').innerHTML = '<div class="log-empty">Log dikosongkan.</div>';
    lastLogTimestamp = Date.now();
}

// ── History ────────────────────────────────────────
async function refreshHistory() {
    try {
        const res = await fetch('/api/history');
        const data = await res.json();
        
        // Only show the latest 10
        const latestTen = data.articles.slice(0, 10);
        renderHistory(latestTen);
    } catch (err) {
        console.error('Failed to refresh history:', err);
    }
}

function renderHistory(articles) {
    const container = document.getElementById('historyContainer');
    if (!articles || articles.length === 0) {
        container.innerHTML = '<div class="log-empty">Tiada rekod lagi.</div>';
        return;
    }

    container.innerHTML = articles.map(item => {
        const status = item.status || 'success';
        const isFailed  = status === 'failed';
        const isPending = status === 'pending';

        const badgeClass = isFailed ? 'failed' : isPending ? 'pending' : 'success';
        const badgeIcon  = isFailed ? '🚩' : isPending ? '⏳' : '✅';
        const badgeLabel = isFailed ? 'GAGAL' : isPending ? 'DALAM PROSES' : 'BERJAYA';
        const cardClass  = isFailed ? 'failed' : isPending ? 'pending' : '';

        return `
            <div class="history-item ${cardClass}">
                <div class="history-title">${item.title}</div>
                <div class="history-meta">
                    <span>📅 ${new Date(item.submittedAt).toLocaleDateString('ms-MY')}</span>
                    <span class="history-badge ${badgeClass}">${badgeIcon} ${badgeLabel}</span>
                </div>
                <div class="history-content">
                    <div class="history-label">Sinopsis AI</div>
                    <div class="history-txt">${item.sinopsis || '—'}</div>
                    <div class="history-label" style="margin-top:10px">Pengajaran</div>
                    <div class="history-txt">${item.pengajaran || '—'}</div>
                </div>
            </div>
        `;
    }).join('');
}

// ── Settings ───────────────────────────────────────
function toggleSettings() {
    const panel = document.getElementById('settingsPanel');
    const arrow = document.getElementById('settingsArrow');
    panel.classList.toggle('open');
    arrow.classList.toggle('open');
}

function loadSettings() {
    const settings = JSON.parse(localStorage.getItem('nilam_settings') || '{}');
    if (settings.geminiKey) document.getElementById('geminiKey').value = settings.geminiKey;
    if (settings.delimaEmail) document.getElementById('delimaEmail').value = settings.delimaEmail;
    if (settings.delimaPassword) document.getElementById('delimaPassword').value = settings.delimaPassword;
    if (settings.intervalMin) document.getElementById('intervalMin').value = settings.intervalMin;
}

async function saveSettings() {
    const settings = {
        geminiKey: document.getElementById('geminiKey').value,
        delimaEmail: document.getElementById('delimaEmail').value,
        delimaPassword: document.getElementById('delimaPassword').value,
        intervalMin: document.getElementById('intervalMin').value || '10'
    };

    localStorage.setItem('nilam_settings', JSON.stringify(settings));

    try {
        await fetch(`${API}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                geminiKey: settings.geminiKey,
                delimaEmail: settings.delimaEmail,
                delimaPassword: settings.delimaPassword,
                intervalMs: parseInt(settings.intervalMin) * 60000
            })
        });

        // Flash save button
        const btn = document.querySelector('.btn-save');
        const oldText = btn.textContent;
        btn.innerHTML = '✨ TETAPAN BERJAYA!';
        btn.style.background = 'var(--secondary)';
        setTimeout(() => { 
            btn.innerHTML = oldText;
            btn.style.background = '';
        }, 2000);
    } catch (err) {
        console.error('Save settings error:', err);
    }
}

function openLiveMonitor() {
    const modal = document.getElementById('monitorModal');
    modal.style.display = 'flex';
    refreshMonitor();
    if (monitorInterval) clearInterval(monitorInterval);
    monitorInterval = setInterval(refreshMonitor, 2000); // refresh every 2s
}

function closeLiveMonitor() {
    const modal = document.getElementById('monitorModal');
    modal.style.display = 'none';
    if (monitorInterval) clearInterval(monitorInterval);
    monitorInterval = null;
}

function refreshMonitor() {
    const img = document.getElementById('monitorImg');
    const status = document.getElementById('monitorStatus');
    if (!img) return;
    
    // Add cache-busting timestamp
    img.src = '/api/screenshot?t=' + Date.now();
    status.textContent = 'Dikemas kini: ' + new Date().toLocaleTimeString();
}

// Auto-refresh history periodically
setInterval(refreshHistory, 30000);
