/* ============================================================================
 * ZODA — Rezervări standuri (modul separat, încărcat condiționat)
 * ----------------------------------------------------------------------------
 * Ținut într-un fișier propriu, în afara balta.html/cont.html, ca să nu mai
 * crească fișierele deja mari (vezi ZODA-REFERINTA-PLATFORMA-LIVE.md §3/§15).
 * Include cu: <script src="rezervari.js" defer></script>
 *
 * Depinde de variabilele globale deja existente în balta.html/cont.html:
 *   - `sb`           — clientul Supabase (creat identic în ambele fișiere)
 *   - `BALTA_USER` / `currentUser` — userul logat, dacă există (opțional;
 *     modulul verifică singur sesiunea prin sb.auth.getSession() ca să nu
 *     depindă de numele exact al variabilei din fiecare fișier gazdă)
 *
 * Nu presupune niciun alt cod din paginile gazdă — construiește tot ce-i
 * trebuie (modaluri, stiluri) dinamic, la prima folosire.
 *
 * NOTĂ IMPORTANTĂ PENTRU MARIAN: obiectul `BALTA` din balta.html vine din
 * RPC-ul `get_balta_cu_fallback`. Nu am văzut definiția reală a RPC-ului, deci
 * nu știu sigur dacă întoarce coloanele noi (rezervare_mod, rezervare_url_extern,
 * ora_zi_start, ora_zi_stop, ora_noapte_start) fără să-l actualizezi tu manual
 * (SELECT * ar trebui să le prindă automat; o listă explicită de coloane, nu).
 * Modulul tratează lipsa lor ca 'fara_rezervare' (ascunde butonul), deci nu
 * pică nimic dacă RPC-ul nu e încă actualizat — doar butonul nu apare până
 * atunci. Verifică o dată în consolă: `console.log(BALTA.rezervare_mod)`.
 * ============================================================================ */

(function (global) {
  'use strict';

  // ── Helpers mici, auto-suficiente (nu depind de host) ──────────────────────

  function escH(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var _toastEl = null;
  function toast(msg, isErr) {
    if (typeof global.showToast === 'function') { global.showToast(msg, !!isErr); return; }
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
        'background:#111827;border:1px solid #1e293b;color:#f1f5f9;padding:11px 18px;border-radius:10px;' +
        'font-size:14px;font-weight:600;z-index:100000;box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:90vw;text-align:center;';
      document.body.appendChild(_toastEl);
    }
    _toastEl.style.borderColor = isErr ? '#ef4444' : '#38bdf8';
    _toastEl.style.color = isErr ? '#fca5a5' : '#f1f5f9';
    _toastEl.textContent = msg;
    _toastEl.style.display = 'block';
    clearTimeout(_toastEl._t);
    _toastEl._t = setTimeout(function () { _toastEl.style.display = 'none'; }, 3800);
  }

  function fmtDataOra(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString('ro-RO', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  }

  function toDateInputValue(d) {
    var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function oraToParts(oraStr) {
    // 'HH:MM:SS' sau 'HH:MM' -> {h, m}
    var p = String(oraStr || '00:00').split(':');
    return { h: parseInt(p[0], 10) || 0, m: parseInt(p[1], 10) || 0 };
  }

  function combinaDataOra(dateStr, oraStr) {
    // dateStr: 'YYYY-MM-DD', oraStr: 'HH:MM:SS' -> Date local
    var parts = oraToParts(oraStr);
    var d = new Date(dateStr + 'T00:00:00');
    d.setHours(parts.h, parts.m, 0, 0);
    return d;
  }

  async function getCurrentUserId() {
    try {
      var res = await sb.auth.getSession();
      return res && res.data && res.data.session ? res.data.session.user.id : null;
    } catch (e) { return null; }
  }

  function injectStylesOnce() {
    if (document.getElementById('rez-styles')) return;
    var css = `
      .rez-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99998;display:flex;align-items:center;justify-content:center;padding:14px;}
      .rez-modal{background:#0a0f1a;border:1px solid #1e293b;border-radius:16px;max-width:520px;width:100%;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.5);}
      .rez-modal-hdr{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #1e293b;position:sticky;top:0;background:#0a0f1a;z-index:2;}
      .rez-modal-hdr h3{margin:0;font-size:16px;color:#f1f5f9;font-weight:800;}
      .rez-modal-close{background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;line-height:1;}
      .rez-modal-body{padding:16px 18px;}
      .rez-field{margin-bottom:14px;}
      .rez-field label{display:block;font-size:12.5px;font-weight:700;color:#94a3b8;margin-bottom:5px;}
      .rez-field input, .rez-field select{width:100%;background:#111827;border:1.5px solid #1e293b;border-radius:8px;padding:9px 11px;color:#f1f5f9;font-size:15px;outline:none;box-sizing:border-box;}
      #rez-nume[readonly]{opacity:.7;cursor:not-allowed;}
      .rez-tel-btn{display:inline-flex;align-items:center;gap:5px;background:rgba(56,189,248,.1);border:1px solid rgba(56,189,248,.35);border-radius:8px;padding:3px 9px;text-decoration:none;color:#38bdf8;font-size:12.5px;font-weight:700;vertical-align:middle;white-space:nowrap;}
      .rez-tel-btn:hover{background:rgba(56,189,248,.18);}
      .rez-tip-row{display:flex;gap:8px;flex-wrap:wrap;}
      .rez-tip-card{flex:1;min-width:100px;border:1.5px solid #1e293b;border-radius:10px;padding:9px 8px;cursor:pointer;text-align:center;}
      .rez-tip-card.active{border-color:#38bdf8;background:rgba(56,189,248,.08);}
      .rez-tip-card-title{font-size:13.5px;font-weight:800;color:#f1f5f9;}
      .rez-tip-desc{font-size:11px;color:#94a3b8;margin-top:2px;}
      .rez-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:#94a3b8;margin:2px 0 10px;}
      .rez-legend span{display:flex;align-items:center;gap:4px;}
      .rez-dot{display:inline-block;width:9px;height:9px;border-radius:50%;}
      .rez-dot.liber{background:#22c55e;}
      .rez-dot.partial{background:#f59e0b;}
      .rez-dot.ocupat{background:#ef4444;}
      .rez-dot.selectat{background:#38bdf8;}
      .rez-stand-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:8px;}
      .rez-stand-cell{border:1.5px solid #1e293b;border-radius:9px;padding:10px 6px;text-align:center;font-size:12.5px;font-weight:700;cursor:pointer;color:#f1f5f9;background:#111827;}
      .rez-stand-cell.liber{background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.4);}
      .rez-stand-cell.partial{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.4);}
      .rez-stand-cell.ocupat{background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.3);color:#64748b;cursor:not-allowed;}
      .rez-stand-cell.selectat{background:rgba(56,189,248,.18);border-color:#38bdf8;color:#38bdf8;}
      .rez-btn{background:#0e7490;color:#fff;font-weight:700;font-size:14px;padding:10px 16px;border:none;border-radius:9px;cursor:pointer;width:100%;}
      .rez-btn:disabled{opacity:.5;cursor:not-allowed;}
      .rez-btn-secondary{background:transparent;border:1px solid #1e293b;color:#94a3b8;}
      .rez-btn-danger{background:#7f1d1d;color:#fecaca;}
      .rez-list-item{border:1px solid #1e293b;border-radius:10px;padding:10px 12px;margin-bottom:8px;font-size:13.5px;color:#cbd5e1;}
      .rez-badge{display:inline-block;font-size:11px;font-weight:800;padding:2px 8px;border-radius:999px;margin-left:6px;}
      .rez-badge-in_asteptare{background:rgba(245,158,11,.15);color:#f59e0b;}
      .rez-badge-confirmata{background:rgba(34,197,94,.15);color:#22c55e;}
      .rez-badge-anulata,.rez-badge-respinsa,.rez-badge-expirata{background:rgba(148,163,184,.15);color:#94a3b8;}
      .rez-badge-neprezentat{background:rgba(239,68,68,.15);color:#ef4444;}
      .rez-strike{color:#f59e0b;font-size:11.5px;font-weight:800;}
      .rez-tabs{display:flex;gap:6px;padding:0 18px;border-bottom:1px solid #1e293b;position:sticky;top:57px;background:#0a0f1a;z-index:1;}
      .rez-tab{background:none;border:none;color:#94a3b8;font-weight:700;font-size:13px;padding:10px 6px;cursor:pointer;border-bottom:2px solid transparent;}
      .rez-tab.active{color:#38bdf8;border-bottom-color:#38bdf8;}
      .rez-empty{text-align:center;color:#4b5563;font-size:13.5px;padding:20px 0;}
      #rez-stand-btn{margin-top:12px;width:100%;background:#0e7490;color:#fff;font-weight:700;font-size:17px;padding:15px;border:none;border-radius:10px;cursor:pointer;}
    `;
    var style = document.createElement('style');
    style.id = 'rez-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Blochează scroll-ul paginii din spate cât timp modalul e deschis — pe
  // mobil, fără asta, gestul de scroll pe conținutul modalului "scapă" des pe
  // pagina de dedesubt. Salvăm valoarea anterioară a lui body.style.overflow
  // (nu o resetăm orbește la '') ca să nu deblocăm din greșeală pagina dacă
  // modalul de rezervare a fost deschis peste overlay-ul unui stand, care
  // își pune singur propriul lock — la închidere, restaurăm exact ce era
  // înainte, nu neapărat scroll liber.
  var _rezScrollLockPrev = null;

  function deschideModalGeneric(titlu, bodyHtml, tabsHtml) {
    injectStylesOnce();
    var backdrop = document.createElement('div');
    backdrop.className = 'rez-modal-backdrop';
    backdrop.id = 'rez-modal-backdrop';
    backdrop.innerHTML =
      '<div class="rez-modal">' +
        '<div class="rez-modal-hdr"><h3>' + escH(titlu) + '</h3><button class="rez-modal-close" onclick="RezervariUI._closeModal()">✕</button></div>' +
        (tabsHtml || '') +
        '<div class="rez-modal-body" id="rez-modal-body">' + bodyHtml + '</div>' +
      '</div>';
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });
    if (_rezScrollLockPrev === null) {
      _rezScrollLockPrev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    return backdrop;
  }

  function closeModal() {
    var el = document.getElementById('rez-modal-backdrop');
    if (el) el.remove();
    if (_rezScrollLockPrev !== null) {
      document.body.style.overflow = _rezScrollLockPrev;
      _rezScrollLockPrev = null;
    }
  }

  function setModalBody(html) {
    var body = document.getElementById('rez-modal-body');
    if (body) body.innerHTML = html;
  }

  // ── 0. Butonul de pe pagina bălții (nivel baltă, nu doar în overlay-ul
  // standului) — apelat din renderPage() în balta.html cu (BALTA). Folosește
  // două elemente STATICE din balta.html (btn-rezervari / btn-rezervari-extern),
  // câte unul pentru fiecare mod posibil — nu injectăm markup dinamic aici,
  // ca butonul să rămână copil direct al grid-ului #ib-actions-grid și să
  // primească automat exact același stil ca Tarife/Regulament (regulile CSS
  // de-acolo sunt pe selector de copil direct, `> a, > button`).
  function renderButonBalta(balta) {
    var btnZoda = document.getElementById('btn-rezervari');
    var btnExtern = document.getElementById('btn-rezervari-extern');
    if (!btnZoda || !btnExtern) return;

    var mod = balta && balta.rezervare_mod;
    btnZoda.style.display = 'none';
    btnExtern.style.display = 'none';

    if (!mod || mod === 'fara_rezervare') return;

    if (mod === 'extern') {
      if (!balta.rezervare_url_extern) return;
      btnExtern.href = balta.rezervare_url_extern;
      btnExtern.style.display = 'flex';
      return;
    }

    // mod === 'zoda'
    btnZoda.style.display = 'flex';
    btnZoda.onclick = function () { deschideModalRezervare(balta, null); };
  }

  // ── 1. Butonul de pe standul din balta.html ─────────────────────────────────
  // Apelat din openOverlay(id) în balta.html cu (BALTA, standObj, containerEl).
  function renderButonStand(balta, stand, containerEl) {
    if (!containerEl) return;
    var mod = balta && balta.rezervare_mod;
    if (!mod || mod === 'fara_rezervare') { containerEl.innerHTML = ''; return; }

    if (mod === 'extern') {
      if (!balta.rezervare_url_extern) { containerEl.innerHTML = ''; return; }
      containerEl.innerHTML = '<a id="rez-stand-btn" href="' + escH(balta.rezervare_url_extern) +
        '" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none;">↗ Rezervă pe site-ul bălții</a>';
      return;
    }

    // mod === 'zoda'
    containerEl.innerHTML = '<button id="rez-stand-btn">📅 Rezervă acest stand</button>';
    var btn = containerEl.querySelector('#rez-stand-btn');
    btn.onclick = function () { deschideModalRezervare(balta, stand); };
  }

  // ── 2. Modal cerere rezervare (pescar) ──────────────────────────────────────
  // Modal unic, apelat fie de pe pagina bălții (standPreselectat = null —
  // pescarul alege standul din grilă), fie din overlay-ul unui stand anume
  // (standPreselectat = acel stand, pre-bifat în grilă dar schimbabil).
  // Layout aliniat cu referința trimisă de Marian: nume prefill din cont,
  // fără câmp de email, dată + tip rezervare, grilă vizuală de standuri
  // colorată după disponibilitate (liber/parțial/ocupat), buton de confirmare.
  async function deschideModalRezervare(balta, standPreselectat) {
    var uid = await getCurrentUserId();
    if (!uid) {
      toast('Trebuie să fii autentificat pentru a rezerva.', true);
      return;
    }

    deschideModalGeneric('Rezervă stand', '<div class="rez-empty">Se încarcă...</div>');

    var numeUser = '';
    var standuri = [];
    try {
      var profRes = await sb.from('user_profiles').select('username').eq('id', uid).single();
      numeUser = (profRes && profRes.data && profRes.data.username) || '';
      var standRes = await sb.from('standuri').select('id, nume').eq('balta_id', balta.id).order('sort_order', { ascending: true, nullsFirst: false }).order('id');
      standuri = standRes.data || [];
    } catch (e) {
      setModalBody('<div class="rez-empty">Eroare la încărcare: ' + escH(e.message) + '</div>');
      return;
    }

    if (!standuri.length) {
      setModalBody('<div class="rez-empty">Această baltă nu are încă standuri definite.</div>');
      return;
    }

    var minDate = new Date(Date.now() + 16 * 3600 * 1000);
    var minDateStr = toDateInputValue(minDate);
    var tipCurent = '12h';
    var standSelectatId = (standPreselectat && standuri.some(function (s) { return s.id === standPreselectat.id; })) ? standPreselectat.id : null;

    var body =
      '<div class="rez-field"><label>Nume complet</label><input type="text" id="rez-nume" value="' + escH(numeUser) + '" readonly></div>' +
      '<div class="rez-field"><label>Telefon de contact *</label><input type="tel" id="rez-telefon" placeholder="07xx xxx xxx" required></div>' +
      '<div class="rez-field"><label>Tip rezervare</label>' +
        '<div class="rez-tip-row" id="rez-tip-row">' +
          '<div class="rez-tip-card active" data-tip="12h"><div class="rez-tip-card-title">Zi</div><div class="rez-tip-desc">' + escH((balta.ora_zi_start || '06:00').slice(0, 5)) + '–' + escH((balta.ora_zi_stop || '18:00').slice(0, 5)) + '</div></div>' +
          '<div class="rez-tip-card" data-tip="24h"><div class="rez-tip-card-title">24 ore</div><div class="rez-tip-desc">de la ' + escH((balta.ora_noapte_start || '18:00').slice(0, 5)) + '</div></div>' +
          '<div class="rez-tip-card" data-tip="personalizat"><div class="rez-tip-card-title">Personalizat</div><div class="rez-tip-desc">24h sau mai mult</div></div>' +
        '</div>' +
      '</div>' +
      '<div id="rez-date-fields"></div>' +
      '<div class="rez-field"><label>Stand</label>' +
        '<div class="rez-legend"><span><i class="rez-dot liber"></i>Liber</span><span><i class="rez-dot partial"></i>Parțial (tot disponibil)</span><span><i class="rez-dot ocupat"></i>Ocupat</span><span><i class="rez-dot selectat"></i>Selectat</span></div>' +
        '<div class="rez-stand-grid" id="rez-stand-grid"></div>' +
      '</div>' +
      '<button class="rez-btn" id="rez-submit-btn" disabled>Trimite cererea</button>' +
      '<div style="font-size:11.5px;color:#4b5563;margin-top:8px;text-align:center;">Rezervările online sunt posibile doar cu minimum 16h înainte. Balta trebuie să aprobe cererea.</div>';

    setModalBody(body);

    function calculeazaInterval() {
      var dataStartInput = document.getElementById('rez-data-start');
      if (!dataStartInput || !dataStartInput.value) return null;
      var dataStart, dataSfarsit;
      if (tipCurent === '12h') {
        dataStart = combinaDataOra(dataStartInput.value, balta.ora_zi_start || '06:00');
        dataSfarsit = combinaDataOra(dataStartInput.value, balta.ora_zi_stop || '18:00');
      } else if (tipCurent === '24h') {
        dataStart = combinaDataOra(dataStartInput.value, balta.ora_noapte_start || '18:00');
        dataSfarsit = new Date(dataStart.getTime() + 24 * 3600 * 1000);
      } else {
        var dataSfarsitInput = document.getElementById('rez-data-sfarsit');
        if (!dataSfarsitInput || !dataSfarsitInput.value) return null;
        var momStart = document.getElementById('rez-mom-start').value;
        var momSfarsit = document.getElementById('rez-mom-sfarsit').value;
        dataStart = combinaDataOra(dataStartInput.value, momStart === 'noapte' ? (balta.ora_noapte_start || '18:00') : (balta.ora_zi_start || '06:00'));
        dataSfarsit = combinaDataOra(dataSfarsitInput.value, momSfarsit === 'noapte' ? (balta.ora_noapte_start || '18:00') : (balta.ora_zi_start || '06:00'));
      }
      if (dataSfarsit <= dataStart) return null;
      return { start: dataStart, sfarsit: dataSfarsit };
    }

    function renderDateFields() {
      var html = '';
      if (tipCurent === 'personalizat') {
        html =
          '<div class="rez-field"><label>Din data</label><input type="date" id="rez-data-start" min="' + minDateStr + '" value="' + minDateStr + '"></div>' +
          '<div class="rez-field"><label>Moment început</label><select id="rez-mom-start"><option value="zi">Dimineață (' + escH((balta.ora_zi_start || '06:00').slice(0, 5)) + ')</option><option value="noapte">Seară (' + escH((balta.ora_noapte_start || '18:00').slice(0, 5)) + ')</option></select></div>' +
          '<div class="rez-field"><label>Până în data</label><input type="date" id="rez-data-sfarsit" min="' + minDateStr + '" value="' + minDateStr + '"></div>' +
          '<div class="rez-field"><label>Moment sfârșit</label><select id="rez-mom-sfarsit"><option value="zi">Dimineață (' + escH((balta.ora_zi_start || '06:00').slice(0, 5)) + ')</option><option value="noapte" selected>Seară (' + escH((balta.ora_noapte_start || '18:00').slice(0, 5)) + ')</option></select></div>';
      } else {
        html = '<div class="rez-field"><label>Data rezervării</label><input type="date" id="rez-data-start" min="' + minDateStr + '" value="' + minDateStr + '"></div>';
      }
      document.getElementById('rez-date-fields').innerHTML = html;
      ['rez-data-start', 'rez-data-sfarsit', 'rez-mom-start', 'rez-mom-sfarsit'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.onchange = actualizeazaGrid;
      });
    }

    var _dispToken = 0;
    async function actualizeazaGrid() {
      var grid = document.getElementById('rez-stand-grid');
      if (!grid) return;
      var interval = calculeazaInterval();
      updateSubmitState();
      if (!interval) {
        grid.innerHTML = '<div class="rez-empty" style="padding:10px 0;">Alege o dată validă pentru a vedea disponibilitatea standurilor.</div>';
        return;
      }
      grid.innerHTML = '<div class="rez-empty" style="padding:10px 0;">Se verifică disponibilitatea...</div>';
      var myToken = ++_dispToken;
      var statusMap = {};
      try {
        var res = await sb.rpc('citeste_disponibilitate_balta', {
          p_balta_id: balta.id, p_data_start: interval.start.toISOString(), p_data_sfarsit: interval.sfarsit.toISOString()
        });
        if (myToken !== _dispToken) return;
        if (res.error) throw res.error;
        (res.data || []).forEach(function (r) { statusMap[r.stand_id] = r.status; });
      } catch (e) {
        if (myToken !== _dispToken) return;
        grid.innerHTML = '<div class="rez-empty" style="padding:10px 0;">Nu am putut verifica disponibilitatea. Încearcă din nou.</div>';
        return;
      }
      if (standSelectatId != null && statusMap[standSelectatId] === 'ocupat') standSelectatId = null;
      randeazaGrid(statusMap);
    }

    function randeazaGrid(statusMap) {
      var grid = document.getElementById('rez-stand-grid');
      if (!grid) return;
      grid.innerHTML = standuri.map(function (s, idx) {
        var status = statusMap[s.id] || 'liber';
        var ocupat = status === 'ocupat';
        var clasa = (!ocupat && s.id === standSelectatId) ? 'selectat' : status;
        var eticheta = s.nume || ('Stand ' + (idx + 1));
        return '<div class="rez-stand-cell ' + clasa + '" data-stand-id="' + s.id + '">' + escH(eticheta) + '</div>';
      }).join('');
      Array.prototype.forEach.call(grid.querySelectorAll('.rez-stand-cell:not(.ocupat)'), function (cell) {
        cell.onclick = function () {
          standSelectatId = parseInt(cell.dataset.standId, 10);
          randeazaGrid(statusMap);
        };
      });
      updateSubmitState();
    }

    function updateSubmitState() {
      var submitBtn = document.getElementById('rez-submit-btn');
      if (!submitBtn) return;
      submitBtn.disabled = !(standSelectatId != null && calculeazaInterval());
    }

    renderDateFields();
    actualizeazaGrid();

    document.getElementById('rez-tip-row').addEventListener('click', function (e) {
      var card = e.target.closest('.rez-tip-card');
      if (!card) return;
      document.querySelectorAll('#rez-tip-row .rez-tip-card').forEach(function (c) { c.classList.remove('active'); });
      card.classList.add('active');
      tipCurent = card.dataset.tip;
      renderDateFields();
      actualizeazaGrid();
    });

    document.getElementById('rez-submit-btn').onclick = async function () {
      var btnEl = this;
      var interval = calculeazaInterval();
      if (!interval) { toast('Alege o dată validă.', true); return; }
      if (standSelectatId == null) { toast('Alege un stand din grilă.', true); return; }
      var telefon = (document.getElementById('rez-telefon').value || '').trim();
      if (!telefon) { toast('Completează un număr de telefon de contact.', true); return; }

      btnEl.disabled = true; btnEl.textContent = 'Se trimite...';
      try {
        var res = await sb.rpc('creeaza_cerere_rezervare', {
          p_stand_id: standSelectatId, p_tip_sesiune: tipCurent,
          p_data_start: interval.start.toISOString(), p_data_sfarsit: interval.sfarsit.toISOString(),
          p_telefon_client: telefon
        });
        if (res.error) throw res.error;
        toast('✓ Cerere trimisă! Balta va răspunde în curând.');
        closeModal();
      } catch (e) {
        toast(e.message || 'Eroare la trimiterea cererii.', true);
        btnEl.textContent = 'Trimite cererea';
        actualizeazaGrid();
      }
    };
  }

  // ── 3. "Rezervările mele" (pescar, cont.html) ───────────────────────────────
  async function deschideModalRezervarileMele() {
    deschideModalGeneric('Rezervările mele', '<div class="rez-empty">Se încarcă...</div>');
    try {
      var res = await sb.rpc('listeaza_rezervari_mele');
      if (res.error) throw res.error;
      var rows = res.data || [];
      if (!rows.length) { setModalBody('<div class="rez-empty">Nu ai nicio rezervare încă.</div>'); return; }
      setModalBody(rows.map(randRezervareMea).join(''));
      rows.forEach(function (r) {
        var confirmBtn = document.getElementById('rez-confirma-' + r.id);
        if (confirmBtn) confirmBtn.onclick = function () { confirmaPrezenta(r.id); };
        var anuleazaBtn = document.getElementById('rez-anuleaza-' + r.id);
        if (anuleazaBtn) anuleazaBtn.onclick = function () { anuleazaMea(r.id); };
      });
    } catch (e) {
      setModalBody('<div class="rez-empty">Eroare: ' + escH(e.message) + '</div>');
    }
  }

  function randRezervareMea(r) {
    var acum = new Date();
    var start = new Date(r.data_start);
    var arataConfirma = r.status === 'confirmata' && !r.confirmat_24h_la && (start - acum) <= 24 * 3600 * 1000 && start > acum;
    var arataAnuleaza = (r.status === 'in_asteptare' || r.status === 'confirmata') && (start - acum) >= 24 * 3600 * 1000;
    return '<div class="rez-list-item">' +
      '<div style="font-weight:700;color:#f1f5f9;">' + escH(r.balta_nume) + ' — ' + escH(r.stand_nume) + '<span class="rez-badge rez-badge-' + r.status + '">' + escH(r.status) + '</span></div>' +
      '<div style="margin:4px 0;">' + fmtDataOra(r.data_start) + ' → ' + fmtDataOra(r.data_sfarsit) + '</div>' +
      (r.motiv_anulare ? '<div style="color:#f59e0b;">Motiv: ' + escH(r.motiv_anulare) + '</div>' : '') +
      (r.confirmat_24h_la ? '<div style="color:#22c55e;">✓ Prezență confirmată</div>' : '') +
      (arataConfirma ? '<button class="rez-btn" id="rez-confirma-' + r.id + '" style="margin-top:8px;">✓ Confirm că vin</button>' : '') +
      (arataAnuleaza ? '<button class="rez-btn rez-btn-danger" id="rez-anuleaza-' + r.id + '" style="margin-top:8px;">Anulează</button>' : '') +
      '</div>';
  }

  async function confirmaPrezenta(id) {
    try {
      var res = await sb.rpc('confirma_prezenta_24h', { p_rezervare_id: id });
      if (res.error) throw res.error;
      toast('✓ Prezență confirmată!');
      deschideModalRezervarileMele();
    } catch (e) { toast(e.message || 'Eroare.', true); }
  }

  async function anuleazaMea(id) {
    if (!confirm('Sigur anulezi această rezervare?')) return;
    try {
      var res = await sb.rpc('anuleaza_rezervare_pescar', { p_rezervare_id: id });
      if (res.error) throw res.error;
      toast('Rezervare anulată.');
      deschideModalRezervarileMele();
    } catch (e) { toast(e.message || 'Eroare.', true); }
  }

  // ── 4. Panoul balta_admin (cont.html) ───────────────────────────────────────
  var _adminBaltaId = null;
  var _adminBaltaNume = null;
  var _adminTabCurent = 'cereri';
  var _adminStanduri = [];
  var _adminMultiplu = false;

  async function deschideModalAdmin(baltaId, baltaNume) {
    _adminBaltaId = baltaId; _adminBaltaNume = baltaNume; _adminTabCurent = 'cereri'; _adminMultiplu = false;
    var tabsHtml = '<div class="rez-tabs">' +
      '<button class="rez-tab active" data-tab="cereri" onclick="RezervariUI._schimbaTabAdmin(\'cereri\')">Cereri</button>' +
      '<button class="rez-tab" data-tab="calendar" onclick="RezervariUI._schimbaTabAdmin(\'calendar\')">Calendar</button>' +
      '<button class="rez-tab" data-tab="manual" onclick="RezervariUI._schimbaTabAdmin(\'manual\')">Adaugă manual</button>' +
      '</div>';
    deschideModalGeneric('📅 Rezervări — ' + baltaNume, '<div class="rez-empty">Se încarcă...</div>', tabsHtml);

    var { data: standuri } = await sb.from('standuri').select('id, nume').eq('balta_id', baltaId).order('sort_order', { ascending: true, nullsFirst: false }).order('id');
    _adminStanduri = standuri || [];

    renderTabAdminCurent();
  }

  function schimbaTabAdmin(tab) {
    _adminTabCurent = tab;
    document.querySelectorAll('.rez-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tab); });
    renderTabAdminCurent();
  }

  async function renderTabAdminCurent() {
    if (_adminTabCurent === 'cereri') return renderTabCereri();
    if (_adminTabCurent === 'calendar') return renderTabCalendar();
    if (_adminTabCurent === 'manual') return renderTabManual();
  }

  async function fetchRezervariBalta() {
    var res = await sb.rpc('listeaza_rezervari_balta', { p_balta_id: _adminBaltaId });
    if (res.error) throw res.error;
    return res.data || [];
  }

  function identitatePescar(r) {
    var nume = r.user_id ? (r.pescar_username || r.pescar_zoda_id || 'Pescar') : (r.nume_client || 'Client telefonic');
    var strikeHtml = (r.strike_uri_active && r.strike_uri_active > 0)
      ? ' <span class="rez-strike">⚠️ ' + r.strike_uri_active + ' strike' + (r.strike_uri_active > 1 ? '-uri' : '') + ' activ' + (r.strike_uri_active > 1 ? 'e' : '') + '</span>'
      : '';
    var telefon = r.telefon_client
      ? ' <a class="rez-tel-btn" href="tel:' + escH(r.telefon_client) + '"><span>📞</span>' + escH(r.telefon_client) + '</a>'
      : '';
    return escH(nume) + telefon + strikeHtml;
  }

  async function renderTabCereri() {
    setModalBody('<div class="rez-empty">Se încarcă...</div>');
    try {
      var toate = await fetchRezervariBalta();
      var cereri = toate.filter(function (r) { return r.status === 'in_asteptare'; });
      if (!cereri.length) { setModalBody('<div class="rez-empty">Nicio cerere în așteptare.</div>'); return; }
      setModalBody(cereri.map(function (r) {
        return '<div class="rez-list-item">' +
          '<div style="font-weight:700;color:#f1f5f9;">' + escH(r.stand_nume) + '<span class="rez-badge rez-badge-in_asteptare">în așteptare</span></div>' +
          '<div style="margin:4px 0;">' + identitatePescar(r) + '</div>' +
          '<div style="margin:4px 0;">' + fmtDataOra(r.data_start) + ' → ' + fmtDataOra(r.data_sfarsit) + '</div>' +
          '<div style="display:flex;gap:8px;margin-top:8px;">' +
            '<button class="rez-btn" style="background:#166534;" id="rez-aproba-' + r.id + '">✓ Aprobă</button>' +
            '<button class="rez-btn rez-btn-danger" id="rez-respinge-' + r.id + '">✕ Respinge</button>' +
          '</div>' +
        '</div>';
      }).join(''));
      cereri.forEach(function (r) {
        document.getElementById('rez-aproba-' + r.id).onclick = function () { aprobaCerere(r.id); };
        document.getElementById('rez-respinge-' + r.id).onclick = function () { respingeCerere(r.id); };
      });
    } catch (e) { setModalBody('<div class="rez-empty">Eroare: ' + escH(e.message) + '</div>'); }
  }

  async function aprobaCerere(id) {
    try {
      var res = await sb.rpc('aproba_rezervare', { p_rezervare_id: id });
      if (res.error) throw res.error;
      toast('✓ Rezervare confirmată.');
      renderTabCereri();
    } catch (e) { toast(e.message || 'Eroare.', true); }
  }

  async function respingeCerere(id) {
    var motiv = prompt('Motiv respingere (opțional):') || null;
    try {
      var res = await sb.rpc('respinge_rezervare', { p_rezervare_id: id, p_motiv: motiv });
      if (res.error) throw res.error;
      toast('Cerere respinsă.');
      renderTabCereri();
    } catch (e) { toast(e.message || 'Eroare.', true); }
  }

  async function renderTabCalendar() {
    setModalBody('<div class="rez-empty">Se încarcă...</div>');
    try {
      var toate = await fetchRezervariBalta();
      var relevante = toate.filter(function (r) { return r.status === 'confirmata' || r.status === 'neprezentat'; })
        .sort(function (a, b) { return new Date(b.data_start) - new Date(a.data_start); });
      if (!relevante.length) { setModalBody('<div class="rez-empty">Nicio rezervare confirmată încă.</div>'); return; }
      var acum = new Date();
      setModalBody(relevante.map(function (r) {
        var sEnd = new Date(r.data_sfarsit);
        var arataNeprezentare = r.status === 'confirmata' && sEnd < acum;
        return '<div class="rez-list-item">' +
          '<div style="font-weight:700;color:#f1f5f9;">' + escH(r.stand_nume) + '<span class="rez-badge rez-badge-' + r.status + '">' + escH(r.status) + '</span></div>' +
          '<div style="margin:4px 0;">' + identitatePescar(r) + '</div>' +
          '<div style="margin:4px 0;">' + fmtDataOra(r.data_start) + ' → ' + fmtDataOra(r.data_sfarsit) + '</div>' +
          (r.confirmat_24h_la ? '<div style="color:#22c55e;font-size:12px;">✓ Confirmat de pescar</div>' : (r.status === 'confirmata' ? '<div style="color:#94a3b8;font-size:12px;">⏳ Neconfirmat încă</div>' : '')) +
          (arataNeprezentare ? '<button class="rez-btn rez-btn-danger" style="margin-top:8px;" id="rez-neprezentare-' + r.id + '">❌ Nu s-a prezentat</button>' : '') +
        '</div>';
      }).join(''));
      relevante.forEach(function (r) {
        var b = document.getElementById('rez-neprezentare-' + r.id);
        if (b) b.onclick = function () { marcheazaNeprezentare(r.id); };
      });
    } catch (e) { setModalBody('<div class="rez-empty">Eroare: ' + escH(e.message) + '</div>'); }
  }

  async function marcheazaNeprezentare(id) {
    if (!confirm('Sigur marchezi neprezentare? Pescarul primește un strike.')) return;
    try {
      var res = await sb.rpc('marcheaza_neprezentare', { p_rezervare_id: id });
      if (res.error) throw res.error;
      toast('Strike acordat.');
      renderTabCalendar();
    } catch (e) { toast(e.message || 'Eroare.', true); }
  }

  function renderTabManual() {
    var standOptions = _adminStanduri.map(function (s) { return '<option value="' + s.id + '">' + escH(s.nume) + '</option>'; }).join('');
    var html =
      '<div class="rez-field">' +
        '<label><input type="checkbox" id="rez-manual-multiplu"> Rezervare multiplă (grup/concurs — mai multe standuri)</label>' +
      '</div>' +
      '<div class="rez-field" id="rez-manual-stand-wrap">' +
        '<label id="rez-manual-stand-label">Stand</label>' +
        '<select id="rez-manual-stand">' + standOptions + '</select>' +
      '</div>' +
      '<div class="rez-field"><label>Tip partidă</label><select id="rez-manual-tip"><option value="12h">Zi</option><option value="24h" selected>24h</option><option value="personalizat">Personalizat</option></select></div>' +
      '<div class="rez-field"><label>Data/ora început</label><input type="datetime-local" id="rez-manual-start"></div>' +
      '<div class="rez-field"><label>Data/ora sfârșit</label><input type="datetime-local" id="rez-manual-sfarsit"></div>' +
      '<div class="rez-field"><label>Nume client</label><input type="text" id="rez-manual-nume" placeholder="opțional"></div>' +
      '<div class="rez-field"><label>Telefon client</label><input type="text" id="rez-manual-telefon" placeholder="opțional"></div>' +
      '<button class="rez-btn" id="rez-manual-submit">Adaugă rezervarea</button>';
    setModalBody(html);

    var multiCheck = document.getElementById('rez-manual-multiplu');
    multiCheck.onchange = function () {
      _adminMultiplu = multiCheck.checked;
      var wrap = document.getElementById('rez-manual-stand-wrap');
      document.getElementById('rez-manual-stand-label').textContent = _adminMultiplu ? 'Standuri (ține Ctrl/Cmd apăsat pentru mai multe)' : 'Stand';
      var sel = document.getElementById('rez-manual-stand');
      sel.multiple = _adminMultiplu;
    };

    document.getElementById('rez-manual-submit').onclick = async function () {
      var btn = this;
      var standSel = document.getElementById('rez-manual-stand');
      var standIds = _adminMultiplu
        ? Array.from(standSel.selectedOptions).map(function (o) { return parseInt(o.value, 10); })
        : [parseInt(standSel.value, 10)];
      var tip = document.getElementById('rez-manual-tip').value;
      var startVal = document.getElementById('rez-manual-start').value;
      var sfarsitVal = document.getElementById('rez-manual-sfarsit').value;
      var nume = document.getElementById('rez-manual-nume').value.trim() || null;
      var telefon = document.getElementById('rez-manual-telefon').value.trim() || null;

      if (!standIds.length || !startVal || !sfarsitVal) { toast('Completează standul și intervalul.', true); return; }
      var dataStart = new Date(startVal), dataSfarsit = new Date(sfarsitVal);
      if (dataSfarsit <= dataStart) { toast('Interval invalid.', true); return; }

      btn.disabled = true; btn.textContent = 'Se salvează...';
      try {
        var res;
        if (_adminMultiplu && standIds.length > 1) {
          res = await sb.rpc('adauga_rezervare_multipla_admin', {
            p_stand_ids: standIds, p_tip_sesiune: tip,
            p_data_start: dataStart.toISOString(), p_data_sfarsit: dataSfarsit.toISOString(),
            p_nume_client: nume, p_telefon_client: telefon
          });
        } else {
          res = await sb.rpc('adauga_rezervare_manuala', {
            p_stand_id: standIds[0], p_tip_sesiune: tip,
            p_data_start: dataStart.toISOString(), p_data_sfarsit: dataSfarsit.toISOString(),
            p_nume_client: nume, p_telefon_client: telefon
          });
        }
        if (res.error) throw res.error;
        toast('✓ Rezervare adăugată.');
        schimbaTabAdmin('calendar');
      } catch (e) {
        toast(e.message || 'Eroare la salvare.', true);
        btn.disabled = false; btn.textContent = 'Adaugă rezervarea';
      }
    };
  }

  // ── API public ───────────────────────────────────────────────────────────
  global.RezervariUI = {
    renderButonBalta: renderButonBalta,
    renderButonStand: renderButonStand,
    deschideModalRezervarileMele: deschideModalRezervarileMele,
    deschideModalAdmin: deschideModalAdmin,
    _closeModal: closeModal,
    _schimbaTabAdmin: schimbaTabAdmin
  };

})(window);
