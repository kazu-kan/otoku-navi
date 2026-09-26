'use strict';
/* おトクナビ — スマホのタッチ決済7%還元の店探し／払い方判定／キャンペーン／年間100万円管理
   データはすべてこの端末の localStorage に保存（外部送信なし）。
   外部通信: 地図タイル・お店データ（OpenStreetMap / Overpass）・地名検索（Nominatim）・data/*.json のみ。 */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (n) => Math.round(n).toLocaleString('ja-JP');
  const yen = (n) => '¥' + nf(n);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => ymd(new Date());

  const LIMIT = 10000;       // タッチ決済の上限（原則）
  const GOAL = 1000000;      // 年間100万円
  const COLORS = { store: '#0e7c66', mo: '#2f6fd6', club: '#7b3fb0', spot: '#a87400', you: '#d93025' };

  // ---------- 保存 ----------
  const KEY = 'otoku.v1';
  const DEFAULTS = () => ({
    settings: { phone: /android/i.test(navigator.userAgent) ? 'android' : 'iphone', brand: 'visa', radius: 1000, yearStart: '' },
    club: [], marks: {}, tx: [], vpDate: '', helpDone: false,
  });
  let S = load();
  function load() {
    const d = DEFAULTS();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const o = JSON.parse(raw);
        return { ...d, ...o, settings: { ...d.settings, ...(o.settings || {}) } };
      }
    } catch (e) { /* 使えない環境ではメモリのみ */ }
    return d;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('この端末に保存できませんでした（プライベートモード等）'); }
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------- データ ----------
  let CH = { chains: [], spots: [] };
  let CAMP = { items: [], updated: null, stores: null };
  async function loadData() {
    const [c, k] = await Promise.all([
      fetch('data/chains.json').then((r) => r.json()),
      fetch('data/campaigns.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => null),
    ]);
    CH = c;
    CH.chains.forEach((x) => { x.rx = new RegExp(x.re, 'i'); });
    CH.spots.forEach((s) => { s.arx = new RegExp(s.alias, 'i'); });
    if (k) CAMP = k;
  }
  const chainById = (id) => CH.chains.find((c) => c.id === id);
  const matchChain = (name) => {
    const t = String(name || '').normalize('NFKC');
    return CH.chains.find((c) => c.rx.test(t)) || null;
  };

  function dist(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`);
  function routeUrl(lat, lon) {
    return S.settings.phone === 'iphone'
      ? `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=w`
      : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=walking`;
  }

  // ---------- タブ ----------
  const TABS = ['search', 'pay', 'camp', 'year'];
  function go(tab) {
    if (!TABS.includes(tab)) tab = 'search';
    $$('.tab').forEach((s) => { s.hidden = s.dataset.tab !== tab; });
    $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.go === tab));
    if (location.hash.slice(1) !== tab) history.replaceState(null, '', location.pathname + location.search + '#' + tab);
    window.scrollTo(0, 0);
    if (tab === 'search' && map) setTimeout(() => map.invalidateSize(), 60);
    if (tab === 'year') renderYear();
    if (tab === 'pay') renderPay();
  }

  // =====================================================================
  // 探す
  // =====================================================================
  let map = null, layer = null, markerById = new Map();
  let last = null;      // 直近の検索 {lat, lon, label, kind:'here'|'place', pref}
  let stores = [];      // 表示中のお店
  let storeFilter = 'all';

  function initMap() {
    if (!window.L) {
      $('#map').innerHTML = '<p class="empty">地図を読み込めませんでした（オフライン？）。お店の一覧は使えます。</p>';
      return;
    }
    map = L.map('map', { zoomControl: true }).setView([35.2, 136.2], 5);
    const attr = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>' +
      ' | 店舗 &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
    const gsi = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', { maxZoom: 18, attribution: attr }).addTo(map);
    // 国土地理院の地図が読めないときは OpenStreetMap の地図に切り替える
    let errors = 0;
    gsi.on('tileerror', () => {
      if (++errors !== 6) return;
      map.removeLayer(gsi);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    });
    layer = L.layerGroup().addTo(map);
  }

  function setStatus(msg) { $('#search-status').textContent = msg; }

  // お店データ: monitor/build_stores.py が週1回作る 0.25度四方ごとのファイル（docs/data/stores/）を読む
  const CELL = 0.25;
  const cellCache = new Map();
  function loadCell(key) {
    if (!cellCache.has(key)) {
      const p = fetch(`data/stores/${key}.json`).then((res) => {
        if (res.status === 404) return [];          // 対象店のない地域
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
      p.catch(() => cellCache.delete(key));          // 通信エラーは次回やり直す
      cellCache.set(key, p);
    }
    return cellCache.get(key);
  }
  async function storesAround(lat, lon, r) {
    const dLat = r / 111000, dLon = r / (111000 * Math.cos(lat * Math.PI / 180));
    const keys = [];
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++) {
      for (let b = Math.floor((lon - dLon) / CELL); b <= Math.floor((lon + dLon) / CELL); b++) keys.push(`${a}_${b}`);
    }
    const out = [];
    for (const rows of await Promise.all(keys.map(loadCell))) {
      for (const [la, lo, id, nm] of rows) {
        const d = dist(lat, lon, la, lo);
        const c = chainById(id);
        if (d > r || !c) continue;
        out.push({ id: `o${la},${lo}`, type: 'store', chain: c, lat: la, lon: lo, name: nm || c.name, d });
      }
    }
    return out;
  }

  async function searchAt(lat, lon, label, kind, pref) {
    last = { lat, lon, label, kind, pref: pref || '' };
    const r = +$('#radius').value;
    setStatus(`${label}の周辺を探しています…`);
    if (map) {
      map.setView([lat, lon], r <= 500 ? 16 : r <= 1000 ? 15 : 14);
    }
    let found = [];
    let failed = false;
    try {
      found = await storesAround(lat, lon, r);
    } catch (e) {
      failed = true;
    }
    // クラブオフ登録店・特約スポット
    for (const c of S.club) {
      const d = dist(lat, lon, c.lat, c.lon);
      if (d <= r) found.push({ id: 'k' + c.id, type: 'club', club: c, chain: matchChain(c.name), lat: c.lat, lon: c.lon, name: c.name, d });
    }
    for (const s of CH.spots) {
      const d = dist(lat, lon, s.lat, s.lon);
      if (d <= Math.max(r, 1500)) found.push({ id: 's' + s.id, type: 'spot', spot: s, lat: s.lat, lon: s.lon, name: s.name, d });
    }
    found.sort((a, b) => ((b.type === 'spot') - (a.type === 'spot')) || a.d - b.d);  // 特約スポットを先頭に、あとは近い順
    stores = found;
    setStatus(failed
      ? 'お店データを読み込めませんでした。通信状態を確認してもう一度お試しください'
      : `${label}から半径${fmtDist(r)}に対象店 ${found.filter((s) => s.type === 'store').length} 件`);
    drawMarkers();
    renderStores();
    renderTrip();
  }

  function markerColor(s) {
    if (s.type === 'club') return COLORS.club;
    if (s.type === 'spot') return COLORS.spot;
    return s.chain.touch ? COLORS.store : COLORS.mo;
  }

  function badges(s) {
    const b = [];
    if (s.type === 'spot') b.push('<span class="tag gold">ここで7%</span>');
    if (s.type === 'club') b.push('<span class="tag club">クラブオフ</span>');
    const c = s.chain;
    if (c) {
      if (c.touch) b.push('<span class="tag">スマホでタッチ→7%</span>');
      if (c.mo) b.push(`<span class="tag${c.touch ? ' gray' : ''}">アプリ注文→7%</span>`);
      if (c.partial) b.push('<span class="tag warn">対象外の店舗あり</span>');
    }
    return b.join('');
  }

  function popupHtml(s) {
    const sub = s.type === 'club' ? esc(s.club.memo || '') : s.type === 'spot' ? '' : esc(s.chain.cat);
    return `<b>${esc(s.name)}</b>${sub ? `<span class="small">${sub}</span><br>` : ''}${badges(s)}<br>` +
      `<a href="${routeUrl(s.lat, s.lon)}" target="_blank" rel="noopener">経路を開く</a>`;
  }

  function drawMarkers() {
    if (!map) return;
    layer.clearLayers();
    markerById = new Map();
    if (last) {
      L.circleMarker([last.lat, last.lon], { radius: 7, color: '#fff', weight: 3, fillColor: COLORS.you, fillOpacity: 1 })
        .bindTooltip(last.kind === 'here' ? '現在地' : last.label).addTo(layer);
      L.circle([last.lat, last.lon], { radius: +$('#radius').value, color: COLORS.store, weight: 1, fillOpacity: 0.04 }).addTo(layer);
    }
    for (const s of stores) {
      const m = L.circleMarker([s.lat, s.lon], { radius: s.type === 'store' ? 7 : 9, color: '#fff', weight: 2, fillColor: markerColor(s), fillOpacity: 1 })
        .bindPopup(popupHtml(s)).addTo(layer);
      markerById.set(s.id, m);
    }
  }

  function passFilter(s) {
    switch (storeFilter) {
      case 'コンビニ': return s.chain?.cat === 'コンビニ';
      case 'food': return s.chain && s.chain.cat !== 'コンビニ';
      case 'mo': return !!s.chain?.mo;
      case 'club': return s.type === 'club';
      default: return true;
    }
  }

  function renderStores() {
    const ul = $('#store-list');
    if (!last) { ul.innerHTML = ''; return; }
    const list = stores.filter(passFilter);
    if (!list.length) {
      ul.innerHTML = `<li class="empty">${storeFilter === 'club' ? 'この範囲にクラブオフ登録店はありません' : '該当するお店が見つかりませんでした（地図データに未登録のお店もあります）'}</li>`;
      return;
    }
    ul.innerHTML = list.slice(0, 150).map((s) => `
      <li data-id="${esc(s.id)}">
        <span class="dot${s.type === 'club' ? ' club' : s.type === 'spot' ? ' gold' : ''}" style="background:${markerColor(s)}"></span>
        <div class="grow">
          <div class="name">${esc(s.name)}</div>
          <div class="sub">${badges(s)}${s.type === 'club' && s.club.memo ? ' ' + esc(s.club.memo) : ''}</div>
        </div>
        <div style="text-align:right">
          <div class="dist">${fmtDist(s.d)}</div>
          <button class="linkish" data-act="pay">払い方</button>
        </div>
      </li>`).join('');
  }

  function focusStore(id) {
    const m = markerById.get(id);
    if (m && map) {
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 16));
      m.openPopup();
      $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ---------- 行き先 ----------
  const REGIONS = {
    北海道: ['北海道'], 東北: ['青森', '岩手', '宮城', '秋田', '山形', '福島'],
    関東: ['東京', '神奈川', '千葉', '埼玉', '茨城', '栃木', '群馬', '山梨'],
    北信越: ['新潟', '富山', '石川', '福井', '長野'], 東海: ['愛知', '岐阜', '静岡', '三重'],
    関西: ['大阪', '京都', '兵庫', '奈良', '滋賀', '和歌山'], 中国: ['鳥取', '島根', '岡山', '広島', '山口'],
    四国: ['徳島', '香川', '愛媛', '高知'], 九州: ['福岡', '佐賀', '長崎', '熊本', '大分', '宮崎', '鹿児島'], 沖縄: ['沖縄'],
  };
  function prefOf(x) {
    const a = x.address || {};
    const p = a.province || a.state || '';
    if (p) return p;
    const m = (x.display_name || '').match(/(北海道|東京都|京都府|大阪府|[^\s,、]{2,3}県)/);
    return m ? m[1] : '';
  }
  async function geocode(q) {
    const sp = CH.spots.find((s) => s.arx.test(q));
    if (sp) return [{ lat: sp.lat, lon: sp.lon, label: sp.name, pref: sp.pref }];
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      format: 'jsonv2', q, countrycodes: 'jp', limit: '5', addressdetails: '1', 'accept-language': 'ja',
    });
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (j.length) return j.map((x) => ({ lat: +x.lat, lon: +x.lon, label: x.name || q, full: x.display_name, pref: prefOf(x) }));
    } catch (e) { /* 下の国土地理院の住所検索で再挑戦 */ }
    const res2 = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q));
    if (!res2.ok) throw new Error('HTTP ' + res2.status);
    return (await res2.json()).slice(0, 5).map((x) => ({
      lat: x.geometry.coordinates[1], lon: x.geometry.coordinates[0], label: x.properties.title, full: x.properties.title,
      pref: (x.properties.title.match(/^(北海道|東京都|京都府|大阪府|.{2,3}県)/) || [''])[0],
    }));
  }

  function activeCampaigns() {
    const t = todayStr();
    return (CAMP.items || []).filter((c) => !c.end || c.end >= t);
  }

  function placeWords(p) {
    const words = new Set();
    const pref = (p.pref || '').replace(/[都府県]$/, '');
    if (pref) {
      words.add(pref);
      for (const [region, prefs] of Object.entries(REGIONS)) if (prefs.includes(pref)) words.add(region);
    }
    String(p.label || '').split(/[\s、,・]/).filter((w) => w.length >= 2).forEach((w) => words.add(w));
    if (CH.spots.some((s) => s.id === 'usj' && (s.arx.test(p.label || '') || dist(p.lat, p.lon, s.lat, s.lon) < 3000))) {
      words.add('USJ'); words.add('ユニバーサル');
    }
    return [...words];
  }

  function renderTrip() {
    const el = $('#trip');
    if (!last) { el.hidden = true; return; }
    const parts = [];
    for (const s of CH.spots) {
      if (dist(last.lat, last.lon, s.lat, s.lon) <= Math.max(+$('#radius').value, 1500)) {
        parts.push(`<div class="item"><span class="tag gold">7%になる場所</span><b>${esc(s.name)}</b>
          <div class="small">${esc(s.note)}</div><a class="small" href="${esc(s.url)}" target="_blank" rel="noopener">公式ページを開く</a></div>`);
      }
    }
    if (last.kind === 'place') {
      const words = placeWords(last);
      const hit = [], travel = [];
      for (const c of activeCampaigns()) {
        if (S.marks[c.id]?.hidden) continue;
        const text = `${c.title} ${c.summary || ''} ${c.area || ''}`;
        if (words.some((w) => text.includes(w))) hit.push(c);
        else if (!c.area && /旅行|ホテル|宿|トリップ|乗車|交通|観光/.test(text)) travel.push(c);
      }
      const line = (c) => `<div class="item">${c.entry ? '<span class="tag warn">エントリー要</span>' : ''}${c.area ? `<span class="tag gray">${esc(c.area)}</span>` : ''}
        <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(cleanTitle(c.title))}</a>${c.end ? `<div class="small muted">〜${fmtDate(c.end)}</div>` : ''}</div>`;
      if (hit.length) parts.push(`<h3>この行き先に関係するキャンペーン</h3>${hit.map(line).join('')}`);
      if (travel.length) parts.push(`<h3>おでかけで使えそうなキャンペーン</h3>${travel.slice(0, 4).map(line).join('')}`);
      parts.push(`<h3>宿・レジャー・グルメの優待</h3><div class="item small">クラブオフでホテル・レジャー施設・飲食店の優待を探せます（要ログイン）。
        <div class="btn-row"><a class="btn" href="https://www.club-off.com/metlife_n/apps/top/fftop_main.cfm?action=1" target="_blank" rel="noopener">クラブオフで探す</a></div></div>`);
    }
    if (!parts.length) { el.hidden = true; return; }
    el.innerHTML = `<h2>${last.kind === 'place' ? '🧳 ' + esc(last.label) + ' のおトク情報' : '📍 近くの特別スポット'}</h2>${parts.join('')}`;
    el.hidden = false;
  }

  function renderPlaceChoices(cands, chosen) {
    const box = $('#place-choices');
    if (cands.length <= 1) { box.hidden = true; return; }
    box.innerHTML = '<span class="small muted" style="align-self:center;flex:none">候補:</span>' + cands.map((c, i) =>
      `<button class="chip${i === chosen ? ' on' : ''}" data-i="${i}" title="${esc(c.full || '')}">${esc(c.label)}${c.pref ? `（${esc(c.pref)}）` : ''}</button>`).join('');
    box.hidden = false;
    box.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const c = cands[+b.dataset.i];
      renderPlaceChoices(cands, +b.dataset.i);
      searchAt(c.lat, c.lon, c.label, 'place', c.pref);
    };
  }

  function locateHere() {
    if (!navigator.geolocation) { setStatus('この端末では現在地を使えません'); return; }
    setStatus('現在地を取得しています…');
    $('#place-choices').hidden = true;
    navigator.geolocation.getCurrentPosition(
      (p) => searchAt(p.coords.latitude, p.coords.longitude, '現在地', 'here'),
      (err) => setStatus(err.code === 1
        ? '位置情報がオフです。スマホの設定でブラウザ（またはこのアプリ）の位置情報を許可してください'
        : '現在地を取得できませんでした。電波の良い場所でもう一度お試しください'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  // 位置情報をすでに許可済みなら、開いた瞬間に現在地の周辺を表示する
  async function autoLocate() {
    try {
      const st = await navigator.permissions?.query({ name: 'geolocation' });
      if (st?.state === 'granted') locateHere();
    } catch (e) { /* Permissions API 非対応の端末はボタンで */ }
  }

  function showHelp(force) {
    const el = $('#help');
    el.hidden = !force && !!S.helpDone;
  }

  function bindSearch() {
    showHelp();
    $('#btn-help-ok').onclick = () => { S.helpDone = true; save(); showHelp(); };

    $('#radius').value = String(S.settings.radius);
    $('#btn-here').onclick = locateHere;
    $('#search-form').onsubmit = async (e) => {
      e.preventDefault();
      const q = $('#q').value.trim();
      if (!q) return;
      $('#q').blur();
      setStatus(`「${q}」を探しています…`);
      try {
        const cands = await geocode(q);
        if (!cands.length) { setStatus(`「${q}」が見つかりませんでした。駅名や施設名で試してください`); return; }
        renderPlaceChoices(cands, 0);
        searchAt(cands[0].lat, cands[0].lon, cands[0].label, 'place', cands[0].pref);
      } catch (err) {
        setStatus('地名の検索に失敗しました。通信状態を確認してください');
      }
    };
    $('#radius').onchange = () => { if (last) searchAt(last.lat, last.lon, last.label, last.kind, last.pref); };
    $('#btn-center').onclick = () => {
      if (!map) return;
      const c = map.getCenter();
      searchAt(c.lat, c.lng, '地図の中心', last?.kind === 'place' ? 'place' : 'here', last?.pref);
    };
    $('#store-filter').onclick = (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      storeFilter = b.dataset.f;
      $$('#store-filter .chip').forEach((x) => x.classList.toggle('on', x === b));
      renderStores();
    };
    $('#store-list').onclick = (e) => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      const s = stores.find((x) => x.id === li.dataset.id);
      if (!s) return;
      if (e.target.closest('[data-act="pay"]')) {
        const v = s.type === 'club' ? 'k:' + s.club.id : s.type === 'spot' ? 's:' + s.spot.id : 'c:' + s.chain.id;
        openPay(v);
        return;
      }
      focusStore(s.id);
    };
  }

  // ---------- クラブオフ登録 ----------
  function renderClub() {
    const ul = $('#club-list');
    $('#club-app-link').href = S.settings.phone === 'android'
      ? 'https://play.google.com/store/search?q=%E3%82%AF%E3%83%A9%E3%83%96%E3%82%AA%E3%83%95&c=apps'
      : 'https://apps.apple.com/jp/app/id1273907949';
    if (!S.club.length) { ul.innerHTML = '<li class="empty">まだ登録はありません</li>'; return; }
    ul.innerHTML = S.club.map((c) => {
      const ch = matchChain(c.name);
      return `<li data-id="${esc(c.id)}"><span class="dot club"></span>
        <div class="grow"><div class="name">${esc(c.name)}</div><div class="sub">${esc(c.memo || '')}${ch ? ' <span class="tag">スマホでタッチ→7%も</span>' : ''}</div></div>
        <button class="linkish" data-act="map">地図</button><button class="linkish" data-act="del" style="color:var(--danger)">削除</button></li>`;
    }).join('');
  }
  function bindClub() {
    const dlg = $('#dlg-club');
    $('#btn-club-add').onclick = () => { $('#club-form').reset(); dlg.showModal(); };
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return;
      const name = $('#club-name').value.trim();
      if (!name) return;
      const memo = $('#club-memo').value.trim();
      const add = (lat, lon) => {
        S.club.push({ id: uid(), name, memo, lat, lon });
        save(); renderClub(); fillPayStores();
        if (last) searchAt(last.lat, last.lon, last.label, last.kind, last.pref);
        toast('登録しました');
      };
      if ($('#club-pos').value === 'here' && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((p) => add(p.coords.latitude, p.coords.longitude),
          () => toast('現在地を取得できなかったため登録できませんでした'), { enableHighAccuracy: true, timeout: 12000 });
      } else if (map) {
        const c = map.getCenter();
        add(c.lat, c.lng);
      } else {
        toast('地図が使えないため登録できませんでした');
      }
    });
    $('#club-list').onclick = (e) => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      const c = S.club.find((x) => x.id === li.dataset.id);
      if (!c) return;
      if (e.target.closest('[data-act="del"]')) {
        if (!confirm(`「${c.name}」を削除しますか？`)) return;
        S.club = S.club.filter((x) => x !== c);
        save(); renderClub(); fillPayStores();
        if (last) searchAt(last.lat, last.lon, last.label, last.kind, last.pref);
      } else if (e.target.closest('[data-act="map"]')) {
        searchAt(c.lat, c.lon, c.name, 'here');
        $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };
  }

  // =====================================================================
  // 払い方
  // =====================================================================
  function fillPayStores() {
    const sel = $('#pay-store');
    const cur = sel.value;
    let h = '<option value="">お店を選んでください</option>';
    for (const cat of ['コンビニ', 'ファストフード', 'ファミレス', 'カフェ']) {
      h += `<optgroup label="${cat}">` + CH.chains.filter((c) => c.cat === cat).map((c) => `<option value="c:${c.id}">${esc(c.name)}</option>`).join('') + '</optgroup>';
    }
    h += '<optgroup label="7%になる場所">' + CH.spots.map((s) => `<option value="s:${s.id}">${esc(s.name)}</option>`).join('') + '</optgroup>';
    if (S.club.length) h += '<optgroup label="クラブオフ登録店">' + S.club.map((c) => `<option value="k:${c.id}">${esc(c.name)}</option>`).join('') + '</optgroup>';
    h += '<optgroup label="その他"><option value="other">上記以外のお店</option></optgroup>';
    sel.innerHTML = h;
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  function openPay(v) {
    fillPayStores();
    $('#pay-store').value = v;
    go('pay');
    if (!$('#pay-amount').value) $('#pay-amount').focus();
  }

  const ptsTouch = (amt) => Math.floor(amt / 200) * 14;  // 7%（200円ごと）
  const ptsNormal = (amt) => Math.floor(amt / 200);     // 通常0.5%（200円ごとに1pt）

  function relatedByName(name) {
    if (!name) return [];
    const words = String(name).normalize('NFKC').split(/[\s・、,]/).filter((w) => w.length >= 2);
    return activeCampaigns().filter((c) => words.some((w) => c.title.includes(w))).slice(0, 3);
  }

  function renderPay() {
    const v = $('#pay-store').value;
    const amt = Math.max(0, Math.floor(+$('#pay-amount').value || 0));
    $('#pay-other-wrap').hidden = v !== 'other';
    const out = $('#pay-result');
    if (!v) {
      out.innerHTML = '<div class="card small muted">お店と金額を入れると、いちばんおトクな払い方とポイントの目安を表示します。</div>';
      return;
    }
    const phone = S.settings.phone, brand = S.settings.brand;
    const wallet = phone === 'android' ? 'Google Pay' : 'Apple Pay';
    const brandName = brand === 'master' ? 'Mastercard' : 'Visa';
    let chain = null, spot = null, club = null, name = '';
    if (v.startsWith('c:')) chain = chainById(v.slice(2));
    else if (v.startsWith('s:')) spot = CH.spots.find((s) => s.id === v.slice(2));
    else if (v.startsWith('k:')) { club = S.club.find((c) => c.id === v.slice(2)); chain = club && matchChain(club.name); name = club?.name; }
    else if (v === 'other') { name = $('#pay-other').value.trim(); chain = name ? matchChain(name) : null; }
    if (chain) name = name || chain.name;
    if (spot) name = spot.name;

    const notes = [];
    let how, cls = 'result', special = false;
    const androidMaster = phone === 'android' && brand === 'master';

    if (club) {
      notes.push(`<span class="w">クラブオフ優待:</span> ${esc(club.memo || '（内容未登録）')} — 会計の前にクーポン・会員証の提示を忘れずに。カード払いとの併用条件は優待ページで確認`);
    }

    if (spot) {
      special = !androidMaster;
      how = `${wallet}の${brandName}タッチ決済で払う`;
      notes.push(esc(spot.note));
      notes.push(`<a href="${esc(spot.url)}" target="_blank" rel="noopener">公式ページで最新の条件を確認</a>`);
    } else if (chain && chain.touch) {
      special = true;
      how = `スマホ（${wallet}）の${brandName}タッチ決済で払う`;
      if (chain.mo) notes.push('公式アプリのモバイルオーダーで払っても7%の対象');
    } else if (chain && chain.mo) {
      // スターバックス: アプリ経由のApple Payモバイルオーダーのみ
      if (phone === 'iphone') {
        special = true;
        how = 'スターバックスアプリのモバイルオーダーで Apple Pay 払い';
        notes.push('<span class="w">店頭レジでのタッチ決済は7%の対象外</span>。スターバックス カードへのチャージも対象外');
      } else {
        how = '通常のクレジット払い';
        notes.push('<span class="w">7%の対象はアプリ経由のApple Payだけのため、Androidでは対象外</span>');
      }
    } else {
      how = '通常のクレジット払い（0.5%）';
    }

    if (special && androidMaster && !spot && chain && chain.touch) {
      special = false;
      how = '通常のクレジット払い（このままでは7%対象外）';
      notes.unshift('<span class="w">Google PayではMastercardのタッチ決済が使えません。</span>Visaのカードを追加で持つ（2ブランド同時に持てます）とスマホタッチ7%が使えます');
    }
    if (special && amt > LIMIT) {
      cls = 'result warn';
      notes.unshift(`<span class="w">原則1万円を超えるとタッチ決済ができず、カードの差し込みになって7%の対象外</span>（その場合は約${nf(ptsNormal(amt))}pt）。会計を1万円以下に分けられれば7%を受けられます`);
    }
    if (chain?.partial) notes.push(`<span class="w">${esc(chain.name)}は対象外の店舗があります</span>（公式の対象店舗一覧を確認）`);
    if (chain?.tip && !(chain.mo && !chain.touch)) notes.push(esc(chain.tip));
    if (special) {
      notes.push('カード現物のタッチ決済・iD・カードの差し込みは7%の対象外。商業施設の中の店舗など、一部対象外の店舗もあります');
    } else {
      if (!chain && !spot) {
        notes.push('近くに7%対象のコンビニ・飲食店があれば、そちらで買うと多くもらえます（「探す」で確認）');
      }
      if (androidMaster) notes.push('Android＋Mastercardの組み合わせは、スマホタッチ7%の対象外です');
    }
    notes.push('このお支払いも年間100万円の集計に入ります');

    if (!special) cls = 'result normal';
    const related = relatedByName(name);
    const tp = ptsTouch(amt), np = ptsNormal(amt);
    out.innerHTML = `
      <div class="card ${cls}">
        <div class="small muted">${esc(name || 'このお店')}</div>
        <div class="how">${esc(how)}</div>
        ${amt > 0 ? `<div class="points">
          ${special ? `<div><div class="k">${amt > LIMIT ? '1万円以下に分けて払えば（7%）' : 'この払い方なら（7%）'}</div><div class="v big">${nf(tp)} pt</div></div>` : ''}
          <div><div class="k">${special ? 'ふつうに払うと（0.5%）' : 'もらえるポイント（0.5%）'}</div><div class="v">${nf(np)} pt</div></div>
          ${special ? `<div><div class="k">差</div><div class="v">+${nf(tp - np)} pt</div></div>` : ''}
        </div>` : '<p class="small muted">金額を入れるとポイントの目安を表示します。</p>'}
        <ul class="notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>
      </div>
      ${related.length ? `<div class="card"><h2>関係しそうなキャンペーン</h2>${related.map((c) =>
        `<div class="small" style="margin-top:6px">${c.entry ? '<span class="tag warn">エントリー要</span>' : ''}<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(cleanTitle(c.title))}</a></div>`).join('')}</div>` : ''}
      <p class="small muted">ポイントは200円（税込）ごとの計算の目安です。1pt＝1円相当。</p>`;
  }

  function bindPay() {
    $('#pay-store').onchange = renderPay;
    $('#pay-amount').oninput = renderPay;
    $('#pay-other').oninput = renderPay;
    $$('#tab-pay [data-amt]').forEach((b) => { b.onclick = () => { $('#pay-amount').value = b.dataset.amt; renderPay(); }; });
  }

  // =====================================================================
  // キャンペーン
  // =====================================================================
  let campFilter = 'all';
  const WD = '日月火水木金土';
  function fmtDate(iso) {
    if (!iso) return '?';
    const d = new Date(iso + 'T00:00:00');
    return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  }
  // 「〇〇キャンペーン」を開催！ → 〇〇キャンペーン のように読みやすくする
  function cleanTitle(t) {
    return String(t || '').trim()
      .replace(/[」』]?\s*を(開催|実施)(いた)?し?(ます)?[！!。]?$/, '')
      .replace(/^[「『]/, '').replace(/[」』]$/, '').trim();
  }

  function daysLeft(c) {
    if (!c.end) return null;
    const end = new Date(c.end + 'T00:00:00'), t = new Date(todayStr() + 'T00:00:00');
    return Math.round((end - t) / 86400000);
  }

  function renderCamps() {
    const all = activeCampaigns();
    let list = campFilter === 'hidden' ? all.filter((c) => S.marks[c.id]?.hidden) : all.filter((c) => !S.marks[c.id]?.hidden);
    if (campFilter === 'entry') list = list.filter((c) => c.entry);
    if (campFilter === 'soon') list = list.filter((c) => { const d = daysLeft(c); return d !== null && d <= 7; });
    if (campFilter === 'prio') list = list.filter((c) => c.priority);
    list.sort((a, b) => (a.end || '9999') < (b.end || '9999') ? -1 : (a.end || '9999') > (b.end || '9999') ? 1 : (b.priority - a.priority));

    $('#camp-updated').textContent = CAMP.updated ? `最終チェック: ${CAMP.updated}` : 'まだキャンペーン情報がありません';
    const box = $('#camp-list');
    if (!list.length) {
      box.innerHTML = `<div class="card empty">${campFilter === 'hidden' ? '非表示にしたキャンペーンはありません' : '該当するキャンペーンはありません'}</div>`;
    } else {
      const t = todayStr();
      box.innerHTML = list.map((c) => {
        const m = S.marks[c.id] || {};
        const d = daysLeft(c);
        const isNew = c.published && (new Date(t) - new Date(c.published)) / 86400000 <= 3;
        const tags = [
          isNew ? '<span class="tag">NEW</span>' : '',
          c.priority ? '<span class="tag gold">注目</span>' : '',
          c.entry === true ? '<span class="tag warn">エントリー要</span>' : c.entry === false ? '<span class="tag gray">エントリー不要</span>' : '<span class="tag gray">エントリー要否は要確認</span>',
          d !== null && d <= 7 ? `<span class="tag warn">あと${d}日</span>` : '',
          c.area ? `<span class="tag gray">${esc(c.area)}</span>` : '',
          m.done ? '<span class="tag">✓ エントリー済み</span>' : '',
        ].join('');
        const period = c.start || c.end ? `期間: ${fmtDate(c.start)}〜${fmtDate(c.end)}${d !== null ? `（あと${d}日）` : ''}` : '期間: 記事で確認';
        return `<article class="card camp${m.done ? ' done' : ''}${c.entry && !m.done ? ' entry-todo' : ''}" data-id="${esc(c.id)}">
          <div>${tags}</div>
          <h3>${esc(cleanTitle(c.title))}</h3>
          <div class="period">${period}</div>
          ${c.summary ? `<p class="summary">${esc(c.summary)}</p>` : ''}
          <div class="btn-row">
            <a class="btn primary" href="${esc(c.url)}" target="_blank" rel="noopener">詳しく見る</a>
            ${c.entry ? `<button class="btn" data-act="done">${m.done ? 'エントリー済みを取り消す' : '✓ エントリーした'}</button>` : ''}
            <button class="btn" data-act="hide">${m.hidden ? '表示に戻す' : '関係ない'}</button>
          </div>
        </article>`;
      }).join('');
    }
    // タブのバッジ: エントリーが必要でまだ済んでいないもの
    const todo = all.filter((c) => c.entry && !S.marks[c.id]?.done && !S.marks[c.id]?.hidden).length;
    const badge = $('#camp-badge');
    badge.textContent = todo; badge.hidden = !todo;
    renderStoreWatch();
  }

  function renderStoreWatch() {
    const el = $('#store-watch');
    const st = CAMP.stores;
    if (!st || !st.front?.length) { el.hidden = true; return; }
    const names = [...st.front, ...st.mobile];
    const unknown = names.filter((n) => !/その他すかいらーく/.test(n) && !matchChain(n));
    el.hidden = false;
    el.innerHTML = `<h2>7%還元の対象店（公式ページ）</h2>
      <p class="small muted">${esc(st.checked)} に確認。変更があれば通知でお知らせします。</p>
      <p class="small"><b>店頭（スマホのタッチ決済）:</b> ${st.front.map(esc).join('、')}</p>
      <p class="small"><b>モバイルオーダー:</b> ${st.mobile.map(esc).join('、')}</p>
      ${unknown.length ? `<p class="small" style="color:var(--warn)"><b>アプリ未対応の新しい対象店:</b> ${unknown.map(esc).join('、')}（地図検索にはまだ出ません）</p>` : ''}
      <a class="small" href="${esc(st.url)}" target="_blank" rel="noopener">公式ページを開く</a>`;
  }

  function bindCamps() {
    $('#camp-filter').onclick = (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      campFilter = b.dataset.f;
      $$('#camp-filter .chip').forEach((x) => x.classList.toggle('on', x === b));
      renderCamps();
    };
    $('#camp-list').onclick = (e) => {
      const btn = e.target.closest('[data-act]');
      const card = e.target.closest('[data-id]');
      if (!btn || !card) return;
      const id = card.dataset.id;
      const m = S.marks[id] || (S.marks[id] = {});
      if (btn.dataset.act === 'done') m.done = !m.done;
      if (btn.dataset.act === 'hide') m.hidden = !m.hidden;
      save(); renderCamps();
    };
    $('#btn-notify-help').onclick = () => $('#dlg-notify').showModal();
  }

  // =====================================================================
  // 年間100万円
  // =====================================================================
  const EXCLUDE_TX = /年会費|手数料|キャッシング|利息/;
  // 明細の店名が7%対象（チェーン・特約スポット）ならその名前を返す
  function specialName(store) {
    const c = matchChain(store);
    if (c && (c.touch || c.mo)) return c.name;
    const s = CH.spots.find((x) => x.arx.test(String(store || '').normalize('NFKC')));
    return s ? s.name : null;
  }
  function yearRange() {
    let ym = S.settings.yearStart;
    if (!/^\d{4}-\d{2}$/.test(ym || '')) {
      const d = new Date();
      ym = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      const dates = S.tx.map((t) => t.date).sort();
      if (dates.length) ym = dates[0].slice(0, 7);
    }
    const [y, m] = ym.split('-').map(Number);
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(y, m - 1 + i, 1);
      months.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
    }
    const endD = new Date(y, m - 1 + 12, 0);
    return { ym, start: `${months[0]}-01`, end: ymd(endD), months, startD: new Date(y, m - 1, 1), endD };
  }

  function renderYear() {
    const R = yearRange();
    $('#year-start').value = S.settings.yearStart || '';
    const tx = S.tx.filter((t) => !t.ex && t.date >= R.start && t.date <= R.end);
    const total = tx.reduce((a, t) => a + t.amount, 0);
    const now = new Date();
    const totalDays = (R.endD - R.startD) / 86400000 + 1;
    const elapsed = Math.min(Math.max((now - R.startD) / 86400000, 0), totalDays);
    const monthsLeft = Math.max(1, R.months.filter((m) => m >= todayStr().slice(0, 7)).length);
    const remain = Math.max(0, GOAL - total);
    const projection = elapsed > 14 ? total / elapsed * totalDays : null;
    const pct = Math.min(100, total / GOAL * 100);
    const unsetNote = S.settings.yearStart ? '' : '<p class="small" style="color:var(--warn)">集計開始月が未設定です。右上で設定してください（Vpassの「年間ご利用額」の集計期間に合わせる）。</p>';

    let verdict = '';
    if (!tx.length) verdict = '<div class="verdict ng">まだ明細がありません。下の「明細を取り込む」からCSVを読み込んでください。</div>';
    else if (total >= GOAL) verdict = '<div class="verdict ok">🎉 達成！ 翌年以降の年会費無料＋10,000ポイントの条件をクリアしています。</div>';
    else if (projection !== null && projection >= GOAL) verdict = `<div class="verdict ok">今のペースだと約${yen(projection)}で達成見込みです。</div>`;
    else if (projection !== null) verdict = `<div class="verdict ng">今のペースだと約${yen(projection)}で、${yen(GOAL - projection)}足りない見込み。残り${monthsLeft}か月で月${yen(remain / monthsLeft)}のペースが必要です。</div>`;

    $('#year-summary').innerHTML = `${unsetNote}
      <div class="big-num">${yen(total)} <span class="small muted">/ ${yen(GOAL)}</span></div>
      <div class="progress"><span style="width:${pct.toFixed(1)}%"></span></div>
      <div class="small muted">${pct.toFixed(1)}% ・ 集計期間 ${R.start.replace(/-/g, '/')}〜${R.end.replace(/-/g, '/')}</div>
      <div class="stats">
        <div><div class="k">あと</div><div class="v">${yen(remain)}</div></div>
        <div><div class="k">残り期間</div><div class="v">${monthsLeft}か月</div></div>
        <div><div class="k">必要なペース</div><div class="v">${remain ? yen(remain / monthsLeft) + '/月' : '達成済み'}</div></div>
        <div><div class="k">着地見込み</div><div class="v">${projection !== null ? yen(projection) : '—'}</div></div>
      </div>${verdict}
      <p class="small muted" style="margin-top:8px">年会費・手数料・キャッシングは除いて集計。一部のチャージ等も対象外の場合があります。正式な金額はVpassアプリで確認できます。</p>`;

    // 月ごと
    const byMonth = Object.fromEntries(R.months.map((m) => [m, 0]));
    for (const t of tx) byMonth[t.date.slice(0, 7)] += t.amount;
    const max = Math.max(GOAL / 12, ...Object.values(byMonth));
    const cur = todayStr().slice(0, 7);
    $('#year-bars').innerHTML = R.months.map((m) => {
      const v = byMonth[m];
      const h = Math.max(1, v / max * 100);
      const label = v ? (v >= 10000 ? (v / 10000).toFixed(1) + '万' : nf(v)) : '';
      return `<div class="bar${m > cur ? ' future' : ''}"><div class="col" style="height:${h}%" data-v="${label}"></div><div class="m">${+m.slice(5)}月</div></div>`;
    }).join('');
    $('#year-target').textContent = `目安: 月${yen(GOAL / 12)}ずつ使うと達成`;

    // 7%対象店での利用
    const seven = tx.map((t) => ({ t, name: specialName(t.store) })).filter((x) => x.name);
    const sevenSum = seven.reduce((a, x) => a + x.t.amount, 0);
    const sevenPts = seven.reduce((a, x) => a + (x.t.amount > 0 && x.t.amount <= LIMIT ? ptsTouch(x.t.amount) : ptsNormal(x.t.amount)), 0);
    const byChain = {};
    for (const x of seven) byChain[x.name] = (byChain[x.name] || 0) + x.t.amount;
    const top = Object.entries(byChain).sort((a, b) => b[1] - a[1]).slice(0, 5);
    $('#year-seven').innerHTML = `<h2>7%対象店での利用</h2>
      ${seven.length ? `<div class="stats">
        <div><div class="k">利用額（${seven.length}件）</div><div class="v">${yen(sevenSum)}</div></div>
        <div><div class="k">スマホタッチで払っていれば</div><div class="v" style="color:var(--accent)">約${nf(sevenPts)} pt</div></div>
      </div>
      <p class="small">${top.map(([n, v]) => `${esc(n)} ${yen(v)}`).join('・')}</p>
      <p class="small muted">明細からは払い方（スマホタッチか現物カードか）が分からないため、すべてスマホタッチで払った場合の目安です。</p>`
      : '<p class="small muted">この期間の明細に、7%対象のコンビニ・飲食店での利用はまだありません。</p>'}`;

    renderTxList();
    renderVp();
  }

  function renderTxList() {
    const list = [...S.tx].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 100);
    $('#tx-list').innerHTML = list.length ? list.map((t) => `<li data-id="${esc(t.id)}">
        <div class="grow"><div class="name">${esc(t.store || '（店名なし）')}</div><div class="sub">${t.date.replace(/-/g, '/')}${t.ex ? ' ・集計対象外' : ''}${matchChain(t.store) ? ' ・<span class="tag">7%対象店</span>' : ''}</div></div>
        <div class="dist">${yen(t.amount)}</div><button class="linkish" data-act="del" aria-label="削除" style="color:var(--danger)">×</button></li>`).join('')
      : '<li class="empty">明細はまだありません</li>';
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  const num = (s) => {
    const n = parseInt(String(s ?? '').normalize('NFKC').replace(/[,円\s]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const txKey = (t) => `${t.date}|${t.store}|${t.amount}`;

  function decode(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('shift_jis').decode(buf); }
  }

  async function importCsv(files) {
    let added = 0, dup = 0, bad = 0;
    for (const f of files) {
      const rows = parseCsv(decode(await f.arrayBuffer()).replace(/^﻿/, ''));
      const txs = [];
      for (const r of rows) {
        const m = String(r[0] || '').normalize('NFKC').trim().match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
        if (!m) continue;
        const amount = num(r[2]) ?? num(r[5]);
        if (amount === null) { bad++; continue; }
        const store = String(r[1] || '').normalize('NFKC').trim();
        txs.push({ date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, store, amount });
      }
      const have = new Map();
      for (const t of S.tx) have.set(txKey(t), (have.get(txKey(t)) || 0) + 1);
      const inFile = new Map();
      for (const t of txs) {
        const k = txKey(t);
        const n = (inFile.get(k) || 0) + 1;
        inFile.set(k, n);
        if (n > (have.get(k) || 0)) {
          S.tx.push({ ...t, id: uid(), ex: EXCLUDE_TX.test(t.store), src: 'csv' });
          have.set(k, n);
          added++;
        } else dup++;
      }
    }
    save();
    $('#csv-status').textContent = added || dup
      ? `${added}件を追加しました${dup ? `（${dup}件は取り込み済みのためスキップ）` : ''}`
      : '明細の行が見つかりませんでした。Vpassの「ご利用明細」のCSVか確認してください';
    if (!S.settings.yearStart && S.tx.length) toast('集計開始月を設定すると、正確なペースが出ます');
    renderYear();
  }

  function renderVp() {
    const v = S.vpDate;
    $('#vp-date').value = v || '';
    const el = $('#vp-result');
    if (!v) { el.innerHTML = ''; return; }
    const d = new Date(v + 'T00:00:00');
    const exp = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
    const left = Math.round((exp - new Date(todayStr() + 'T00:00:00')) / 86400000);
    el.innerHTML = `<div class="verdict ${left <= 60 ? 'ng' : 'ok'}">有効期限: ${exp.getFullYear()}/${exp.getMonth() + 1}/${exp.getDate()}（${left >= 0 ? `あと${left}日` : '期限切れの可能性'}）${left <= 60 && left >= 0 ? '<br>1ポイントでも貯める・使うと、期限が1年延びます' : ''}</div>`;
  }

  function bindYear() {
    $('#year-start').onchange = (e) => { S.settings.yearStart = e.target.value; save(); renderYear(); };
    $('#csv-input').onchange = (e) => { if (e.target.files.length) importCsv([...e.target.files]); e.target.value = ''; };
    $('#tx-date').value = todayStr();
    $('#tx-form').onsubmit = (e) => {
      e.preventDefault();
      const amount = num($('#tx-amount').value);
      if (amount === null) return;
      const store = $('#tx-store').value.trim().normalize('NFKC');
      S.tx.push({ id: uid(), date: $('#tx-date').value, store, amount, ex: EXCLUDE_TX.test(store), src: 'manual' });
      save();
      $('#tx-store').value = ''; $('#tx-amount').value = '';
      toast('追加しました');
      renderYear();
    };
    $('#tx-list').onclick = (e) => {
      if (!e.target.closest('[data-act="del"]')) return;
      const id = e.target.closest('li').dataset.id;
      S.tx = S.tx.filter((t) => t.id !== id);
      save(); renderYear();
    };
    $('#btn-tx-clear').onclick = () => {
      if (!S.tx.length || !confirm('取り込んだ明細をすべて削除しますか？')) return;
      S.tx = []; save(); renderYear();
    };
    $('#vp-date').onchange = (e) => { S.vpDate = e.target.value; save(); renderVp(); };
  }

  // =====================================================================
  // 設定・バックアップ
  // =====================================================================
  function bindSettings() {
    const dlg = $('#dlg-settings');
    $('#btn-settings').onclick = () => {
      $('#set-phone').value = S.settings.phone;
      $('#set-brand').value = S.settings.brand;
      $('#set-radius').value = String(S.settings.radius);
      dlg.showModal();
    };
    $('#set-phone').onchange = (e) => { S.settings.phone = e.target.value; save(); renderClub(); renderPay(); drawMarkers(); };
    $('#set-brand').onchange = (e) => { S.settings.brand = e.target.value; save(); renderPay(); };
    $('#set-radius').onchange = (e) => { S.settings.radius = +e.target.value; $('#radius').value = e.target.value; save(); };
    $('#btn-help-again').onclick = () => { showHelp(true); dlg.close(); go('search'); window.scrollTo(0, 0); };
    $('#btn-export').onclick = async () => {
      const blob = new Blob([JSON.stringify({ app: 'otoku-navi', exported: new Date().toISOString(), data: S }, null, 1)], { type: 'application/json' });
      const fname = `otoku-navi-backup-${todayStr()}.json`;
      const file = new File([blob], fname, { type: 'application/json' });
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'おトクナビ バックアップ' }); return; }
      } catch (e) { if (e.name === 'AbortError') return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    $('#import-input').onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const o = JSON.parse(await f.text());
        if (o.app !== 'otoku-navi' || !o.data) throw new Error('形式が違います');
        if (!confirm('いまのデータを、バックアップの内容で置き換えますか？')) return;
        const d = DEFAULTS();
        S = { ...d, ...o.data, settings: { ...d.settings, ...(o.data.settings || {}) } };
        save(); renderAll();
        toast('読み込みました');
      } catch (err) {
        toast('読み込めませんでした: ' + err.message);
      }
    };
  }

  function renderAll() {
    fillPayStores(); renderClub(); renderCamps(); renderPay(); renderYear();
    if (last) searchAt(last.lat, last.lon, last.label, last.kind, last.pref);
  }

  // =====================================================================
  // 起動
  // =====================================================================
  async function start() {
    $$('.tabbar button').forEach((b) => { b.onclick = () => go(b.dataset.go); });
    window.addEventListener('hashchange', () => go(location.hash.slice(1)));
    try {
      await loadData();
    } catch (e) {
      $('main').insertAdjacentHTML('afterbegin', '<div class="card" style="color:var(--danger)">データを読み込めませんでした。通信状態を確認して再読み込みしてください。</div>');
      return;
    }
    initMap();
    bindSearch(); bindClub(); bindPay(); bindCamps(); bindYear(); bindSettings();
    fillPayStores(); renderClub(); renderCamps(); renderPay();
    go(location.hash.slice(1) || 'search');

    // 動作確認用: ?at=緯度,経度 でその場所を「現在地」として検索
    const at = new URLSearchParams(location.search).get('at');
    if (at && /^-?[\d.]+,-?[\d.]+$/.test(at)) {
      const [la, lo] = at.split(',').map(Number);
      searchAt(la, lo, '指定地点', 'here');
    } else if ((location.hash.slice(1) || 'search') === 'search') {
      autoLocate();
    }
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      // アプリが更新されたら、新しい版に切り替わった時点で1回だけ読み込み直す
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
  start();
})();
