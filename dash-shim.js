'use strict';
/*
 * Camada de compatibilidade: reproduz no celular as funções que o painel
 * "Carteira Pessoal" usa no Claude (dash.data, draw, calc, loader, colors, setLink).
 * Assim painel.html roda aqui sem nenhuma alteração.
 *
 * Fontes:
 *  - ao vivo: abas da planilha Google (cotações e preços semanais);
 *  - arquivos: pacote de dados importado no aparelho (fica só no IndexedDB).
 */
(function () {
  const AO_VIVO = {
    cotacoes: { aba: 'Cotações', faixa: 'A1:G60' },
    precos_semanais_1: { aba: 'Semanal', faixa: 'A1:AR420' },
    precos_semanais_2: { aba: 'Semanal', faixa: 'AS1:CK420' },
  };
  const ARQUIVOS = ['lancamentos', 'proventos_b3', 'provisionados', 'posicao_corretora', 'renda_fixa_bancos', 'precos_b3', 'indices_bcb'];

  const estado = {};   // id -> {status, data, message, ver}
  const loaders = {};
  const calcs = {};    // id -> {inputs, fn, chave, valor}
  const desenhos = {}; // nome -> {fn | {mount, update, unmount}, feitos: Map}
  const ouvintes = [];
  let ver = 0;

  /* ---------- armazenamento local (IndexedDB) ---------- */
  const idb = () => new Promise((ok, erro) => {
    const r = indexedDB.open('carteira', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  });
  async function ler(chave) {
    try {
      const db = await idb();
      return await new Promise((ok, erro) => {
        const q = db.transaction('kv').objectStore('kv').get(chave);
        q.onsuccess = () => ok(q.result);
        q.onerror = () => erro(q.error);
      });
    } catch (e) { return undefined; }
  }
  async function gravar(chave, valor) {
    const db = await idb();
    await new Promise((ok, erro) => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(valor, chave);
      t.oncomplete = ok;
      t.onerror = () => erro(t.error);
    });
  }

  /* ---------- fontes ---------- */
  function definir(id, status, data, message) {
    estado[id] = { status, data, message: message || '', ver: ++ver };
    agendar();
  }

  function linhasCSV(texto) {
    const linhas = d3.csvParse(texto, (r) => {
      for (const k in r) if (r[k] === '') r[k] = null;
      return r;
    });
    return linhas;
  }

  // Converte uma célula do gviz no texto que o painel recebia da API do Sheets.
  function celula(c) {
    if (!c || c.v == null) return '';
    if (typeof c.v === 'number') return String(c.v).replace('.', ',');
    if (typeof c.v === 'string' && c.v.startsWith('Date(')) {
      const n = c.v.slice(5, -1).split(',').map(Number);
      if (n.length > 3 && c.f) return c.f;
      return `${n[0]}-${String(n[1] + 1).padStart(2, '0')}-${String(n[2]).padStart(2, '0')}`;
    }
    return String(c.v);
  }

  async function buscarAba(sheetId, aba, faixa) {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(aba)}&range=${faixa}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const t = await r.text();
    const i = t.indexOf('('), j = t.lastIndexOf(')');
    if (i < 0 || j < 0) throw new Error('a planilha não está compartilhada como “qualquer pessoa com o link”');
    const res = JSON.parse(t.slice(i + 1, j));
    if (res.status === 'error') throw new Error((res.errors && res.errors[0] && res.errors[0].detailed_message) || 'erro da planilha');
    const cab = res.table.cols.map((c) => c.label || '');
    const linhas = res.table.rows.map((row) => (row.c || []).map(celula));
    return { values: [cab, ...linhas] };
  }

  async function carregarAoVivo(sheetId) {
    const cache = (await ler('ao-vivo')) || {};
    const falhas = [];
    await Promise.all(Object.entries(AO_VIVO).map(async ([id, s]) => {
      if (!estado[id] || estado[id].status !== 'ok') definir(id, cache[id] ? 'ok' : 'loading', [], '');
      if (cache[id]) aplicarLoader(id, cache[id].resposta);
      if (!sheetId) { if (!cache[id]) definir(id, 'error', [], 'Planilha não configurada.'); return; }
      try {
        const resposta = await buscarAba(sheetId, s.aba, s.faixa);
        cache[id] = { resposta, em: new Date().toISOString() };
        aplicarLoader(id, resposta);
      } catch (e) {
        if (!cache[id]) definir(id, 'error', [], e.message);
        falhas.push(`${s.aba}: ${e.message}`);
      }
    }));
    try { await gravar('ao-vivo', cache); } catch (e) { /* sem cache offline */ }
    return { falhas };
  }

  function aplicarLoader(id, resposta) {
    try {
      const l = loaders[id];
      const dados = l ? l.fn({ answer: resposta }) : resposta;
      definir(id, 'ok', dados);
    } catch (e) {
      definir(id, 'error', [], e.message);
    }
  }

  function carregarArquivos(pacote) {
    for (const id of ARQUIVOS) {
      const texto = pacote && pacote.arquivos && pacote.arquivos[id];
      if (texto == null) definir(id, 'error', [], 'Dados não importados.');
      else {
        try { definir(id, 'ok', linhasCSV(texto)); } catch (e) { definir(id, 'error', [], e.message); }
      }
    }
  }

  /* ---------- cálculos ---------- */
  function avaliar(id) {
    const c = calcs[id];
    const ins = c.inputs.map((i) => dash.data(i));
    const ruim = ins.find((d) => d.status !== 'ok' && d.status !== 'loading');
    if (ruim) return { status: 'error', data: null, message: ruim.message, ver: 0 };
    if (ins.some((d) => d.status === 'loading')) return { status: 'loading', data: null, message: '', ver: 0 };
    const chave = c.inputs.map((i) => (estado[i] || calcs[i] || {}).ver).join('|');
    if (c.chave !== chave) {
      try {
        c.valor = { status: 'ok', data: c.fn(...ins.map((d) => d.data)), message: '' };
      } catch (e) {
        console.error('calc', id, e);
        c.valor = { status: 'error', data: null, message: e.message };
      }
      c.chave = chave;
      c.ver = ++ver;
    }
    return c.valor;
  }

  /* ---------- desenhos ---------- */
  function rodar(nome) {
    const d = desenhos[nome];
    if (!d) return;
    document.querySelectorAll(`#dash-root [data-draw="${CSS.escape(nome)}"]`).forEach((el) => {
      if (el.closest('[hidden]')) return;
      try {
        if (typeof d.fn === 'function') d.fn(el);
        else {
          if (!d.feitos.has(el)) { el.replaceChildren(); d.feitos.set(el, d.fn.mount ? d.fn.mount(el) : undefined); }
          if (d.fn.update) d.fn.update(el, d.feitos.get(el));
        }
      } catch (e) {
        console.error('desenho', nome, e);
      }
    });
  }

  let pendente = false;
  function agendar() {
    if (pendente || !iniciado) return;
    pendente = true;
    requestAnimationFrame(() => {
      pendente = false;
      ouvintes.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
      Object.keys(desenhos).forEach(rodar);
    });
  }
  let iniciado = false;

  /* ---------- API usada pelo painel ---------- */
  const dash = {
    data(id) {
      if (calcs[id]) return avaliar(id);
      const s = estado[id];
      if (!s) return { status: 'missing', data: [], message: '', refreshing: false, meta: {} };
      return { status: s.status, data: s.data, message: s.message, refreshing: false, meta: {} };
    },
    onData(fn) { ouvintes.push(fn); if (iniciado) fn(); },
    calc(id, def) { calcs[id] = { inputs: def.inputs || [], fn: def.fn, chave: null, valor: null, ver: 0 }; },
    loader(id, def) { loaders[id] = def; },
    draw(nome, fn) {
      if (fn === undefined) { rodar(nome); return; }
      desenhos[nome] = { fn, feitos: new Map() };
    },
    colors: ['var(--serie-1)', 'var(--serie-2)', 'var(--serie-3)', 'var(--serie-4)', 'var(--serie-5)', 'var(--serie-6)', 'var(--serie-7)', 'var(--serie-8)'],
    refresh() { app.atualizar(); },
    setLink(nome) { try { history.replaceState(null, '', '#' + nome); } catch (e) { /* ignora */ } },
    params() { return {}; },
    setParams() {},
    resetParams() {},
  };
  window.dash = dash;

  /* ---------- controle do app ---------- */
  const app = {
    ler, gravar,
    async iniciar(htmlPainel) {
      const root = document.getElementById('dash-root');
      const doc = new DOMParser().parseFromString(htmlPainel, 'text/html');
      const scripts = [...doc.querySelectorAll('script')];
      scripts.forEach((s) => s.remove());
      root.replaceChildren(...doc.head.childNodes, ...doc.body.childNodes);
      for (const s of scripts) {
        const el = document.createElement('script');
        el.textContent = s.textContent;
        root.appendChild(el);
      }
      new MutationObserver(agendar).observe(root, { attributes: true, attributeFilter: ['hidden'], subtree: true });
      let largura = window.innerWidth;
      window.addEventListener('resize', () => { if (window.innerWidth !== largura) { largura = window.innerWidth; agendar(); } });

      const pacote = await ler('pacote');
      carregarArquivos(pacote);
      iniciado = true;
      agendar();
      return pacote;
    },
    async atualizar() {
      const pacote = await ler('pacote');
      const sheetId = (await ler('sheetId')) || (pacote && pacote.sheetId) || '';
      return carregarAoVivo(sheetId);
    },
    async importar(texto) {
      const p = JSON.parse(texto);
      if (p.formato !== 'carteira-pacote-v1' || !p.arquivos) throw new Error('arquivo não é um pacote da carteira');
      const faltam = ARQUIVOS.filter((k) => p.arquivos[k] == null);
      await gravar('pacote', p);
      if (p.sheetId && !(await ler('sheetId'))) await gravar('sheetId', p.sheetId);
      carregarArquivos(p);
      return { gerado: p.gerado, faltam };
    },
  };
  window.CarteiraApp = app;
})();
