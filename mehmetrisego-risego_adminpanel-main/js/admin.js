// ============================================
// RiseGo Admin Panel - JavaScript
// ============================================
// API Base URL: localhost (sadece local sunucuda) veya Railway production backend
const API_BASE = (function () {
    if (typeof window === 'undefined') return 'https://risegobackend-production-bf6d.up.railway.app/api';
    const h = window.location.hostname;
    // Sadece localhost/127.0.0.1 üzerinde çalışıyorsa local API kullan (geliştirme için)
    const isLocalDev = h === 'localhost' || h === '127.0.0.1';
    if (isLocalDev) return 'http://localhost:3000/api';
    // file://, GitHub Pages, risegodriver.com vb. → production Railway backend
    return 'https://risegobackend-production-bf6d.up.railway.app/api';
})();

const ADMIN_TOKEN_KEY = 'risego_admin_token';

function getAdminToken() {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
}

function setAdminToken(token) {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
}

function getAdminHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = getAdminToken();
    if (token) headers['X-Admin-Token'] = token;
    return headers;
}

function handleAdminApiResponse(response) {
    if (response.status === 401) {
        setAdminToken(null);
        showLoginScreen();
        return true;
    }
    return false;
}

// ============================================
// Admin Auth - OTP Giriş
// ============================================

async function checkAdminSession() {
    const token = getAdminToken();
    if (!token) return { success: false };
    try {
        const res = await fetch(`${API_BASE}/admin/auth/session`, {
            headers: { 'X-Admin-Token': token }
        });
        const data = await res.json();
        return data;
    } catch {
        return { success: false };
    }
}

function showLoginScreen() {
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('adminContainer').style.display = 'none';
}

function showDashboard() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('adminContainer').style.display = 'flex';
}

async function sendAdminOtp() {
    const phoneInput = document.getElementById('loginPhone');
    const phone = phoneInput.value.trim();
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('btnSendOtp');
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');

    errorEl.textContent = '';
    if (!phone || phone.replace(/\D/g, '').length < 10) {
        errorEl.textContent = 'Geçerli bir telefon numarası giriniz.';
        return;
    }

    btnText.style.display = 'none';
    btnLoader.style.display = 'flex';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/admin/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });
        const data = await res.json();

        if (data.success) {
            document.getElementById('loginStepPhone').style.display = 'none';
            document.getElementById('loginStepOtp').style.display = 'flex';
            document.getElementById('loginOtp').value = '';
            document.getElementById('loginOtp').focus();
        } else {
            errorEl.textContent = data.message || 'Bir hata oluştu.';
        }
    } catch (err) {
        errorEl.textContent = 'Sunucuya bağlanılamadı. Lütfen tekrar deneyin.';
    } finally {
        btnText.style.display = 'inline';
        btnLoader.style.display = 'none';
        btn.disabled = false;
    }
}

async function verifyAdminOtp() {
    const phone = document.getElementById('loginPhone').value.trim();
    const otpRaw = document.getElementById('loginOtp').value.trim();
    const otp = otpRaw.replace(/\D/g, '');
    const errorEl = document.getElementById('otpError');
    const btn = document.getElementById('btnVerifyOtp');
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');

    errorEl.textContent = '';
    if (!otp || otp.length !== 6) {
        errorEl.textContent = '6 haneli doğrulama kodunu giriniz.';
        return;
    }

    btnText.style.display = 'none';
    btnLoader.style.display = 'flex';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/admin/auth/verify-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, otp: otp })
        });
        const data = await res.json();

        if (data.success && data.adminSessionToken) {
            setAdminToken(data.adminSessionToken);
            showDashboard();
            checkServerStatus();
            await loadAdminParks();
            loadCampaign();
            loadLeaderboard();

            // Başarılı girişten hemen sonra session check tetikleyip sürücü sayısını alalım
            checkAdminSession().then(sessionData => {
                if (sessionData && sessionData.activeDriverSessions !== undefined) {
                    document.getElementById('activeSessionsCount').textContent = sessionData.activeDriverSessions;
                }
            });

        } else {
            errorEl.textContent = data.message || 'Doğrulama başarısız.';
        }
    } catch (err) {
        errorEl.textContent = 'Sunucuya bağlanılamadı.';
    } finally {
        btnText.style.display = 'inline';
        btnLoader.style.display = 'none';
        btn.disabled = false;
    }
}

function backToPhoneStep() {
    document.getElementById('loginStepOtp').style.display = 'none';
    document.getElementById('loginStepPhone').style.display = 'flex';
    document.getElementById('loginOtp').value = '';
    document.getElementById('otpError').textContent = '';
}

async function adminLogout() {
    const token = getAdminToken();
    if (token) {
        try {
            await fetch(`${API_BASE}/admin/auth/logout`, {
                method: 'POST',
                headers: { 'X-Admin-Token': token }
            });
        } catch (_) { }
        setAdminToken(null);
    }
    showLoginScreen();
    document.getElementById('loginPhone').value = '';
    document.getElementById('loginError').textContent = '';
    backToPhoneStep();
}

// ============================================
// Sayfa Yüklendiğinde Başlat
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    const sessionData = await checkAdminSession();
    if (sessionData && sessionData.success) {
        showDashboard();
        checkServerStatus();
        await loadAdminParks();
        loadCampaign();
        loadLeaderboard();
        if (sessionData.activeDriverSessions !== undefined) {
            document.getElementById('activeSessionsCount').textContent = sessionData.activeDriverSessions;
        }
    } else {
        showLoginScreen();
        checkServerStatus();
    }

    const citySelect = document.getElementById('leaderboardCity');
    if (citySelect) {
        citySelect.addEventListener('change', () => {
            const range = getLeaderboardDateRangeOrNull();
            if (range) loadLeaderboard(false, range.from, range.to);
            else loadLeaderboard(currentLeaderboardView);
        });
    }

    const campaignCity = document.getElementById('campaignCity');
    if (campaignCity) {
        campaignCity.addEventListener('change', () => loadCampaign());
    }

    // Textarea karakter sayacı
    const textarea = document.getElementById('campaignInput');
    if (textarea) {
        textarea.addEventListener('input', () => {
            const count = textarea.value.length;
            document.getElementById('charCount').textContent = count;

            // Onayla butonunu aktif/pasif yap
            const approveBtn = document.getElementById('approveBtn');
            approveBtn.disabled = count === 0;
        });
    }
});

// ============================================
// Sunucu Durumu Kontrolü
// ============================================
async function checkServerStatus() {
    const statusEl = document.getElementById('serverStatus');
    const statusText = statusEl.querySelector('.status-text');

    try {
        const response = await fetch(`${API_BASE}/health`);
        const data = await response.json();

        if (data.status === 'ok') {
            statusEl.classList.add('online');
            statusEl.classList.remove('error');
            statusText.textContent = 'Çevrimiçi';
        } else {
            throw new Error('Server not ok');
        }
    } catch (error) {
        statusEl.classList.add('error');
        statusEl.classList.remove('online');
        statusText.textContent = 'Bağlantı Hatası';
        console.error('[Admin] Sunucu bağlantı hatası:', error.message);
    }
}

// ============================================
// Kampanya Yönetimi
// ============================================

function getCampaignParkQuery() {
    const sel = document.getElementById('campaignCity');
    if (!sel || !sel.value) return '';
    return `?parkPartnerId=${encodeURIComponent(sel.value)}`;
}

function getSelectedCampaignCityLabel() {
    const sel = document.getElementById('campaignCity');
    if (!sel || sel.selectedIndex < 0) return '';
    return sel.options[sel.selectedIndex].textContent.trim();
}

/**
 * Mevcut kampanyayı API'den yükler ve UI'ı günceller (seçili şehir)
 */
async function loadCampaign() {
    try {
        const response = await fetch(`${API_BASE}/admin/campaign${getCampaignParkQuery()}`, {
            headers: getAdminHeaders()
        });
        if (handleAdminApiResponse(response)) return;
        const data = await response.json();

        if (data.success) {
            updateCampaignUI(data.campaign);
        }
        const textarea = document.getElementById('campaignInput');
        if (textarea) {
            textarea.value = '';
            document.getElementById('charCount').textContent = '0';
            document.getElementById('approveBtn').disabled = true;
        }
    } catch (error) {
        console.error('[Admin] Kampanya yükleme hatası:', error.message);
    }
}

/**
 * Kampanya durumunu UI'da günceller
 * @param {Object} campaign - { text, active, updatedAt }
 */
function updateCampaignUI(campaign) {
    const badge = document.getElementById('campaignBadge');
    const badgeText = document.getElementById('campaignBadgeText');
    const textEl = document.getElementById('currentCampaignText');
    const dateEl = document.getElementById('campaignDate');
    const deleteBtn = document.getElementById('deleteBtn');

    if (campaign.active && campaign.text) {
        // Aktif kampanya var
        badge.classList.remove('inactive');
        badge.classList.add('active');
        badgeText.textContent = 'Aktif Kampanya';
        textEl.textContent = campaign.text;
        deleteBtn.disabled = false;

        if (campaign.updatedAt) {
            const date = new Date(campaign.updatedAt);
            dateEl.textContent = `Son güncelleme: ${formatDate(date)}`;
        }
    } else {
        // Aktif kampanya yok
        badge.classList.remove('active');
        badge.classList.add('inactive');
        badgeText.textContent = 'Aktif Kampanya Yok';
        textEl.textContent = 'Henüz bir kampanya oluşturulmamış.';
        dateEl.textContent = '';
        deleteBtn.disabled = true;
    }
}

/**
 * Kampanyayı kaydeder (Onayla butonu)
 */
async function saveCampaign() {
    const textarea = document.getElementById('campaignInput');
    const text = textarea.value.trim();

    if (!text) return;

    const btn = document.getElementById('approveBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');

    // Loading state
    btnText.style.display = 'none';
    btnLoader.style.display = 'flex';
    btn.disabled = true;

    try {
        const parkPartnerId = document.getElementById('campaignCity')?.value || '';
        const response = await fetch(`${API_BASE}/admin/campaign`, {
            method: 'POST',
            headers: getAdminHeaders(),
            body: JSON.stringify({ text, parkPartnerId })
        });
        if (handleAdminApiResponse(response)) return;
        const data = await response.json();

        if (data.success) {
            updateCampaignUI(data.campaign);
            textarea.value = '';
            document.getElementById('charCount').textContent = '0';
            showToast('success', 'Kampanya başarıyla kaydedildi!');
        } else {
            showToast('error', data.message || 'Kampanya kaydedilemedi.');
        }
    } catch (error) {
        showToast('error', 'Sunucuya bağlanılamadı. Lütfen tekrar deneyin.');
        console.error('[Admin] Kampanya kaydetme hatası:', error);
    } finally {
        btnText.style.display = 'inline';
        btnLoader.style.display = 'none';
        // Textarea boş olduğu için buton pasif kalacak
        btn.disabled = textarea.value.trim().length === 0;
    }
}

/**
 * Kampanyayı siler (Sil butonu)
 */
async function deleteCampaign() {
    const cityLabel = getSelectedCampaignCityLabel();
    const msg = cityLabel
        ? `"${cityLabel}" şehri için aktif kampanyayı silmek istediğinize emin misiniz?`
        : 'Aktif kampanyayı silmek istediğinize emin misiniz?';
    if (!confirm(msg)) return;

    const btn = document.getElementById('deleteBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');

    // Loading state
    btnText.style.display = 'none';
    btnLoader.style.display = 'flex';
    btn.disabled = true;

    try {
        const parkPartnerId = document.getElementById('campaignCity')?.value || '';
        const delQ = parkPartnerId ? `?parkPartnerId=${encodeURIComponent(parkPartnerId)}` : '';
        const response = await fetch(`${API_BASE}/admin/campaign${delQ}`, {
            method: 'DELETE',
            headers: getAdminHeaders()
        });
        if (handleAdminApiResponse(response)) return;
        const data = await response.json();

        if (data.success) {
            updateCampaignUI({ text: '', active: false, updatedAt: null });
            showToast('success', 'Kampanya başarıyla silindi.');
        } else {
            showToast('error', data.message || 'Kampanya silinemedi.');
            btn.disabled = false;
        }
    } catch (error) {
        showToast('error', 'Sunucuya bağlanılamadı.');
        console.error('[Admin] Kampanya silme hatası:', error);
        btn.disabled = false;
    } finally {
        btnText.style.display = 'inline';
        btnLoader.style.display = 'none';
    }
}

/**
 * Toast bildirim gösterir
 * @param {'success' | 'error'} type
 * @param {string} message
 */
function showToast(type, message) {
    const toast = document.getElementById('campaignToast');
    const toastText = document.getElementById('campaignToastText');

    // Önceki toast'ı temizle
    toast.classList.remove('show', 'success', 'error');

    // Yeni toast ayarla
    toast.classList.add(type, 'show');
    toastText.textContent = message;

    // 4 saniye sonra gizle
    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s var(--ease) forwards';
        setTimeout(() => {
            toast.classList.remove('show', 'success', 'error');
            toast.style.animation = '';
        }, 300);
    }, 4000);
}

// ============================================
// Leaderboard
// ============================================

/**
 * Tarih alanlarında ikisi de doluysa özel aralık; yoksa null (mevcut/önceki sekme mantığı)
 */
function getLeaderboardDateRangeOrNull() {
    const startInput = document.getElementById('startDate');
    const endInput = document.getElementById('endDate');
    if (!startInput || !endInput) return null;
    const s = startInput.value;
    const e = endInput.value;
    if (s && e) return { from: s, to: e };
    return null;
}

function getLeaderboardParkQuery() {
    const sel = document.getElementById('leaderboardCity');
    if (!sel || !sel.value) return '';
    return `&parkPartnerId=${encodeURIComponent(sel.value)}`;
}

function fillParkSelectFromData(selectId, parks, prevValue) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '';
    parks.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.partnerId;
        opt.textContent = p.label;
        sel.appendChild(opt);
    });
    if (prevValue && [...sel.options].some(o => o.value === prevValue)) sel.value = prevValue;
    else if (sel.options.length) sel.selectedIndex = 0;
}

function fillParkSelectError(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '<option value="">Park listesi alınamadı</option>';
}

/**
 * Yandex park listesini yükler (sıralama + kampanya şehir seçimi)
 */
async function loadAdminParks() {
    const prevLb = document.getElementById('leaderboardCity')?.value;
    const prevCamp = document.getElementById('campaignCity')?.value;
    try {
        const res = await fetch(`${API_BASE}/admin/parks`, { headers: getAdminHeaders() });
        if (handleAdminApiResponse(res)) return;
        const data = await res.json();
        if (!data.success || !Array.isArray(data.parks)) {
            fillParkSelectError('leaderboardCity');
            fillParkSelectError('campaignCity');
            return;
        }
        fillParkSelectFromData('leaderboardCity', data.parks, prevLb);
        fillParkSelectFromData('campaignCity', data.parks, prevCamp);
    } catch (e) {
        console.error('[Admin] Park listesi:', e);
        const err = '<option value="">Park listesi yüklenemedi</option>';
        const lb = document.getElementById('leaderboardCity');
        const cc = document.getElementById('campaignCity');
        if (lb) lb.innerHTML = err;
        if (cc) cc.innerHTML = err;
    }
}

let currentLeaderboardView = false;
let currentLeaderboardPage = 1;
const LEADERBOARD_PAGE_SIZE = 20;
let currentLeaderboardData = [];
let currentTotalOrders = 0;
let currentTotalDrivers = 0;

/** Mevcut görünümü yeniler (tarih alanları doluysa önceki özel aralığı korur) */
function reloadCurrentLeaderboard() {
    const range = getLeaderboardDateRangeOrNull();
    if (range) loadLeaderboard(false, range.from, range.to);
    else loadLeaderboard(currentLeaderboardView);
}

/**
 * Admin leaderboard verisini API'den yükler
 * @param {boolean} [previous=false] - true ise sonlanmış önceki dönem
 * @param {string} [startDate=null] - ISO YYYY-MM-DD
 * @param {string} [endDate=null] - ISO YYYY-MM-DD
 */
async function loadLeaderboard(previous = false, startDate = null, endDate = null) {
    if (!startDate) {
        currentLeaderboardView = previous;
    }

    const content     = document.getElementById('leaderboardContent');
    const periodTitle = document.getElementById('leaderboardPeriod');
    const periodInfo  = document.getElementById('periodInfoText');
    const btnCurrent  = document.getElementById('btnCurrent');
    const btnPrevious = document.getElementById('btnPrevious');

    if (btnCurrent)  btnCurrent.classList.toggle('active', !previous && !startDate);
    if (btnPrevious) btnPrevious.classList.toggle('active', previous && !startDate);

    content.innerHTML = `
        <div class="leaderboard-loading">
            <div class="spinner-large"></div>
            <p>Sıralama tablosu yükleniyor...</p>
            <p class="loading-hint">İlk yükleme biraz zaman alabilir</p>
        </div>
    `;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);

        let url;
        const parkQ = getLeaderboardParkQuery();
        if (startDate && endDate) {
            url = `${API_BASE}/admin/leaderboard?from=${startDate}&to=${endDate}${parkQ}`;
            if (btnCurrent)  btnCurrent.classList.remove('active');
            if (btnPrevious) btnPrevious.classList.remove('active');
        } else if (previous) {
            const { from: pFrom, to: pTo } = getPreviousPeriodDates();
            url = `${API_BASE}/admin/leaderboard?from=${pFrom}&to=${pTo}${parkQ}`;
        } else {
            const today = getTodayStr();
            url = `${API_BASE}/admin/leaderboard?from=${today}&to=${today}${parkQ}`;
        }

        const response = await fetch(url, { headers: getAdminHeaders(), signal: controller.signal });
        clearTimeout(timeout);
        if (handleAdminApiResponse(response)) return;

        const data = await response.json();

        if (!data.success) {
            content.innerHTML = '<p class="leaderboard-error">Sıralama tablosu yüklenemedi.</p>';
            if (periodInfo) periodInfo.textContent = 'Veri alınamadı';
            return;
        }

        if (periodTitle) periodTitle.textContent = data.periodLabel;

        let periodDesc;
        const citySel = document.getElementById('leaderboardCity');
        const cityLabel = citySel && citySel.options[citySel.selectedIndex]
            ? citySel.options[citySel.selectedIndex].textContent.trim()
            : '';
        const cityPrefix = cityLabel ? `Şehir: ${cityLabel} · ` : '';

        if (startDate && endDate) {
            periodDesc = `${cityPrefix}${data.periodLabel} tarihleri arası özel filtreleme`;
        } else if (previous) {
            periodDesc = `${cityPrefix}${data.periodLabel} (önceki dönem) — en çok yolculuk yapan sürücüler`;
        } else {
            periodDesc = `${cityPrefix}${data.periodLabel} tarihleri arasında en çok yolculuk yapan sürücüler`;
        }
        if (data.syncedAt) {
            const syncDate = new Date(data.syncedAt);
            periodDesc += ` · Son güncelleme: ${formatDate(syncDate)}`;
        }
        if (periodInfo) periodInfo.textContent = periodDesc;

        currentLeaderboardData = data.leaderboard || [];
        currentTotalOrders     = data.totalOrders  || 0;
        currentTotalDrivers    = data.totalDrivers || 0;
        currentLeaderboardPage = 1;

        renderLeaderboard();

    } catch (error) {
        console.error('[Admin] Leaderboard hatası:', error);
        const msg = error.name === 'AbortError' ? 'İstek zaman aşımına uğradı.' : 'Sunucuya bağlanılamadı.';
        content.innerHTML = `<p class="leaderboard-error">${msg}</p>`;
    }
}

/** Bugünün tarihini YYYY-MM-DD formatında döner */
function getTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Önceki 10 günlük dönem tarihlerini hesaplar */
function getPreviousPeriodDates() {
    const now   = new Date();
    const day   = now.getDate();
    const year  = now.getFullYear();
    const month = now.getMonth();
    let fromDate, toDate;
    if (day <= 10) {
        fromDate = new Date(year, month - 1, 21);
        toDate   = new Date(year, month, 0, 23, 59, 59);
    } else if (day <= 20) {
        fromDate = new Date(year, month, 1);
        toDate   = new Date(year, month, 10, 23, 59, 59);
    } else {
        fromDate = new Date(year, month, 11);
        toDate   = new Date(year, month, 20, 23, 59, 59);
    }
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    return { from: fmt(fromDate), to: fmt(toDate) };
}

/**
 * Filtrele butonuna basıldığında çalışır
 */
function filterLeaderboard() {
    const startInput = document.getElementById('startDate').value;
    const endInput   = document.getElementById('endDate').value;

    if (!startInput || !endInput) {
        showToast('error', 'Lütfen hem başlangıç hem de bitiş tarihi seçin.');
        return;
    }
    if (new Date(startInput) > new Date(endInput)) {
        showToast('error', 'Başlangıç tarihi bitiş tarihinden sonra olamaz.');
        return;
    }
    loadLeaderboard(false, startInput, endInput);
}

function renderLeaderboard() {
    const content = document.getElementById('leaderboardContent');

    const totalPages = Math.ceil(currentLeaderboardData.length / LEADERBOARD_PAGE_SIZE) || 1;

    let html = '';

    // İstatistik satırı
    html += `
        <div class="lb-stats">
            <div class="lb-stat">
                <div class="lb-stat-value">${currentTotalOrders.toLocaleString('tr-TR')}</div>
                <div class="lb-stat-label">Toplam Yolculuk</div>
            </div>
            <div class="lb-stat">
                <div class="lb-stat-value">${currentTotalDrivers.toLocaleString('tr-TR')}</div>
                <div class="lb-stat-label">Kayıtlı Sürücü</div>
            </div>
        </div>
    `;

    if (currentLeaderboardData.length === 0) {
        html += '<p class="lb-empty">Bu dönemde henüz tamamlanmış yolculuk yok.</p>';
        content.innerHTML = html;
        return;
    }

    html += '<div class="lb-list">';

    const startIndex = (currentLeaderboardPage - 1) * LEADERBOARD_PAGE_SIZE;
    const endIndex = startIndex + LEADERBOARD_PAGE_SIZE;
    const pageData = currentLeaderboardData.slice(startIndex, endIndex);

    pageData.forEach(entry => {
        const rankClass = entry.rank <= 3 ? ` lb-rank-${entry.rank}` : '';
        html += `
            <div class="lb-item">
                <div class="lb-rank${rankClass}">${entry.rank}</div>
                <div class="lb-driver-name">${escapeHtml(entry.fullName)}</div>
                <div class="lb-trip-badge">
                    ${entry.tripCount}
                    <span class="lb-trip-label">yolculuk</span>
                </div>
            </div>
        `;
    });

    html += '</div>';

    // Sayfalandırma Kontrolleri
    if (totalPages > 1) {
        html += `
            <div class="lb-pagination" style="display: flex; justify-content: center; gap: 10px; margin-top: 20px;">
                <button class="btn" style="padding: 5px 15px; font-size: 14px;" onclick="changeLeaderboardPage(-1)" ${currentLeaderboardPage === 1 ? 'disabled' : ''}>Önceki</button>
                <div style="display: flex; align-items: center; font-weight: bold;">Sayfa ${currentLeaderboardPage} / ${totalPages}</div>
                <button class="btn" style="padding: 5px 15px; font-size: 14px;" onclick="changeLeaderboardPage(1)" ${currentLeaderboardPage === totalPages ? 'disabled' : ''}>Sonraki</button>
            </div>
        `;
    }

    content.innerHTML = html;
}

function changeLeaderboardPage(delta) {
    const totalPages = Math.ceil(currentLeaderboardData.length / LEADERBOARD_PAGE_SIZE) || 1;
    let newPage = currentLeaderboardPage + delta;
    if (newPage < 1) newPage = 1;
    if (newPage > totalPages) newPage = totalPages;

    if (newPage !== currentLeaderboardPage) {
        currentLeaderboardPage = newPage;
        renderLeaderboard();
    }
}

// ============================================
// Yardımcı Fonksiyonlar
// ============================================

/**
 * Tarih formatlar
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
    const months = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
        'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day} ${month} ${year}, ${hours}:${minutes}`;
}

/**
 * HTML XSS koruması
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}
