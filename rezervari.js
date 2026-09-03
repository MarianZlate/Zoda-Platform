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
    injectStylesOnce();
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.className = 'rez-toast';
      document.body.appendChild(_toastEl);
    }
    _toastEl.classList.toggle('err', !!isErr);
    _toastEl.textContent = msg;
    _toastEl.style.display = 'block';
    clearTimeout(_toastEl._t);
    _toastEl._t = setTimeout(function () { _toastEl.style.display = 'none'; }, 3800);
  }

  // Format unic de dată pentru tot ce ține de rezervări — 'dd-mm-yyyy'
  // (rundă 32, cerere explicită a lui Marian: „data la rezervari sa fie
  // afisata peste tot dd-mm-yyyy"). Înainte, `toLocaleDateString('ro-RO', ...)`
  // producea 'dd.mm.yyyy' (cu punct, formatul implicit românesc din motorul
  // JS, nu cu liniuță) — de aceea data era construită manual, cifră cu
  // cifră, nu prin locale, ca separatorul să fie garantat liniuța cerută,
  // indiferent de mediul de rulare (browser/motor JS) al vizitatorului.
  function fmtDataDDMMYYYY(d) {
    var zi = String(d.getDate()).padStart(2, '0');
    var luna = String(d.getMonth() + 1).padStart(2, '0');
    return zi + '-' + luna + '-' + d.getFullYear();
  }

  function fmtDataOra(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return fmtDataDDMMYYYY(d) +
      ' ' + d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  }

  // Variantă cu data și ora colorate diferit (rundă 17, cerere explicită a
  // lui Marian) — ca cele două să se distingă instant dintr-o privire în
  // modalul de detaliu al unei rezervări, fără să se confunde cu culorile
  // deja folosite pentru status (albastru/verde/roșu, §38). Un singur loc
  // de formatare, ca cele două stiluri să rămână sincronizate peste tot.
  function fmtDataOraColorat(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    var dataStr = fmtDataDDMMYYYY(d);
    var oraStr = d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
    return '<span class="rez-data-part">' + dataStr + '</span> <span class="rez-ora-part">' + oraStr + '</span>';
  }

  // Eticheta afișată pentru fiecare status de rezervare — separată de valoarea
  // brută din baza de date (`rezervari.status`), ca să putem alege un cuvânt
  // care nu se confundă cu alte concepte din UI. În particular, 'confirmata'
  // (adică balta_admin a APROBAT cererea) afișa literal "confirmata", ușor de
  // confundat cu "✓ Confirmat de pescar" (`confirmat_24h_la` — pescarul își
  // confirmă prezența cu 24h înainte, un concept total diferit) — de-aici
  // "aprobată" în loc de "confirmata".
  function statusLabel(status) {
    var harta = {
      confirmata: 'aprobată',
      in_asteptare: 'în așteptare',
      anulata: 'anulată',
      respinsa: 'respinsă',
      expirata: 'expirată',
      neprezentat: 'neprezentat'
    };
    return harta[status] || status;
  }

  // Nivelul de „încredere" al unei rezervări `confirmata` (aprobate) — 3
  // culori distincte, cerute explicit de Marian (rundă 16): ALBASTRU
  // (implicit) = aprobată de balta_admin, dar pescarul nu și-a confirmat
  // încă prezența; VERDE = fie adăugată direct de balta_admin (`sursa
  // === 'manual_admin'` — n-are cum să mai fie "neconfirmată", admin-ul a
  // introdus-o direct, nu există pescar cu cont care s-o confirme), fie
  // aprobată ȘI confirmată de pescar (`confirmat_24h_la` setat). ROȘU
  // (`neprezentat`) e deja tratat separat, nu trece prin funcția asta.
  // Un singur loc de decizie, folosit atât la badge-uri cât și la barele
  // din Gantt, ca să nu diveargă între ele.
  function esteRezervareVerde(r) {
    return r.sursa === 'manual_admin' || !!r.confirmat_24h_la;
  }

  // Clasele CSS de adăugat unui badge/unei bare pentru o rezervare
  // `confirmata` — clasa de bază (`confirmata`) rămâne albastră (stilul
  // implicit din foaia de stil injectată), iar `.verde` o suprascrie.
  function claseNivelIncredere(r) {
    return esteRezervareVerde(r) ? ' verde' : '';
  }

  // ── Istoricul de rezervări al unui client, în „Bază clienți" (rundă 43,
  // cerere explicită a lui Marian: „fiecare client sa aiba un dropdown la
  // care sa vedem istoricul rezervarilor pe balta respectiva, data cand a
  // facut rezervarea, durata partidei, daca au fost onorate, anulate sau
  // nu s-a prezentat"). Două piese separate de `statusLabel`/`claseNivelIncredere`
  // de mai sus, dar construite peste ele, nu în paralel:
  //
  // 1) Durata efectivă a partidei — calculată din `data_sfarsit - data_start`
  //    (nu din `tip_sesiune`, ca să rămână corectă și pentru „personalizat",
  //    unde durata nu e fixă) — afișată în ore ("24h"), sau în zile întregi
  //    ("2 zile") doar când durata e un multiplu de 24h ȘI trece de 24h (o
  //    rezervare obișnuită de 24h rămâne "24h", ca să se recunoască din
  //    prima privire, la fel ca eticheta tipului "24 ore" de la rezervare).
  function fmtDurataSesiune(r) {
    var ore = Math.round((new Date(r.data_sfarsit) - new Date(r.data_start)) / 3600000);
    if (ore > 24 && ore % 24 === 0) return (ore / 24) + ' zile';
    return ore + 'h';
  }

  // 2) Eticheta/badge-ul de rezultat pentru o rezervare din istoric — statusul
  //    brut (`statusLabel`) nu distinge o rezervare `confirmata` care s-a
  //    ÎNCHEIAT deja (deci a fost efectiv onorată — pescarul a venit, n-a
  //    fost marcată "neprezentat") de una `confirmata` care abia URMEAZĂ.
  //    Rezultat nou, calculat DOAR pentru istoric (nu schimbă nimic din
  //    Calendar/Cereri, unde `confirmata` rămâne „aprobată" peste tot,
  //    indiferent de dată — comportament neatins, cf. `claseNivelIncredere`
  //    de mai sus). Restul statusurilor (anulata/respinsa/expirata/
  //    neprezentat/in_asteptare) își păstrează eticheta+culoarea obișnuită.
  function statusIstoricBadge(r) {
    if (r.status === 'confirmata' && new Date(r.data_sfarsit) < new Date()) {
      return { label: 'onorată', classAttr: 'rez-badge rez-badge-onorata' };
    }
    var clase = 'rez-badge rez-badge-' + r.status + (r.status === 'confirmata' ? claseNivelIncredere(r) : '');
    return { label: statusLabel(r.status), classAttr: clase };
  }

  // Randează lista de rezervări din istoricul unui client — cea mai recentă
  // primă (sortare descrescătoare după `data_start`), un rând per rezervare:
  // dată, durată, stand, rezultat. Funcție separată (nu inline în
  // `renderTabModerare`), ca să poată fi testată izolat și randată abia la
  // deschiderea dropdown-ului (nu la randarea inițială a listei de clienți —
  // ar însemna sute de rânduri ascunse, randate degeaba, pe o baltă cu mulți
  // clienți).
  function randeazaIstoricClient(rezervari) {
    if (!rezervari.length) return '<div class="rez-istoric-empty">Nicio rezervare încă la această baltă.</div>';
    var sortate = rezervari.slice().sort(function (a, b) { return new Date(b.data_start) - new Date(a.data_start); });
    return sortate.map(function (r) {
      var info = statusIstoricBadge(r);
      return '<div class="rez-istoric-item">' +
        '<span class="rez-istoric-data">' + escH(fmtDataDDMMYYYY(new Date(r.data_start))) + '</span>' +
        '<span class="rez-istoric-durata">' + escH(fmtDurataSesiune(r)) + '</span>' +
        '<span class="rez-istoric-stand">' + escH(r.stand_nume || '') + '</span>' +
        '<span class="' + info.classAttr + '">' + escH(info.label) + '</span>' +
      '</div>';
    }).join('');
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

  // ── Program sezonier (§29 pct. 7, rundă 12) ─────────────────────────────────
  // Rezolvare CÂMP CU CÂMP, nu o singură „regulă câștigătoare" pentru toată
  // data — decizie de design revizuită după ce testele automate au prins
  // problema variantei inițiale: o regulă PERMANENTĂ de blocare 24h și o
  // regulă SEZONIERĂ separată doar de ore (ex. program de iarnă) se pot
  // suprapune pe aceleași date; dacă una singură "câștiga" toată data, cea mai
  // recent creată dintre ele (de regulă cea de blocare, fără ore proprii) ar
  // fi anulat orele sezoniere ale celeilalte, fără nicio legătură logică
  // între ele. Corect: fiecare câmp (ora_zi_start/stop, ora_noapte_start,
  // blocheaza_24h) se rezolvă independent — cea mai recentă regulă activă
  // care acoperă data ȘI specifică EXPLICIT acel câmp câștigă doar pentru
  // acel câmp. Pentru blocheaza_24h, "specifică" = explicit `true` — o regulă
  // cu `blocheaza_24h=false` nu deblochează nimic, doar nu contribuie.
  // OGLINDĂ EXACTĂ a verificării din trigger-ul `fn_verifica_blocare_24h()`
  // (SQL) — dacă se schimbă regula de rezolvare, se schimbă în AMBELE locuri.
  function gasesteValoareRegula(reguli, dataStr, camp) {
    var candidat = null;
    (Array.isArray(reguli) ? reguli : []).forEach(function (r) {
      var inRange = (!r.data_start || dataStr >= r.data_start) && (!r.data_sfarsit || dataStr <= r.data_sfarsit);
      var areValoare = camp === 'blocheaza_24h' ? !!r.blocheaza_24h : (r[camp] != null && r[camp] !== '');
      if (inRange && areValoare && (!candidat || r.id > candidat.id)) candidat = r;
    });
    return candidat;
  }

  // Orele efective pentru o dată — orele din cea mai recentă regulă care
  // suprascrie fiecare câmp în parte (dacă există), altfel orele de bază ale
  // bălții; blocheaza_24h = true dacă ORICE regulă activă acoperind data are
  // blocheaza_24h=true.
  function oreEfectivePentruData(balta, reguli, dataStr) {
    var rZiStart = gasesteValoareRegula(reguli, dataStr, 'ora_zi_start');
    var rZiStop = gasesteValoareRegula(reguli, dataStr, 'ora_zi_stop');
    var rNoapte = gasesteValoareRegula(reguli, dataStr, 'ora_noapte_start');
    var rBlocheaza = gasesteValoareRegula(reguli, dataStr, 'blocheaza_24h');
    return {
      ora_zi_start: (rZiStart && rZiStart.ora_zi_start) || (balta && balta.ora_zi_start) || '06:00',
      ora_zi_stop: (rZiStop && rZiStop.ora_zi_stop) || (balta && balta.ora_zi_stop) || '18:00',
      ora_noapte_start: (rNoapte && rNoapte.ora_noapte_start) || (balta && balta.ora_noapte_start) || '18:00',
      blocheaza_24h: !!rBlocheaza
    };
  }

  // Mesaj de indisponibilitate pentru UI (null dacă tipul e disponibil la data
  // respectivă) — folosit ca avertisment înainte de trimitere, atât în
  // modalul pescarului cât și la adăugarea manuală.
  function motivIndisponibilSesiune(balta, tip, dataStartStr, reguli) {
    if (!dataStartStr || (tip !== '24h' && tip !== 'personalizat')) return null;
    var ore = oreEfectivePentruData(balta, reguli, dataStartStr);
    return ore.blocheaza_24h ? 'Partidele de 24h/personalizat sunt indisponibile pentru data aleasă (regulă sezonieră a bălții) — alege tipul „Zi" sau o altă dată.' : null;
  }

  // Calculul orei de start/sfârșit al unei partide din tipul ei + orele de
  // ancoră ale bălții (eventual suprascrise de o regulă sezonieră activă
  // pentru data aleasă, cf. mai sus) — SINGURUL loc unde se face acest calcul,
  // folosit atât de modalul pescarului (deschideModalRezervare) cât și de
  // adăugarea manuală din panoul balta_admin (renderTabManual, cf. §29 pct.
  // 6/7) — ca să nu diveargă logica între cele două locuri.
  // tip: '12h' | '24h' | 'personalizat'. Pentru 'personalizat', momStart/
  // momSfarsit sunt 'zi'|'noapte'. `reguli` (opțional) = rezultatul
  // `citeste_reguli_program_balta`. Întoarce {start, sfarsit} (Date) sau null
  // dacă intervalul nu poate fi calculat, e invalid (sfârșit <= start), sau
  // tipul e blocat de o regulă sezonieră pentru data aleasă.
  function calculeazaIntervalSesiune(balta, tip, dataStartStr, dataSfarsitStr, momStart, momSfarsit, reguli) {
    if (!dataStartStr) return null;
    var oreStart = oreEfectivePentruData(balta, reguli, dataStartStr);
    if ((tip === '24h' || tip === 'personalizat') && oreStart.blocheaza_24h) return null;
    var dataStart, dataSfarsit;
    if (tip === '12h') {
      dataStart = combinaDataOra(dataStartStr, oreStart.ora_zi_start);
      dataSfarsit = combinaDataOra(dataStartStr, oreStart.ora_zi_stop);
    } else if (tip === '24h') {
      dataStart = combinaDataOra(dataStartStr, oreStart.ora_noapte_start);
      dataSfarsit = new Date(dataStart.getTime() + 24 * 3600 * 1000);
    } else {
      if (!dataSfarsitStr) return null;
      var oreSfarsit = oreEfectivePentruData(balta, reguli, dataSfarsitStr);
      dataStart = combinaDataOra(dataStartStr, momStart === 'noapte' ? oreStart.ora_noapte_start : oreStart.ora_zi_start);
      dataSfarsit = combinaDataOra(dataSfarsitStr, momSfarsit === 'noapte' ? oreSfarsit.ora_noapte_start : oreSfarsit.ora_zi_start);
    }
    if (!dataStart || !dataSfarsit || dataSfarsit <= dataStart) return null;
    return { start: dataStart, sfarsit: dataSfarsit };
  }

  async function getCurrentUserId() {
    try {
      var res = await sb.auth.getSession();
      return res && res.data && res.data.session ? res.data.session.user.id : null;
    } catch (e) { return null; }
  }

  function injectStylesOnce() {
    if (document.getElementById('rez-styles')) return;
    // Culorile de mai jos folosesc variabilele CSS `--zc-*` — definite deja,
    // identic, în balta.html/cont.html/rezervari-admin.html (fiecare cu
    // propriul motor de temă light/dark/automat, cf. §29 pct. 4). Dacă acest
    // modul e vreodată încărcat într-o pagină gazdă FĂRĂ acele variabile
    // definite, fallback-urile din var(--x, fallback) de mai jos păstrează
    // exact culorile dark originale — nimic nu se strică.
    var css = `
      .rez-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99998;display:flex;align-items:center;justify-content:center;padding:14px;}
      .rez-toast{display:none;position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--zc-bg-panel,#111827);border:1px solid #0891b2;color:var(--zc-text-primary,#f1f5f9);padding:11px 18px;border-radius:10px;font-size:14px;font-weight:600;z-index:100000;box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:90vw;text-align:center;}
      .rez-toast.err{border-color:#ef4444;color:#b91c1c;}
      .rez-text-ok{color:#15803d;}
      .rez-text-warn{color:#b45309;}
      .rez-text-muted2{color:var(--zc-text-secondary-2,#94a3b8);}
      .rez-nume-pescar{font-weight:800;color:var(--zc-text-primary,#f1f5f9);}
      .rez-data-part{font-weight:800;color:var(--zc-text-primary,#f1f5f9);}
      .rez-ora-part{font-weight:800;color:#15803d;}
      .rez-modal{background:var(--zc-bg,#0a0f1a);border:1px solid var(--zc-border,#1e293b);border-radius:16px;max-width:520px;width:100%;max-height:88vh;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.4);}
      .rez-modal-hdr{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--zc-border,#1e293b);position:sticky;top:0;background:var(--zc-bg,#0a0f1a);z-index:2;gap:10px;}
      .rez-modal-hdr h3{margin:0;font-size:16px;color:var(--zc-text-primary,#f1f5f9);font-weight:800;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .rez-modal-close{background:none;border:none;color:var(--zc-text-secondary-2,#94a3b8);font-size:20px;cursor:pointer;line-height:1;flex-shrink:0;}
      /* Acțiune principală în header-ul modalului (rundă 23) — Marian a
         semnalat că butonul "Trimite cererea" jos de tot, sub grila de
         standuri, nu era intuitiv: trebuia scrollat tot modalul ca să-l
         găsești. Mutat în header, lângă ✕, mereu vizibil (header-ul e deja
         'position:sticky;top:0', deci rămâne pe ecran indiferent cât ai
         scrollat conținutul de sub el). Grupat cu ✕ într-un wrapper propriu
         ('.rez-modal-hdr-actions') ca 'justify-content:space-between' de pe
         '.rez-modal-hdr' să nu împingă butonul undeva la mijloc, între titlu
         și ✕ — title-ul ia tot spațiul rămas ('flex:1', cu elipsis dacă e
         prea lung), iar acțiunile stau grupate compact la dreapta. */
      .rez-modal-hdr-actions{display:flex;align-items:center;gap:10px;flex-shrink:0;}
      .rez-btn-header{width:auto;padding:8px 14px;font-size:13.5px;border-radius:8px;}
      .rez-modal-body{padding:16px 18px;}
      .rez-field{margin-bottom:14px;}
      .rez-field label{display:block;font-size:12.5px;font-weight:700;color:var(--zc-text-secondary-2,#94a3b8);margin-bottom:5px;}
      .rez-field input, .rez-field select{width:100%;background:var(--zc-bg-panel,#111827);border:1.5px solid var(--zc-border,#1e293b);border-radius:8px;padding:9px 11px;color:var(--zc-text-primary,#f1f5f9);font-size:15px;outline:none;box-sizing:border-box;}
      .rez-field input[type="checkbox"]{width:auto;flex:0 0 auto;background:none;border:none;padding:0;}
      #rez-nume[readonly]{opacity:.7;cursor:not-allowed;}
      .rez-tel-btn{display:inline-flex;align-items:center;gap:5px;background:rgba(56,189,248,.1);border:1px solid rgba(56,189,248,.35);border-radius:8px;padding:3px 9px;text-decoration:none;color:#0891b2;font-size:12.5px;font-weight:700;vertical-align:middle;white-space:nowrap;}
      .rez-tel-btn:hover{background:rgba(56,189,248,.18);}
      .rez-tip-row{display:flex;gap:8px;flex-wrap:wrap;}
      .rez-tip-card{flex:1;min-width:100px;border:1.5px solid var(--zc-border,#1e293b);border-radius:10px;padding:9px 8px;cursor:pointer;text-align:center;}
      .rez-tip-card.active{border-color:#38bdf8;background:rgba(56,189,248,.08);}
      .rez-tip-card-title{font-size:13.5px;font-weight:800;color:var(--zc-text-primary,#f1f5f9);}
      .rez-tip-desc{font-size:11px;color:var(--zc-text-secondary-2,#94a3b8);margin-top:2px;}
      .rez-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:12.3px;color:var(--zc-text-secondary-2,#94a3b8);margin:2px 0 10px;}
      .rez-legend span{display:flex;align-items:center;gap:4px;}
      .rez-dot{display:inline-block;width:9px;height:9px;border-radius:50%;}
      .rez-dot.liber{background:#22c55e;}
      .rez-dot.partial{background:#f59e0b;}
      .rez-dot.ocupat{background:#ef4444;}
      .rez-dot.selectat{background:#38bdf8;}
      .rez-stand-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:8px;}
      /* Când grila de standuri afișează un mesaj în loc de celule (dată
         nevalidă, blocată sezonier, eroare) — mesajul e un singur element
         .rez-empty injectat direct în containerul grid, care altfel l-ar
         plasa într-o singură coloană de ~72px (lățimea minimă a unei
         celule de stand), făcând textul lung să se rupă absurd de îngust,
         literă cu literă aproape. Îl întindem pe toată lățimea grilei. */
      .rez-stand-grid > .rez-empty{grid-column:1 / -1;}
      .rez-stand-cell{border:1.5px solid var(--zc-border,#1e293b);border-radius:9px;padding:10px 6px;text-align:center;font-size:12.5px;font-weight:700;cursor:pointer;color:var(--zc-text-primary,#f1f5f9);background:var(--zc-bg-panel,#111827);}
      .rez-stand-cell.liber{background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.4);}
      .rez-stand-cell.partial{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.4);}
      .rez-stand-cell.ocupat{background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.3);color:var(--zc-text-muted,#64748b);cursor:not-allowed;}
      .rez-stand-cell.selectat{background:rgba(56,189,248,.18);border-color:#38bdf8;color:#0891b2;}
      .rez-btn{background:var(--zc-accent-dark,#0e7490);color:#fff;font-weight:700;font-size:14px;padding:10px 16px;border:none;border-radius:9px;cursor:pointer;width:100%;}
      .rez-btn:disabled{opacity:.5;cursor:not-allowed;}
      .rez-btn-secondary{background:transparent;border:1px solid var(--zc-border,#1e293b);color:var(--zc-text-secondary-2,#94a3b8);}
      .rez-btn-danger{background:#7f1d1d;color:#fecaca;}
      .rez-list-item{border:1px solid var(--zc-border,#1e293b);border-radius:10px;padding:10px 12px;margin-bottom:8px;font-size:13.5px;color:var(--zc-text-secondary-2,#cbd5e1);}
      .rez-blocare-label{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:var(--zc-text-secondary-2,#94a3b8);margin-bottom:10px;cursor:pointer;}
      .rez-text-small{font-size:12px;}
      /* Rundă 44 — butonul de anulare, din modalul de detaliu, a devenit
         „outline" (fundal transparent, doar contur+text roșu) în loc de
         roșu plin — cerere implicită a lui Marian („informația e
         împrăștiată, fără corelare/prioritizare"): „Nu s-a prezentat" (dă
         un avertisment real pescarului) rămâne roșu PLIN ('.rez-btn-danger',
         neatins) — cea mai gravă acțiune din modal; „Anulează" e mai
         frecventă/neutră (eliberează standul, fără penalizare), deci
         vizual secundară față de ea, deși tot semnalează o acțiune cu
         urmări. Lățimea/poziționarea (fostul 'margin:8px auto 0;width:70%')
         au fost mutate în '.rez-detail-actions .rez-btn' (mai jos) — cele
         2 butoane stau acum unul lângă altul, într-un rând de acțiuni
         dedicat, nu unul sub altul, pe toată lățimea. */
      .rez-btn-anuleaza-mic{background:transparent;border:1.5px solid #b91c1c;color:#b91c1c;}
      .rez-btn-anuleaza-mic:hover{background:rgba(185,28,28,.08);}
      /* Buton „Șterge" pe cardurile din Moderare (rundă 19) — înălțime
         redusă cu 30% față de un buton normal (padding vertical 6px→4px,
         font aliniat la 12.5px), ca să fie la fel de înalt ca pastila de
         telefon (.rez-tel-btn) de lângă el, cerere explicită a lui Marian. */
      .rez-btn-sterge-mic{width:auto;padding:4px 12px;font-size:12.5px;white-space:nowrap;}
      /* Sugestii de conturi Zoda la completarea numelui clientului în tab-ul
         „Adaugă manual" (rundă 20) — dropdown ancorat sub câmpul de nume. */
      .rez-autocomplete-list{position:absolute;left:0;right:0;top:100%;margin-top:2px;background:var(--zc-bg-panel,#111827);border:1.5px solid var(--zc-border,#1e293b);border-radius:8px;max-height:170px;overflow-y:auto;z-index:5;display:none;box-shadow:0 8px 20px rgba(0,0,0,.35);}
      .rez-autocomplete-item{padding:8px 10px;cursor:pointer;font-size:13px;color:var(--zc-text-primary,#f1f5f9);}
      .rez-autocomplete-item:hover{background:var(--zc-bg-tint,#0c3a4d);}
      .rez-autocomplete-item + .rez-autocomplete-item{border-top:1px solid var(--zc-border,#1e293b);}
      /* Modalul de detaliu al unei rezervări (renderCalendarDetail) — text
         mărit cu 12% + centrat, cerere explicită a lui Marian (rundă 18),
         ca totul să fie mai vizibil dintr-o privire. Scopat strict la acest
         modal (clasă adăugată doar acolo) — restul locurilor unde apar
         aceleași clase (.rez-badge, .rez-tel-btn etc., ex. tab-ul Cereri)
         rămân la mărimea implicită. */
      .rez-detail-mare{font-size:15.1px;text-align:center;}
      .rez-detail-mare .rez-badge{font-size:12.3px;}
      .rez-detail-mare .rez-tel-btn{font-size:14px;}
      .rez-detail-mare .rez-strike{font-size:12.9px;}
      .rez-detail-mare .rez-text-small{font-size:13.4px;}
      .rez-detail-mare .rez-field label{font-size:14px;}
      .rez-detail-mare .rez-field textarea{font-size:15.1px !important;text-align:left;}
      .rez-detail-mare .rez-blocare-label{font-size:14px;justify-content:center;}
      /* Rundă 44 — redesenul modalului de detaliu al rezervării (din Gantt),
         la cererea explicită a lui Marian: informația era „împrăștiată, fără
         corelare/prioritizare” — nume, dată, status, buton de anulare uriaș
         și roșu, apoi câmpurile de notă, toate cu aceeași greutate vizuală,
         fără nicio grupare. Restructurat pe 3 blocuri, în ordinea în care
         balta_admin are nevoie de informație: (1) CINE + CÂND — identitate
         și interval, cele mai importante, primele; (2) STARE — badge-ul de
         status ȘI confirmarea pescarului, pe ACELAȘI rând (sunt ambele
         despre „ce se știe despre rezervarea asta acum”, corelate, nu mai
         una sub alta ca informații separate) + acțiunile disponibile,
         imediat sub stare (efectul lor asupra stării); (3) NOTĂ & BLOCARE
         CLIENT — despărțit vizual printr-o linie + un antet de secțiune,
         pentru că e o acțiune diferită în esență (administrarea profilului
         clientului, nu a acestei rezervări anume) — nu mai amestecată direct
         sub butonul de anulare, ca înainte. */
      /* Rundă 46 — cerere explicită a lui Marian: pe mobil, intervalul
         "dată oră → dată oră" se rupea pe 2 rânduri urât — nu la săgeată
         (unde ar arăta curat), ci exact ÎNTRE dată și oră, pentru că fiecare
         '.rez-data-part'/'.rez-ora-part' (§39) e un '<span>' separat, cu un
         spațiu normal (punct de rupere valid) între ele. Fix: fiecare
         pereche dată+oră învelită într-un '<span>' propriu,
         '.rez-detail-perioada-parte', cu 'white-space:nowrap'.
         Rundă 48 → 49: încercare de „un singur rând, la orice lățime" (font
         redus la 9.5px) → abandonată, în favoarea lizibilității (font
         normal, rupere pe 2 rânduri — vezi istoricul complet la §70/§71).
         Rundă 50 — Marian a acceptat definitiv 2 rânduri („Hai sa lasam pe
         2 randuri”), dar a cerut 2 corecturi de aliniere: (1) data+ora de
         START și cele de SFÂRȘIT trebuie să stea EXACT una sub cealaltă,
         aliniate — cu 'flex-wrap' (rundă 49), cele 2 rânduri se centrau
         FIECARE separat (lățimi diferite: primul rând avea și blocul
         săgeată/durată alături, al doilea nu), deci începeau din puncte
         diferite, dezaliniate vizual; (2) un pic mai mult spațiu între
         blocul săgeată/durată și data de start (erau prea lipite).
         Rezolvare: renunțat la 'flex-wrap' — acum e mereu o structură FIXĂ,
         nu una care depinde de cât încape pe ecran: un rând ('flex', fără
         'wrap') cu 2 „coloane” — (a) '.rez-detail-perioada-date', o coloană
         proprie cu cele 2 perechi dată+oră, una sub cealaltă, aliniate
         (părinte comun, deci start la aceeași poziție orizontală ca
         sfârșitul); (b) '.rez-detail-perioada-sageata', blocul
         săgeată/durată, ca înainte — acum cu un 'gap' puțin mai mare între
         cele 2 coloane (14px, față de 6px înainte) — „doar puțin”, cf.
         cererii explicite, nu o distanță mare. */
      .rez-detail-perioada{margin:2px 0 8px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:14px;}
      .rez-detail-perioada-date{display:flex;flex-direction:column;align-items:center;gap:2px;}
      .rez-detail-perioada-parte{white-space:nowrap;}
      .rez-detail-perioada-sageata{display:flex;flex-direction:column;align-items:center;line-height:1.15;flex-shrink:0;}
      .rez-detail-durata{font-size:11px;font-weight:800;color:var(--zc-text-secondary-2,#94a3b8);text-transform:uppercase;letter-spacing:.3px;}
      .rez-detail-stare-row{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;}
      .rez-detail-stare-row .rez-badge{margin-left:0;}
      .rez-detail-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px;}
      /* Rundă 45 — cerere explicită a lui Marian: butonul de anulare (și,
         când apare, cel de neprezentare) erau prea „mari" comparativ cu
         informația de deasupra (badge/text mici) — lățime întinsă ('flex:1',
         până la 220px chiar și cu un singur buton), padding/font moștenite
         de la '.rez-btn' de bază (10px/14px). Acum butoanele din acest rând
         se dimensionează după conținut ('flex:0 1 auto', 'width:auto'), cu
         padding/font reduse — nu mai domină vizual restul modalului. */
      /* Rundă 46 — cerere explicită a lui Marian: butonul de anulare, tot
         "prea inalt" chiar și după reducerea de la rundă 45 — încă
         -30% pe verticală (padding vertical 7px → 5px; ~30% mai puțin). */
      .rez-detail-actions .rez-btn{width:auto;flex:0 1 auto;margin:0;padding:5px 16px;font-size:13px;}
      .rez-detail-divider{height:1px;background:var(--zc-border,#1e293b);margin:16px 0 10px;}
      /* Rundă 45 — butonul „Sună" de lângă câmpul editabil de telefon (din
         'randeazaIdentitateSiNotaPescar') — apelul rămâne la un singur tap,
         chiar dacă telefonul nu mai e un simplu link 'tel:' static (acum e
         un '<input>' editabil), folosind mereu valoarea CURENTĂ din câmp.
         Rundă 46 — padding orizontal redus (12px→10px), ca să lase ceva
         mai mult loc câmpului de telefon de lângă el (cf. mai jos, fix-ul
         principal fiind însă stivuirea pe mobil, nu micșorarea butonului). */
      .rez-call-btn{flex:0 0 auto;width:auto;background:var(--zc-bg-panel,#111827);border:1.5px solid var(--zc-border,#1e293b);border-radius:8px;padding:8px 10px;font-size:15px;cursor:pointer;color:var(--zc-text-primary,#f1f5f9);}
      /* Rundă 46 — rândul Nume+Telefon ('randeazaIdentitateSiNotaPescar'):
         implicit (mobil — '.rez-modal' ajunge la 'width:100%', cf.
         'max-width:520px'), Nume și Telefon stau unul SUB altul, fiecare
         pe toată lățimea disponibilă — spațiu din belșug pentru orice
         număr de telefon, indiferent de câte cifre, plus butonul de
         apelare. De la 480px în sus (telefon mare/tabletă/desktop — modalul
         are oricum destul spațiu orizontal), revin unul lângă altul. */
      .rez-ident-row{display:flex;flex-direction:column;gap:8px;margin-top:10px;margin-bottom:8px;}
      .rez-ident-row .rez-field{flex:1;min-width:0;}
      @media(min-width:480px){
        .rez-ident-row{flex-direction:row;flex-wrap:wrap;}
        .rez-ident-row .rez-field{min-width:120px;}
      }
      .rez-badge{display:inline-block;font-size:11px;font-weight:800;padding:2px 8px;border-radius:999px;margin-left:6px;}
      .rez-badge-in_asteptare{background:rgba(245,158,11,.15);color:#b45309;}
      .rez-badge-confirmata{background:rgba(56,189,248,.15);color:#0369a1;}
      .rez-badge-confirmata.verde{background:rgba(34,197,94,.15);color:#15803d;}
      .rez-badge-anulata,.rez-badge-respinsa,.rez-badge-expirata{background:rgba(148,163,184,.18);color:var(--zc-text-secondary,#94a3b8);}
      .rez-badge-neprezentat{background:rgba(239,68,68,.15);color:#dc2626;}
      /* Rundă 43 — „onorată" (rezervare aprobată, deja încheiată, nemarcată
         neprezentat) — nu e un status real din baza de date, doar o etichetă
         calculată pentru istoricul din „Bază clienți" (cf. 'statusIstoricBadge'),
         dar folosește aceeași nuanță de verde ca „aprobată + confirmată de
         pescar" ('.rez-badge-confirmata.verde'), ca vocabularul de culori să
         rămână unul singur în toată aplicația. */
      .rez-badge-onorata{background:rgba(34,197,94,.15);color:#15803d;}
      /* Dropdown-ul de istoric al unui client, în „Bază clienți" (rundă 43). */
      .rez-istoric-btn{background:transparent;border:1px solid var(--zc-border,#1e293b);color:var(--zc-accent-dark,#0e7490);font-size:12px;font-weight:700;padding:4px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;}
      .rez-istoric-list{margin-top:10px;padding-top:10px;border-top:1px dashed var(--zc-border,#1e293b);}
      .rez-istoric-item{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:5px 0;font-size:12.5px;}
      .rez-istoric-item + .rez-istoric-item{border-top:1px solid var(--zc-border,#1e293b);}
      .rez-istoric-data{font-weight:700;color:var(--zc-text-primary,#f1f5f9);min-width:74px;}
      .rez-istoric-durata{color:var(--zc-text-muted,#64748b);min-width:40px;}
      .rez-istoric-stand{color:var(--zc-text-secondary-2,#94a3b8);flex:1;min-width:60px;}
      .rez-istoric-empty{font-size:12.5px;color:var(--zc-text-muted,#64748b);padding:4px 0;}
      .rez-strike{color:#b45309;font-size:11.5px;font-weight:800;}
      .rez-tabs{display:flex;gap:6px;padding:0 18px;border-bottom:1px solid var(--zc-border,#1e293b);position:sticky;top:57px;background:var(--zc-bg,#0a0f1a);z-index:1;}
      /* Bara de tab-uri a panoului admin (Cereri/Calendar/Adaugă manual/
         Moderare/Program sezonier) — rundă 22: pe mobil, cu 'flex-wrap:wrap'
         de dinainte, tab-ul cel mai lung ("Program sezonier") sărea des
         singur pe rândul al doilea; izolat, fără vecini și fără vreun
         fundal/bordură propriu (doar text + o linie de subliniere pe cel
         activ), nu se mai citea deloc ca buton — arăta ca un simplu titlu.
         Fix: (1) tab-urile au acum fundal+bordură+colțuri rotunjite proprii
         — un „pill" — ca să se recunoască drept clickabile indiferent de
         context, izolate sau nu; (2) bara nu se mai rupe pe mai multe
         rânduri — derulează orizontal ('overflow-x:auto'), la fel ca
         Gantt-ul de mai jos, un gest deja familiar în acest panou. */
      .rez-tabs-page{display:flex;gap:8px;flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px;margin-bottom:16px;}
      .rez-tab{flex:0 0 auto;white-space:nowrap;background:var(--zc-bg-panel,#111827);border:1.5px solid var(--zc-border,#1e293b);color:var(--zc-text-secondary-2,#94a3b8);font-weight:700;font-size:13px;padding:9px 14px;cursor:pointer;border-radius:9px;}
      .rez-tab.active{color:#0891b2;background:rgba(56,189,248,.12);border-color:#38bdf8;}
      /* Rundă 36 — cerere explicită a lui Marian: pe desktop, tab-urile
         (Cereri/Calendar/Adaugă manual/Bază clienți/Program sezonier) mutate
         lateral — nu mai ocupă un rând întreg deasupra tabelului, ca să
         rămână mai multă înălțime verticală pentru grid-ul Gantt (scopul
         explicit: „sa vedem mai multe informatii in el”). Pe mobil rămân
         neschimbate, rând orizontal deasupra conținutului — o coloană
         verticală de butoane n-ar încăpea lizibil pe un ecran îngust.
         '.rez-admin-layout' înfășoară acum ambele — tab-urile ȘI
         '#rez-modal-body' — copii DIRECȚI, în această ordine în DOM (tab-uri
         primul, conținut al doilea). Implicit (mobil), 'flex-direction:column'
         păstrează exact ordinea vizuală de dinainte (tab-uri sus, conținut
         dedesubt).
         Rundă 38 — Marian a cerut mutarea lor din dreapta în STÂNGA
         tabelului („in spatiul asta gol, ca in dreapta acolo ia din
         latimea tabelului”): pe desktop, 'flex-direction:row' simplu (NU
         'row-reverse', ca la rundă 36) — ordinea vizuală urmează acum
         direct ordinea din DOM, deci primul copil ('.rez-tabs-page') ajunge
         primul vizual (stânga), iar al doilea ('#rez-modal-body') rămâne
         al doilea vizual (dreapta) — fără nicio schimbare de HTML, doar
         inversarea acestei singure proprietăți CSS.
         Rundă 39 — tot nu era suficient: Marian a arătat, cu o captură,
         că pe ecranul lui rămâne mult spațiu gol ADEVĂRAT — în afara
         coloanei centrate a paginii ('#dashboard', din rezervari-admin.html,
         'max-width:1100px;margin:0 auto') — pe care tab-urile din rundă 38
         tot nu-l foloseau, pentru că stăteau ÎN INTERIORUL acelei coloane,
         doar mutate la marginea ei stângă — deci tot „furau” din lățimea
         disponibilă tabelului. Cerința reală: tab-urile complet ÎN AFARA
         coloanei de 1100px, în marginea adevărat goală a ferestrei, ca
         tabelul să poată folosi coloana întreagă, de la un capăt la altul.
         Rezolvat cu un breakpoint suplimentar, generos (1500px — sub acest
         prag, marginea reală a ferestrei e prea îngustă ca să mai încapă un
         sidebar de 176px + un gol de aer, deci tab-urile rămân unde erau,
         cf. rundă 38, ÎN coloană): 'position:fixed', poziționat cu 'calc()'
         relativ la mijlocul FERESTREI (nu al coloanei) — jumătate din
         lățimea ferestrei, minus jumătate din lățimea coloanei (550px),
         minus un gol (16px), minus lățimea sidebar-ului (176px) — ca
         marginea lui dreaptă să cadă exact la 16px de marginea stângă a
         coloanei de conținut. Fiind 'fixed' (scos din flux), '#rez-modal-
         body' (singurul copil rămas în flux) se întinde automat pe toată
         lățimea coloanei — fără nicio altă schimbare de CSS necesară
         pentru el. 'max(12px, ...)' e doar o plasă de siguranță, ca
         sidebar-ul să nu ajungă niciodată în afara ecranului, în stânga,
         chiar la limita breakpoint-ului (bară de scroll, rotunjiri etc). */
      .rez-admin-layout{display:flex;flex-direction:column;}
      @media(min-width:769px){
        .rez-admin-layout{flex-direction:row;align-items:flex-start;gap:18px;}
        .rez-admin-layout > .rez-tabs-page{flex:0 0 176px;flex-direction:column;overflow-x:visible;margin-bottom:0;position:sticky;top:12px;}
        .rez-admin-layout > .rez-tabs-page > .rez-tab{width:100%;text-align:left;}
        .rez-admin-layout > #rez-modal-body{flex:1;min-width:0;}
      }
      @media(min-width:1500px){
        .rez-admin-layout > .rez-tabs-page{position:fixed;top:78px;left:max(12px, calc(50vw - 742px));width:176px;flex:none;}
      }
      .rez-empty{text-align:center;color:var(--zc-text-dim,#4b5563);font-size:13.5px;padding:20px 0;}
      #rez-stand-btn{margin-top:12px;width:100%;background:var(--zc-accent-dark,#0e7490);color:#fff;font-weight:700;font-size:17px;padding:15px;border:none;border-radius:10px;cursor:pointer;}
      /* Grila Gantt (Calendar) — rundă 22: rescrisă de la „un 'display:flex'
         per rând" la CSS Grid, cu TOATE celulele (eticheta fiecărui stand +
         track-ul lui, plus colțul și rândul de zile din antet) copii DIRECȚI
         ai '.rez-cal-scroll' (containerul cu 'overflow:auto'), nu înfășurate
         fiecare într-un '<div class="rez-cal-row">' intermediar ca înainte.
         Motiv: coloana de eticheta ('.rez-cal-label', 'position:sticky;
         left:0') nu rămânea deloc fixă la scroll orizontal pe mobil — se
         scrola liniar odată cu restul, exact ca și cum sticky nici n-ar fi
         fost aplicat. Cauza, confirmată izolat: 'position:sticky' cu
         'left'/'right' nu funcționează corect dacă elementul sticky are UN
         SINGUR PĂRINTE INTERMEDIAR între el și strămoșul care scrolează
         efectiv (aici, fostul '.rez-cal-row') — indiferent dacă acel părinte
         e flex, inline-block sau block simplu. Cu Grid, eticheta e copil
         direct al containerului care scrolează, deci sticky funcționează
         corect (verificat și izolat, într-o pagină minimală de test, și
         direct în Gantt, cu scroll real, în Playwright). Coloanele grilei
         (78px + lățimea track-ului, în px) se setează dinamic, inline, la
         randare ('renderTabCalendar'), pentru că depind de intervalul de
         zile afișat. */
      /* Rundă 31 — cerere explicită a lui Marian: liniile din grid-ul
         Gantt (Calendar) erau prea șterse pe modul light — foloseau
         'var(--zc-border, ...)', variabila de temă generică a paginii
         gazdă (balta.html/cont.html/rezervari-admin.html), care pe light
         e un gri foarte deschis, potrivit pentru borduri fine în restul
         interfeței, dar prea puțin vizibil pentru un grid dens de date.
         De-acum, liniile grid-ului NU mai depind de '--zc-border' — au
         culori proprii, fixe, alese special pentru acest grid: aproape
         negru ('#0f172a') pe light (regulile implicite, negardate, de mai
         jos), și un gri mediu-deschis ('#64748b'/'#94a3b8') pe dark (bloc
         separat, mai jos, cf. convenției de temă a fișierului — regulile
         negardate țintesc fundal DESCHIS, 'html:not([data-theme="light"])'
         suprascrie pentru fundal ÎNCHIS). */
      /* Rundă 38 — cerere explicită a lui Marian: linia DINTRE STANDURI
         (separatorul orizontal de rând — 'border-bottom' de mai jos, pe
         '.rez-cal-label' ȘI pe '.rez-cal-track') arăta „prea tabel de
         Excel” pe light, la aproape-negru ('#0f172a', cf. rundă 31, mai
         sus). Devine gri ('#94a3b8') — DOAR separatorul de rând; liniile
         verticale dintre zile/subcoloane (border-right pe '.rez-cal-label',
         gridline-urile din fundalul '.rez-cal-track') rămân aproape-negre,
         neschimbate — Marian a cerut explicit „linia dintre standuri”, nu
         toate liniile grid-ului. Pe dark, separatorul de rând era deja gri
         ('#64748b', cf. rundă 31) — nu mai are nevoie de nicio schimbare. */
      .rez-cal-scroll{display:grid;overflow:auto;max-height:60vh;border:1.5px solid #0f172a;border-radius:10px;-webkit-overflow-scrolling:touch;scrollbar-width:auto;scrollbar-color:#0891b2 var(--zc-bg-panel,#111827);}
      /* Rundă 40 — cerere explicită a lui Marian: bara de scroll orizontală
         (jos, pe grid) se ascundea — pe multe sisteme (mai ales macOS),
         scrollbar-ul implicit al browser-ului e „overlay”, subțire și
         invizibil până începi să dai scroll, ceea ce ascunde complet
         indiciul că mai sunt zile de văzut la dreapta. Definirea explicită
         a '::-webkit-scrollbar' de mai jos scoate Chrome/Edge/Safari din
         modul „overlay” și-l trece pe stilul „clasic” — desenat mereu, nu
         doar la hover/scroll (efect secundar cunoscut al acestei proprietăți
         — simpla ei prezență schimbă comportamentul, nu doar aspectul).
         'scrollbar-width:auto' (nu 'thin', nu 'none') + 'scrollbar-color'
         de mai sus fac același lucru pentru Firefox. */
      .rez-cal-scroll::-webkit-scrollbar{height:14px;width:14px;}
      .rez-cal-scroll::-webkit-scrollbar-track{background:var(--zc-bg-panel,#111827);}
      .rez-cal-scroll::-webkit-scrollbar-thumb{background:#0891b2;border-radius:7px;border:3px solid var(--zc-bg-panel,#111827);}
      .rez-cal-scroll::-webkit-scrollbar-thumb:hover{background:#0e7490;}
      .rez-cal-label{width:78px;box-sizing:border-box;padding:8px 6px;font-size:12.9px;font-weight:700;color:var(--zc-text-secondary-2,#cbd5e1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:sticky;left:0;background:var(--zc-bg,#0a0f1a);border-right:2px solid #0f172a;border-bottom:2px solid #94a3b8;display:flex;align-items:center;z-index:2;}
      /* Rândul de antet (colț + zile) — sticky pe verticală (rămâne vizibil
         la scroll în jos), fundal opac ca să acopere rândurile care trec pe
         sub el. Colțul ('.rez-cal-corner', care combină și clasa
         '.rez-cal-label') trebuie să fie sticky pe AMBELE axe și cu z-index
         cel mai mare — e „intersecția" celor două benzi fixe. */
      .rez-cal-header-cell{position:sticky;top:0;z-index:3;background:var(--zc-bg,#0a0f1a);background-image:none;}
      .rez-cal-corner{z-index:4;}
      /* Rundă 30 — bug real, prins acum la cererea lui Marian de a bloca
         antetul la scroll vertical: rândul de zile ('.rez-cal-daynums',
         care are și clasa '.rez-cal-header-cell' de mai sus) NU rămânea de
         fapt fixat la scroll în jos, deși regula de mai sus îi punea deja
         'position:sticky'. Motiv: elementul are și clasa '.rez-cal-track'
         (mai jos), a cărei regulă declară 'position:relative' — aceeași
         specificitate CSS (o singură clasă) ca '.rez-cal-header-cell', dar
         declarată MAI JOS în foaia de stil, deci câștigă cascada și
         suprascrie 'sticky' cu 'relative'. Regula de mai jos, cu 2 clase
         combinate, are specificitate mai mare și câștigă indiferent de
         ordinea din fișier — nu mai depinde de a nu muta regulile una
         față de alta pe viitor. */
      .rez-cal-daynums.rez-cal-header-cell{position:sticky;top:0;}
      /* Rundă 29 — cerere explicită a lui Marian: grila mai vizibilă, cu
         fiecare zi împărțită în 2 subcoloane egale — Zi (ora_zi_start,
         implicit 06:00, până la ora_zi_start+12h) și Noapte (restul de 12h,
         până la Zi a zilei următoare). O rezervare de tip '12h' umple exact
         subcoloana Zi; una de '24h' (pornește la ora_noapte_start, durează
         24h reale) umple exact Noapte + Zi a zilei următoare (12h+12h=24h) —
         'extinsă până în ziua următoare, cum e și acum', exact cum a cerut.
         Poziționarea rămâne strict pe bază de oră reală (offsetPx, mai jos,
         calculat din ora_zi_start a bălții) — nu snap la subcoloană — deci o
         rezervare 'personalizat', cu ore oarecare, se așază proporțional,
         posibil nealiniată perfect la subcoloane, exact ca înainte.
         Simplificare asumată: subcoloanele desenate aici folosesc DOAR
         ora_zi_start a bălții (nu și eventualele reguli sezoniere care pot
         suprascrie orele pe interval de date, §34) — un compromis conștient,
         ca headerul să nu recalculeze reguli pentru fiecare zi afișată. */
      /* Rundă 30 — cerere explicită a lui Marian: grila mai vizibilă, cu
         liniile dintre zile ȘI cele dintre standuri mai groase (2px, față
         de 1/1.5px înainte pe toate). Linia dintre subcoloanele Zi/Noapte
         (mai puțin importantă vizual, e doar o jumătate de zi) rămâne mai
         subțire ca să nu concureze cu linia dintre zile întregi. */
      .rez-cal-track{position:relative;height:34px;border-bottom:2px solid #94a3b8;background-image:repeating-linear-gradient(to right, transparent 0, transparent 83px, rgba(15,23,42,.4) 83px, rgba(15,23,42,.4) 85px, transparent 85px, transparent 168px, #0f172a 168px, #0f172a 170px);}
      .rez-cal-scroll > *:nth-last-child(-n+2){border-bottom:none;}
      /* '.rez-cal-daynums' e declarată DUPĂ '.rez-cal-track' intenționat —
         suprascrie explicit fundalul-linii repetitiv de mai sus (are deja
         propriile celule cu 'border-right', cf. '.rez-cal-daycell'; ordinea
         contează, ambele reguli au aceeași specificitate). */
      .rez-cal-daynums{height:auto;display:flex;background-image:none;}
      .rez-cal-daycell{flex:0 0 auto;box-sizing:border-box;text-align:center;font-size:11.8px;color:var(--zc-text-muted,#64748b);border-right:2px solid #0f172a;padding:4px 0 0;}
      .rez-cal-daycell.weekend{background:rgba(148,163,184,.1);}
      .rez-cal-daycell.azi{color:#0891b2;font-weight:800;}
      /* Rundă 30: luna nu mai e pe rândul ei propriu (deasupra numărului
         zilei) — devine un prefix, pe ACELAȘI rând, doar la zilele unde
         apare ('.rez-cal-datanum', un singur 'div', cu 'luna' ca 'span'
         inline în interior). Înainte, ziua cu lună (începutul unei luni)
         avea un rând în plus față de restul zilelor, deci antetul „sărea"
         vizual în înălțime de la o zi la alta — exact ce a semnalat Marian. */
      .rez-cal-datanum{white-space:nowrap;}
      .rez-cal-luna{font-size:10.1px;color:var(--zc-text-muted,#475569);text-transform:uppercase;font-weight:700;}
      /* Sub-rândul cu cele 2 subcoloane, Zi/Noapte, sub numărul zilei. */
      .rez-cal-subrow{display:flex;margin-top:3px;border-top:1px solid rgba(15,23,42,.35);}
      .rez-cal-subcell{flex:1;font-size:9.3px;font-weight:800;color:var(--zc-text-dim,#4b5563);padding:2px 0;text-transform:uppercase;letter-spacing:.03em;}
      .rez-cal-subcell.noapte{border-left:1px solid rgba(15,23,42,.35);}
      /* Rundă 37 — cerere explicită a lui Marian: linia verticală albastră
         care marca „acum" pe grid a fost eliminată („mai mult încarcă decât
         ajută") — regula '.rez-cal-today-line' de aici a fost scoasă odată
         cu markup-ul ei din JS; ziua curentă rămâne totuși vizibil marcată
         prin eticheta 'azi' din antet (text bold, culoare de accent). */
      .rez-cal-bar{position:absolute;top:6px;height:22px;border-radius:6px;cursor:pointer;box-sizing:border-box;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:0 2px;}
      /* Rundă 38 — cerere explicită a lui Marian: „Rezervarile sa le facem
         cu verde plin, iar rezervarea sa treaca peste liniile tabelului, sa
         nu se ascunda in spatele lor ca sunt greu de observat”. Bara era pe
         culori translucide ('rgba(...,.4)') — la 40% opacitate, gridline-
         urile din fundalul '.rez-cal-track' (rundă 30/31, acum destul de
         pronunțate) se vedeau PRIN bară, dând senzația că rezervarea „se
         ascunde” în grid, în loc să iasă clar în evidență deasupra lui.
         Fundal SOLID (opac), nu translucid — gridline-urile nu mai pot
         străbate prin bară, indiferent cât de pronunțate sunt dedesubt.
         Decizie de scopare, asumată explicit: „verde plin” s-a aplicat la
         'confirmata' ȘI 'confirmata.verde' (aprobată + confirmată de
         pescar, ambele stări „bune”) — nuanța dintre ele (fostul albastru
         vs. verde, cf. rundă 16/§38) rămâne DOAR pe eticheta de status din
         modalul de detaliu/„Rezervările mele” ('.rez-badge-confirmata',
         neatinsă), nu mai apare pe bara din grid, unde conta mai puțin
         decât lizibilitatea la o privire rapidă. 'neprezentat' (roșu)
         NESCHIMBAT ca nuanță — doar făcut la fel de opac, din același
         motiv (nu se cere explicit verde pentru el, și rămâne un semnal
         important, diferit, de neprezentare). */
      .rez-cal-bar.confirmata{background:#22c55e;border:1.5px solid #16a34a;}
      .rez-cal-bar.confirmata.verde{background:#22c55e;border-color:#16a34a;}
      .rez-cal-bar.neprezentat{background:#ef4444;border:1.5px solid #dc2626;}
      .rez-cal-bar.selectat{outline:2px solid #0891b2;outline-offset:1px;}
      .rez-cal-bar-dur{font-size:10.1px;font-weight:800;color:#0f172a;white-space:nowrap;pointer-events:none;line-height:1;text-shadow:0 0 3px rgba(255,255,255,.5);}
      /* Nume + telefon în interiorul barei — DOAR pe desktop (rundă 29, cerere
         explicită: pe mobil rămân informațiile din modalul de detaliu deja
         existent, neschimbat). Sub 769px, '.rez-cal-bar-info' rămâne ascunsă
         și '.rez-cal-bar-dur' (durata) rămâne singurul conținut al barei,
         exact comportamentul de dinainte de această rundă. */
      .rez-cal-bar-info{display:none;}
      @media(min-width:769px){
        .rez-cal-track{height:52px;}
        .rez-cal-bar{height:42px;top:5px;}
        .rez-cal-bar-dur{display:none;}
        .rez-cal-bar-info{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;line-height:1.22;overflow:hidden;pointer-events:none;}
        .rez-cal-bar-nume{font-size:11px;font-weight:800;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;text-shadow:0 0 3px rgba(255,255,255,.5);}
        .rez-cal-bar-tel{font-size:9.8px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;opacity:.85;text-shadow:0 0 3px rgba(255,255,255,.5);}
        /* Rundă 36 — cu tab-urile mutate lateral (mai sus), rândul orizontal
           de tab-uri nu mai „mănâncă” înălțime deasupra tabelului — profităm
           de spațiul eliberat ca grid-ul să arate efectiv mai multe rânduri
           deodată, exact cerința lui Marian („sa vedem mai multe informatii
           in el”). 'calc()', nu un procent fix din viewport — scade din
           înălțimea ferestrei chenarele fixe de deasupra tabelului (antetul
           paginii + padding-ul dashboard-ului + selectorul de baltă +
           legenda de culori), estimate generos, ca tabelul să nu ajungă sub
           marginea de jos a ecranului pe ferestre mai scunde. Selector cu 2
           clase ('.rez-admin-layout .rez-cal-scroll'), NU doar
           '.rez-cal-scroll' — specificitate mai mare decât regula de bază
           (o singură clasă, mai sus), câștigă indiferent de ordinea din
           fișier — exact bug-ul de sticky din rundă 30 (§52), evitat din
           start de data asta. */
        .rez-admin-layout .rez-cal-scroll{max-height:calc(100vh - 230px);}
      }
      /* ── Variante DARK — culorile de mai sus (badge-uri, telefon, tab activ,
         ziua curentă din calendar, durata de pe bară) sunt alese să fie
         lizibile pe fundal DESCHIS (mai saturate/închise la culoare, cf.
         §29 pct. 4); pe fundal ÎNCHIS aceleași nuanțe sunt prea închise ca să
         mai contrasteze bine, deci le înlocuim aici cu variantele deschise
         folosite dintotdeauna de modul, active când tema efectivă NU e
         'light' (adică atributul data-theme lipsește sau e explicit 'dark'). */
      html:not([data-theme="light"]) .rez-tel-btn{color:#38bdf8;}
      html:not([data-theme="light"]) .rez-stand-cell.selectat{color:#38bdf8;}
      html:not([data-theme="light"]) .rez-badge-in_asteptare{color:#f59e0b;}
      html:not([data-theme="light"]) .rez-badge-confirmata{color:#38bdf8;}
      html:not([data-theme="light"]) .rez-badge-confirmata.verde{color:#22c55e;}
      html:not([data-theme="light"]) .rez-badge-neprezentat{color:#ef4444;}
      html:not([data-theme="light"]) .rez-btn-anuleaza-mic{border-color:#f87171;color:#f87171;}
      html:not([data-theme="light"]) .rez-btn-anuleaza-mic:hover{background:rgba(248,113,113,.12);}
      html:not([data-theme="light"]) .rez-detail-divider{background:#334155;}
      html:not([data-theme="light"]) .rez-badge-onorata{color:#22c55e;}
      html:not([data-theme="light"]) .rez-istoric-btn{color:#38bdf8;}
      html:not([data-theme="light"]) .rez-strike{color:#f59e0b;}
      html:not([data-theme="light"]) .rez-tab.active{color:#38bdf8;}
      html:not([data-theme="light"]) .rez-cal-daycell.azi{color:#38bdf8;}
      /* Rundă 31 — liniile grid-ului (aproape negre pe light, mai sus) au
         nevoie de o culoare separată pe dark — negrul aproape s-ar pierde
         complet pe un fundal deja foarte închis. Gri mediu-deschis
         ('#64748b'/'#94a3b8'), suficient de vizibil pe '--zc-bg' dark, fără
         să fie la fel de strident ca albastrul de accent (#38bdf8), care
         rămâne rezervat pentru elemente interactive/de focalizare (linia
         de "azi", selecția etc.), nu pentru linii de grid statice. */
      html:not([data-theme="light"]) .rez-cal-scroll{border-color:#64748b;}
      html:not([data-theme="light"]) .rez-cal-label{border-right-color:#64748b;border-bottom-color:#64748b;}
      html:not([data-theme="light"]) .rez-cal-track{border-bottom-color:#64748b;background-image:repeating-linear-gradient(to right, transparent 0, transparent 83px, rgba(148,163,184,.45) 83px, rgba(148,163,184,.45) 85px, transparent 85px, transparent 168px, #64748b 168px, #64748b 170px);}
      /* Declarată DUPĂ regula de mai sus, intenționat (aceeași
         specificitate — cea combinată cu '.rez-cal-track' de mai sus — deci
         ordinea contează): trebuie să suprascrie din nou fundalul repetitiv
         pentru rândul de antet, la fel cum face deja '.rez-cal-daycell'
         (mai jos) pentru light, cf. notei de mai sus din fișier — altfel
         rândul de zile ar arăta din nou liniile de fundal pe sub etichetele
         Zi/Noapte, pe modul dark. */
      html:not([data-theme="light"]) .rez-cal-daynums{background-image:none;}
      html:not([data-theme="light"]) .rez-cal-daycell{border-right-color:#64748b;}
      html:not([data-theme="light"]) .rez-cal-subrow{border-top-color:rgba(148,163,184,.4);}
      html:not([data-theme="light"]) .rez-cal-subcell.noapte{border-left-color:rgba(148,163,184,.4);}
      html:not([data-theme="light"]) .rez-cal-bar.selectat{outline-color:#38bdf8;}
      html:not([data-theme="light"]) .rez-cal-bar-dur{color:#f1f5f9;text-shadow:none;}
      html:not([data-theme="light"]) .rez-cal-bar-nume{color:#f1f5f9;text-shadow:none;}
      html:not([data-theme="light"]) .rez-cal-bar-tel{color:#f1f5f9;text-shadow:none;}
      html:not([data-theme="light"]) .rez-toast{border-color:#38bdf8;}
      html:not([data-theme="light"]) .rez-toast.err{color:#fca5a5;}
      html:not([data-theme="light"]) .rez-text-ok{color:#22c55e;}
      html:not([data-theme="light"]) .rez-text-warn{color:#f59e0b;}
      html:not([data-theme="light"]) .rez-ora-part{color:#22c55e;}
    `;
    var style = document.createElement('style');
    style.id = 'rez-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Blochează scroll-ul paginii din spate cât timp modalul e deschis — pe
  // mobil, fără asta, gestul de scroll pe conținutul modalului "scapă" des pe
  // pagina de dedesubt. Salvăm valorile anterioare (nu le resetăm orbește la
  // '') ca să nu deblocăm din greșeală pagina dacă modalul de rezervare a
  // fost deschis peste overlay-ul unui stand, care își pune singur propriul
  // lock — la închidere, restaurăm exact ce era înainte, nu neapărat scroll
  // liber. Blocăm ATÂT `<html>` cât și `<body>` (rundă 21) — pe `balta.html`,
  // fără o înălțime fixată explicit pe niciunul dintre ele, elementul care
  // scrolează efectiv e `document.documentElement` (`<html>`), nu `<body>`;
  // blocând doar `body.style.overflow`, ca înainte, pagina tot scrola pe sub
  // modal. Exact pattern-ul deja folosit de `#stand-overlay`-ul nativ din
  // `balta.html` (care blochează ambele, de la introducere), acum aliniat.
  var _rezScrollLockActiv = false;
  var _rezScrollLockPrevBody = '';
  var _rezScrollLockPrevHtml = '';

  // `bodyId` e opțional (implicit 'rez-modal-body') — folosit doar când acest
  // modal se deschide PESTE o pagină care are deja un element cu acel id (ex.
  // panoul de rezervări din rezervari-admin.html, care ține conținutul
  // tab-urilor tocmai în `#rez-modal-body`) — ca să nu apară două elemente cu
  // același id în document. Vezi `renderCalendarDetail()`, care deschide
  // detaliul unei rezervări ca modal peste Gantt, cu `bodyId` distinct.
  // `headerExtra` (opțional, rundă 23) — HTML pentru o acțiune principală
  // afișată în header, lângă ✕ (ex. butonul „Trimite" al modalului de
  // rezervare al pescarului — vezi `deschideModalRezervare`) — mereu
  // vizibilă, fără scroll, spre deosebire de un buton pus la finalul unui
  // formular lung. Opțională: modalele care n-o folosesc rămân neschimbate.
  function deschideModalGeneric(titlu, bodyHtml, tabsHtml, bodyId, headerExtra) {
    injectStylesOnce();
    bodyId = bodyId || 'rez-modal-body';
    var backdrop = document.createElement('div');
    backdrop.className = 'rez-modal-backdrop';
    backdrop.id = 'rez-modal-backdrop';
    backdrop.innerHTML =
      '<div class="rez-modal">' +
        '<div class="rez-modal-hdr"><h3>' + escH(titlu) + '</h3><div class="rez-modal-hdr-actions">' + (headerExtra || '') + '<button class="rez-modal-close" onclick="RezervariUI._closeModal()">✕</button></div></div>' +
        (tabsHtml || '') +
        '<div class="rez-modal-body" id="' + bodyId + '">' + bodyHtml + '</div>' +
      '</div>';
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });
    if (!_rezScrollLockActiv) {
      _rezScrollLockActiv = true;
      _rezScrollLockPrevBody = document.body.style.overflow;
      _rezScrollLockPrevHtml = document.documentElement.style.overflow;
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    }
    return backdrop;
  }

  function closeModal() {
    var el = document.getElementById('rez-modal-backdrop');
    if (el) el.remove();
    if (_rezScrollLockActiv) {
      document.body.style.overflow = _rezScrollLockPrevBody;
      document.documentElement.style.overflow = _rezScrollLockPrevHtml;
      _rezScrollLockActiv = false;
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

    deschideModalGeneric('Rezervă stand', '<div class="rez-empty">Se încarcă...</div>', null, null,
      '<button class="rez-btn rez-btn-header" id="rez-submit-btn" disabled>Trimite</button>');

    var numeUser = '';
    var standuri = [];
    var reguli = [];
    try {
      var profRes = await sb.from('user_profiles').select('username').eq('id', uid).single();
      numeUser = (profRes && profRes.data && profRes.data.username) || '';
      var standRes = await sb.from('standuri').select('id, nume').eq('balta_id', balta.id).order('sort_order', { ascending: true, nullsFirst: false }).order('id');
      standuri = standRes.data || [];
      // Regulile sezoniere (§29 pct. 7) — public, fără autentificare, la fel
      // ca disponibilitatea; eșecul acestui apel nu blochează restul
      // modalului, doar renunță la orice suprascriere sezonieră.
      try {
        var reguliRes = await sb.rpc('citeste_reguli_program_balta', { p_balta_id: balta.id });
        if (!reguliRes.error) reguli = reguliRes.data || [];
      } catch (e2) { /* fără reguli — folosim orele de bază ale bălții */ }
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
      '<div id="rez-avert-tip"></div>' +
      '<div id="rez-date-fields"></div>' +
      '<div class="rez-field"><label>Stand</label>' +
        '<div class="rez-legend"><span><i class="rez-dot liber"></i>Liber</span><span><i class="rez-dot partial"></i>Parțial (tot disponibil)</span><span><i class="rez-dot ocupat"></i>Ocupat</span><span><i class="rez-dot selectat"></i>Selectat</span></div>' +
        '<div class="rez-stand-grid" id="rez-stand-grid"></div>' +
      '</div>' +
      // Butonul de trimitere (`#rez-submit-btn`) NU mai e aici — a fost mutat
      // în header-ul modalului (rundă 23), cf. `deschideModalGeneric` mai
      // sus, ca să rămână vizibil fără scroll pe formulare lungi.
      '<div style="font-size:11.5px;color:var(--zc-text-dim,#4b5563);margin-top:8px;text-align:center;">Rezervările online sunt posibile doar cu minimum 16h înainte. Balta trebuie să aprobe cererea.</div>';

    setModalBody(body);

    function calculeazaInterval() {
      var dataStartInput = document.getElementById('rez-data-start');
      if (!dataStartInput || !dataStartInput.value) return null;
      if (tipCurent === 'personalizat') {
        var dataSfarsitInput = document.getElementById('rez-data-sfarsit');
        var momStart = document.getElementById('rez-mom-start').value;
        var momSfarsit = document.getElementById('rez-mom-sfarsit').value;
        return calculeazaIntervalSesiune(balta, tipCurent, dataStartInput.value, dataSfarsitInput ? dataSfarsitInput.value : null, momStart, momSfarsit, reguli);
      }
      return calculeazaIntervalSesiune(balta, tipCurent, dataStartInput.value, null, null, null, reguli);
    }

    function actualizeazaAvertizare() {
      var dataStartInput = document.getElementById('rez-data-start');
      var avertEl = document.getElementById('rez-avert-tip');
      if (!avertEl) return;
      var motiv = dataStartInput ? motivIndisponibilSesiune(balta, tipCurent, dataStartInput.value, reguli) : null;
      avertEl.innerHTML = motiv ? '<div class="rez-text-warn" style="font-size:12.5px;margin:-6px 0 12px;">⚠️ ' + escH(motiv) + '</div>' : '';
    }

    function renderDateFields() {
      var html = '';
      if (tipCurent === 'personalizat') {
        html =
          '<div class="rez-field"><label>Din data</label><input type="date" lang="ro" id="rez-data-start" min="' + minDateStr + '" value="' + minDateStr + '"></div>' +
          '<div class="rez-field"><label>Moment început</label><select id="rez-mom-start"><option value="zi">Dimineață (' + escH((balta.ora_zi_start || '06:00').slice(0, 5)) + ')</option><option value="noapte">Seară (' + escH((balta.ora_noapte_start || '18:00').slice(0, 5)) + ')</option></select></div>' +
          '<div class="rez-field"><label>Până în data</label><input type="date" lang="ro" id="rez-data-sfarsit" min="' + minDateStr + '" value="' + minDateStr + '"></div>' +
          '<div class="rez-field"><label>Moment sfârșit</label><select id="rez-mom-sfarsit"><option value="zi">Dimineață (' + escH((balta.ora_zi_start || '06:00').slice(0, 5)) + ')</option><option value="noapte" selected>Seară (' + escH((balta.ora_noapte_start || '18:00').slice(0, 5)) + ')</option></select></div>';
      } else {
        html = '<div class="rez-field"><label>Data rezervării</label><input type="date" lang="ro" id="rez-data-start" min="' + minDateStr + '" value="' + minDateStr + '"></div>';
      }
      document.getElementById('rez-date-fields').innerHTML = html;
      ['rez-data-start', 'rez-data-sfarsit', 'rez-mom-start', 'rez-mom-sfarsit'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.onchange = function () { actualizeazaAvertizare(); actualizeazaGrid(); };
      });
      actualizeazaAvertizare();
    }

    var _dispToken = 0;
    async function actualizeazaGrid() {
      var grid = document.getElementById('rez-stand-grid');
      if (!grid) return;
      var interval = calculeazaInterval();
      updateSubmitState();
      if (!interval) {
        var dataStartInput2 = document.getElementById('rez-data-start');
        var motivBlocaj = dataStartInput2 ? motivIndisponibilSesiune(balta, tipCurent, dataStartInput2.value, reguli) : null;
        grid.innerHTML = '<div class="rez-empty" style="padding:10px 0;">' + (motivBlocaj ? escH(motivBlocaj) : 'Alege o dată validă pentru a vedea disponibilitatea standurilor.') + '</div>';
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
        btnEl.textContent = 'Trimite';
        actualizeazaGrid();
      }
    };
  }

  // ── 3. "Rezervările mele" (pescar, cont.html) ───────────────────────────────
  // `deschideModalRezervarileMele()` deschide modalul (creează backdrop-ul,
  // o singură dată) — restul e delegat lui `incarcaRezervarileMele()`, care
  // doar reumple `#rez-modal-body`-ul deja existent. Separarea asta e
  // intenționată: `confirmaPrezenta`/`anuleazaMea` de mai jos trebuiau doar
  // să RE-ÎNCARCE lista în modalul deja deschis, dar apelau înainte
  // `deschideModalRezervarileMele()` direct — care crea un al DOILEA
  // `#rez-modal-backdrop` (id duplicat!) peste primul, încă deschis.
  // `setModalBody()`/`closeModal()` folosesc `getElementById`, care
  // întoarce mereu PRIMUL element cu acel id din DOM — deci actualizau
  // (sau închideau) modalul vechi, invizibil, dedesubt, în timp ce cel nou,
  // vizibil deasupra, rămânea blocat pe „Se încarcă..." la nesfârșit —
  // exact bug-ul semnalat de Marian (2026-08-28, rundă 15).
  async function deschideModalRezervarileMele() {
    deschideModalGeneric('Rezervările mele', '<div class="rez-empty">Se încarcă...</div>');
    await incarcaRezervarileMele();
  }

  async function incarcaRezervarileMele() {
    setModalBody('<div class="rez-empty">Se încarcă...</div>');
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
      '<div style="font-weight:700;color:var(--zc-text-primary,#f1f5f9);">' + escH(r.balta_nume) + ' — ' + escH(r.stand_nume) + '<span class="rez-badge rez-badge-' + r.status + (r.status === 'confirmata' ? claseNivelIncredere(r) : '') + '">' + escH(statusLabel(r.status)) + '</span></div>' +
      '<div style="margin:4px 0;">' + fmtDataOra(r.data_start) + ' → ' + fmtDataOra(r.data_sfarsit) + '</div>' +
      (r.motiv_anulare ? '<div class="rez-text-warn">Motiv: ' + escH(r.motiv_anulare) + '</div>' : '') +
      (r.confirmat_24h_la ? '<div class="rez-text-ok">✓ Prezență confirmată</div>' : '') +
      (arataConfirma ? '<button class="rez-btn" id="rez-confirma-' + r.id + '" style="margin-top:8px;">✓ Confirm că vin</button>' : '') +
      (arataAnuleaza ? '<button class="rez-btn rez-btn-danger" id="rez-anuleaza-' + r.id + '" style="margin-top:8px;">Anulează</button>' : '') +
      '</div>';
  }

  async function confirmaPrezenta(id) {
    try {
      var res = await sb.rpc('confirma_prezenta_24h', { p_rezervare_id: id });
      if (res.error) throw res.error;
      toast('✓ Prezență confirmată!');
      incarcaRezervarileMele();
    } catch (e) { toast(e.message || 'Eroare.', true); }
  }

  async function anuleazaMea(id) {
    if (!confirm('Sigur anulezi această rezervare?')) return;
    try {
      var res = await sb.rpc('anuleaza_rezervare_pescar', { p_rezervare_id: id });
      if (res.error) throw res.error;
      toast('Rezervare anulată.');
      incarcaRezervarileMele();
    } catch (e) { toast(e.message || 'Eroare.', true); }
  }

  // ── 4. Panoul balta_admin ────────────────────────────────────────────────
  // De la rundă 7 (2026-08-28), panoul nu mai e un modal deschis din cont.html
  // — e randat direct într-un container dintr-o pagină dedicată,
  // `rezervari-admin.html` (motivul: mai mult spațiu pe ecran, esențial mai
  // ales pentru cronologia Gantt din tab-ul Calendar, care avea nevoie de
  // scroll orizontal excesiv într-un modal de 520px). Restul funcțiilor de
  // mai jos (renderTabCereri/renderTabCalendar/renderTabManual etc.) rămân
  // neschimbate — știau deja să scrie doar în `#rez-modal-body`/`.rez-tab`,
  // indiferent dacă părintele e un modal sau un container simplu de pagină.
  var _adminBaltaId = null;
  var _adminBaltaNume = null;
  var _adminBalta = null; // rândul complet din `balti` (ore de ancoră etc.) — cf. §29 pct. 6/7
  var _adminReguli = []; // reguli sezoniere active (§29 pct. 7)
  var _adminTabCurent = 'cereri';
  var _adminStanduri = [];
  var _adminMultiplu = false;

  async function randeazaPanouAdmin(baltaId, baltaNume, containerEl) {
    injectStylesOnce();
    // Oprim orice refresh automat rămas de la o randare anterioară a
    // panoului (ex. schimbare de baltă) — altfel, la fiecare apel al
    // acestei funcții, s-ar mai porni un `setInterval` peste cel vechi,
    // fără să-l oprească, și ar rămâne mai multe active simultan.
    opresteRefreshAutomatCereri();
    _adminBaltaId = baltaId; _adminBaltaNume = baltaNume; _adminTabCurent = 'cereri'; _adminMultiplu = false;

    // Rundă 36 — '.rez-admin-layout' înfășoară tab-urile + conținutul, ca
    // să poată fi rearanjate din CSS (rând, pe mobil; lateral, pe desktop) —
    // vezi nota din CSS, de lângă '.rez-admin-layout'.
    containerEl.innerHTML = '<div class="rez-admin-layout"><div class="rez-tabs-page">' +
      '<button class="rez-tab active" data-tab="cereri" onclick="RezervariUI._schimbaTabAdmin(\'cereri\')">Cereri</button>' +
      '<button class="rez-tab" data-tab="calendar" onclick="RezervariUI._schimbaTabAdmin(\'calendar\')">Calendar</button>' +
      '<button class="rez-tab" data-tab="manual" onclick="RezervariUI._schimbaTabAdmin(\'manual\')">Adaugă manual</button>' +
      '<button class="rez-tab" data-tab="moderare" onclick="RezervariUI._schimbaTabAdmin(\'moderare\')">Bază clienți</button>' +
      '<button class="rez-tab" data-tab="program" onclick="RezervariUI._schimbaTabAdmin(\'program\')">Program</button>' +
      '</div>' +
      '<div id="rez-modal-body"><div class="rez-empty">Se încarcă...</div></div></div>';

    var standRes = await sb.from('standuri').select('id, nume').eq('balta_id', baltaId).order('sort_order', { ascending: true, nullsFirst: false }).order('id');
    _adminStanduri = standRes.data || [];

    var baltaRes = await sb.from('balti').select('id, ora_zi_start, ora_zi_stop, ora_noapte_start').eq('id', baltaId).single();
    _adminBalta = baltaRes.data || { ora_zi_start: '06:00', ora_zi_stop: '18:00', ora_noapte_start: '18:00' };

    try {
      var reguliRes = await sb.rpc('citeste_reguli_program_balta', { p_balta_id: baltaId });
      _adminReguli = reguliRes.error ? [] : (reguliRes.data || []);
    } catch (e) { _adminReguli = []; }

    renderTabAdminCurent();
  }

  function schimbaTabAdmin(tab) {
    // La ieșirea din „Cereri" (spre orice alt tab), oprim refresh-ul automat
    // — n-are rost să continue să bată RPC-ul din fundal cât timp
    // balta_admin se uită în altă parte; `renderTabCereri()` îl repornește
    // oricum, dacă revine.
    if (tab !== 'cereri') opresteRefreshAutomatCereri();
    _adminTabCurent = tab;
    document.querySelectorAll('.rez-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tab); });
    renderTabAdminCurent();
  }

  async function renderTabAdminCurent() {
    if (_adminTabCurent === 'cereri') return renderTabCereri();
    if (_adminTabCurent === 'calendar') return renderTabCalendar();
    if (_adminTabCurent === 'manual') return renderTabManual();
    if (_adminTabCurent === 'moderare') return renderTabModerare();
    if (_adminTabCurent === 'program') return renderTabProgram();
  }

  async function fetchRezervariBalta() {
    var res = await sb.rpc('listeaza_rezervari_balta', { p_balta_id: _adminBaltaId });
    if (res.error) throw res.error;
    return res.data || [];
  }

  // Identitatea implicită a unui pescar dintr-o rezervare — username-ul de
  // cont (dacă are cont), altfel numele/„Client telefonic" din rezervare.
  // Notă (rundă 19): asta rămâne identitatea afișată în Cereri/Calendar —
  // deliberat NEschimbată de un nume custom din „Moderare" (vezi §41), ca să
  // nu amestecăm două surse de adevăr pentru numele dintr-o rezervare
  // existentă; numele custom se vede în „Moderare" și în blocul de notă.
  function numeImplicitPescar(r) {
    return r.user_id ? (r.pescar_username || r.pescar_zoda_id || 'Pescar') : (r.nume_client || 'Client telefonic');
  }

  // Textul afișat e „avertisment", nu „strike" (rundă 27, la cererea lui
  // Marian — mulți nu știu ce înseamnă „strike"). Doar cuvântul din UI
  // s-a schimbat; numele câmpului din baza de date (`strike_uri_active`,
  // tabelul `strike_uri`, RPC-ul `marcheaza_neprezentare`) rămân
  // neschimbate — schimbarea aici e strict de vocabular pentru pescar/
  // balta_admin, nu o redenumire de schemă. Extras într-un helper propriu
  // (rundă 45) — folosit atât de `identitatePescar()` (mai jos, neschimbată)
  // cât și de modalul de detaliu al Gantt-ului, care de la rundă 45 nu mai
  // apelează `identitatePescar()` (nume/telefon au devenit editabile acolo,
  // cf. mai jos), dar tot trebuie să arate avertismentele pescarului.
  function htmlAvertismentPescar(r) {
    return (r.strike_uri_active && r.strike_uri_active > 0)
      ? ' <span class="rez-strike">⚠️ ' + r.strike_uri_active + ' avertisment' + (r.strike_uri_active > 1 ? 'e' : '') + ' activ' + (r.strike_uri_active > 1 ? 'e' : '') + '</span>'
      : '';
  }

  function identitatePescar(r) {
    var nume = numeImplicitPescar(r);
    var strikeHtml = htmlAvertismentPescar(r);
    var telefon = r.telefon_client
      ? ' <a class="rez-tel-btn" href="tel:' + escH(r.telefon_client) + '"><span>📞</span>' + escH(r.telefon_client) + '</a>'
      : '';
    // Numele — mai vizibil (bold + culoare de text puternică) decât restul
    // rândului, cerere explicită a lui Marian (rundă 17): identitatea
    // pescarului trebuie să iasă în evidență dintr-o privire, în ambele teme.
    return '<span class="rez-nume-pescar">' + escH(nume) + '</span>' + telefon + strikeHtml;
  }

  // Rundă 40 — cerere explicită a lui Marian: „tab-ul de cereri sa isi dea
  // refresh singur... fara sa mai fie nevoie sa dam refresh la pagina”. Cât
  // timp tab-ul „Cereri" e activ, se reface lista automat, la fiecare
  // CERERI_POLL_MS — nu am folosit Supabase Realtime (ar fi însemnat o
  // conexiune nouă, cu propriile ei condiții de eșec/reconectare, netestate
  // în această sesiune) — un `setInterval` simplu, peste RPC-ul deja
  // existent (`listeaza_rezervari_balta`), e suficient de fiabil și mult
  // mai ușor de verificat. Ca să nu deranjeze balta_admin-ul cu re-randări
  // fără rost (flicker la fiecare 20s chiar și când nu s-a schimbat nimic),
  // lista de ID-uri e comparată înainte de orice re-randare — doar o
  // schimbare REALĂ (cerere nouă apărută, sau dispărută — ex. rezolvată
  // dintr-un alt tab deschis de același admin, în alt tab de browser)
  // declanșează redesenarea; o cerere nouă, apărută între timp, mai
  // primește și un toast, ca balta_admin să observe imediat, chiar dacă nu
  // se uită fix la ecran.
  var _cereriPollTimer = null;
  var _cereriIdsAnterior = null; // string, id-uri sortate, unite prin ',' — null = nu s-a randat încă
  var CERERI_POLL_MS = 20000;

  function opresteRefreshAutomatCereri() {
    if (_cereriPollTimer) { clearInterval(_cereriPollTimer); _cereriPollTimer = null; }
  }

  function pornesteRefreshAutomatCereri() {
    opresteRefreshAutomatCereri();
    _cereriPollTimer = setInterval(async function () {
      // Apărare suplimentară — dacă din orice motiv timer-ul n-a fost oprit
      // la schimbarea tab-ului (nu ar trebui să se întâmple, cf.
      // `schimbaTabAdmin`, dar mai bine verificăm), nu mai randăm peste un
      // alt tab activ.
      if (_adminTabCurent !== 'cereri') { opresteRefreshAutomatCereri(); return; }
      try {
        var toate = await fetchRezervariBalta();
        var cereri = toate.filter(function (r) { return r.status === 'in_asteptare'; });
        var idsAnteriorStr = _cereriIdsAnterior;
        var idsAcumStr = cereri.map(function (r) { return r.id; }).sort(function (a, b) { return a - b; }).join(',');
        if (idsAcumStr === idsAnteriorStr) return; // nimic nou — nicio redesenare
        var idsAnteriorSet = idsAnteriorStr ? idsAnteriorStr.split(',') : [];
        var apareCerereNoua = cereri.some(function (r) { return idsAnteriorSet.indexOf(String(r.id)) === -1; });
        randeazaListaCereri(cereri);
        _cereriIdsAnterior = idsAcumStr;
        if (apareCerereNoua) toast('🔔 Cerere nouă de rezervare.');
      } catch (e) { /* eșec silențios — un refresh de fundal ratat nu trebuie să deranjeze balta_admin-ul cu un toast de eroare; încearcă din nou la următorul ciclu */ }
    }, CERERI_POLL_MS);
  }

  function randeazaListaCereri(cereri) {
    if (!cereri.length) { setModalBody('<div class="rez-empty">Nicio cerere în așteptare.</div>'); return; }
    setModalBody(cereri.map(function (r) {
      return '<div class="rez-list-item">' +
        '<div style="font-weight:700;color:var(--zc-text-primary,#f1f5f9);">' + escH(r.stand_nume) + '<span class="rez-badge rez-badge-in_asteptare">în așteptare</span></div>' +
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
  }

  async function renderTabCereri() {
    setModalBody('<div class="rez-empty">Se încarcă...</div>');
    try {
      var toate = await fetchRezervariBalta();
      var cereri = toate.filter(function (r) { return r.status === 'in_asteptare'; });
      randeazaListaCereri(cereri);
      _cereriIdsAnterior = cereri.map(function (r) { return r.id; }).sort(function (a, b) { return a - b; }).join(',');
      pornesteRefreshAutomatCereri();
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

  // ── Calendar — cronologie tip Gantt ─────────────────────────────────────────
  // Un rând per stand (toate standurile bălții, chiar și cele fără rezervări
  // active acum), zilele orizontal, rezervările ca bare colorate poziționate
  // pe o axă de timp în pixeli. Gândit ca să rămână lizibil și cu 20+
  // rezervări active simultan — dintr-o privire se vede ce stand e liber și
  // când, fără să mai deschizi fiecare rezervare pe rând.
  // HALF_W = lățimea unei subcoloane (Zi SAU Noapte, 12h) — rundă 29,
  // cerere explicită a lui Marian: grilă mai vizibilă, cu ziua împărțită
  // vizual în 2. DAY_W (o zi întreagă, Zi+Noapte) e mereu 2×HALF_W — se
  // potrivește exact cu liniile din 'repeating-linear-gradient' de pe
  // '.rez-cal-track' (100px/200px, cf. CSS).
  // Rundă 37 — cerere explicită a lui Marian: coloanele mai înguste cu 15%
  // (100px → 85px pe subcoloană), atât pe mobil cât și pe desktop — HALF_W
  // e singura sursă a lățimii coloanelor, folosită la fel pe ambele (nu
  // există o valoare separată de mobil vs. desktop pentru lățime, doar
  // pentru înălțime, cf. media query-ul de mai jos din CSS) — deci o
  // singură schimbare acoperă ambele cazuri. Gridline-urile din fundalul
  // '.rez-cal-track' (CSS, mai sus) au fost recalibrate la aceeași scară.
  var HALF_W = 85; // px pe subcoloană de 12h (Zi sau Noapte) — 100 × 0.85
  var DAY_W = HALF_W * 2; // px pe zi întreagă
  var LABEL_W = 78; // px, coloana fixă (sticky) cu numele standului
  var _calRezervari = [];
  var _calSelectedId = null;

  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function diffZile(a, b) { return (b.getTime() - a.getTime()) / 86400000; }

  async function renderTabCalendar() {
    setModalBody('<div class="rez-empty">Se încarcă...</div>');
    try {
      var toate = await fetchRezervariBalta();
      var acum = new Date();
      // Prag de istorie — extins de la 24h la O SĂPTĂMÂNĂ (2026-08-28, rundă
      // 16, la cererea lui Marian): rezervările deja încheiate — inclusiv
      // cele marcate "neprezentat" — rămân vizibile în Gantt încă 7 zile
      // după ce s-au terminat, ca balta_admin să poată vedea istoricul
      // recent dintr-o privire, nu doar rezervările curente/viitoare.
      var pragVechi = new Date(acum.getTime() - 7 * 24 * 3600 * 1000);
      var relevante = toate.filter(function (r) {
        return (r.status === 'confirmata' || r.status === 'neprezentat') && new Date(r.data_sfarsit) >= pragVechi;
      });
      _calRezervari = relevante;
      _calSelectedId = null;

      if (!_adminStanduri.length) { setModalBody('<div class="rez-empty">Această baltă nu are încă standuri definite.</div>'); return; }

      // ── Intervalul afișat: (azi - 7 zile) → azi+14 zile — o săptămână de
      // istoric mereu vizibilă implicit (rundă 16), extins în plus dacă e
      // nevoie ca să cuprindă rezervări chiar mai vechi/mai îndepărtate,
      // plafonat la 60 de zile ca lățimea grilei să nu explodeze pe cazuri
      // extreme.
      var azi = startOfDay(acum);
      var rangeStart = new Date(azi.getTime() - 7 * 86400000);
      var rangeEnd = new Date(azi.getTime() + 14 * 86400000);
      relevante.forEach(function (r) {
        var s = startOfDay(new Date(r.data_start));
        var e = new Date(startOfDay(new Date(r.data_sfarsit)).getTime() + 86400000);
        if (s < rangeStart) rangeStart = s;
        if (e > rangeEnd) rangeEnd = e;
      });
      var MAX_ZILE = 60;
      if (diffZile(rangeStart, rangeEnd) > MAX_ZILE) rangeEnd = new Date(rangeStart.getTime() + MAX_ZILE * 86400000);

      var totalZile = Math.round(diffZile(rangeStart, rangeEnd));
      var trackW = totalZile * DAY_W;

      // Ancora grilei nu mai e miezul nopții (00:00), ci începutul zilei de
      // pescuit a bălții (`ora_zi_start`, implicit 06:00) — cf. rundă 29:
      // subcoloana "Zi" a fiecărei zile din grid trebuie să corespundă
      // exact intervalului real de zi (ora_zi_start → ora_zi_stop), iar
      // "Noapte" restului de 12h, până la "Zi" a zilei următoare — la fel
      // cum sunt calculate și rezervările efective (cf. `calculeazaIntervalSesiune`).
      // Scop asumat: etichetele Zi/Noapte din antet rămân generice (nu arată
      // orele exacte), ca să nu se complice cu reguli sezoniere care pot
      // schimba `ora_zi_start` pe intervale — grid-ul folosește mereu ora
      // implicită a bălții ca ancoră vizuală.
      var oraZiStr = (_adminBalta && _adminBalta.ora_zi_start) || '06:00:00';
      var oraZiH = parseInt(String(oraZiStr).slice(0, 2), 10);
      if (isNaN(oraZiH)) oraZiH = 6;
      var gridStart = new Date(rangeStart.getTime() + oraZiH * 3600000);
      function offsetPx(d) { return (d.getTime() - gridStart.getTime()) / 3600000 / 12 * HALF_W; }

      // ── Rândul de antet: numărul zilei + eticheta lunii, + subrândul cu
      // cele 2 subcoloane Zi/Noapte (rundă 29) ──
      var headerCells = '';
      for (var i = 0; i < totalZile; i++) {
        var ziua = new Date(rangeStart.getTime() + i * 86400000);
        var esteWeekend = (ziua.getDay() === 0 || ziua.getDay() === 6);
        var esteAzi = ziua.getTime() === azi.getTime();
        // Rundă 30: luna + numărul zilei pe UN singur rând ('.rez-cal-datanum'),
        // nu pe 2 (luna deasupra, ca înainte) — ca toate celulele de antet
        // să aibă aceeași înălțime.
        // Rundă 40 — cerere explicită a lui Marian: luna apare acum pe
        // FIECARE celulă, nu doar la începutul unei luni noi (cf. rundă 30,
        // 'esteInceputLuna', scoasă acum) — „sept 01, sept 02, etc.” — ca
        // să fie limpede din ce lună e fiecare zi, fără să trebuiască să
        // cauți înapoi până la ultima etichetă de lună vizibilă. Numărul
        // zilei, cu zero în față (`01`, nu `1`), exact ca-n exemplul dat.
        var etichetaZi = '<span class="rez-cal-luna">' + escH(ziua.toLocaleDateString('ro-RO', { month: 'short' })) + '</span> ' + String(ziua.getDate()).padStart(2, '0');
        headerCells += '<div class="rez-cal-daycell' + (esteWeekend ? ' weekend' : '') + (esteAzi ? ' azi' : '') + '" style="width:' + DAY_W + 'px;">' +
          '<div class="rez-cal-datanum">' + etichetaZi + '</div>' +
          '<div class="rez-cal-subrow"><div class="rez-cal-subcell">Zi</div><div class="rez-cal-subcell noapte">Noapte</div></div>' +
        '</div>';
      }

      // Rundă 37 — cerere explicită a lui Marian: linia albastră care arăta
      // „acum" pe grid a fost scoasă („mai mult încarcă decât ajută") — dar
      // `todayOffset` rămâne calculat, tot ancorat pe momentul curent real
      // (nu miezul nopții), pentru că mai e folosit mai jos, la centrarea
      // automată a grid-ului pe ziua curentă la deschidere (§40) — asta
      // rămâne neschimbată, doar liniuța vizuală a dispărut.
      var todayOffset = offsetPx(acum);

      // ── Un rând per stand (toate, inclusiv fără rezervări acum) ──
      var randuriStanduri = _adminStanduri.map(function (stand) {
        var reznStand = relevante.filter(function (r) { return r.stand_id === stand.id; });
        var bareHtml = reznStand.map(function (r) {
          var dataStart = new Date(r.data_start), dataSfarsit = new Date(r.data_sfarsit);
          var left = Math.max(0, offsetPx(dataStart));
          var right = Math.min(trackW, offsetPx(dataSfarsit));
          var width = Math.max(14, right - left);
          var clasa = 'rez-cal-bar ' + r.status + (r.status === 'confirmata' ? claseNivelIncredere(r) : '') + (r.id === _calSelectedId ? ' selectat' : '');
          // Durata reală (data_sfarsit - data_start), nu tip_sesiune — la
          // 'personalizat' intervalul poate fi orice, nu doar 12h/24h.
          var oreDurata = Math.round((dataSfarsit - dataStart) / 3600000);
          // Sub ~20px (mai puțin de ~12h la scara actuală) bara e prea
          // îngustă chiar și pentru un text minuscul — rămâne doar culoarea
          // + tooltip-ul (title) cu intervalul complet. Peste acest prag
          // (include și rezervările de 12h, cf. feedback Marian) arătăm
          // durata, cu font mai mic decât restul textelor din grid ca să
          // încapă și pe bare relativ înguste. Prag ușor ridicat (18→20px)
          // când fontul din Gantt a crescut cu 12% (rundă 12, punct de
          // accesibilitate cerut de Marian) — ca textul să încapă la fel
          // de curat ca înainte, fără să atingă marginile barei.
          var durataHtml = width >= 20 ? '<span class="rez-cal-bar-dur">' + oreDurata + 'h</span>' : '';
          // Pe desktop (cf. media query din CSS), bara arată numele +
          // telefonul clientului în loc de durată — cerere explicită a lui
          // Marian, rundă 29. Pe mobil rămâne neschimbat: doar durata,
          // restul informațiilor stau în modalul de detaliu, ca până acum.
          // Sub un prag de lățime (bare foarte scurte, tipice la sesiuni
          // 'personalizat'), textul n-ar încăpea curat nici pe desktop —
          // rămâne doar culoarea + tooltip-ul, la fel ca la bara îngustă de
          // pe mobil (prag simetric cu cel de la `durataHtml`, de mai sus).
          var infoHtml = width >= 55 ? '<div class="rez-cal-bar-info"><span class="rez-cal-bar-nume">' + escH(numeImplicitPescar(r)) + '</span>' +
            (r.telefon_client ? '<span class="rez-cal-bar-tel">' + escH(r.telefon_client) + '</span>' : '') + '</div>' : '';
          return '<div class="' + clasa + '" data-rez-id="' + r.id + '" style="left:' + left + 'px;width:' + width + 'px;" title="' +
            escH(fmtDataOra(r.data_start) + ' → ' + fmtDataOra(r.data_sfarsit)) + '">' + durataHtml + infoHtml + '</div>';
        }).join('');
        // Celule copii DIRECTE ale `.rez-cal-scroll` (nu mai există un
        // `<div class="rez-cal-row">` care să le înfășoare) — cf. notei din
        // CSS (§44/rundă 22): eticheta trebuie să fie copil direct al
        // containerului care scrolează, altfel `position:sticky;left:0` nu
        // ține pe scroll orizontal. Grid-ul pune automat eticheta + track-ul
        // pe același rând vizual (2 coloane fixate mai jos, pe container).
        return '<div class="rez-cal-label" title="' + escH(stand.nume || '') + '">' + escH(stand.nume || '') + '</div>' +
               '<div class="rez-cal-track">' + bareHtml + '</div>';
      }).join('');

      var notaGoala = relevante.length ? '' : '<div class="rez-empty" style="padding:0 0 12px;">Nicio rezervare confirmată încă.</div>';

      var html = notaGoala +
        // Rundă 38: legenda urmează culorile noi ale barelor — „Aprobată"
        // și „Confirmată" (fostele albastru/verde) au devenit aceeași
        // culoare solidă pe bară (verde plin, cf. nota din CSS), deci și
        // aici apar unite, într-o singură intrare, ca legenda să reflecte
        // exact ce se vede pe grid — nu mai are rost o distincție de
        // culoare în legendă pe care bara însăși n-o mai arată.
        '<div class="rez-legend"><span><i class="rez-dot" style="background:#22c55e;"></i>Rezervare</span><span><i class="rez-dot" style="background:#ef4444;"></i>Neprezentat</span></div>' +
        '<div class="rez-cal-scroll" style="grid-template-columns:' + LABEL_W + 'px ' + trackW + 'px;">' +
          // Rundă 40 — cerere explicită a lui Marian: colțul din stânga-sus,
          // gol până acum, arată acum eticheta „Standuri” — ca să fie clar,
          // fără ambiguitate, ce reprezintă coloana de dedesubt.
          '<div class="rez-cal-label rez-cal-corner rez-cal-header-cell">Standuri</div>' +
          '<div class="rez-cal-track rez-cal-daynums rez-cal-header-cell">' + headerCells + '</div>' +
          randuriStanduri +
        '</div>';

      setModalBody(html);

      // Centrare automată pe ziua curentă (rundă 18, cerere explicită a lui
      // Marian) — la deschidere, grid-ul pornea mereu scrollat la extrema
      // stângă (începutul ferestrei de o săptămână în urmă, §38), deci "azi"
      // era adesea în afara ecranului, la dreapta. Poziția absolută a liniei
      // de "azi" în interiorul containerului scrollabil e LABEL_W (coloana
      // fixă cu numele standului, care nu se scrollează) + offsetPx(azi)
      // (poziția ei pe axa timpului); centrăm asta în lățimea vizibilă a
      // containerului, în loc să pornim de la 0.
      var scrollEl = document.querySelector('.rez-cal-scroll');
      if (scrollEl) {
        var scrollDorit = (LABEL_W + todayOffset) - (scrollEl.clientWidth / 2);
        scrollEl.scrollLeft = Math.max(0, scrollDorit);
      }

      Array.prototype.forEach.call(document.querySelectorAll('.rez-cal-bar'), function (bar) {
        bar.onclick = function () {
          var id = parseInt(bar.dataset.rezId, 10);
          _calSelectedId = id;
          Array.prototype.forEach.call(document.querySelectorAll('.rez-cal-bar'), function (b) {
            b.classList.toggle('selectat', parseInt(b.dataset.rezId, 10) === id);
          });
          var gasita = null;
          for (var j = 0; j < _calRezervari.length; j++) { if (_calRezervari[j].id === id) { gasita = _calRezervari[j]; break; } }
          if (gasita) renderCalendarDetail(gasita);
        };
      });
    } catch (e) { setModalBody('<div class="rez-empty">Eroare: ' + escH(e.message) + '</div>'); }
  }

  // Detaliul unei rezervări apăsate pe Gantt — un modal propriu-zis (nu un
  // panou randat sub grid), ca balta_admin să-l vadă instant, fără să mai
  // dea scroll până jos de tot să ajungă la el (mai ales dacă balta are
  // multe standuri și tocmai a apăsat pe o bară de pe ultimul rând). Folosim
  // `deschideModalGeneric` cu un `bodyId` propriu (`rez-cal-detail-body`),
  // distinct de `rez-modal-body` — acela e deja ocupat de containerul
  // persistent al tab-urilor din rezervari-admin.html, care rămâne pe ecran
  // în spatele acestui modal.
  function renderCalendarDetail(r) {
    var acum = new Date();
    var sStart = new Date(r.data_start);
    var sEnd = new Date(r.data_sfarsit);
    // Rundă 25 — cerere explicită a lui Marian: până acum, "Nu s-a
    // prezentat" apărea DOAR după ce rezervarea se termina complet
    // (sEnd < acum), iar "Anulează" doar cât timp era încă în curs/viitoare
    // — cele două se excludeau mereu. Problemă reală: dacă pescarul nu
    // apărea și balta_admin anula rezervarea la 1-2 ore de la începutul ei
    // (ca să elibereze standul pentru altcineva), statusul devenea 'anulata'
    // — nu mai era 'confirmata' — deci butonul de neprezentare nu mai putea
    // apărea NICIODATĂ pentru acea rezervare, chiar și după ce ora ei de
    // sfârșit trecea; strike-ul devenea imposibil de dat.
    //
    // Fix: "Nu s-a prezentat" e disponibil de la ÎNCEPUTUL rezervării (nu de
    // la sfârșit), cât timp e încă 'confirmata' — balta_admin poate deci
    // să-l apese oricând după ce a decis, pe teren, că pescarul nu vine
    // (ex. la 1-2 ore de la ora de start), FĂRĂ să mai fie nevoit să anuleze
    // întâi (și să piardă opțiunea). De reținut: `marcheaza_neprezentare`
    // schimbă statusul din 'confirmata' în 'neprezentat' — asta, singură,
    // eliberează automat standul (constraint-ul anti-suprapunere din §3 se
    // aplică DOAR rândurilor 'confirmata'), deci în cazul obișnuit nici nu
    // mai e nevoie de un "Anulează" separat ca să elibereze locul.
    // "Anulează" rămâne disponibil în paralel, tot pe rezervarea în curs —
    // pentru cazul opus, când balta_admin vrea doar să elibereze standul
    // FĂRĂ să dea strike (ex. pescarul a anunțat din timp o întârziere).
    var arataNeprezentare = r.status === 'confirmata' && sStart <= acum;
    var arataAnuleaza = r.status === 'confirmata' && sEnd >= acum;
    // Rundă 44 — cerere explicită a lui Marian: „informația e împrăștiată,
    // fără corelare/prioritizare”. Restructurat pe 3 blocuri (cf. comentariul
    // din CSS, mai sus, lângă `.rez-detail-identitate`): (1) cine + când —
    // identitate și interval, primele; (2) starea rezervării — badge-ul de
    // status și confirmarea pescarului, corelate pe același rând, urmate
    // imediat de acțiunile care le schimbă (nu mai un buton uriaș, izolat);
    // (3) nota/blocarea clientului, despărțită vizual — e administrare a
    // PROFILULUI clientului, nu a acestei rezervări anume.
    var htmlActiuni = (arataNeprezentare || arataAnuleaza)
      ? '<div class="rez-detail-actions">' +
          (arataNeprezentare ? '<button class="rez-btn rez-btn-danger" id="rez-neprezentare-' + r.id + '">❌ Nu s-a prezentat</button>' : '') +
          (arataAnuleaza ? '<button class="rez-btn rez-btn-anuleaza-mic" id="rez-cal-anuleaza-' + r.id + '">🚫 Anulează</button>' : '') +
        '</div>'
      : '';
    // Rundă 45 — cerere explicită a lui Marian: „pe langa numele
    // pescarului, ar trebuii sa putem modifica si numarul de telefon...
    // astea merg puse pe acelasi rand unde este acum numele pescarului”.
    // Identitatea nu mai e afișată needitabil (`identitatePescar(r)`, ca
    // până acum) — devine chiar câmpurile editabile de nume+telefon
    // (mutate aici de la §41, unde exista doar „Nume”, mai jos în bloc),
    // randate async, o dată cu restul notei, de `randeazaIdentitateSiNotaPescar`
    // (redenumită din `randeazaBlocNotaPescar`, cf. mai jos). Avertismentul
    // pescarului (dacă are unul activ) tot trebuie arătat undeva — nu mai
    // vine din `identitatePescar()`, ci direct din helper-ul extras
    // `htmlAvertismentPescar(r)`.
    var bodyHtml = '<div class="rez-list-item rez-detail-mare" style="margin-bottom:0;">' +
      '<div id="rez-cal-detail-identitate"></div>' +
      (htmlAvertismentPescar(r) ? '<div style="margin:-4px 0 4px;">' + htmlAvertismentPescar(r) + '</div>' : '') +
      '<div class="rez-detail-perioada">' +
        '<div class="rez-detail-perioada-date">' +
          '<span class="rez-detail-perioada-parte">' + fmtDataOraColorat(r.data_start) + '</span>' +
          '<span class="rez-detail-perioada-parte">' + fmtDataOraColorat(r.data_sfarsit) + '</span>' +
        '</div>' +
        '<span class="rez-detail-perioada-sageata">' +
          '<span class="rez-detail-durata">' + escH(fmtDurataSesiune(r)) + '</span>' +
          '<span>→</span>' +
        '</span>' +
      '</div>' +
      '<div class="rez-detail-stare-row">' +
        '<span class="rez-badge rez-badge-' + r.status + (r.status === 'confirmata' ? claseNivelIncredere(r) : '') + '">' + escH(statusLabel(r.status)) + '</span>' +
        (r.confirmat_24h_la ? '<span class="rez-text-ok rez-text-small">✓ Confirmat de pescar</span>' : (r.status === 'confirmata' ? '<span class="rez-text-muted2 rez-text-small">⏳ Neconfirmat încă</span>' : '')) +
      '</div>' +
      htmlActiuni +
      '<div class="rez-detail-divider"></div>' +
      '<div id="rez-cal-detail-nota"></div>' +
    '</div>';
    // Rundă 51 — cerere explicită a lui Marian: butonul „Salvează” (Nume/
    // Telefon/Notă/Blocat, cf. rundă 48) trebuie să apară ÎN HEADER, nu jos
    // de tot în modal — pe un formular lung, jos „nu e vizibil" fără scroll.
    // Exact același fix ca la rundă 23 („Trimite cererea", modalul
    // pescarului) — butonul de acțiune principală mutat în header-ul
    // modalului (`.rez-modal-hdr-actions`, deja 'position:sticky;top:0',
    // deci rămâne pe ecran indiferent cât ai scrollat conținutul). Pornește
    // ascuns (`display:none`) — apare DOAR la o modificare reală, exact ca
    // înainte (rundă 48); `randeazaIdentitateSiNotaPescar` primește acum
    // id-ul lui ca ultim parametru și îl folosește în locul rândului de jos
    // — DOAR aici, în modalul din Gantt (o singură rezervare, un singur
    // header posibil). În „Bază clienți" (mai mulți clienți, un singur
    // header comun al tab-ului), rândul de jos rămâne neschimbat — n-ar
    // avea sens un singur buton în header pentru mai multe carduri.
    deschideModalGeneric(r.stand_nume, bodyHtml, null, 'rez-cal-detail-body',
      '<button class="rez-btn rez-btn-header" id="rez-cal-detail-save" type="button" style="display:none;">Salvează</button>');
    randeazaIdentitateSiNotaPescar(document.getElementById('rez-cal-detail-identitate'), document.getElementById('rez-cal-detail-nota'), _adminBaltaId, r.user_id, r.telefon_client, numeImplicitPescar(r), null, 'rez-cal-detail-save');

    var b = document.getElementById('rez-neprezentare-' + r.id);
    if (b) b.onclick = async function () {
      if (!confirm('Sigur marchezi neprezentare? Pescarul primește un avertisment.')) return;
      try {
        var res = await sb.rpc('marcheaza_neprezentare', { p_rezervare_id: r.id });
        if (res.error) throw res.error;
        toast('Avertisment acordat.');
        closeModal();
        renderTabCalendar();
      } catch (e) { toast(e.message || 'Eroare.', true); }
    };

    var a = document.getElementById('rez-cal-anuleaza-' + r.id);
    if (a) a.onclick = async function () {
      // Rundă 33 — cerere explicită a lui Marian: la o rezervare adăugată
      // MANUAL de balta_admin (`r.sursa === 'manual_admin'`, cf. §16), n-are
      // sens să i se ceară un motiv de anulare — n-a existat nicio cerere
      // online, aprobată separat, în spatele ei; balta_admin e singurul care
      // a introdus-o și tot el o anulează. Motivul rămâne OBLIGATORIU doar
      // pentru rezervările online (create de pescar, prin cerere) — acolo
      // chiar ajunge la pescar, într-o notificare, cf. mesajului din prompt.
      var esteManuala = r.sursa === 'manual_admin';
      var motiv;
      if (esteManuala) {
        if (!confirm('Sigur anulezi această rezervare?')) return;
        motiv = 'Anulată de administratorul bălții.';
      } else {
        var motivIntrodus = prompt('Motiv anulare (obligatoriu — pescarul va fi notificat):');
        if (motivIntrodus === null) return; // a apăsat Cancel la prompt
        if (!motivIntrodus.trim()) { toast('Motivul anulării e obligatoriu.', true); return; }
        motiv = motivIntrodus.trim();
      }
      try {
        var res = await sb.rpc('anuleaza_rezervare_admin', { p_rezervare_id: r.id, p_motiv: motiv });
        if (res.error) throw res.error;
        toast('Rezervare anulată.');
        closeModal();
        renderTabCalendar();
      } catch (e) { toast(e.message || 'Eroare.', true); }
    };
  }

  // ── Notă privată pe pescar + blocare — rundă 12 (§29 pct. 2+3), redenumită
  // și extinsă la rundă 45 ──────────────────────────────────────────────────
  // Bloc reutilizabil, randat atât în modalul de detaliu al unei rezervări
  // din Gantt (§26) cât și în tab-ul „Bază clienți" (o dată per pescar din
  // listă) — SINGURUL loc unde se construiește acest UI, ca să nu diveargă.
  // `userId`/`telefon` identifică pescarul exact ca peste tot în modul
  // (user_id XOR telefon). `numeImplicit` — identitatea implicită (username
  // de cont, sau „Client telefonic" pentru un pescar fără cont) — arătată ca
  // placeholder în câmpul de nume. `onSchimbat` (opțional) e apelat după
  // salvare, ca ecranul care conține blocul (ex. „Bază clienți") să se poată
  // reîmprospăta cu noul nume.
  //
  // Rundă 45 — 2 cereri explicite ale lui Marian: (1) telefonul de contact
  // trebuie să fie editabil, „pe același rând" cu numele — funcția primește
  // acum DOUĂ containere (`identitateEl`/`notaEl`), nu unul singur: rândul
  // Nume+Telefon merge în `identitateEl` (în modalul din Gantt, poziționat
  // SUS, chiar unde stătea numele needitabil înainte de rundă 45 — cf.
  // `renderCalendarDetail`), iar Notă privată + Blocare + Salvează rămân în
  // `notaEl` (mai jos, sub acțiuni). În „Bază clienți" (`renderTabModerare`),
  // unde nu există o poziționare separată de dorit, ambele containere sunt
  // pur și simplu ACELAȘI element — funcția scrie identitatea, apoi nota, în
  // ordine, în el (verificat cu `identitateEl === notaEl`, mai jos). (2)
  // etichetele lungi („✏️ Nume (opțional — înlocuiește «X» peste tot)")
  // înlocuite cu text scurt („Nume”/„Telefon”) — cerere explicită („prea
  // multă informație inutilă”).
  //
  // Telefonul editabil e o SUPRASCRIERE de afișare (`note_pescari.telefon_custom`,
  // rundă 45), exact ca numele custom de la rundă 19 — NU rescrie
  // `telefon_client` de pe rezervarea reală (istoric, neatins), și NU se
  // propagă în `identitatePescar()` (Cereri/Calendar rămân pe telefonul
  // real al rezervării) — aceeași decizie de scopare ca la numele custom
  // (§41: „ca să nu amestecăm două surse de adevăr”).
  var _notaSeq = 0;
  async function randeazaIdentitateSiNotaPescar(identitateEl, notaEl, baltaId, userId, telefon, numeImplicit, onSchimbat, headerBtnId) {
    if (!identitateEl && !notaEl) return;
    var acelasiContainer = identitateEl === notaEl;
    var meu = 'rez-nota-' + (++_notaSeq);
    var elIncarcare = identitateEl || notaEl;
    elIncarcare.innerHTML = '<div class="rez-empty" style="padding:8px 0;text-align:left;">Se încarcă...</div>';

    var nota = { text: '', blocat: false, nume: null };
    var telefonCustom = '';
    try {
      var res = await sb.rpc('citeste_nota_pescar', { p_balta_id: baltaId, p_pescar_user_id: userId || null, p_pescar_telefon: userId ? null : telefon });
      if (!res.error && res.data && res.data.length) nota = res.data[0];
    } catch (e) { /* fără notă existentă — pornim de la gol */ }
    try {
      var resTel = await sb.rpc('citeste_telefon_custom_pescar', { p_balta_id: baltaId, p_pescar_user_id: userId || null, p_pescar_telefon: userId ? null : telefon });
      if (!resTel.error && resTel.data) telefonCustom = resTel.data;
    } catch (e) { /* fără telefon suprascris — pornim de la gol */ }

    var stilCamp = 'width:100%;background:var(--zc-bg-panel,#111827);border:1.5px solid var(--zc-border,#1e293b);border-radius:8px;padding:8px 10px;color:var(--zc-text-primary,#f1f5f9);font-size:13.5px;font-family:inherit;box-sizing:border-box;';

    // Rundă 46 — cerere explicită a lui Marian: pe mobil, „numarul de
    // telefon nu se vede complet din cauza butonului de apelare”. Rândul
    // Nume+Telefon (rundă 45) era `display:flex` pur, unul lângă altul,
    // fiecare `flex:1;min-width:120px` — pe un modal îngust (mobil, unde
    // `.rez-modal` ajunge la `width:100%`, cf. `max-width:520px`), 120px
    // pentru TOT câmpul de telefon (etichetă+input+buton de apelare) nu
    // lasă loc destul pentru 10 cifre. Fix: rândul a devenit o clasă CSS
    // dedicată (`.rez-ident-row`), nu stil inline — implicit (mobil),
    // Nume și Telefon se așază unul SUB altul, fiecare pe toată lățimea
    // modalului (destul loc pentru orice număr, indiferent de câte cifre);
    // doar de la 480px în sus (telefon/tabletă mai lat, sau desktop) revin
    // unul lângă altul, ca înainte.
    // Rundă 50 — cerere explicită a lui Marian: „fa textul din casutele cu
    // nume si telefon sa fie editabil, nu sa trebuiasca sa introduci totul
    // de la zero”. Până acum, câmpul pornea GOL ori de câte ori nu exista
    // încă o suprascriere custom — identitatea reală (numele de cont/„Client
    // telefonic”, respectiv telefonul de pe rezervare) apărea DOAR ca
    // placeholder (text gri, ne-editabil, dispare la orice apăsare de
    // tastă) — o corectură minoră (o literă greșit scrisă, o cifră) însemna
    // să rescrii tot numele/telefonul din memorie. Acum câmpul pornește
    // completat cu identitatea CURENT AFIȘATĂ (suprascrierea custom, dacă
    // există, altfel identitatea reală) — editabilă direct, ca orice text
    // deja scris într-un formular. Placeholder-ul (identitatea reală) rămâne
    // ca reper, vizibil doar dacă admin-ul golește complet câmpul.
    var numeAfisatInitial = nota.nume || numeImplicit || '';
    var telefonAfisatInitial = telefonCustom || telefon || '';
    var htmlIdentitate =
      '<div class="rez-ident-row">' +
        '<div class="rez-field" style="margin:0;">' +
          '<label>Nume</label>' +
          '<input type="text" id="' + meu + '-nume" value="' + escH(numeAfisatInitial) + '" placeholder="' + escH(numeImplicit || '') + '" style="' + stilCamp + '">' +
        '</div>' +
        '<div class="rez-field" style="margin:0;">' +
          '<label>Telefon</label>' +
          '<div style="display:flex;gap:6px;">' +
            '<input type="tel" id="' + meu + '-telefon" value="' + escH(telefonAfisatInitial) + '" placeholder="' + escH(telefon || '') + '" style="' + stilCamp + '">' +
            '<button type="button" class="rez-call-btn" id="' + meu + '-suna" title="Sună">📞</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var htmlNota =
      '<div class="rez-field" style="margin-bottom:8px;">' +
        '<label>📝 Notă privată (vizibilă doar ție)</label>' +
        '<textarea id="' + meu + '-text" rows="2" style="width:100%;background:var(--zc-bg-panel,#111827);border:1.5px solid var(--zc-border,#1e293b);border-radius:8px;padding:8px 10px;color:var(--zc-text-primary,#f1f5f9);font-size:13.5px;font-family:inherit;resize:vertical;box-sizing:border-box;">' + escH(nota.text || '') + '</textarea>' +
      '</div>' +
      '<label class="rez-blocare-label">' +
        '<input type="checkbox" id="' + meu + '-blocat"' + (nota.blocat ? ' checked' : '') + '> 🚫 Blocat de la rezervări la această baltă' +
      '</label>' +
      // Rundă 48 — cerere explicită a lui Marian: „pe câmpurile alea când
      // apeși și editezi ceva, sa apara un buton de salvare ca sa evitam
      // editarea accidentala”. Butonul „Salvează” era mereu vizibil, chiar
      // și fără nicio modificare — un atingere accidentală (ex. la scroll
      // pe mobil) pe un câmp de Nume/Telefon/Notă putea rămâne neobservată
      // până la un „Salvează” ulterior, nelegat de acea editare. Rândul cu
      // butonul pornește ascuns ('hidden', atribut HTML nativ) și apare
      // DOAR după o modificare reală față de valorile încărcate — vezi
      // 'verificaModificari()' mai jos, apelată la fiecare 'input'/'change'
      // pe cele 4 câmpuri urmărite. După un „Salvează” reușit, valorile de
      // referință se actualizează la cele tocmai salvate, iar butonul
      // dispare din nou (nimic nemodificat rămas de trimis).
      // Rundă 51 — cerere explicită a lui Marian: pe un formular lung,
      // butonul de jos „nu e vizibil" fără scroll — mutat în header-ul
      // modalului (cf. mai jos, doar când e dat un 'headerBtnId'). Când e
      // dat, rândul de jos NU se mai randează deloc — un singur buton,
      // nu două. Fără 'headerBtnId' (ex. „Bază clienți", mai multe carduri,
      // un singur header comun), rândul de jos rămâne exact ca la rundă 48.
      (headerBtnId ? '' :
        '<div style="display:none;gap:8px;margin-top:8px;" id="' + meu + '-save-row">' +
          '<button class="rez-btn rez-btn-secondary" id="' + meu + '-save" type="button" style="flex:1;">Salvează</button>' +
        '</div>');

    if (acelasiContainer) {
      identitateEl.innerHTML = htmlIdentitate + htmlNota;
    } else {
      if (identitateEl) identitateEl.innerHTML = htmlIdentitate;
      if (notaEl) notaEl.innerHTML = htmlNota;
    }

    var btnSuna = document.getElementById(meu + '-suna');
    if (btnSuna) btnSuna.onclick = function () {
      var v = document.getElementById(meu + '-telefon').value.trim() || (telefon || '');
      if (v) window.location.href = 'tel:' + v;
    };

    // Rundă 48 — valorile de referință față de care detectăm o modificare
    // reală (nu doar un focus/blur fără nicio schimbare de text). Rundă 50 —
    // acum egale cu ce e CHIAR AFIȘAT în câmp (identitatea reală, dacă nu
    // exista încă o suprascriere), nu mai gol — altfel simpla completare a
    // câmpului (fără nicio editare reală) ar fi arătat butonul „Salvează”
    // degeaba. Actualizate din nou, la fiecare „Salvează” reușit, mai jos.
    var valInitiale = {
      nume: numeAfisatInitial,
      telefon: telefonAfisatInitial,
      text: nota.text || '',
      blocat: !!nota.blocat
    };
    // Rundă 51 — ținta vizibilității e fie butonul din header (dacă e dat
    // 'headerBtnId'), fie rândul de jos, ca înainte — niciodată amândouă.
    var randSalveaza = headerBtnId ? document.getElementById(headerBtnId) : document.getElementById(meu + '-save-row');
    // Comutăm direct 'style.display' (nu atributul HTML 'hidden') — rândul
    // are deja un 'style="display:none;..."' inline (ca să păstreze
    // 'display:flex' când e vizibil, pentru alinierea butonului); un stil
    // inline are prioritate mereu peste regula UA a atributului 'hidden'
    // ('[hidden]{display:none}'), deci cele două combinate ar fi lăsat
    // rândul vizibil tot timpul, indiferent de atribut — bug prins la
    // verificarea vizuală cu Playwright, înainte de livrare.
    function verificaModificari() {
      if (!randSalveaza) return;
      var elNume = document.getElementById(meu + '-nume');
      var elTelefon = document.getElementById(meu + '-telefon');
      var elText = document.getElementById(meu + '-text');
      var elBlocat = document.getElementById(meu + '-blocat');
      var modificat =
        (elNume && elNume.value.trim() !== valInitiale.nume) ||
        (elTelefon && elTelefon.value.trim() !== valInitiale.telefon) ||
        (elText && elText.value.trim() !== valInitiale.text) ||
        (elBlocat && elBlocat.checked !== valInitiale.blocat);
      // Butonul din header e un '<button>' simplu (flex item deja, în
      // '.rez-modal-hdr-actions') — revine la afișarea implicită (''), nu
      // 'flex'; rândul de jos (un 'div' cu 'display:flex' cerut pentru
      // alinierea internă a butonului) tot 'flex', ca înainte.
      randSalveaza.style.display = modificat ? (headerBtnId ? '' : 'flex') : 'none';
    }
    [meu + '-nume', meu + '-telefon', meu + '-text'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', verificaModificari);
    });

    // Rundă 45 — cerere explicită a lui Marian: bifarea „Blocat” trebuie să
    // anunțe, printr-un pop-up, că urmează să blocheze rezervările clientului
    // — declanșat la BIFARE (nu la debifare, care e o acțiune sigură/pozitivă,
    // nu are nevoie de confirmare), înainte ca „Salvează” să trimită efectiv
    // schimbarea la server. Refuzul confirmării revine bifa la loc, nedecis.
    var chkBlocat = document.getElementById(meu + '-blocat');
    if (chkBlocat) chkBlocat.onchange = function () {
      if (this.checked) {
        var numeAfisat = (document.getElementById(meu + '-nume').value || '').trim() || numeImplicit || 'acest client';
        if (!confirm('Blochezi clientul „' + numeAfisat + '” de la rezervări la această baltă?')) {
          this.checked = false;
        }
      }
      verificaModificari();
    };

    // Rundă 51 — același handler de „Salvează", legat fie de butonul din
    // header, fie de cel din rândul de jos (oricare există, cf. mai sus).
    var btnSalveazaEl = headerBtnId ? document.getElementById(headerBtnId) : document.getElementById(meu + '-save');
    if (btnSalveazaEl) btnSalveazaEl.onclick = async function () {
      var btn = this;
      var nume = document.getElementById(meu + '-nume').value.trim();
      var telefonCustomNou = document.getElementById(meu + '-telefon').value.trim();
      var text = document.getElementById(meu + '-text').value.trim();
      var blocat = document.getElementById(meu + '-blocat').checked;
      // Rundă 50 — câmpurile pornesc acum precompletate cu identitatea REALĂ
      // (nu mai goale, cf. mai sus), ca să fie editabile direct. Dacă
      // rămân nemodificate față de identitatea reală (adică admin-ul n-a
      // vrut de fapt s-o suprascrie — a modificat doar telefonul, de
      // exemplu, lăsând numele așa cum era), trimitem NULL la server (nicio
      // suprascriere), exact ca înainte de rundă 50 — altfel am fi „înghețat"
      // o suprascriere identică cu identitatea reală, care n-ar mai urmări
      // automat o eventuală schimbare ulterioară a ei (ex. pescarul își
      // redenumește contul Zoda).
      var numeDeTrimis = (nume && nume !== (numeImplicit || '').trim()) ? nume : null;
      var telefonDeTrimis = (telefonCustomNou && telefonCustomNou !== (telefon || '').trim()) ? telefonCustomNou : null;
      btn.disabled = true; var txtOrig = btn.textContent; btn.textContent = 'Se salvează...';
      try {
        var res2 = await sb.rpc('seteaza_nota_pescar', {
          p_balta_id: baltaId, p_pescar_user_id: userId || null, p_pescar_telefon: userId ? null : telefon,
          p_text: text, p_blocat: blocat, p_nume: numeDeTrimis
        });
        if (res2.error) throw res2.error;
        var res3 = await sb.rpc('seteaza_telefon_custom_pescar', {
          p_balta_id: baltaId, p_pescar_user_id: userId || null, p_pescar_telefon: userId ? null : telefon,
          p_telefon_custom: telefonDeTrimis
        });
        if (res3.error) throw res3.error;
        valInitiale = { nume: nume, telefon: telefonCustomNou, text: text, blocat: blocat };
        verificaModificari();
        toast('✓ Salvat.');
        if (typeof onSchimbat === 'function') onSchimbat();
      } catch (e) {
        toast(e.message || 'Eroare la salvare.', true);
      }
      btn.disabled = false; btn.textContent = txtOrig;
    };
  }

  // ── Tab „Moderare" — listă de pescari (cei care au rezervat vreodată la
  // balta + cei adăugați manual, fără rezervare, doar ca să li se pună o
  // notă/blocare din timp), cu blocare manuală + notă, independent de a avea
  // sau nu o rezervare activă (§29 pct. 3). Folosește exact același bloc de
  // notă ca modalul de detaliu din Gantt (`randeazaBlocNotaPescar`).
  async function renderTabModerare() {
    setModalBody('<div class="rez-empty">Se încarcă...</div>');
    try {
      var toate = await fetchRezervariBalta();
      var noteRes = await sb.rpc('listeaza_note_pescari', { p_balta_id: _adminBaltaId });
      if (noteRes.error) throw noteRes.error;
      var note = noteRes.data || [];

      function cheie(userId, tel) { return userId ? ('u:' + userId) : ('t:' + tel); }

      var harta = {};
      toate.forEach(function (r) {
        if (!r.user_id && !r.telefon_client) return;
        var k = cheie(r.user_id, r.telefon_client);
        if (!harta[k]) {
          harta[k] = {
            userId: r.user_id || null,
            // Telefonul de contact de pe rezervare — păstrat pentru
            // afișare/căutare (rundă 20) indiferent dacă pescarul are cont
            // sau nu (până acum se păstra doar pentru cei fără cont, deci
            // un pescar cu cont nu avea nici buton de telefon, nici nu
            // putea fi găsit prin căutare după telefon în „Moderare”).
            // Rămâne folosit ca identitate (pentru RPC-uri) doar când NU
            // există userId — locurile care-l trimit la server îl ignoră
            // oricum când userId e prezent (`p.userId ? null : p.telefon`).
            telefon: r.telefon_client || null,
            numeImplicit: numeImplicitPescar(r),
            numeCustom: null,
            text: '', blocat: false,
            // Rundă 34 — folosit doar ca să putem explica exact, la
            // ștergere, de ce clientul rămâne sau nu în listă (cf. mai jos).
            areRezervari: true,
            // Rundă 35 — separat de `areRezervari`: contează DOAR
            // rezervările online (`sursa !== 'manual_admin'`), actualizat
            // mai jos la FIECARE rezervare găsită (nu doar la prima), ca să
            // prindem și cazul unui client cu rezervări mixte (o parte
            // manuale, o parte online), indiferent de ordinea în care apar.
            areRezervariOnline: false,
            // Rundă 43 — istoricul complet de rezervări ale clientului la
            // ACEASTĂ baltă (nu doar flag-uri) — `toate` e deja filtrat pe
            // `_adminBaltaId` prin `fetchRezervariBalta`, deci nu trebuie
            // filtrat din nou aici. Populat mai jos, la FIECARE rezervare
            // găsită (nu doar prima), la fel ca `areRezervariOnline`.
            rezervari: []
          };
        }
        if (r.sursa !== 'manual_admin') harta[k].areRezervariOnline = true;
        harta[k].rezervari.push(r);
      });
      // Rundă 19: o notă poate avea acum un `nume` custom (ex. numele real al
      // unui client telefonic, în loc de „Client telefonic") — dacă există,
      // ține locul identității implicite peste tot în acest tab. Un rând de
      // notă fără nicio rezervare (adăugat direct din formularul de mai jos)
      // e păstrat separat, ca să poată fi șters/redenumit chiar dacă n-a
      // rezervat niciodată.
      note.forEach(function (n) {
        var k = cheie(n.pescar_user_id, n.pescar_telefon);
        if (harta[k]) {
          harta[k].text = n.text; harta[k].blocat = n.blocat; harta[k].numeCustom = n.nume || null;
        } else {
          harta[k] = {
            userId: n.pescar_user_id, telefon: n.pescar_telefon,
            numeImplicit: n.pescar_username || n.pescar_telefon || 'Pescar',
            numeCustom: n.nume || null,
            text: n.text, blocat: n.blocat,
            areRezervari: false,
            rezervari: []
          };
        }
      });

      var lista = Object.keys(harta).map(function (k) { return harta[k]; });
      lista.forEach(function (p) { p.nume = p.numeCustom || p.numeImplicit; });
      lista.sort(function (a, b) {
        if (a.blocat !== b.blocat) return a.blocat ? -1 : 1;
        if (!!a.text !== !!b.text) return a.text ? -1 : 1;
        return (a.nume || '').localeCompare(b.nume || '', 'ro');
      });

      var htmlAdd =
        '<div class="rez-field" style="border:1px solid var(--zc-border,#1e293b);border-radius:10px;padding:12px;margin-bottom:16px;">' +
          '<label>Adaugă pescar după telefon (chiar fără nicio rezervare încă)</label>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<input type="tel" id="rez-mod-add-tel" placeholder="07xx xxx xxx" style="flex:1;min-width:120px;">' +
            '<input type="text" id="rez-mod-add-nume" placeholder="Nume (opțional)" style="flex:1;min-width:120px;">' +
            '<button class="rez-btn" id="rez-mod-add-btn" type="button" style="width:auto;padding:9px 16px;white-space:nowrap;">Adaugă</button>' +
          '</div>' +
        '</div>';

      // Căutare (rundă 20) — filtru simplu, client-side, pe lista deja
      // încărcată (nu mai e nevoie de niciun RPC nou pentru asta) — după
      // nume (custom sau implicit) sau telefon. Randarea listei e separată
      // într-o funcție proprie, apelată o dată la deschidere (fără filtru)
      // și apoi la fiecare tastă din câmpul de căutare, ca să nu trebuiască
      // reluat fetch-ul de fiecare dată.
      var htmlSearch =
        '<div class="rez-field">' +
          '<input type="text" id="rez-mod-search" placeholder="🔍 Caută după nume sau telefon...">' +
        '</div>';

      function randeazaListaModerare(query) {
        var q = (query || '').trim().toLowerCase();
        var filtrata = !q ? lista : lista.filter(function (p) {
          return (p.nume || '').toLowerCase().indexOf(q) !== -1 || (p.telefon || '').toLowerCase().indexOf(q) !== -1;
        });

        var htmlLista = filtrata.length ? filtrata.map(function (p, idx) {
          var telBtn = p.telefon
            ? ' <a class="rez-tel-btn" href="tel:' + escH(p.telefon) + '"><span>📞</span>' + escH(p.telefon) + '</a>'
            : '';
          // Rundă 43 — buton „Istoric" (dropdown) doar dacă clientul chiar are
          // cel puțin o rezervare la această baltă (`p.rezervari`, cf. mai
          // sus) — un client adăugat doar din formularul de mai sus, fără
          // nicio rezervare încă, n-are ce istoric să arate.
          var istoricBtn = p.rezervari.length
            ? '<button class="rez-istoric-btn" id="rez-mod-ist-btn-' + idx + '" type="button">📋 Istoric (' + p.rezervari.length + ')</button>'
            : '';
          return '<div class="rez-list-item">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
              '<div style="font-weight:700;color:var(--zc-text-primary,#f1f5f9);">' + escH(p.nume) +
                (p.blocat ? ' <span class="rez-badge rez-badge-neprezentat">blocat</span>' : '') +
                telBtn +
              '</div>' +
              '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                istoricBtn +
                '<button class="rez-btn rez-btn-danger rez-btn-sterge-mic" id="rez-mod-sterge-' + idx + '" type="button">🗑️ Șterge</button>' +
              '</div>' +
            '</div>' +
            '<div id="rez-mod-nota-' + idx + '"></div>' +
            (p.rezervari.length ? '<div class="rez-istoric-list" id="rez-mod-ist-' + idx + '" style="display:none;"></div>' : '') +
          '</div>';
        }).join('') : (q
          ? '<div class="rez-empty">Niciun pescar găsit pentru „' + escH(query.trim()) + '".</div>'
          : '<div class="rez-empty">Niciun pescar încă — adaugă unul după telefon mai sus, sau apare automat aici după prima lui rezervare/cerere.</div>');

        document.getElementById('rez-mod-lista').innerHTML = htmlLista;

        filtrata.forEach(function (p, idx) {
          // Rundă 45 — `randeazaIdentitateSiNotaPescar` cere 2 containere;
          // aici, unde nu are sens o poziționare separată (cardul are deja
          // numele mare deasupra), i se dă ACELAȘI element de două ori —
          // funcția scrie identitate+notă, în ordine, în el.
          var elNotaModerare = document.getElementById('rez-mod-nota-' + idx);
          randeazaIdentitateSiNotaPescar(elNotaModerare, elNotaModerare, _adminBaltaId, p.userId, p.telefon, p.numeImplicit, renderTabModerare);

          // Rundă 43 — deschide/închide dropdown-ul de istoric; conținutul
          // (`randeazaIstoricClient`) e randat o singură dată, lene (abia la
          // primul click), nu odată cu toată lista de clienți.
          var btnIstoric = document.getElementById('rez-mod-ist-btn-' + idx);
          if (btnIstoric) {
            var contIstoric = document.getElementById('rez-mod-ist-' + idx);
            var istoricRandat = false;
            btnIstoric.onclick = function () {
              var esteDeschis = contIstoric.style.display !== 'none';
              if (esteDeschis) {
                contIstoric.style.display = 'none';
                btnIstoric.textContent = '📋 Istoric (' + p.rezervari.length + ')';
                return;
              }
              if (!istoricRandat) { contIstoric.innerHTML = randeazaIstoricClient(p.rezervari); istoricRandat = true; }
              contIstoric.style.display = 'block';
              btnIstoric.textContent = '▲ Istoric (' + p.rezervari.length + ')';
            };
          }

          var btnSterge = document.getElementById('rez-mod-sterge-' + idx);
          if (btnSterge) btnSterge.onclick = async function () {
            // Rundă 34 — cerere explicită a lui Marian: „nu se sterg clientii
            // din baza de date daca dau stergere... imi apare 'sters' dar
            // clientul este tot acolo”. Diagnosticat: comportamentul ăsta
            // exista deja, DOCUMENTAT din rundă 19 — „Șterge” elimină DOAR
            // rândul din `note_pescari` (notița, numele custom, blocarea),
            // niciodată istoricul de rezervări. Dacă pescarul are vreo
            // rezervare ONLINE la această baltă, tot reapare în listă, fără
            // notiță/nume custom — nu e un bug, e rost să nu pierdem istoric
            // real al unui pescar care chiar a folosit platforma.
            //
            // Rundă 35 — Marian a lovit exact cealaltă situație: un client
            // fără NICIO rezervare activă, dar tot nu putea fi șters —
            // pentru că avea totuși o rezervare veche (istorică, indiferent
            // de status) adăugată MANUAL de el însuși. „Bază clienți”
            // ținea cont de orice rezervare, manuală sau nu, ca să nu piardă
            // istoricul unui pescar real — dar o rezervare manuală n-are
            // nimic „real” de păstrat: a scris-o tot balta_admin, nu vine de
            // la niciun pescar. Acum: dacă TOATE rezervările clientului la
            // această baltă sunt manuale (nicio rezervare online, niciodată)
            // — `!p.areRezervariOnline` — ștergerea devine una COMPLETĂ și
            // DEFINITIVĂ: șterge notița ȘI rezervările lui manuale, prin
            // RPC-ul nou `sterge_client_manual_complet` (aditiv, nu atinge
            // nimic existent) — clientul chiar dispare din „Bază clienți”.
            // Dacă are și o singură rezervare ONLINE, comportamentul vechi
            // (doar notița) rămâne neschimbat — acolo chiar e istoric real.
            var esteDoarManual = p.areRezervari && !p.areRezervariOnline;
            var mesajConfirmare;
            if (esteDoarManual) {
              mesajConfirmare = 'Ștergi COMPLET clientul „' + p.nume + '"? Are doar rezervări adăugate manual de tine (nicio rezervare online) — se șterg definitiv, ireversibil, notița ȘI toate rezervările lui manuale de la această baltă.';
            } else if (p.areRezervari) {
              mesajConfirmare = 'Ștergi notița, numele custom și blocarea pentru „' + p.nume + '"? Are rezervări online la această baltă, deci rămâne în listă (fără notiță/nume custom) — rezervările lui nu sunt afectate.';
            } else {
              mesajConfirmare = 'Ștergi complet clientul „' + p.nume + '"? Nu are nicio rezervare la această baltă — va dispărea de tot din listă.';
            }
            if (!confirm(mesajConfirmare)) return;
            try {
              if (esteDoarManual) {
                var resDC = await sb.rpc('sterge_client_manual_complet', { p_balta_id: _adminBaltaId, p_pescar_user_id: p.userId || null, p_pescar_telefon: p.userId ? null : p.telefon });
                if (resDC.error) throw resDC.error;
                toast('✓ Client șters definitiv (notiță + rezervări manuale).');
              } else {
                var resD = await sb.rpc('sterge_nota_pescar', { p_balta_id: _adminBaltaId, p_pescar_user_id: p.userId || null, p_pescar_telefon: p.userId ? null : p.telefon });
                if (resD.error) throw resD.error;
                toast(p.areRezervari ? '✓ Notița a fost ștearsă (clientul rămâne — are rezervări online).' : '✓ Client șters complet.');
              }
              renderTabModerare();
            } catch (e) { toast(e.message || 'Eroare la ștergere.', true); }
          };
        });
      }

      setModalBody(htmlAdd + htmlSearch + '<div id="rez-mod-lista"></div>');
      randeazaListaModerare('');

      document.getElementById('rez-mod-search').oninput = function () { randeazaListaModerare(this.value); };

      document.getElementById('rez-mod-add-btn').onclick = async function () {
        var tel = document.getElementById('rez-mod-add-tel').value.trim();
        var nume = document.getElementById('rez-mod-add-nume').value.trim();
        if (!tel) { toast('Introdu un număr de telefon.', true); return; }
        try {
          var res = await sb.rpc('seteaza_nota_pescar', { p_balta_id: _adminBaltaId, p_pescar_user_id: null, p_pescar_telefon: tel, p_text: '', p_blocat: false, p_nume: nume || null });
          if (res.error) throw res.error;
          toast('✓ Adăugat.');
          renderTabModerare();
        } catch (e) { toast(e.message || 'Eroare.', true); }
      };
    } catch (e) { setModalBody('<div class="rez-empty">Eroare: ' + escH(e.message) + '</div>'); }
  }

  // ── Tab „Adaugă manual" — redesenat la rundă 12 (§29 pct. 5+6):
  // (5) grila de standuri clickabile (ca sub harta din balta.html), în loc de
  // select-ul cu scroll, cu buton „Selectează tot" în modul multiplu;
  // (6) doar dată (nu și oră) — ora rezultă din tipul partidei + orele de
  // ancoră ale bălții, exact ca în modalul pescarului (`calculeazaIntervalSesiune`,
  // aceeași funcție, ca logica să nu diveargă între cele două locuri).
  var _manualSelectie = []; // array de stand_id, ordinea nu contează
  var _manualTip = '24h';

  // ── Tab „Program sezonier" — rundă 12 (§29 pct. 7) ──────────────────────────
  // CRUD pentru `reguli_program_balta`: intervale orare zi/noapte pe sezon +
  // blocare partide 24h/24h+ (permanent sau pe interval de date). Regulile
  // citite aici (`citeste_reguli_program_balta`) sunt EXACT aceleași folosite
  // de modalul pescarului (balta.html) și de tab-ul „Adaugă manual" de mai
  // sus, prin `calculeazaIntervalSesiune`/`motivIndisponibilSesiune` — nu
  // există o a doua copie a logicii de rezolvare.
  function fmtDataScurta(d) { return d ? fmtDataDDMMYYYY(new Date(d + 'T00:00:00')) : null; }

  async function renderTabProgram() {
    setModalBody('<div class="rez-empty">Se încarcă...</div>');
    try {
      var res = await sb.rpc('citeste_reguli_program_balta', { p_balta_id: _adminBaltaId });
      if (res.error) throw res.error;
      _adminReguli = res.data || [];

      var htmlLista = _adminReguli.length ? _adminReguli.map(function (r) {
        var interval = (r.data_start || r.data_sfarsit)
          ? (fmtDataScurta(r.data_start) || 'oricând') + ' → ' + (fmtDataScurta(r.data_sfarsit) || 'fără sfârșit')
          : 'permanentă';
        var oreParti = [];
        if (r.ora_zi_start || r.ora_zi_stop) oreParti.push('Zi: ' + (r.ora_zi_start || '?').slice(0, 5) + '–' + (r.ora_zi_stop || '?').slice(0, 5));
        if (r.ora_noapte_start) oreParti.push('Noapte: de la ' + r.ora_noapte_start.slice(0, 5));
        return '<div class="rez-list-item">' +
          '<div style="font-weight:700;color:var(--zc-text-primary,#f1f5f9);">' + escH(r.nume || '(fără nume)') +
            (r.blocheaza_24h ? ' <span class="rez-badge rez-badge-neprezentat">blochează 24h/personalizat</span>' : '') +
          '</div>' +
          '<div style="margin:4px 0;">📅 ' + escH(interval) + '</div>' +
          (oreParti.length ? '<div style="margin:4px 0;">🕐 ' + escH(oreParti.join(' · ')) + '</div>' : '') +
          '<button class="rez-btn rez-btn-danger" style="margin-top:8px;width:auto;padding:7px 14px;" id="rez-prog-sterge-' + r.id + '">Șterge regula</button>' +
        '</div>';
      }).join('') : '<div class="rez-empty">Nicio regulă sezonieră încă — balta folosește orele de bază, tot anul.</div>';

      var htmlForm =
        '<div class="rez-field" style="border:1px solid var(--zc-border,#1e293b);border-radius:10px;padding:12px;margin-bottom:16px;">' +
          '<div style="font-weight:700;color:var(--zc-text-primary,#f1f5f9);margin-bottom:10px;">Regulă nouă</div>' +
          '<div class="rez-field"><label>Nume (opțional, doar pentru tine)</label><input type="text" id="rez-prog-nume" placeholder="ex. Sezon rece"></div>' +
          '<div style="display:flex;gap:10px;">' +
            '<div class="rez-field" style="flex:1;"><label>De la data (gol = fără limită)</label><input type="date" lang="ro" id="rez-prog-data-start"></div>' +
            '<div class="rez-field" style="flex:1;"><label>Până la data (gol = fără limită)</label><input type="date" lang="ro" id="rez-prog-data-sfarsit"></div>' +
          '</div>' +
          '<div style="display:flex;gap:10px;">' +
            '<div class="rez-field" style="flex:1;"><label>Ora start Zi</label><input type="time" id="rez-prog-ora-zi-start"></div>' +
            '<div class="rez-field" style="flex:1;"><label>Ora stop Zi</label><input type="time" id="rez-prog-ora-zi-stop"></div>' +
            '<div class="rez-field" style="flex:1;"><label>Ora start Noapte</label><input type="time" id="rez-prog-ora-noapte"></div>' +
          '</div>' +
          '<label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:var(--zc-text-secondary-2,#94a3b8);margin-bottom:10px;cursor:pointer;">' +
            '<input type="checkbox" id="rez-prog-blocheaza" style="width:auto;flex:0 0 auto;"> 🚫 Blochează partidele de 24h/personalizat în acest interval' +
          '</label>' +
          '<div style="font-size:11.5px;color:var(--zc-text-dim,#4b5563);margin-bottom:10px;">Lasă orele goale dacă regula servește doar la blocarea 24h, fără să schimbe programul de zi/noapte.</div>' +
          '<button class="rez-btn" id="rez-prog-adauga" type="button">Adaugă regula</button>' +
        '</div>';

      setModalBody(htmlForm + htmlLista);

      _adminReguli.forEach(function (r) {
        var btn = document.getElementById('rez-prog-sterge-' + r.id);
        if (btn) btn.onclick = async function () {
          if (!confirm('Sigur ștergi regula „' + (r.nume || '(fără nume)') + '"?')) return;
          try {
            var delRes = await sb.rpc('sterge_regula_program', { p_id: r.id, p_balta_id: _adminBaltaId });
            if (delRes.error) throw delRes.error;
            toast('Regulă ștearsă.');
            renderTabProgram();
          } catch (e) { toast(e.message || 'Eroare.', true); }
        };
      });

      document.getElementById('rez-prog-adauga').onclick = async function () {
        var btnEl = this;
        var nume = document.getElementById('rez-prog-nume').value.trim() || null;
        var dataStart = document.getElementById('rez-prog-data-start').value || null;
        var dataSfarsit = document.getElementById('rez-prog-data-sfarsit').value || null;
        var oraZiStart = document.getElementById('rez-prog-ora-zi-start').value || null;
        var oraZiStop = document.getElementById('rez-prog-ora-zi-stop').value || null;
        var oraNoapte = document.getElementById('rez-prog-ora-noapte').value || null;
        var blocheaza = document.getElementById('rez-prog-blocheaza').checked;

        if (!oraZiStart && !oraZiStop && !oraNoapte && !blocheaza) {
          toast('Completează cel puțin o oră sau bifează blocarea 24h.', true);
          return;
        }
        if (dataStart && dataSfarsit && dataSfarsit < dataStart) {
          toast('Data de sfârșit nu poate fi înainte de data de start.', true);
          return;
        }

        btnEl.disabled = true; btnEl.textContent = 'Se salvează...';
        try {
          var addRes = await sb.rpc('seteaza_regula_program', {
            p_id: null, p_balta_id: _adminBaltaId, p_nume: nume,
            p_data_start: dataStart, p_data_sfarsit: dataSfarsit,
            p_ora_zi_start: oraZiStart, p_ora_zi_stop: oraZiStop, p_ora_noapte_start: oraNoapte,
            p_blocheaza_24h: blocheaza
          });
          if (addRes.error) throw addRes.error;
          toast('✓ Regulă adăugată.');
          renderTabProgram();
        } catch (e) {
          toast(e.message || 'Eroare la salvare.', true);
          btnEl.disabled = false; btnEl.textContent = 'Adaugă regula';
        }
      };
    } catch (e) { setModalBody('<div class="rez-empty">Eroare: ' + escH(e.message) + '</div>'); }
  }

  function renderTabManual() {
    _manualSelectie = [];
    _manualTip = '24h';
    var minDateStr = toDateInputValue(new Date()); // admin nu are restricția de 16h a pescarului

    var html =
      '<div class="rez-field"><label>Tip partidă</label>' +
        '<div class="rez-tip-row" id="rez-manual-tip-row"></div>' +
      '</div>' +
      '<div id="rez-manual-avert-tip"></div>' +
      '<div id="rez-manual-date-fields"></div>' +
      '<div class="rez-field" style="position:relative;">' +
        '<label>Nume client</label>' +
        '<input type="text" id="rez-manual-nume" placeholder="opțional — scrie ca să vezi sugestii de conturi Zoda" autocomplete="off">' +
        '<div class="rez-autocomplete-list" id="rez-manual-nume-sugestii"></div>' +
      '</div>' +
      '<div class="rez-field"><label>Telefon client</label><input type="text" id="rez-manual-telefon" placeholder="opțional"></div>' +
      '<div class="rez-field">' +
        '<label><input type="checkbox" id="rez-manual-multiplu"> Rezervare multiplă (grup/concurs — mai multe standuri)</label>' +
      '</div>' +
      '<div class="rez-field">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<label id="rez-manual-stand-label" style="margin:0;">Stand</label>' +
          '<button type="button" class="rez-btn rez-btn-secondary" id="rez-manual-selall" style="display:none;width:auto;padding:4px 12px;font-size:12px;">Selectează tot</button>' +
        '</div>' +
        '<div class="rez-stand-grid" id="rez-manual-stand-grid"></div>' +
      '</div>' +
      '<button class="rez-btn" id="rez-manual-submit" disabled>Adaugă rezervarea</button>';
    setModalBody(html);

    // ── Sugestii de conturi Zoda pe măsură ce se scrie numele (rundă 20) ──────
    // Doar ajutor la scriere — alegerea unei sugestii completează exact
    // numele contului în câmp, NU leagă rezervarea de acel cont (rămâne o
    // rezervare manuală, nume_client/telefon_client, ca și până acum — vezi
    // nota din 2026-08-28_runda20_cauta_pescari.sql pentru motiv).
    (function initSugestiiNume() {
      var numeInput = document.getElementById('rez-manual-nume');
      var sugestiiEl = document.getElementById('rez-manual-nume-sugestii');
      if (!numeInput || !sugestiiEl) return;
      var _sugestiiToken = 0;
      var _sugestiiTimer = null;
      function ascundeSugestii() { sugestiiEl.innerHTML = ''; sugestiiEl.style.display = 'none'; }
      numeInput.oninput = function () {
        var query = numeInput.value.trim();
        var myToken = ++_sugestiiToken;
        clearTimeout(_sugestiiTimer);
        if (query.length < 2) { ascundeSugestii(); return; }
        _sugestiiTimer = setTimeout(async function () {
          try {
            var res = await sb.rpc('cauta_pescari_cont', { p_balta_id: _adminBaltaId, p_query: query });
            if (myToken !== _sugestiiToken) return;
            var rezultate = (!res.error && res.data) ? res.data : [];
            if (!rezultate.length) { ascundeSugestii(); return; }
            sugestiiEl.innerHTML = rezultate.map(function (p) {
              return '<div class="rez-autocomplete-item" data-nume="' + escH(p.username || '') + '">' + escH(p.username || '(fără nume)') +
                (p.zoda_id ? ' <span style="opacity:.6;">· ' + escH(p.zoda_id) + '</span>' : '') + '</div>';
            }).join('');
            sugestiiEl.style.display = 'block';
            Array.prototype.forEach.call(sugestiiEl.querySelectorAll('.rez-autocomplete-item'), function (item) {
              item.onclick = function () { numeInput.value = item.dataset.nume; ascundeSugestii(); };
            });
          } catch (e) { ascundeSugestii(); }
        }, 250);
      };
      // Delay la pierderea focusului, ca un click pe o sugestie să apuce să
      // se înregistreze înainte ca dropdown-ul să dispară (altfel blur-ul
      // ascunde lista chiar înainte de a procesa click-ul).
      numeInput.onblur = function () { setTimeout(ascundeSugestii, 150); };
    })();

    function randeazaStandGrid() {
      var grid = document.getElementById('rez-manual-stand-grid');
      grid.innerHTML = _adminStanduri.map(function (s, idx) {
        var selectat = _manualSelectie.indexOf(s.id) !== -1;
        var eticheta = s.nume || ('Stand ' + (idx + 1));
        return '<div class="rez-stand-cell' + (selectat ? ' selectat' : '') + '" data-stand-id="' + s.id + '">' + escH(eticheta) + '</div>';
      }).join('');
      Array.prototype.forEach.call(grid.querySelectorAll('.rez-stand-cell'), function (cell) {
        cell.onclick = function () {
          var id = parseInt(cell.dataset.standId, 10);
          if (_adminMultiplu) {
            var i = _manualSelectie.indexOf(id);
            if (i === -1) _manualSelectie.push(id); else _manualSelectie.splice(i, 1);
          } else {
            _manualSelectie = [id];
          }
          randeazaStandGrid();
          updateSubmitState();
        };
      });
    }

    function randeazaTipRow() {
      var b = _adminBalta || {};
      document.getElementById('rez-manual-tip-row').innerHTML =
        '<div class="rez-tip-card' + (_manualTip === '12h' ? ' active' : '') + '" data-tip="12h"><div class="rez-tip-card-title">Zi</div><div class="rez-tip-desc">' + escH((b.ora_zi_start || '06:00').slice(0, 5)) + '–' + escH((b.ora_zi_stop || '18:00').slice(0, 5)) + '</div></div>' +
        '<div class="rez-tip-card' + (_manualTip === '24h' ? ' active' : '') + '" data-tip="24h"><div class="rez-tip-card-title">24 ore</div><div class="rez-tip-desc">de la ' + escH((b.ora_noapte_start || '18:00').slice(0, 5)) + '</div></div>' +
        '<div class="rez-tip-card' + (_manualTip === 'personalizat' ? ' active' : '') + '" data-tip="personalizat"><div class="rez-tip-card-title">Personalizat</div><div class="rez-tip-desc">24h sau mai mult</div></div>';
      document.getElementById('rez-manual-tip-row').onclick = function (e) {
        var card = e.target.closest('.rez-tip-card');
        if (!card) return;
        _manualTip = card.dataset.tip;
        randeazaTipRow();
        randeazaDateFields();
        updateSubmitState();
      };
    }

    // Rundă 41 — cerere explicită a lui Marian: la „Adaugă manual”, data
    // apărea în ordinea americană (mm-dd-yyyy), nu zi-lună-an. Cauza: un
    // `<input type="date">` nativ e afișat de BROWSER, în formatul limbii
    // vizitatorului (setarea de limbă a browserului/sistemului de operare
    // al lui Marian, nu a paginii) — `value`-ul lui, `yyyy-mm-dd`, e fix,
    // cerut de standardul HTML pentru input-uri de tip dată, dar TEXTUL
    // afișat în widget-ul nativ nu e sub controlul CSS-ului paginii deloc.
    // Fix: atributul `lang="ro"`, direct pe fiecare `<input type="date">`
    // din tot fișierul (nu doar aici) — browserele native (confirmat pe
    // Chrome) formatează după limba ELEMENTULUI, dacă e specificată,
    // înaintea limbii implicite a browserului — deci ordinea devine
    // zi-lună-an peste tot, indiferent ce limbă are setată vizitatorul.
    // Notă onestă: separatorul exact (punct, cf. convenției românești a
    // widget-ului nativ, vs. liniuța folosită peste tot în rest, cf. rundă
    // 32) rămâne ales de browser, nu de noi — widget-ul nativ de dată nu
    // poate fi restilizat prin CSS ca să schimbe caracterul separator;
    // ordinea zi-lună-an, care era problema reală semnalată, e însă fixată.
    function randeazaDateFields() {
      var b = _adminBalta || {};
      var html2;
      if (_manualTip === 'personalizat') {
        html2 =
          '<div class="rez-field"><label>Din data</label><input type="date" lang="ro" id="rez-manual-data-start" min="' + minDateStr + '" value="' + minDateStr + '"></div>' +
          '<div class="rez-field"><label>Moment început</label><select id="rez-manual-mom-start"><option value="zi">Dimineață (' + escH((b.ora_zi_start || '06:00').slice(0, 5)) + ')</option><option value="noapte">Seară (' + escH((b.ora_noapte_start || '18:00').slice(0, 5)) + ')</option></select></div>' +
          '<div class="rez-field"><label>Până în data</label><input type="date" lang="ro" id="rez-manual-data-sfarsit" min="' + minDateStr + '" value="' + minDateStr + '"></div>' +
          '<div class="rez-field"><label>Moment sfârșit</label><select id="rez-manual-mom-sfarsit"><option value="zi">Dimineață (' + escH((b.ora_zi_start || '06:00').slice(0, 5)) + ')</option><option value="noapte" selected>Seară (' + escH((b.ora_noapte_start || '18:00').slice(0, 5)) + ')</option></select></div>';
      } else {
        html2 = '<div class="rez-field"><label>Data</label><input type="date" lang="ro" id="rez-manual-data-start" min="' + minDateStr + '" value="' + minDateStr + '"></div>';
      }
      document.getElementById('rez-manual-date-fields').innerHTML = html2;
      ['rez-manual-data-start', 'rez-manual-data-sfarsit', 'rez-manual-mom-start', 'rez-manual-mom-sfarsit'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.onchange = function () { actualizeazaAvertizareManual(); updateSubmitState(); };
      });
      actualizeazaAvertizareManual();
    }

    function actualizeazaAvertizareManual() {
      var dataStartInput = document.getElementById('rez-manual-data-start');
      var avertEl = document.getElementById('rez-manual-avert-tip');
      if (!avertEl) return;
      var motiv = dataStartInput ? motivIndisponibilSesiune(_adminBalta || {}, _manualTip, dataStartInput.value, _adminReguli) : null;
      avertEl.innerHTML = motiv ? '<div class="rez-text-warn" style="font-size:12.5px;margin:-6px 0 12px;">⚠️ ' + escH(motiv) + '</div>' : '';
    }

    function calculeazaIntervalManual() {
      var dataStartInput = document.getElementById('rez-manual-data-start');
      if (!dataStartInput || !dataStartInput.value) return null;
      if (_manualTip === 'personalizat') {
        var dataSfarsitInput = document.getElementById('rez-manual-data-sfarsit');
        var momStart = document.getElementById('rez-manual-mom-start').value;
        var momSfarsit = document.getElementById('rez-manual-mom-sfarsit').value;
        return calculeazaIntervalSesiune(_adminBalta || {}, _manualTip, dataStartInput.value, dataSfarsitInput ? dataSfarsitInput.value : null, momStart, momSfarsit, _adminReguli);
      }
      return calculeazaIntervalSesiune(_adminBalta || {}, _manualTip, dataStartInput.value, null, null, null, _adminReguli);
    }

    function updateSubmitState() {
      var btn = document.getElementById('rez-manual-submit');
      if (!btn) return;
      btn.disabled = !(_manualSelectie.length > 0 && calculeazaIntervalManual());
    }

    var multiCheck = document.getElementById('rez-manual-multiplu');
    multiCheck.onchange = function () {
      _adminMultiplu = multiCheck.checked;
      document.getElementById('rez-manual-stand-label').textContent = _adminMultiplu ? 'Standuri' : 'Stand';
      document.getElementById('rez-manual-selall').style.display = _adminMultiplu ? '' : 'none';
      if (!_adminMultiplu && _manualSelectie.length > 1) _manualSelectie = _manualSelectie.slice(0, 1);
      randeazaStandGrid();
      updateSubmitState();
    };

    document.getElementById('rez-manual-selall').onclick = function () {
      _manualSelectie = _adminStanduri.map(function (s) { return s.id; });
      randeazaStandGrid();
      updateSubmitState();
    };

    randeazaStandGrid();
    randeazaTipRow();
    randeazaDateFields();
    updateSubmitState();

    document.getElementById('rez-manual-submit').onclick = async function () {
      var btn = this;
      var standIds = _manualSelectie.slice();
      var interval = calculeazaIntervalManual();
      var nume = document.getElementById('rez-manual-nume').value.trim() || null;
      var telefon = document.getElementById('rez-manual-telefon').value.trim() || null;

      if (!standIds.length) { toast('Alege cel puțin un stand.', true); return; }
      if (!interval) { toast('Alege o dată validă.', true); return; }

      btn.disabled = true; btn.textContent = 'Se salvează...';
      try {
        var res;
        if (_adminMultiplu && standIds.length > 1) {
          res = await sb.rpc('adauga_rezervare_multipla_admin', {
            p_stand_ids: standIds, p_tip_sesiune: _manualTip,
            p_data_start: interval.start.toISOString(), p_data_sfarsit: interval.sfarsit.toISOString(),
            p_nume_client: nume, p_telefon_client: telefon
          });
        } else {
          res = await sb.rpc('adauga_rezervare_manuala', {
            p_stand_id: standIds[0], p_tip_sesiune: _manualTip,
            p_data_start: interval.start.toISOString(), p_data_sfarsit: interval.sfarsit.toISOString(),
            p_nume_client: nume, p_telefon_client: telefon
          });
        }
        if (res.error) throw res.error;
        toast('✓ Rezervare adăugată.');
        schimbaTabAdmin('calendar');
      } catch (e) {
        toast(e.message || 'Eroare la salvare.', true);
        btn.disabled = false; btn.textContent = 'Adaugă rezervarea';
        updateSubmitState();
      }
    };
  }

  // ── API public ───────────────────────────────────────────────────────────
  global.RezervariUI = {
    renderButonBalta: renderButonBalta,
    renderButonStand: renderButonStand,
    deschideModalRezervarileMele: deschideModalRezervarileMele,
    randeazaPanouAdmin: randeazaPanouAdmin,
    _closeModal: closeModal,
    _schimbaTabAdmin: schimbaTabAdmin
  };

})(window);
