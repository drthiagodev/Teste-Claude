'use strict';

/* ---------- Estado ---------- */

const CHAVE = 'carteira.v1';
const CLASSES = ['Ações', 'FIIs', 'ETFs', 'Exterior', 'Cripto', 'Outros'];

const vazio = () => ({
  config: { sheetId: '' },
  classes: {},          // ticker -> classe escolhida pelo usuário
  lancamentos: [],      // {id, tipo, ativo, data, qtd, valor}
  rendaFixa: [],        // {id, nome, tipo, taxa, data, valor, venc}
  cache: { cotacoes: {}, cdi: [], ipca: {}, atualizado: null },
});

let db = carregar();

function carregar() {
  try {
    const bruto = localStorage.getItem(CHAVE);
    if (!bruto) return vazio();
    return Object.assign(vazio(), JSON.parse(bruto));
  } catch (e) {
    return vazio();
  }
}

function salvar() {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(db));
  } catch (e) {
    status('Não consegui salvar neste aparelho (armazenamento cheio ou bloqueado).', true);
  }
}

/* ---------- Utilidades ---------- */

const $ = (s) => document.querySelector(s);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 });
const R = (v) => brl.format(v || 0);
const sinal = (v) => (v > 0.005 ? 'pos' : v < -0.005 ? 'neg' : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const hoje = () => new Date().toISOString().slice(0, 10);

// Aceita "1.234,56", "1234,56", "1234.56", "0,0096".
function num(s) {
  if (typeof s === 'number') return s;
  if (s == null) return NaN;
  let t = String(s).trim().replace(/[R$\s%]/g, '');
  if (!t) return NaN;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return parseFloat(t);
}

// Datas da planilha: "dd/mm/aaaa", "aaaa-mm-dd", "Date(2026,10,9)" ou número de série.
function data(s) {
  if (s == null || s === '') return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/^Date\((\d+),(\d+),(\d+)/);
  if (m) return `${m[1]}-${String(+m[2] + 1).padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const n = num(t);
  if (n > 20000 && n < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function diasUteis(de, ate) {
  // Dias de semana entre (de, ate]. Não considera feriados.
  const a = new Date(de + 'T12:00:00Z');
  const b = new Date(ate + 'T12:00:00Z');
  let n = 0;
  for (let d = new Date(a.getTime() + 86400000); d <= b; d = new Date(d.getTime() + 86400000)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

function csv(texto) {
  const linhas = [];
  let linha = [], campo = '', aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo); linhas.push(linha); linha = []; campo = '';
    } else campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

const normaliza = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

function status(msg, erro) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('erro', !!erro);
}

/* ---------- Busca de dados ---------- */

function extraiSheetId(entrada) {
  const t = String(entrada || '').trim();
  const m = t.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(t) ? t : '';
}

async function lerAba(nome) {
  const url = `https://docs.google.com/spreadsheets/d/${db.config.sheetId}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(nome)}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`aba ${nome}: HTTP ${r.status}`);
  const texto = await r.text();
  if (texto.trimStart().startsWith('<')) throw new Error('a planilha não está compartilhada para leitura');
  return csv(texto);
}

function colunas(cab, nomes) {
  const n = cab.map(normaliza);
  const out = {};
  for (const [chave, alvo] of Object.entries(nomes)) out[chave] = n.findIndex((h) => h.startsWith(alvo));
  return out;
}

async function atualizarCotacoes() {
  const linhas = await lerAba('Cotações');
  const c = colunas(linhas[0], { ativo: 'ativo', moeda: 'moeda', preco: 'preco', var: 'vardia', brl: 'precoemr', ult: 'ultima' });
  const cot = {};
  for (const l of linhas.slice(1)) {
    const tk = (l[c.ativo] || '').trim().toUpperCase();
    if (!tk) continue;
    const precoBRL = num(l[c.brl]);
    cot[tk] = {
      moeda: (l[c.moeda] || 'BRL').trim(),
      preco: num(l[c.preco]),
      var: num(l[c.var]),
      precoBRL: isFinite(precoBRL) ? precoBRL : num(l[c.preco]),
      ult: (l[c.ult] || '').trim(),
    };
  }
  if (!Object.keys(cot).length) throw new Error('aba Cotações veio vazia');
  db.cache.cotacoes = cot;
}

async function atualizarIndicesPlanilha() {
  const linhas = await lerAba('Índices');
  const c = colunas(linhas[0], { data: 'data', cdi: 'cdi', ipca: 'ipca' });
  const cdi = [], ipca = {};
  for (const l of linhas.slice(1)) {
    const d = data(l[c.data]);
    if (!d) continue;
    const vc = num(l[c.cdi]);
    if (isFinite(vc)) cdi.push([d, vc]);
    const vi = num(l[c.ipca]);
    if (c.ipca >= 0 && isFinite(vi)) ipca[d.slice(0, 7)] = vi;
  }
  return { cdi, ipca };
}

// Reserva: API pública do Banco Central (séries 12 = CDI diário, 433 = IPCA mensal).
async function atualizarIndicesBCB(desde) {
  const [a, m, d] = desde.split('-');
  const ini = `${d}/${m}/${a}`;
  const get = async (serie) => {
    const r = await fetch(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie}/dados?formato=json&dataInicial=${ini}`);
    if (!r.ok) throw new Error(`BCB ${serie}: HTTP ${r.status}`);
    return r.json();
  };
  const [s12, s433] = await Promise.all([get(12), get(433)]);
  const cdi = s12.map((x) => [data(x.data), num(x.valor)]).filter((x) => x[0] && isFinite(x[1]));
  const ipca = {};
  for (const x of s433) { const dd = data(x.data); if (dd) ipca[dd.slice(0, 7)] = num(x.valor); }
  return { cdi, ipca };
}

async function atualizarIndices() {
  if (!db.rendaFixa.length) return;
  let idx = { cdi: [], ipca: {} };
  try { idx = await atualizarIndicesPlanilha(); } catch (e) { /* tenta o BCB */ }
  const precisaCDI = db.rendaFixa.some((x) => x.tipo === 'cdi');
  const precisaIPCA = db.rendaFixa.some((x) => x.tipo === 'ipca');
  if ((precisaCDI && !idx.cdi.length) || (precisaIPCA && !Object.keys(idx.ipca).length)) {
    const desde = db.rendaFixa.map((x) => x.data).sort()[0];
    try {
      const bcb = await atualizarIndicesBCB(desde);
      if (!idx.cdi.length) idx.cdi = bcb.cdi;
      if (!Object.keys(idx.ipca).length) idx.ipca = bcb.ipca;
    } catch (e) { /* mantém o que houver */ }
  }
  if (idx.cdi.length) db.cache.cdi = idx.cdi.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (Object.keys(idx.ipca).length) db.cache.ipca = idx.ipca;
}

async function atualizar() {
  if (!db.config.sheetId) {
    status('Informe a planilha em Ajustes para buscar cotações.', true);
    return;
  }
  const btn = $('#btn-atualizar');
  btn.classList.add('girando');
  status('Atualizando…');
  try {
    await atualizarCotacoes();
    await atualizarIndices();
    db.cache.atualizado = new Date().toISOString();
    salvar();
    status('');
  } catch (e) {
    status(`Falha ao atualizar: ${e.message}. Mostrando últimos valores salvos.`, true);
  } finally {
    btn.classList.remove('girando');
    render();
  }
}

/* ---------- Cálculos ---------- */

function classeDe(tk) {
  if (db.classes[tk]) return db.classes[tk];
  const c = db.cache.cotacoes[tk];
  if (c && c.moeda && c.moeda !== 'BRL') return 'Exterior';
  if (/^(BTC|ETH|SOL)/.test(tk)) return 'Cripto';
  if (/11$/.test(tk)) return 'FIIs';
  return 'Ações';
}

function posicoes() {
  const pos = {};
  const ordem = [...db.lancamentos].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  for (const l of ordem) {
    const p = (pos[l.ativo] ||= { ativo: l.ativo, qtd: 0, custo: 0, realizado: 0, proventos: 0 });
    if (l.tipo === 'compra') { p.qtd += l.qtd; p.custo += l.valor; }
    else if (l.tipo === 'venda') {
      const pm = p.qtd > 0 ? p.custo / p.qtd : 0;
      const q = Math.min(l.qtd, p.qtd);
      p.realizado += l.valor - q * pm;
      p.qtd -= q; p.custo -= q * pm;
      if (p.qtd < 1e-9) { p.qtd = 0; p.custo = 0; }
    } else if (l.tipo === 'provento') p.proventos += l.valor;
  }
  for (const p of Object.values(pos)) {
    const c = db.cache.cotacoes[p.ativo];
    p.pm = p.qtd ? p.custo / p.qtd : 0;
    p.preco = c && isFinite(c.precoBRL) ? c.precoBRL : null;
    p.valor = p.preco != null ? p.qtd * p.preco : p.custo;
    p.var = c && isFinite(c.var) ? c.var : 0;
    p.ganhoDia = p.preco != null ? p.valor - p.valor / (1 + p.var) : 0;
    p.semCotacao = p.preco == null;
    p.classe = classeDe(p.ativo);
  }
  return Object.values(pos);
}

function valorRendaFixa(x) {
  const fim = hoje();
  const du = diasUteis(x.data, fim);
  let fator = 1, aviso = '';
  if (x.tipo === 'pre') {
    fator = Math.pow(1 + x.taxa / 100, du / 252);
  } else if (x.tipo === 'cdi') {
    const serie = db.cache.cdi.filter(([d]) => d > x.data && d <= fim);
    for (const [, v] of serie) fator *= 1 + (v / 100) * (x.taxa / 100);
    if (!serie.length) aviso = 'sem dados de CDI';
    else if (serie[serie.length - 1][0] < fim) aviso = `CDI até ${serie[serie.length - 1][0].split('-').reverse().join('/')}`;
  } else if (x.tipo === 'ipca') {
    const mesAplic = x.data.slice(0, 7);
    const meses = Object.keys(db.cache.ipca).filter((m) => m > mesAplic).sort();
    for (const m of meses) fator *= 1 + db.cache.ipca[m] / 100;
    if (!meses.length) aviso = 'sem dados de IPCA';
    fator *= Math.pow(1 + x.taxa / 100, du / 252);
  }
  return { valor: x.valor * fator, aviso };
}

/* ---------- Telas ---------- */

function renderResumo(pos, rf) {
  const ativos = pos.filter((p) => p.qtd > 0);
  const totalRV = ativos.reduce((s, p) => s + p.valor, 0);
  const totalRF = rf.reduce((s, x) => s + x.atual, 0);
  const total = totalRV + totalRF;
  const investido = ativos.reduce((s, p) => s + p.custo, 0) + rf.reduce((s, x) => s + x.valor, 0);
  const dia = ativos.reduce((s, p) => s + p.ganhoDia, 0);
  const proventos = pos.reduce((s, p) => s + p.proventos, 0);
  const realizado = pos.reduce((s, p) => s + p.realizado, 0);
  const resultado = total - investido;

  $('#r-total').textContent = R(total);
  const base = totalRV - dia;
  $('#r-dia').innerHTML = totalRV
    ? `<span class="${sinal(dia)}">${dia >= 0 ? '+' : ''}${R(dia)} (${pct.format(base ? dia / base : 0)}) hoje em renda variável</span>`
    : '';
  $('#r-investido').textContent = R(investido);
  $('#r-resultado').innerHTML = `<span class="${sinal(resultado)}">${R(resultado)}</span>`;
  $('#r-proventos').textContent = R(proventos);
  $('#r-realizado').innerHTML = `<span class="${sinal(realizado)}">${R(realizado)}</span>`;

  const porClasse = {};
  for (const p of ativos) porClasse[p.classe] = (porClasse[p.classe] || 0) + p.valor;
  if (totalRF) porClasse['Renda fixa'] = totalRF;
  const itens = Object.entries(porClasse).sort((a, b) => b[1] - a[1]);
  $('#r-alocacao').innerHTML = itens.length
    ? itens.map(([k, v]) => `
      <div class="barra">
        <div class="barra-topo"><span>${esc(k)}</span><span>${pct.format(v / total)} · ${R(v)}</span></div>
        <div class="barra-fundo"><div class="barra-cheia" style="width:${(v / total) * 100}%"></div></div>
      </div>`).join('')
    : '<p class="vazio">Nenhum investimento lançado ainda. Use a aba Lançar.</p>';

  const at = db.cache.atualizado;
  $('#r-cotacao-hora').textContent = at
    ? `Cotações atualizadas em ${new Date(at).toLocaleString('pt-BR')}. Fonte: Google Finance, via planilha.`
    : '';
}

function renderAtivos(pos, rf) {
  const ativos = pos.filter((p) => p.qtd > 0);
  const total = ativos.reduce((s, p) => s + p.valor, 0) + rf.reduce((s, x) => s + x.atual, 0);
  const grupos = {};
  for (const p of ativos) (grupos[p.classe] ||= []).push(p);
  const html = [];
  for (const classe of [...CLASSES, ...Object.keys(grupos).filter((k) => !CLASSES.includes(k))]) {
    const lista = grupos[classe];
    if (!lista) continue;
    lista.sort((a, b) => b.valor - a.valor);
    html.push(`<div class="grupo">${esc(classe)}</div>`);
    for (const p of lista) {
      const res = p.valor - p.custo;
      html.push(`
        <div class="item">
          <span class="nome">${esc(p.ativo)}</span>
          <span class="dir">${R(p.valor)}</span>
          <span class="mini">${numFmt.format(p.qtd)} × ${p.semCotacao ? 'sem cotação' : R(p.preco)} · PM ${R(p.pm)}</span>
          <span class="dir mini"><span class="${sinal(res)}">${R(res)} (${pct.format(p.custo ? res / p.custo : 0)})</span></span>
          <span class="mini">${total ? pct.format(p.valor / total) : ''} da carteira</span>
          <span class="dir mini"><span class="${sinal(p.var)}">${p.semCotacao ? '' : 'dia ' + pct.format(p.var)}</span></span>
        </div>`);
    }
  }
  $('#lista-ativos').innerHTML = html.join('') || '<p class="vazio">Nenhuma posição em renda variável.</p>';

  const rotuloTipo = { cdi: (x) => `${numFmt.format(x.taxa)}% do CDI`, pre: (x) => `Pré ${numFmt.format(x.taxa)}% a.a.`, ipca: (x) => `IPCA + ${numFmt.format(x.taxa)}% a.a.` };
  $('#lista-rf').innerHTML = rf.length
    ? rf.map((x) => {
        const res = x.atual - x.valor;
        return `
        <div class="item">
          <span class="nome">${esc(x.nome)}</span>
          <span class="dir">${R(x.atual)}</span>
          <span class="mini">${rotuloTipo[x.tipo](x)} · aplicado ${R(x.valor)} em ${x.data.split('-').reverse().join('/')}</span>
          <span class="dir mini"><span class="${sinal(res)}">${R(res)}</span></span>
          <span class="mini">${x.venc ? 'vence ' + x.venc.split('-').reverse().join('/') : ''}${x.aviso ? ' · ' + esc(x.aviso) : ''}</span>
          <button class="del" data-del-rf="${x.id}">excluir</button>
        </div>`;
      }).join('')
    : '<p class="vazio">Nenhum título de renda fixa.</p>';
}

function renderLancamentos() {
  const nomes = { compra: 'Compra', venda: 'Venda', provento: 'Provento' };
  const lista = [...db.lancamentos].sort((a, b) => (a.data < b.data ? 1 : -1)).slice(0, 50);
  $('#lista-lanc').innerHTML = lista.length
    ? lista.map((l) => `
      <div class="item">
        <span class="nome">${nomes[l.tipo]} · ${esc(l.ativo)}</span>
        <span class="dir">${R(l.valor)}</span>
        <span class="mini">${l.data.split('-').reverse().join('/')}${l.tipo !== 'provento' ? ' · ' + numFmt.format(l.qtd) + ' un.' : ''}</span>
        <button class="del" data-del-lanc="${l.id}">excluir</button>
      </div>`).join('')
    : '<p class="vazio">Nenhum lançamento.</p>';

  $('#tickers').innerHTML = Object.keys(db.cache.cotacoes)
    .filter((t) => t !== 'USDBRL').sort()
    .map((t) => `<option value="${esc(t)}">`).join('');
}

function renderAjustes(pos) {
  $('#form-config').sheet.value = db.config.sheetId;
  const tks = [...new Set(pos.map((p) => p.ativo))].sort();
  $('#lista-classes').innerHTML = tks.length
    ? tks.map((t) => `
      <div class="classe-linha">
        <span>${esc(t)}</span>
        <select data-classe="${esc(t)}">${CLASSES.map((c) => `<option ${classeDe(t) === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>`).join('')
    : '<p class="nota">As classes aparecem aqui depois do primeiro lançamento.</p>';
}

function render() {
  const pos = posicoes();
  const rf = db.rendaFixa.map((x) => { const v = valorRendaFixa(x); return { ...x, atual: v.valor, aviso: v.aviso }; });
  renderResumo(pos, rf);
  renderAtivos(pos, rf);
  renderLancamentos();
  renderAjustes(pos);
}

/* ---------- Eventos ---------- */

const TITULOS = { resumo: 'Resumo', ativos: 'Ativos', lancar: 'Lançar', ajustes: 'Ajustes' };
function irPara(tela) {
  document.querySelectorAll('.tela').forEach((s) => s.classList.toggle('ativa', s.id === 'tela-' + tela));
  document.querySelectorAll('.rodape button').forEach((b) => b.classList.toggle('ativa', b.dataset.tela === tela));
  $('#titulo').textContent = TITULOS[tela];
  window.scrollTo(0, 0);
}
document.querySelectorAll('.rodape button').forEach((b) => b.addEventListener('click', () => irPara(b.dataset.tela)));
$('#btn-atualizar').addEventListener('click', atualizar);

document.querySelectorAll('.aba').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.aba').forEach((x) => x.classList.toggle('ativa', x === b));
  $('#form-rv').hidden = b.dataset.form !== 'form-rv';
  $('#form-rf').hidden = b.dataset.form !== 'form-rf';
}));

const formRV = $('#form-rv');
formRV.data.value = hoje();
formRV.tipo.addEventListener('change', () => {
  const negocio = formRV.tipo.value !== 'provento';
  document.querySelectorAll('.so-negocio').forEach((el) => (el.hidden = !negocio));
});
formRV.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = formRV;
  const tipo = f.tipo.value;
  const ativo = f.ativo.value.trim().toUpperCase();
  const qtd = tipo === 'provento' ? 0 : num(f.qtd.value);
  const valor = num(f.valor.value);
  if (!ativo || !isFinite(valor) || valor <= 0 || (tipo !== 'provento' && !(qtd > 0))) {
    status('Preencha ativo, quantidade e valor com números válidos.', true);
    return;
  }
  if (tipo === 'venda') {
    const p = posicoes().find((x) => x.ativo === ativo);
    if (!p || p.qtd + 1e-9 < qtd) { status(`Você não tem ${numFmt.format(qtd)} de ${ativo} para vender.`, true); return; }
  }
  db.lancamentos.push({ id: uid(), tipo, ativo, data: f.data.value, qtd, valor });
  salvar();
  f.qtd.value = ''; f.valor.value = ''; f.ativo.value = '';
  status(`Lançamento de ${ativo} salvo.`);
  render();
});

const formRF = $('#form-rf');
formRF.data.value = hoje();
formRF.tipo.addEventListener('change', () => {
  $('#rf-taxa-rotulo').textContent = { cdi: '% do CDI', pre: 'Taxa ao ano (%)', ipca: 'Taxa acima do IPCA, ao ano (%)' }[formRF.tipo.value];
  formRF.taxa.placeholder = { cdi: '110', pre: '13,5', ipca: '6,2' }[formRF.tipo.value];
});
formRF.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formRF;
  const taxa = num(f.taxa.value), valor = num(f.valor.value);
  if (!isFinite(taxa) || !isFinite(valor) || valor <= 0) { status('Taxa e valor precisam ser números.', true); return; }
  db.rendaFixa.push({ id: uid(), nome: f.nome.value.trim(), tipo: f.tipo.value, taxa, data: f.data.value, valor, venc: f.venc.value || '' });
  salvar();
  f.nome.value = ''; f.taxa.value = ''; f.valor.value = ''; f.venc.value = '';
  status('Título de renda fixa salvo.');
  render();
  if (db.config.sheetId) { await atualizarIndices(); salvar(); render(); }
});

document.addEventListener('click', (e) => {
  const l = e.target.dataset.delLanc, r = e.target.dataset.delRf;
  if (l && confirm('Excluir este lançamento?')) { db.lancamentos = db.lancamentos.filter((x) => x.id !== l); salvar(); render(); }
  if (r && confirm('Excluir este título?')) { db.rendaFixa = db.rendaFixa.filter((x) => x.id !== r); salvar(); render(); }
});

document.addEventListener('change', (e) => {
  const t = e.target.dataset.classe;
  if (t) { db.classes[t] = e.target.value; salvar(); render(); }
});

$('#form-config').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = extraiSheetId(e.target.sheet.value);
  if (!id) { status('Link ou ID da planilha inválido.', true); return; }
  db.config.sheetId = id;
  salvar();
  atualizar();
});

$('#btn-exportar').addEventListener('click', () => {
  const { cache, ...dados } = db;
  const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `carteira-backup-${hoje()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('#inp-importar').addEventListener('change', async (e) => {
  const arq = e.target.files[0];
  if (!arq) return;
  try {
    const dados = JSON.parse(await arq.text());
    if (!Array.isArray(dados.lancamentos) || !Array.isArray(dados.rendaFixa)) throw new Error('formato');
    if (!confirm('Substituir os dados deste aparelho pelo backup?')) return;
    db = Object.assign(vazio(), dados, { cache: db.cache });
    salvar(); render(); status('Backup importado.');
  } catch (err) {
    status('Arquivo de backup inválido.', true);
  } finally {
    e.target.value = '';
  }
});

$('#btn-apagar').addEventListener('click', () => {
  if (!confirm('Apagar todos os lançamentos deste aparelho? Exporte um backup antes.')) return;
  if (!confirm('Tem certeza? Não dá para desfazer.')) return;
  const sheetId = db.config.sheetId;
  db = vazio(); db.config.sheetId = sheetId;
  salvar(); render(); status('Dados apagados.');
});

/* ---------- Início ---------- */

render();
if (db.config.sheetId) atualizar();
else irPara('ajustes'), status('Primeiro passo: informe a planilha de cotações.');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
