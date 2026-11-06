// Painel administrativo da Frente Capital.
//
// Só chama as funções admin_* de supabase/admin_dashboard.sql, que conferem
// public.app_admins no servidor. Nada aqui concede acesso: esconder um botão
// não protege nada, quem protege é o banco. Todo texto vindo do banco entra
// na página como texto (el()), nunca como HTML.
'use strict';
(() => {
  // Clickjacking: another site could load this panel in an invisible
  // iframe (with the admin's own session) and trick a click on "suspender"
  // or "PRO". GitHub Pages can't send X-Frame-Options, and CSP
  // frame-ancestors is ignored in a <meta>, so refuse to run framed.
  if (window.top !== window.self) {
    document.documentElement.replaceChildren();
    return;
  }
  const CFG = window.ADMIN_CONFIG || {};
  const LOCAL = CFG.mode === 'local';
  const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  // Subresource Integrity: the browser refuses the file if the CDN ever
  // serves something else, so a compromised CDN cannot run code with the
  // admin's session. Changing the version above requires a new hash
  // (openssl dgst -sha384 -binary supabase.js | openssl base64 -A).
  const SUPABASE_JS_SRI = 'sha384-0w2KAL2YHP6wKOkUDzkCDGgVvfmHnj02DHeQ6XcHOgTfFsGyonKOpShMH1x6nk9o';
  const PAGE = 50;

  // ── DOM ───────────────────────────────────────────────────────────
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'class') node.className = value;
      else if (key === 'style') node.style.cssText = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
  const svgNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    const node = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    return node;
  }
  const app = document.getElementById('app');
  let toastTimer;
  function toast(message, isError) {
    const box = document.getElementById('toast');
    box.textContent = message;
    box.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.className = ''; }, isError ? 5000 : 2600);
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* sem armazenamento */ } },
  };

  // ── Formatação ────────────────────────────────────────────────────
  const nf = new Intl.NumberFormat('pt-BR');
  const fmtNum = (n) => (n == null ? '—' : nf.format(n));
  const toDate = (ts) => (ts ? new Date(ts) : null);
  const fmtDate = (ts) => (ts ? toDate(ts).toLocaleDateString('pt-BR') : '—');
  const fmtDateTime = (ts) => (ts ? toDate(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  function relTime(ts) {
    if (!ts) return '—';
    const diff = (Date.now() - toDate(ts).getTime()) / 1000;
    const future = diff < 0;
    const s = Math.abs(diff);
    const unit = s < 60 ? 'agora' : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h`
      : s < 86400 * 45 ? `${Math.round(s / 86400)} d` : null;
    if (!unit) return fmtDate(ts);
    if (unit === 'agora') return 'agora';
    return future ? `em ${unit}` : `há ${unit}`;
  }
  const fmtId = (id) => (id && id.length === 8 ? `${id.slice(0, 4)}-${id.slice(4)}` : id || '—');
  const dayLabel = (iso) => { const [, m, d] = iso.split('-'); return `${d}/${m}`; };
  const weekday = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short' });

  function badge(map, key) {
    const [label, cls] = map[key] || [key || '—', 'b-muted'];
    return el('span', { class: `badge ${cls}` }, label);
  }
  const STATUS = {
    new: ['Novo', 'b-info'], triage: ['Em análise', 'b-warn'], in_progress: ['Em andamento', 'b-warn'],
    resolved: ['Resolvido', 'b-good'], wont_fix: ['Não será feito', 'b-muted'], duplicate: ['Duplicado', 'b-muted'],
  };
  const PRIORITY = { urgent: ['Urgente', 'b-bad'], high: ['Alta', 'b-warn'], normal: ['Normal', 'b-muted'], low: ['Baixa', 'b-muted'] };
  const PLAN = { pro_paid: ['PRO pago', 'b-good'], pro_coupon: ['PRO cupom', 'b-info'], free: ['Gratuita', 'b-muted'] };
  const COUPON = { available: ['Disponível', 'b-good'], redeemed: ['Resgatado', 'b-info'], expired: ['Vencido', 'b-muted'] };
  const EVENTS = {
    identity_changed: 'Chave de contato trocada',
    invite_bad: 'Convite inválido repetido',
    call_signal_flood: 'Excesso de sinais de chamada',
    call_signal_unsealed: 'Sinal de chamada sem lacre',
    storage_key_mismatch: 'Arquivo com chave divergente',
    update_signature_invalid: 'Atualização com assinatura inválida',
  };
  const ACTIONS = {
    suspend: 'Suspendeu conta', unsuspend: 'Reativou conta', set_pro: 'Alterou PRO pago',
    adjust_coupon_pro: 'Ajustou PRO por tempo', grant_invites: 'Deu convites', create_coupons: 'Criou cupons',
    expire_coupon: 'Invalidou cupom', update_bug: 'Atualizou ticket', note_bug: 'Anotou ticket', reply_bug: 'Respondeu ticket',
  };
  const ACTIVITY = {
    signup: ['👤', 'Cadastro'], post: ['📝', 'Publicação'], bug: ['🐞', 'Relato de bug'],
    coupon: ['🎟️', 'Cupom resgatado'], security: ['🛡️', 'Evento de segurança'],
  };

  // ── API ───────────────────────────────────────────────────────────
  class ApiError extends Error {
    constructor(code, message) { super(message || 'Erro'); this.code = code; }
  }
  const api = {
    sb: null,
    localUser: null,
    async rpc(fn, args = {}) {
      if (LOCAL) {
        const res = await fetch(`/local/rpc/${encodeURIComponent(fn)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Local-User': this.localUser || '' },
          body: JSON.stringify(args),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new ApiError(data.code, data.message);
        return data;
      }
      const { data, error } = await this.sb.rpc(fn, args);
      if (error) throw new ApiError(error.code, error.message);
      return data;
    },
  };
  function errorText(e) {
    if (!e) return 'Erro desconhecido.';
    if (e.code === '42501') return 'Acesso restrito a administradores.';
    if (e.code === 'P0002') return 'Registro não encontrado.';
    if (e.code === '22023') return `Valor inválido: ${e.message}`;
    if (e.code === 'P0001' && /admin/.test(e.message)) return 'Contas administradoras não podem ser suspensas.';
    if (e instanceof TypeError) return 'Sem conexão com o servidor.';
    return e.message || 'Erro desconhecido.';
  }
  async function run(promise, okMessage) {
    try {
      const result = await promise;
      if (okMessage) toast(okMessage);
      return result;
    } catch (e) {
      toast(errorText(e), true);
      if (e.code === '42501') setTimeout(() => location.reload(), 1500);
      throw e;
    }
  }

  // ── Tema ──────────────────────────────────────────────────────────
  function applyTheme() {
    const theme = store.get('fc-admin-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const now = store.get('fc-admin-theme') || 'auto';
    const next = order[(order.indexOf(now) + 1) % order.length];
    store.set('fc-admin-theme', next);
    applyTheme();
    toast(`Tema: ${{ auto: 'automático', light: 'claro', dark: 'escuro' }[next]}`);
    redrawCharts();
  }

  // ── Entrada ───────────────────────────────────────────────────────
  function loadScript(src, integrity) {
    return new Promise((resolve, reject) => {
      const s = el('script', { src, integrity, crossorigin: 'anonymous' });
      s.onload = resolve;
      s.onerror = () => reject(new Error('Não foi possível carregar o cliente do Supabase.'));
      document.head.append(s);
    });
  }

  async function boot() {
    applyTheme();
    if (LOCAL) {
      api.localUser = sessionStorage.getItem('fc-admin-local-user');
      return api.localUser ? enter() : localLogin();
    }
    if (CFG.mode !== 'supabase' || !CFG.url || !CFG.anonKey || /COLE_SUA/.test(CFG.anonKey)) {
      return message('Configuração ausente', 'Copie admin/config.example.js para admin/config.js e preencha a URL e a chave pública (anon) do projeto. Nunca use a service key.');
    }
    if (/^sb_secret_/.test(CFG.anonKey) || /service_role/.test(atob((CFG.anonKey.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/') || '') || '')) {
      return message('Chave errada', 'config.js tem a service_role key. Troque pela chave pública (anon): a service key nunca pode ir para o navegador.');
    }
    try {
      await loadScript(SUPABASE_JS, SUPABASE_JS_SRI);
    } catch (e) {
      return message('Sem conexão', e.message);
    }
    // Pelo scripts/admin-panel.py (este PC) as chamadas passam pelo
    // servidor local, que acrescenta o segredo do PC; fora dele, só o
    // login com a conta Google liberada abre o painel.
    api.sb = window.supabase.createClient(CFG.url, CFG.anonKey, {
      auth: { persistSession: true, storageKey: 'fc-admin-auth', flowType: 'pkce', detectSessionInUrl: true },
    });
    const { data } = await api.sb.auth.getSession();
    return data.session ? enter() : login();
  }

  function message(title, text, ...extra) {
    app.replaceChildren(el('div', { class: 'login' }, el('div', { class: 'card' },
      el('h1', null, title), el('p', { class: 'muted' }, text), ...extra)));
  }

  function loginCard(...content) {
    return el('div', { class: 'login' }, el('div', { class: 'card' },
      el('div', { class: 'brand', style: 'padding:0 0 4px' }, el('div', { class: 'brand-mark' }, 'F'),
        el('div', null, el('b', null, 'Frente Capital'), el('span', null, 'Administração'))),
      ...content));
  }

  function localLogin() {
    const select = el('select', { 'aria-label': 'Conta de teste' });
    const form = el('form', {
      onsubmit: (ev) => {
        ev.preventDefault();
        api.localUser = select.value;
        sessionStorage.setItem('fc-admin-local-user', select.value);
        enter();
      },
    },
    el('div', { class: 'callout warn' }, 'Prévia local com dados fictícios num Postgres descartável. Nada aqui chega à produção.'),
    el('label', { class: 'field' }, 'Entrar como', select),
    el('button', { class: 'btn primary', type: 'submit' }, 'Entrar'));
    app.replaceChildren(loginCard(form));
    fetch('/local/accounts').then((r) => r.json()).then((accounts) => {
      select.replaceChildren(...accounts.map((a) => el('option', { value: a.id }, a.label)));
    });
  }

  function login() {
    let mode = 'id';
    const error = el('div', { class: 'error', role: 'alert' });
    const idInput = el('input', { type: 'text', autocomplete: 'username', placeholder: 'XXXX-XXXX', required: true });
    const emailInput = el('input', { type: 'email', autocomplete: 'username', placeholder: 'voce@exemplo.com', required: true });
    const password = el('input', { type: 'password', autocomplete: 'current-password', required: true });
    const idField = el('label', { class: 'field' }, 'ID Frente Capital', idInput);
    const emailField = el('label', { class: 'field hidden' }, 'E-mail', emailInput);
    const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Entrar');
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Forma de entrar' });
    const setMode = (m) => {
      mode = m;
      idField.classList.toggle('hidden', m !== 'id');
      emailField.classList.toggle('hidden', m !== 'email');
      idInput.required = m === 'id';
      emailInput.required = m === 'email';
      [...seg.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    };
    seg.append(
      el('button', { type: 'button', 'data-mode': 'id', 'aria-pressed': 'true', onclick: () => setMode('id') }, 'Com ID'),
      el('button', { type: 'button', 'data-mode': 'email', 'aria-pressed': 'false', onclick: () => setMode('email') }, 'Com e-mail'));
    const form = el('form', {
      onsubmit: async (ev) => {
        ev.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          if (mode === 'email') {
            const { error: e } = await api.sb.auth.signInWithPassword({ email: emailInput.value.trim().toLowerCase(), password: password.value });
            if (e) throw e;
          } else {
            const { data, error: e } = await api.sb.functions.invoke('id-login', {
              body: { action: 'login', id: idInput.value.trim(), password: password.value },
            });
            let code = 'invalid';
            if (e && e.context && typeof e.context.json === 'function') {
              code = (await e.context.json().catch(() => ({}))).error || code;
            }
            if (e || !data || !data.refresh_token) {
              throw new Error(code === 'rate_limited' ? 'Muitas tentativas. Aguarde e tente de novo.'
                : code === 'email_not_confirmed' ? 'Confirme o e-mail da conta antes de entrar.' : 'ID ou senha incorretos.');
            }
            const { error: e2 } = await api.sb.auth.refreshSession({ refresh_token: data.refresh_token });
            if (e2) throw e2;
          }
          password.value = '';
          await enter();
        } catch (e) {
          error.textContent = /Invalid login/.test(e.message) ? 'E-mail ou senha incorretos.' : e.message;
        } finally {
          submit.disabled = false;
        }
      },
    }, seg, idField, emailField, el('label', { class: 'field' }, 'Senha', password), error, submit,
    el('p', { class: 'faint', style: 'margin:0;font-size:12px' }, 'Só contas administradoras, e só neste PC ou com a conta Google autorizada.'));
    const google = el('button', {
      class: 'btn primary', type: 'button',
      onclick: async () => {
        const { error: e } = await api.sb.auth.signInWithOAuth({
          provider: 'google', options: { redirectTo: location.origin + location.pathname },
        });
        if (e) error.textContent = e.message;
      },
    }, 'Entrar com Google');
    // Fora deste PC a senha não basta: o banco só aceita a sessão do Google.
    app.replaceChildren(CFG.viaThisPc ? loginCard(el('div', { style: 'display:grid;gap:12px;margin-top:16px' }, google), form)
      : loginCard(el('div', { style: 'display:grid;gap:12px;margin-top:16px' }, google, error,
        el('p', { class: 'faint', style: 'margin:0;font-size:12px' }, 'Acesso só com a conta Google autorizada. Sem ela, use o painel neste PC (scripts/admin-panel.py).'))));
  }

  async function signOut() {
    if (LOCAL) sessionStorage.removeItem('fc-admin-local-user');
    else await api.sb.auth.signOut();
    location.hash = '';
    location.reload();
  }

  const state = { me: null, overview: null };

  async function enter() {
    app.replaceChildren(el('div', { class: 'login' }, el('div', { class: 'skeleton', style: 'width:320px' })));
    let me;
    try {
      me = await api.rpc('admin_me');
    } catch (e) {
      return message('Erro ao entrar', errorText(e), el('button', { class: 'btn', onclick: signOut }, 'Sair'));
    }
    if (!me || !me.is_admin) {
      return message('Acesso restrito', 'Esta conta não é administradora. O acesso é liberado pela tabela app_admins no banco.',
        el('button', { class: 'btn', onclick: signOut }, 'Sair'));
    }
    if (!me.dashboard_allowed) {
      return message('Acesso restrito', 'O painel só abre neste PC (scripts/admin-panel.py) ou entrando com a conta Google autorizada.',
        el('button', { class: 'btn', onclick: signOut }, 'Sair'));
    }
    state.me = me;
    renderShell();
    window.addEventListener('hashchange', route);
    route();
  }

  // ── Estrutura ─────────────────────────────────────────────────────
  const ICONS = {
    overview: 'M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z',
    tickets: 'M20 8h-2.81a6 6 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17a6 6 0 0 0-2.83 0L8.41 3 7 4.41l1.62 1.63A6 6 0 0 0 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81A6 6 0 0 0 12 21a6 6 0 0 0 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20zm-6 8h-4v-2h4zm0-4h-4v-2h4z',
    users: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3m-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3m0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5m8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5',
    pro: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    coupons: 'M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2m-4.42 4.8L12 14.5l-3.58 2.3 1.08-4.12-3.29-2.69 4.24-.25L12 5.8l1.54 3.95 4.24.25-3.29 2.69z',
    invites: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2m0 4-8 5-8-5V6l8 5 8-5z',
    security: 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11z',
    audit: 'M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.95 8.95 0 0 0 13 21a9 9 0 0 0 0-18m-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8z',
  };
  const VIEWS = [
    ['overview', 'Visão geral'], ['tickets', 'Tickets de bug'], ['users', 'Usuários'], ['pro', 'Contas PRO'],
    ['coupons', 'Cupons'], ['invites', 'Convites'], ['security', 'Segurança'], ['audit', 'Auditoria'],
  ];
  let shell;
  let mainEl;
  let navButtons = {};

  function renderShell() {
    navButtons = {};
    const nav = el('nav', { class: 'nav', 'aria-label': 'Seções' }, VIEWS.map(([id, label]) => {
      const icon = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
      icon.append(svg('path', { d: ICONS[id], fill: 'currentColor' }));
      const count = el('span', { class: 'count hidden' });
      const btn = el('button', { type: 'button', onclick: () => { location.hash = `#/${id}`; shell.classList.remove('nav-open'); } }, icon, label, count);
      navButtons[id] = { btn, count };
      return btn;
    }));
    const who = state.me;
    mainEl = el('main', { class: 'main' });
    shell = el('div', { class: 'shell' },
      el('aside', { class: 'sidebar' },
        el('div', { class: 'brand' }, el('div', { class: 'brand-mark' }, 'F'),
          el('div', null, el('b', null, 'Frente Capital'), el('span', null, 'Administração'))),
        nav,
        el('div', { class: 'sidebar-foot' },
          el('div', { class: 'who' }, who.display_name || 'Admin'),
          el('div', { class: 'faint' }, fmtId(who.digfy_id)),
          el('div', { class: 'row' },
            el('button', { class: 'btn small', onclick: cycleTheme, title: 'Alternar tema' }, 'Tema'),
            el('button', { class: 'btn small', onclick: signOut }, 'Sair')))),
      mainEl);
    app.replaceChildren(shell);
  }

  function topbar(title, ...right) {
    return el('div', { class: 'topbar' },
      el('button', { class: 'btn menu-btn', 'aria-label': 'Abrir menu', onclick: () => shell.classList.toggle('nav-open') }, '☰'),
      el('h1', null, title),
      el('span', { class: `env ${LOCAL ? 'local' : 'prod'}` }, LOCAL ? 'LOCAL · DADOS FICTÍCIOS' : CFG.viaThisPc ? 'PRODUÇÃO · ESTE PC' : 'PRODUÇÃO'),
      el('div', { class: 'spacer' }), ...right);
  }

  function setNavCounts(overview) {
    if (!overview) return;
    const open = overview.bugs.open;
    const c = navButtons.tickets.count;
    c.textContent = open;
    c.classList.toggle('hidden', !open);
  }

  async function refreshOverview() {
    state.overview = await api.rpc('admin_overview');
    setNavCounts(state.overview);
    return state.overview;
  }

  let routeToken = 0;
  function route() {
    const [name, query] = (location.hash.replace(/^#\/?/, '') || 'overview').split('?');
    const view = VIEWS.some(([id]) => id === name) ? name : 'overview';
    for (const [id, { btn }] of Object.entries(navButtons)) {
      if (id === view) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    }
    const token = ++routeToken;
    charts.length = 0;
    mainEl.replaceChildren(topbar(VIEWS.find(([id]) => id === view)[1]), el('div', { class: 'skeleton' }));
    document.title = `${VIEWS.find(([id]) => id === view)[1]} · Frente Capital`;
    const params = new URLSearchParams(query || '');
    VIEW_RENDER[view](params).then((content) => {
      if (token !== routeToken) return;
      mainEl.replaceChildren(...content);
      redrawCharts();
    }).catch((e) => {
      if (token !== routeToken) return;
      mainEl.replaceChildren(topbar('Erro'), el('div', { class: 'card card-body' }, errorText(e)));
      if (e.code === '42501') setTimeout(() => location.reload(), 1500);
    });
  }

  // ── Gráficos ──────────────────────────────────────────────────────
  // Barras finas ancoradas na base, uma série por gráfico (o título diz o
  // que é), dica no hover com alvo do tamanho da coluna inteira.
  const charts = [];
  function niceMax(v) {
    if (v <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function barChart(values, days, { height = 220, unit = '', compact = false } = {}) {
    const box = el('div', { class: 'chart' });
    const draw = () => {
      const width = Math.max(box.clientWidth, 200);
      const left = compact ? 4 : 34;
      const bottom = 22;
      const top = 8;
      const plotW = width - left - 4;
      const plotH = height - top - bottom;
      const max = niceMax(Math.max(1, ...values));
      const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img',
        'aria-label': `${unit}: ${values.reduce((a, b) => a + b, 0)} no período` });
      const ticks = compact ? [0, max] : [0, max / 2, max];
      for (const t of ticks) {
        const y = top + plotH - (t / max) * plotH;
        root.append(svg('line', { x1: left, x2: width - 4, y1: y, y2: y, class: 'grid-line' }));
        if (!compact) {
          const label = svg('text', { x: left - 6, y: y + 4, 'text-anchor': 'end', class: 'axis-label' });
          label.textContent = nf.format(t);
          root.append(label);
        }
      }
      const slot = plotW / values.length;
      const gap = Math.min(2, slot * 0.25);
      const barW = Math.max(1, slot - gap);
      const bars = [];
      values.forEach((v, i) => {
        const x = left + i * slot + gap / 2;
        const h = (v / max) * plotH;
        const y = top + plotH - h;
        const r = Math.min(4, barW / 2, h);
        const bar = svg('path', {
          class: 'bar',
          d: h <= 0 ? '' : `M${x},${top + plotH}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${top + plotH}Z`,
        });
        bars.push(bar);
        root.append(bar);
      });
      const labelIdx = values.length <= 1 ? [0] : [0, Math.floor((values.length - 1) / 2), values.length - 1];
      for (const i of labelIdx) {
        const t = svg('text', {
          x: left + i * slot + slot / 2, y: height - 6, class: 'axis-label',
          'text-anchor': i === 0 ? 'start' : i === values.length - 1 ? 'end' : 'middle',
        });
        t.textContent = dayLabel(days[i]);
        if (i === 0) t.setAttribute('x', left);
        if (i === values.length - 1) t.setAttribute('x', width - 4);
        root.append(t);
      }
      const tip = el('div', { class: 'tooltip hidden' });
      values.forEach((v, i) => {
        const hit = svg('rect', { x: left + i * slot, y: top, width: slot, height: plotH, class: 'hit' });
        hit.addEventListener('mouseenter', () => {
          bars.forEach((b, j) => b.classList.toggle('dim', j !== i));
          tip.textContent = `${weekday(days[i])} ${dayLabel(days[i])}: ${nf.format(v)} ${unit}`;
          tip.style.left = `${left + i * slot + slot / 2}px`;
          tip.style.top = `${top + plotH - (v / max) * plotH}px`;
          tip.classList.remove('hidden');
        });
        hit.addEventListener('mouseleave', () => {
          bars.forEach((b) => b.classList.remove('dim'));
          tip.classList.add('hidden');
        });
        root.append(hit);
      });
      box.replaceChildren(root, tip);
    };
    charts.push(draw);
    return box;
  }
  function redrawCharts() { requestAnimationFrame(() => charts.forEach((draw) => draw())); }
  window.addEventListener('resize', debounce(redrawCharts, 120));

  function barList(rows) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    if (!rows.length) return el('div', { class: 'empty' }, 'Nada no período.');
    return el('div', { class: 'bar-list' }, rows.map((r) => el('div', { class: 'row' },
      el('span', null, r.label), el('span', { class: 'num muted' }, fmtNum(r.value)),
      el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(r.value / max) * 100}%` })))));
  }

  // ── Componentes ───────────────────────────────────────────────────
  function kpi(label, value, sub, onclick) {
    return el('div', { class: `card kpi${onclick ? ' clickable' : ''}`, onclick, role: onclick ? 'link' : null, tabindex: onclick ? 0 : null },
      el('div', { class: 'label' }, label),
      el('div', { class: 'value num' }, fmtNum(value)),
      sub ? el('div', { class: 'sub' }, sub) : null);
  }
  function card(title, body, ...headRight) {
    return el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', null, title), el('div', { class: 'spacer' }), ...headRight),
      el('div', { class: 'card-body' }, body));
  }
  function segmented(options, value, onChange, label) {
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': label || '' });
    for (const [v, text] of options) {
      seg.append(el('button', {
        type: 'button', 'aria-pressed': String(v === value),
        onclick: () => {
          [...seg.children].forEach((b) => b.setAttribute('aria-pressed', 'false'));
          seg.children[options.findIndex(([x]) => x === v)].setAttribute('aria-pressed', 'true');
          onChange(v);
        },
      }, text));
    }
    return seg;
  }
  function selectBox(options, value, onChange, label) {
    const s = el('select', { 'aria-label': label, onchange: () => onChange(s.value) },
      options.map(([v, text]) => el('option', { value: v, selected: v === value }, text)));
    return s;
  }
  function searchBox(placeholder, value, onChange) {
    const input = el('input', { type: 'search', placeholder, value: value || '', 'aria-label': placeholder });
    input.addEventListener('input', debounce(() => onChange(input.value.trim()), 300));
    return input;
  }
  function person(name, digfy, onclick) {
    if (!name && !digfy) return el('span', { class: 'faint' }, '—');
    const node = el('div', { class: 'person' }, el('b', null, name || 'Sem nome'), el('span', null, fmtId(digfy)));
    if (onclick) {
      return el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); onclick(); } }, node);
    }
    return node;
  }

  // Tabela paginada: load(offset) devolve linhas com "total".
  function pagedTable(columns, load, { onRow, empty = 'Nada encontrado.' } = {}) {
    const wrap = el('div', { class: 'card' });
    let offset = 0;
    const draw = async () => {
      wrap.replaceChildren(el('div', { class: 'card-body' }, el('div', { class: 'skeleton', style: 'height:60px' })));
      let rows;
      try {
        rows = await load(offset);
      } catch (e) {
        wrap.replaceChildren(el('div', { class: 'empty' }, errorText(e)));
        return;
      }
      const total = rows.length ? Number(rows[0].total) : 0;
      if (!rows.length) {
        wrap.replaceChildren(el('div', { class: 'empty' }, empty));
        return;
      }
      const thead = el('thead', null, el('tr', null, columns.map((c) => el('th', { class: c.right ? 'right' : null }, c.label))));
      const tbody = el('tbody', null, rows.map((row) => el('tr', {
        class: onRow ? 'clickable' : null,
        tabindex: onRow ? 0 : null,
        onclick: onRow ? () => onRow(row, draw) : null,
        onkeydown: onRow ? (ev) => { if (ev.key === 'Enter') onRow(row, draw); } : null,
      }, columns.map((c) => el('td', { class: c.right ? 'right num' : c.wide ? 'wide' : null }, c.cell(row, draw))))));
      const pager = el('div', { class: 'pager' },
        `${fmtNum(offset + 1)}–${fmtNum(offset + rows.length)} de ${fmtNum(total)}`,
        el('button', { class: 'btn small', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - PAGE); draw(); } }, 'Anterior'),
        el('button', { class: 'btn small', disabled: offset + rows.length >= total, onclick: () => { offset += PAGE; draw(); } }, 'Próxima'));
      wrap.replaceChildren(el('div', { class: 'table-wrap' }, el('table', null, thead, tbody)), pager);
    };
    wrap.reload = (reset) => { if (reset) offset = 0; return draw(); };
    draw();
    return wrap;
  }

  let drawerClose = null;
  function openDrawer(head, body) {
    if (drawerClose) drawerClose();
    const scrim = el('div', { class: 'scrim' });
    const closeBtn = el('button', { class: 'btn ghost', 'aria-label': 'Fechar' }, '✕');
    const drawer = el('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'drawer-head' }, el('div', { style: 'min-width:0' }, head), el('div', { class: 'spacer' }), closeBtn),
      el('div', { class: 'drawer-body' }, body));
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    function close() {
      scrim.remove();
      drawer.remove();
      document.removeEventListener('keydown', onKey);
      drawerClose = null;
    }
    scrim.onclick = close;
    closeBtn.onclick = close;
    document.addEventListener('keydown', onKey);
    document.body.append(scrim, drawer);
    closeBtn.focus();
    drawerClose = close;
    return { drawer, close, setBody: (...b) => drawer.querySelector('.drawer-body').replaceChildren(...b), setHead: (h) => { drawer.querySelector('.drawer-head > div').replaceChildren(h); } };
  }
  function props(pairs) {
    return el('dl', { class: 'props' }, pairs.filter(Boolean).map(([k, v]) => [el('dt', null, k), el('dd', null, v == null || v === '' ? '—' : v)]));
  }

  // ── Visão geral ───────────────────────────────────────────────────
  let seriesDays = Number(store.get('fc-admin-days')) || 30;
  async function viewOverview() {
    const [o, series, activity] = await Promise.all([
      refreshOverview(), api.rpc('admin_daily_series', { days: seriesDays }), api.rpc('admin_recent_activity', { max_rows: 40 }),
    ]);
    const go = (hash) => () => { location.hash = hash; };
    const kpis = el('div', { class: 'grid kpis' },
      kpi('Usuários', o.users.total, `+${fmtNum(o.users.new_7d)} em 7 dias · +${fmtNum(o.users.new_1d)} hoje`, go('#/users?filter=new_7d')),
      kpi('Ativos em 7 dias', o.users.active_7d, `${fmtNum(o.users.active_1d)} em 24 h · ${fmtNum(o.users.active_30d)} em 30 dias`),
      kpi('PRO ativos', o.pro.paid + o.pro.coupon_active, `${fmtNum(o.pro.paid)} pagos · ${fmtNum(o.pro.coupon_active)} por cupom`, go('#/pro')),
      kpi('Tickets abertos', o.bugs.open, `${fmtNum(o.bugs.new)} novos · ${fmtNum(o.bugs.urgent_open)} alta/urgente`, go('#/tickets')),
      kpi('Posts em 7 dias', o.feed.posts_7d, `${fmtNum(o.feed.authors_7d)} autores · ${fmtNum(o.feed.live_posts)} no ar`),
      kpi('Convites usados (7 d)', o.invites.used_7d, `${fmtNum(o.invites.used)} de ${fmtNum(o.invites.total)} no total`, go('#/invites')),
      kpi('Cupons disponíveis', o.coupons.available, `${fmtNum(o.coupons.redeemed_7d)} resgatados em 7 dias`, go('#/coupons')),
      kpi('Segurança (24 h)', o.security.events_1d, `${fmtNum(o.security.events_7d)} eventos em 7 dias`, go('#/security')));

    const s = series.series;
    const total = (arr) => (arr || []).reduce((a, b) => a + b, 0);
    const periodSeg = segmented([[14, '14 d'], [30, '30 d'], [90, '90 d']], seriesDays, (v) => {
      seriesDays = v;
      store.set('fc-admin-days', String(v));
      route();
    }, 'Período');
    const signups = el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', null, 'Cadastros por dia'), el('div', { class: 'spacer' }), periodSeg),
      el('div', { class: 'card-body' },
        el('div', { class: 'chart-total num' }, fmtNum(total(s.signups)), el('span', { class: 'muted', style: 'font-size:13px;font-weight:400' }, ` cadastros em ${seriesDays} dias`)),
        barChart(s.signups, series.days, { unit: 'cadastros' })));

    const attention = [];
    if (o.bugs.urgent_open) attention.push(['🐞', `${o.bugs.urgent_open} ticket(s) de prioridade alta ou urgente`, '#/tickets?priority=high_plus']);
    if (o.bugs.new) attention.push(['📥', `${o.bugs.new} ticket(s) novo(s) sem triagem`, '#/tickets?status=new']);
    if (o.pro.coupon_expiring_7d) attention.push(['⏳', `${o.pro.coupon_expiring_7d} PRO por cupom vencem em 7 dias`, '#/pro?filter=pro_expiring']);
    if (o.security.events_1d) attention.push(['🛡️', `${o.security.events_1d} evento(s) de segurança em 24 h`, '#/security']);
    if (o.coupons.failed_attempts_1d > 20) attention.push(['🎟️', `${o.coupons.failed_attempts_1d} tentativas de cupom em 24 h`, '#/coupons']);
    if (o.users.suspended) attention.push(['⛔', `${o.users.suspended} conta(s) suspensa(s)`, '#/users?filter=suspended']);
    const attentionCard = card('Precisa de atenção', attention.length
      ? el('ul', { class: 'feed attention' }, attention.map(([ico, text, hash]) => el('li', null,
        el('span', { class: 'ico', 'aria-hidden': 'true' }, ico), el('a', { href: hash, class: 'what' }, text), el('span'))))
      : el('div', { class: 'empty' }, 'Tudo em dia.'));

    const minis = [
      ['posts', 'Publicações'], ['likes', 'Curtidas'], ['comments', 'Comentários'], ['invites_used', 'Convites usados'],
      ['coupons_redeemed', 'Cupons resgatados'], ['bug_reports', 'Relatos de bug'], ['security_events', 'Eventos de segurança'],
      ['applications', 'Candidaturas a vagas'], ['company_messages', 'Mensagens a empresas'],
    ].filter(([key]) => s[key]).map(([key, label]) => el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', null, label), el('div', { class: 'spacer' }), el('span', { class: 'num muted' }, fmtNum(total(s[key])))),
      el('div', { class: 'card-body' }, barChart(s[key], series.days, { height: 90, unit: label.toLowerCase(), compact: true }))));

    const feed = el('ul', { class: 'feed' }, activity.map((a) => {
      const [ico, label] = ACTIVITY[a.kind] || ['•', a.kind];
      return el('li', null, el('span', { class: 'ico', 'aria-hidden': 'true' }, ico),
        el('div', { class: 'what' },
          el('div', null, el('b', null, label), ' · ',
            a.user_id ? el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); userDrawer(a.user_id); } }, a.user_name || fmtId(a.user_digfy)) : '—'),
          a.detail ? el('div', { class: 'faint', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
            a.kind === 'security' ? (EVENTS[a.detail.split(' · ')[0]] || a.detail) : a.detail) : null),
        el('span', { class: 'when', title: fmtDateTime(a.at) }, relTime(a.at)));
    }));
    const b = o.business;
    const business = card('Empresas e vagas', props([
      ['Empresas cadastradas', b.companies == null ? 'não publicado' : fmtNum(b.companies)],
      ['Vagas abertas', b.open_jobs == null ? 'não publicado' : fmtNum(b.open_jobs)],
      ['Candidaturas (7 d)', b.applications_7d == null ? 'não publicado' : fmtNum(b.applications_7d)],
      ['Conversas com empresas', b.company_threads == null ? 'não publicado' : fmtNum(b.company_threads)],
      ['Mensagens a empresas (7 d)', b.company_messages_7d == null ? 'não publicado' : fmtNum(b.company_messages_7d)],
      ['Comentários (7 d)', fmtNum(o.feed.comments_7d)],
      ['Curtidas (7 d)', fmtNum(o.feed.likes_7d)],
    ]));
    return [
      topbar('Visão geral', el('button', { class: 'btn', onclick: route }, 'Atualizar')),
      kpis,
      el('div', { class: 'grid two', style: 'margin-bottom:14px' }, signups, attentionCard),
      el('h3', { style: 'margin:6px 0 10px' }, `Fluxo de uso · últimos ${seriesDays} dias`),
      el('div', { class: 'grid mini-charts', style: 'margin-bottom:14px' }, minis),
      el('div', { class: 'grid two' }, card('Atividade recente', activity.length ? feed : el('div', { class: 'empty' }, 'Sem atividade.')), business),
    ];
  }

  // ── Tickets ───────────────────────────────────────────────────────
  async function viewTickets(params) {
    const f = { status: params.get('status') || 'open', priority: params.get('priority') || 'all', search: '' };
    refreshOverview().catch(() => {});
    const table = pagedTable([
      { label: 'Prioridade', cell: (r) => badge(PRIORITY, r.prio) },
      { label: 'Ticket', wide: true, cell: (r) => el('div', { class: 'person ticket' }, el('b', null, r.title), el('span', null, r.description.slice(0, 110))) },
      { label: 'Status', cell: (r) => badge(STATUS, r.state) },
      { label: 'Relatado por', cell: (r) => person(r.owner_name, r.owner_digfy, r.owner_id && (() => userDrawer(r.owner_id))) },
      { label: 'Versão', cell: (r) => el('span', { class: 'muted' }, [r.app_version, r.platform].filter(Boolean).join(' · ') || '—') },
      { label: 'Notas', right: true, cell: (r) => fmtNum(r.notes) },
      { label: 'Aberto', cell: (r) => el('span', { title: fmtDateTime(r.created_at) }, relTime(r.created_at)) },
    ], (offset) => api.rpc('admin_list_bug_reports', {
      status: f.status, priority: f.priority, search: f.search, max_rows: PAGE, skip: offset,
    }),
    { onRow: (row, reload) => ticketDrawer(row, reload), empty: 'Nenhum ticket com esses filtros.' });
    return [
      topbar('Tickets de bug'),
      el('div', { class: 'toolbar' },
        segmented([['open', 'Abertos'], ['new', 'Novos'], ['triage', 'Em análise'], ['in_progress', 'Em andamento'], ['closed', 'Fechados'], ['all', 'Todos']],
          f.status, (v) => { f.status = v; table.reload(true); }, 'Status'),
        selectBox([['all', 'Todas as prioridades'], ['high_plus', 'Alta + urgente'], ['urgent', 'Urgente'], ['normal', 'Normal'], ['low', 'Baixa']],
          f.priority, (v) => { f.priority = v; table.reload(true); }, 'Prioridade'),
        searchBox('Buscar título, texto, pessoa, versão', '', (v) => { f.search = v; table.reload(true); })),
      table,
    ];
  }

  function ticketDrawer(row, reloadList) {
    const status = selectBox(Object.entries(STATUS).map(([k, [l]]) => [k, l]), row.state, () => {}, 'Status');
    const priority = selectBox(Object.entries(PRIORITY).map(([k, [l]]) => [k, l]), row.prio, () => {}, 'Prioridade');
    const notesBox = el('div', { class: 'stack' }, el('div', { class: 'skeleton', style: 'height:50px' }));
    let isReply = false;
    const text = el('textarea', { placeholder: 'Escreva uma nota interna…', maxlength: 2000 });
    const kind = segmented([[false, 'Nota interna'], [true, 'Resposta ao usuário']], false, (v) => {
      isReply = v;
      text.placeholder = v ? 'Resposta que a pessoa verá…' : 'Escreva uma nota interna…';
    }, 'Tipo de nota');
    const loadNotes = async () => {
      const notes = await api.rpc('admin_bug_report_notes', { report: row.id });
      notesBox.replaceChildren(...(notes.length ? notes.map((n) => el('div', { class: `note${n.is_reply ? ' reply' : ''}` },
        el('div', { class: 'meta' }, `${n.is_reply ? 'Resposta ao usuário' : 'Nota interna'} · ${n.author_name || 'Admin'} · ${fmtDateTime(n.created_at)}`),
        el('div', { class: 'pre' }, n.body))) : [el('div', { class: 'faint' }, 'Sem notas ainda.')]));
    };
    const head = el('div', null, el('h2', null, row.title),
      el('div', { class: 'actions', style: 'margin-top:6px' }, badge(STATUS, row.state), badge(PRIORITY, row.prio)));
    const d = openDrawer(head, [
      card('Detalhes', props([
        ['Relatado por', person(row.owner_name, row.owner_digfy, row.owner_id && (() => userDrawer(row.owner_id)))],
        ['Aberto em', fmtDateTime(row.created_at)],
        ['Versão do app', row.app_version], ['Plataforma', row.platform],
        ['Atualizado', fmtDateTime(row.updated_at)], ['Resolvido em', fmtDateTime(row.resolved_at)],
      ])),
      card('Descrição', el('div', { class: 'pre' }, row.description)),
      row.steps ? card('Passos para reproduzir', el('div', { class: 'pre' }, row.steps)) : null,
      card('Triagem', el('div', { class: 'actions' },
        el('label', { class: 'field' }, 'Status', status), el('label', { class: 'field' }, 'Prioridade', priority),
        el('button', {
          class: 'btn primary', style: 'align-self:flex-end',
          onclick: async () => {
            const r = await run(api.rpc('admin_update_bug_report', { report: row.id, new_status: status.value, new_priority: priority.value }), 'Ticket atualizado.');
            row.state = r.status; row.prio = r.priority; row.resolved_at = r.resolved_at;
            head.querySelector('.actions').replaceChildren(badge(STATUS, row.state), badge(PRIORITY, row.prio));
            reloadList();
            refreshOverview().catch(() => {});
          },
        }, 'Salvar'))),
      card('Notas e respostas', el('div', { class: 'stack' }, notesBox, kind, text,
        el('div', { class: 'callout info' }, 'Respostas ficam visíveis para quem relatou pela função my_bug_reports; o app ainda precisa de uma tela para mostrá-las.'),
        el('div', { class: 'actions' }, el('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!text.value.trim()) return toast('Escreva a nota primeiro.', true);
            await run(api.rpc('admin_add_bug_note', { report: row.id, body: text.value, is_reply: isReply }), isReply ? 'Resposta enviada.' : 'Nota salva.');
            text.value = '';
            loadNotes();
            reloadList();
          },
        }, 'Adicionar')))),
    ]);
    loadNotes().catch((e) => notesBox.replaceChildren(el('div', { class: 'faint' }, errorText(e))));
    return d;
  }

  // ── Usuários ──────────────────────────────────────────────────────
  const USER_FILTERS = [
    ['all', 'Todas as contas'], ['free', 'Gratuitas'], ['pro', 'PRO (todas)'], ['pro_paid', 'PRO pago'],
    ['pro_coupon', 'PRO por cupom'], ['pro_expiring', 'PRO vencendo em 7 dias'], ['pro_expired', 'PRO por cupom vencido'],
    ['suspended', 'Suspensas'], ['admins', 'Administradoras'], ['new_7d', 'Novas (7 dias)'], ['inactive_30d', 'Inativas há 30 dias'],
  ];
  const USER_SORTS = [['recent', 'Mais recentes'], ['last_seen', 'Último acesso'], ['expiry', 'Vencimento do PRO'], ['name', 'Nome']];

  function userTable(f) {
    return pagedTable([
      { label: 'Pessoa', cell: (r) => person(r.display_name, r.digfy_id) },
      { label: 'E-mail', cell: (r) => el('span', { class: 'muted' }, r.email || '—') },
      {
        label: 'Plano',
        cell: (r) => el('div', null, badge(PLAN, r.plan),
          r.coupon_pro_until && r.plan !== 'free' && !r.is_pro ? el('div', { class: 'faint', style: 'font-size:12px' }, `até ${fmtDate(r.coupon_pro_until)}`) : null,
          r.plan === 'free' && r.coupon_pro_until ? el('div', { class: 'faint', style: 'font-size:12px' }, `cupom venceu ${fmtDate(r.coupon_pro_until)}`) : null),
      },
      { label: 'Cadastro', cell: (r) => el('span', { title: fmtDateTime(r.created_at) }, fmtDate(r.created_at)) },
      { label: 'Último acesso', cell: (r) => el('span', { title: fmtDateTime(r.last_seen) }, relTime(r.last_seen)) },
      { label: 'Posts', right: true, cell: (r) => fmtNum(r.posts) },
      {
        label: 'Situação',
        cell: (r) => el('div', { class: 'actions' },
          r.suspended_at ? el('span', { class: 'badge b-bad' }, 'Suspensa') : el('span', { class: 'badge b-good' }, 'Ativa'),
          r.is_admin ? el('span', { class: 'badge b-info' }, 'Admin') : null),
      },
    ], (offset) => api.rpc('admin_list_users', { search: f.search, filter: f.filter, sort: f.sort, max_rows: PAGE, skip: offset }),
    { onRow: (row, reload) => userDrawer(row.id, reload), empty: 'Nenhuma conta encontrada.' });
  }

  async function viewUsers(params) {
    const f = { search: params.get('q') || '', filter: params.get('filter') || 'all', sort: 'recent' };
    const table = userTable(f);
    return [
      topbar('Usuários'),
      el('div', { class: 'toolbar' },
        searchBox('Nome, e-mail, ID ou UUID', f.search, (v) => { f.search = v; table.reload(true); }),
        selectBox(USER_FILTERS, f.filter, (v) => { f.filter = v; table.reload(true); }, 'Filtro'),
        selectBox(USER_SORTS, f.sort, (v) => { f.sort = v; table.reload(true); }, 'Ordenar')),
      table,
    ];
  }

  async function viewPro(params) {
    const o = await refreshOverview();
    const f = { search: '', filter: params.get('filter') || 'pro', sort: 'expiry' };
    const table = userTable(f);
    return [
      topbar('Contas PRO'),
      el('div', { class: 'grid kpis' },
        kpi('PRO pago', o.pro.paid, 'profiles.is_pro (assinatura)'),
        kpi('PRO por cupom ativo', o.pro.coupon_active, 'prazo em coupon_pro_until'),
        kpi('Vencem em 7 dias', o.pro.coupon_expiring_7d, 'cupom perto do fim'),
        kpi('Venceram (30 dias)', o.pro.coupon_expired_30d, 'oportunidade de conversão')),
      el('div', { class: 'toolbar' },
        segmented([['pro', 'Todas PRO'], ['pro_paid', 'Pagas'], ['pro_coupon', 'Por cupom'], ['pro_expiring', 'Vencendo em 7 dias'], ['pro_expired', 'Vencidas']],
          f.filter, (v) => { f.filter = v; table.reload(true); }, 'Tipo de PRO'),
        searchBox('Nome, e-mail ou ID', '', (v) => { f.search = v; table.reload(true); })),
      table,
    ];
  }

  async function userDrawer(id, reloadList) {
    const d = openDrawer(el('h2', null, 'Carregando…'), el('div', { class: 'skeleton' }));
    const refresh = async () => {
      let u;
      try {
        u = await api.rpc('admin_user_detail', { target: id });
      } catch (e) {
        d.setBody(el('div', { class: 'card card-body' }, errorText(e)));
        return;
      }
      const p = u.profile;
      const plan = p.is_pro ? 'pro_paid' : p.coupon_pro_until && new Date(p.coupon_pro_until) > new Date() ? 'pro_coupon' : 'free';
      d.setHead(el('div', null, el('h2', null, p.display_name || 'Sem nome'),
        el('div', { class: 'faint mono' }, `${fmtId(p.digfy_id)} · ${p.id}`),
        el('div', { class: 'actions', style: 'margin-top:6px' }, badge(PLAN, plan),
          u.suspension ? el('span', { class: 'badge b-bad' }, 'Suspensa') : null,
          p.is_admin ? el('span', { class: 'badge b-info' }, 'Admin') : null)));
      const after = async (promise, msg) => {
        const r = await run(promise, msg);
        await refresh();
        if (reloadList) reloadList();
        refreshOverview().catch(() => {});
        return r;
      };
      const det = u.details || {};
      const account = card('Conta', props([
        ['E-mail', p.email], ['E-mail confirmado', fmtDateTime(p.email_confirmed_at)],
        ['Cadastro', fmtDateTime(p.created_at)], ['Último acesso no app', fmtDateTime(p.last_seen)],
        ['Último login', fmtDateTime(p.last_sign_in_at)],
        ['Convite usado', p.invited_with ? el('span', { class: 'mono' }, fmtId(p.invited_with)) : '—'],
        ['Convidada por', u.invited_by ? person(u.invited_by.name, u.invited_by.digfy_id, u.invited_by.id && (() => userDrawer(u.invited_by.id))) : '—'],
        det.occupation ? ['Ocupação', det.occupation] : null,
        det.gender ? ['Gênero', det.gender] : null,
        det.city_code ? ['Município (IBGE)', String(det.city_code)] : null,
      ]));

      const planText = p.is_pro ? 'PRO pago ativo.'
        : plan === 'pro_coupon' ? `PRO por cupom até ${fmtDateTime(p.coupon_pro_until)}.`
          : p.coupon_pro_until ? `Conta gratuita (cupom venceu em ${fmtDate(p.coupon_pro_until)}).` : 'Conta gratuita.';
      const planCard = card('Plano PRO', el('div', { class: 'stack' },
        el('div', null, planText),
        el('div', { class: 'actions' },
          el('button', {
            class: p.is_pro ? 'btn danger' : 'btn primary',
            onclick: () => {
              const msg = p.is_pro ? 'Remover o PRO pago desta conta?' : 'Marcar como PRO pago? A conta passa a receber 10 convites e 2 cupons de presente de 3 meses (uma vez).';
              if (confirm(msg)) after(api.rpc('admin_set_pro', { target: id, pro: !p.is_pro }), p.is_pro ? 'PRO pago removido.' : 'Marcada como PRO pago.');
            },
          }, p.is_pro ? 'Remover PRO pago' : 'Marcar PRO pago')),
        el('div', { class: 'faint', style: 'font-size:12.5px' }, 'PRO por tempo (mesmo prazo do cupom; soma ao que restar):'),
        el('div', { class: 'actions' },
          [1, 3, 12].map((m) => el('button', {
            class: 'btn',
            onclick: () => { if (confirm(`Adicionar ${m} ${m === 1 ? 'mês' : 'meses'} de PRO?`)) after(api.rpc('admin_adjust_coupon_pro', { target: id, months: m }), 'Prazo atualizado.'); },
          }, `+${m} ${m === 1 ? 'mês' : 'meses'}`)),
          plan === 'pro_coupon' ? el('button', {
            class: 'btn danger',
            onclick: () => { if (confirm('Encerrar agora o PRO por cupom/tempo?')) after(api.rpc('admin_adjust_coupon_pro', { target: id, months: 0 }), 'PRO por tempo encerrado.'); },
          }, 'Encerrar') : null)));

      const reason = el('input', { type: 'text', placeholder: 'Motivo (fica só no registro administrativo)', maxlength: 300, style: 'flex:1;min-width:200px' });
      const moderation = card('Moderação', u.suspension
        ? el('div', { class: 'stack' },
          el('div', { class: 'callout warn' }, `Suspensa em ${fmtDateTime(u.suspension.suspended_at)}. Motivo: ${u.suspension.reason || '—'}`),
          el('button', {
            class: 'btn primary',
            onclick: () => { if (confirm('Reativar esta conta?')) after(api.rpc('admin_set_suspended', { target: id, suspended: false }), 'Conta reativada.'); },
          }, 'Reativar conta'))
        : p.is_admin ? el('div', { class: 'faint' }, 'Contas administradoras não podem ser suspensas pelo painel.')
          : el('div', { class: 'stack' },
            el('div', { class: 'faint', style: 'font-size:12.5px' }, 'Suspender bane a conta no login (Auth) e encerra as sessões abertas.'),
            el('div', { class: 'actions' }, reason, el('button', {
              class: 'btn danger',
              onclick: async () => {
                if (!confirm(`Suspender ${p.display_name || 'esta conta'}?`)) return;
                const r = await after(api.rpc('admin_set_suspended', { target: id, suspended: true, reason: reason.value }), 'Conta suspensa.');
                if (r && r.auth_applied === false) toast('Suspensa no painel, mas o banco não permitiu banir no Auth. Faça pelo painel do Supabase.', true);
              },
            }, 'Suspender'))));

      const qty = el('input', { type: 'number', min: 1, max: 50, value: 5, style: 'width:80px', 'aria-label': 'Quantidade de convites' });
      const invites = card('Convites', el('div', { class: 'stack' },
        props([['Emitidos', fmtNum(u.invites.issued)], ['Usados', fmtNum(u.invites.used)]]),
        el('div', { class: 'actions' }, qty, el('button', {
          class: 'btn',
          onclick: () => {
            const n = Number(qty.value);
            if (!(n >= 1 && n <= 50)) return toast('Escolha de 1 a 50 convites.', true);
            after(api.rpc('admin_grant_invites', { target: id, quantity: n }), `${n} convite(s) adicionados.`);
          },
        }, 'Dar convites')),
        u.invites.recent.filter((i) => i.used_at).length ? el('ul', { class: 'feed' }, u.invites.recent.filter((i) => i.used_at).slice(0, 10).map((i) => el('li', null,
          el('span', { class: 'ico' }, '✉️'), el('div', { class: 'what' }, `${i.used_by_name || 'Conta removida'} `, el('span', { class: 'faint' }, fmtId(i.used_by_digfy))),
          el('span', { class: 'when' }, fmtDate(i.used_at))))) : null));

      const st = u.stats;
      const usage = card('Uso', props([
        ['Posts (no ar)', `${fmtNum(st.posts)} (${fmtNum(st.live_posts)})`], ['Comentários', fmtNum(st.comments)],
        ['Contatos', fmtNum(st.contacts)], ['Empresas', fmtNum(st.companies)], ['Candidaturas', fmtNum(st.applications)],
        ['Relatos de bug', fmtNum(st.bug_reports)],
      ]));
      const list = (items, render, emptyText) => (items.length ? el('ul', { class: 'feed' }, items.map(render)) : el('div', { class: 'faint' }, emptyText));
      const coupons = card('Cupons', el('div', { class: 'stack' },
        el('h3', null, 'Resgatados'),
        list(u.coupons_redeemed, (c) => el('li', null, el('span', { class: 'ico' }, '🎟️'),
          el('div', { class: 'what' }, `${c.months} meses`, c.gift_from ? el('span', { class: 'faint' }, ` · presente de ${c.gift_from}`) : null,
            c.code_hint ? el('span', { class: 'faint mono' }, ` · …${c.code_hint}`) : null),
          el('span', { class: 'when' }, fmtDate(c.redeemed_at))), 'Nenhum.'),
        el('h3', null, 'De presente (PRO pago)'),
        list(u.gift_coupons, (c) => el('li', null, el('span', { class: 'ico' }, '🎁'),
          el('div', { class: 'what' }, `${c.months} meses `, el('span', { class: 'faint mono' }, `…${c.code_hint}`),
            c.redeemed_by ? el('span', { class: 'faint' }, ` · usado por ${c.redeemed_by}`) : el('span', { class: 'faint' }, ' · ainda não usado')),
          el('span', { class: 'when' }, fmtDate(c.redeemed_at || c.created_at))), 'Nenhum.')));
      const reports = card('Relatos de bug', list(u.bug_reports, (b) => el('li', null, el('span', { class: 'ico' }, '🐞'),
        el('div', { class: 'what' }, b.title), el('span', { class: 'when' }, badge(STATUS, b.status))), 'Nenhum.'));
      const events = card('Eventos de segurança', list(u.security_events, (e) => el('li', null, el('span', { class: 'ico' }, '🛡️'),
        el('div', { class: 'what' }, EVENTS[e.kind] || e.kind, e.detail ? el('div', { class: 'faint mono' }, e.detail) : null),
        el('span', { class: 'when' }, fmtDateTime(e.created_at))), 'Nenhum.'));
      const audit = card('Histórico administrativo', list(u.audit, (a) => el('li', null, el('span', { class: 'ico' }, '📋'),
        el('div', { class: 'what' }, ACTIONS[a.action] || a.action, el('span', { class: 'faint' }, ` · ${a.admin_name || 'Admin'}`)),
        el('span', { class: 'when' }, fmtDateTime(a.created_at))), 'Nenhuma ação registrada.'));
      d.setBody(account, planCard, moderation, invites, usage, coupons, reports, events, audit);
    };
    await refresh();
  }

  // ── Cupons ────────────────────────────────────────────────────────
  async function viewCoupons() {
    const o = await refreshOverview();
    const f = { status: 'all', search: '' };
    let months = 1;
    const qty = el('input', { type: 'number', min: 1, max: 200, value: 1, style: 'width:90px' });
    const validity = selectBox([['', 'Sem prazo'], ['30', '30 dias'], ['60', '60 dias'], ['90', '90 dias'], ['180', '180 dias'], ['365', '1 ano']], '', () => {}, 'Validade');
    const note = el('input', { type: 'text', maxlength: 120, placeholder: 'Ex.: Parceria rádio X', style: 'width:220px;max-width:100%' });
    const createBtn = el('button', { class: 'btn primary', style: 'align-self:flex-end' }, 'Gerar códigos');
    createBtn.onclick = async () => {
      const n = Number(qty.value);
      if (!(n >= 1 && n <= 200)) return toast('Escolha de 1 a 200 cupons.', true);
      createBtn.disabled = true;
      try {
        const codes = await run(api.rpc('admin_create_coupons', {
          months, quantity: n, valid_days: validity.value ? Number(validity.value) : null, note: note.value || null,
        }));
        showCodes(codes);
        table.reload(true);
      } finally {
        createBtn.disabled = false;
      }
    };
    const create = card('Criar cupons', el('div', { class: 'stack' },
      el('div', { class: 'actions', style: 'align-items:flex-end' },
        el('label', { class: 'field' }, 'Duração', segmented([[1, '1 mês'], [3, '3 meses'], [12, '12 meses']], 1, (v) => { months = v; }, 'Duração')),
        el('label', { class: 'field' }, 'Quantidade', qty),
        el('label', { class: 'field' }, 'Validade para resgate', validity),
        el('label', { class: 'field' }, 'Nota interna', note),
        createBtn),
      el('div', { class: 'faint', style: 'font-size:12.5px' }, 'Os códigos são gerados no servidor e mostrados uma única vez: o banco guarda só o SHA-256 e os 4 últimos caracteres.')));
    const table = pagedTable([
      { label: 'Código', cell: (r) => el('span', { class: 'mono' }, `FC-…-${r.code_hint || '????'}`) },
      { label: 'Duração', cell: (r) => `${r.months} ${r.months === 1 ? 'mês' : 'meses'}` },
      { label: 'Origem', cell: (r) => (r.source === 'gift' ? el('span', null, 'Presente de ', el('b', null, r.gift_owner_name || '—')) : el('span', null, 'Administração', r.created_by_name ? el('span', { class: 'faint' }, ` · ${r.created_by_name}`) : null)) },
      { label: 'Situação', cell: (r) => badge(COUPON, r.state) },
      { label: 'Validade', cell: (r) => (r.valid_until ? fmtDate(r.valid_until) : el('span', { class: 'faint' }, 'sem prazo')) },
      { label: 'Resgatado por', cell: (r) => person(r.redeemed_by_name, r.redeemed_by_digfy, r.redeemed_by && (() => userDrawer(r.redeemed_by))) },
      { label: 'Resgate', cell: (r) => fmtDate(r.redeemed_at) },
      { label: 'Nota', cell: (r) => el('span', { class: 'muted' }, r.note || '') },
      {
        label: '',
        cell: (r, reload) => (r.state === 'available' ? el('button', {
          class: 'btn small danger',
          onclick: async (ev) => {
            ev.stopPropagation();
            if (!confirm(`Invalidar o cupom …${r.code_hint}? Ele deixa de valer na hora.`)) return;
            await run(api.rpc('admin_expire_coupon', { hash: r.code_hash }), 'Cupom invalidado.');
            reload();
          },
        }, 'Invalidar') : null),
      },
    ], (offset) => api.rpc('admin_list_coupons', { status: f.status, search: f.search, max_rows: PAGE, skip: offset }),
    { empty: 'Nenhum cupom com esses filtros.' });
    return [
      topbar('Cupons'),
      el('div', { class: 'grid kpis' },
        kpi('Disponíveis', o.coupons.available, 'não resgatados e no prazo'),
        kpi('Resgatados', o.coupons.redeemed, `${fmtNum(o.coupons.redeemed_7d)} nos últimos 7 dias`),
        kpi('Cupons de presente', o.coupons.gifts, '2 por conta PRO paga'),
        kpi('Tentativas (24 h)', o.coupons.failed_attempts_1d, 'limite: 10 a cada 15 min por conta')),
      el('div', { style: 'margin-bottom:14px' }, create),
      el('div', { class: 'toolbar' },
        segmented([['all', 'Todos'], ['available', 'Disponíveis'], ['redeemed', 'Resgatados'], ['expired', 'Vencidos'], ['gift', 'Presentes'], ['admin', 'Da administração']],
          f.status, (v) => { f.status = v; table.reload(true); }, 'Situação'),
        searchBox('Final do código, nota ou pessoa', '', (v) => { f.search = v; table.reload(true); })),
      table,
    ];
  }

  function showCodes(codes) {
    const textOut = codes.map((c) => c.code).join('\n');
    const m = codes[0].coupon_months;
    const until = codes[0].expires_at ? `resgatar até ${fmtDate(codes[0].expires_at)}` : 'sem prazo para resgate';
    openDrawer(el('h2', null, `${codes.length} cupom(ns) de ${m} ${m === 1 ? 'mês' : 'meses'}`), [
      el('div', { class: 'callout warn' }, 'Guarde agora. Estes códigos não podem ser exibidos de novo: o banco guarda só o hash.'),
      el('div', { class: 'muted' }, until),
      el('div', { class: 'codes' }, textOut),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn primary',
          onclick: () => navigator.clipboard.writeText(textOut).then(() => toast('Copiados.'), () => toast('Não foi possível copiar.', true)),
        }, 'Copiar todos'),
        el('button', {
          class: 'btn',
          onclick: () => {
            const url = URL.createObjectURL(new Blob([textOut + '\n'], { type: 'text/plain' }));
            const a = el('a', { href: url, download: `cupons-pro-${m}m-${new Date().toISOString().slice(0, 10)}.txt` });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          },
        }, 'Baixar .txt')),
    ]);
  }

  // ── Convites ──────────────────────────────────────────────────────
  async function viewInvites() {
    const [o, top] = await Promise.all([refreshOverview(), api.rpc('admin_top_inviters', { max_rows: 10 })]);
    const f = { status: 'all', search: '' };
    const rate = o.invites.total ? Math.round((o.invites.used / o.invites.total) * 100) : 0;
    const table = pagedTable([
      { label: 'Código', cell: (r) => el('span', { class: 'mono' }, fmtId(r.code)) },
      { label: 'Emitido por', cell: (r) => person(r.issuer_name, r.issuer_digfy, r.issuer_id && (() => userDrawer(r.issuer_id))) },
      { label: 'Criado', cell: (r) => fmtDate(r.created_at) },
      { label: 'Usado por', cell: (r) => (r.used_by ? person(r.used_by_name, r.used_by_digfy, () => userDrawer(r.used_by)) : el('span', { class: 'badge b-muted' }, 'Livre')) },
      { label: 'Usado em', cell: (r) => fmtDateTime(r.used_at) },
    ], (offset) => api.rpc('admin_list_invites', { status: f.status, search: f.search, max_rows: PAGE, skip: offset }),
    { empty: 'Nenhum convite com esses filtros.' });
    return [
      topbar('Convites'),
      el('div', { class: 'grid kpis' },
        kpi('Convites emitidos', o.invites.total, 'gratuita: 5 por conta · PRO: 10'),
        kpi('Usados', o.invites.used, `${rate}% de aproveitamento`),
        kpi('Usados em 7 dias', o.invites.used_7d, 'novas contas por convite')),
      el('div', { class: 'grid two', style: 'margin-bottom:14px' },
        el('div', null,
          el('div', { class: 'toolbar' },
            segmented([['all', 'Todos'], ['used', 'Usados'], ['unused', 'Livres']], f.status, (v) => { f.status = v; table.reload(true); }, 'Situação'),
            searchBox('Código, quem emitiu ou quem usou', '', (v) => { f.search = v; table.reload(true); })),
          table),
        card('Quem mais trouxe gente', barList(top.map((t) => ({ label: `${t.display_name || 'Sem nome'} · ${fmtId(t.digfy_id)}`, value: Number(t.used) }))))),
    ];
  }

  // ── Segurança ─────────────────────────────────────────────────────
  async function viewSecurity() {
    const o = await refreshOverview();
    const f = { kind: '' };
    const byKind = Object.entries(o.security.by_kind_7d).sort((a, b) => b[1] - a[1]);
    const table = pagedTable([
      { label: 'Quando', cell: (r) => el('span', { title: fmtDateTime(r.created_at) }, fmtDateTime(r.created_at)) },
      { label: 'Evento', cell: (r) => el('div', { class: 'person' }, el('b', null, EVENTS[r.event_kind] || r.event_kind), el('span', { class: 'mono' }, r.event_kind)) },
      { label: 'Detalhe', cell: (r) => el('span', { class: 'mono muted' }, r.detail || '') },
      { label: 'Conta', cell: (r) => person(r.user_name, r.user_digfy, r.user_id && (() => userDrawer(r.user_id))) },
    ], (offset) => api.rpc('admin_list_security_events', { kind: f.kind, max_rows: PAGE, skip: offset }),
    { empty: 'Nenhum evento registrado (o registro guarda 90 dias).' });
    return [
      topbar('Segurança'),
      el('div', { class: 'grid kpis' },
        kpi('Eventos em 24 h', o.security.events_1d), kpi('Eventos em 7 dias', o.security.events_7d),
        kpi('Contas suspensas', o.users.suspended, null, () => { location.hash = '#/users?filter=suspended'; })),
      el('div', { class: 'grid two' },
        el('div', null,
          el('div', { class: 'toolbar' }, selectBox([['', 'Todos os tipos'], ...Object.entries(EVENTS)], '', (v) => { f.kind = v; table.reload(true); }, 'Tipo')),
          table),
        card('Por tipo (7 dias)', barList(byKind.map(([k, v]) => ({ label: EVENTS[k] || k, value: v }))))),
    ];
  }

  // ── Auditoria ─────────────────────────────────────────────────────
  async function viewAudit() {
    const table = pagedTable([
      { label: 'Quando', cell: (r) => fmtDateTime(r.created_at) },
      { label: 'Administrador', cell: (r) => r.admin_name || '—' },
      { label: 'Ação', cell: (r) => ACTIONS[r.action] || r.action },
      { label: 'Alvo', cell: (r) => (r.target_name ? el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); userDrawer(r.target); } }, r.target_name) : el('span', { class: 'mono faint' }, r.target ? r.target.slice(0, 12) : '—')) },
      {
        label: 'Detalhe',
        cell: (r) => el('span', { class: 'mono muted' }, Object.entries(r.detail || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`).join(' · ')),
      },
    ], (offset) => api.rpc('admin_list_audit', { max_rows: PAGE, skip: offset }), { empty: 'Nenhuma ação administrativa ainda.' });
    return [topbar('Auditoria'), el('p', { class: 'muted', style: 'margin-top:-6px' }, 'Toda ação feita pelo painel fica registrada aqui, com quem fez e quando.'), table];
  }

  const VIEW_RENDER = {
    overview: viewOverview, tickets: viewTickets, users: viewUsers, pro: viewPro,
    coupons: viewCoupons, invites: viewInvites, security: viewSecurity, audit: viewAudit,
  };

  boot().catch((e) => message('Erro', errorText(e)));
})();
