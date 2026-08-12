/* ============================================================
   Tabela de Isótopos — lógica da aplicação
   Duas vertentes por variante de LoRA:
   - PESSOAL: pra cada pergunta, você vê as respostas de TODAS as
     variantes lado a lado, em ordem embaralhada, e ordena por
     preferência (empates permitidos). 1º lugar = N pontos
     (N = nº de variantes comparadas naquela pergunta), último = 0.
   - OBJETIVA FACTUAL: você manda pra um LLM corrigir e registra
     aqui só a quantidade de acertos. (inalterado)

   Observação sobre o "blind": como isto é uma página estática
   (sem backend), o id da variante fica em atributos internos do
   DOM/JS, não em nenhum texto visível — o suficiente pra você
   avaliar sem viés no uso normal, mas não é criptograficamente
   oculto de quem abrir o devtools de propósito.
   ============================================================ */

// ---- 1. Variantes esperadas (pastas), com seus parâmetros r / alpha ----
// Cada pasta deve conter: historico_interacoes_pessoal.txt e
// historico_interacoes_objetiva.txt, direto na raiz ao lado deste arquivo.
const EXPERIMENTS = [
  { id: "r16_a16",        r: 16, a: 16,  aug: null },
  { id: "r16_a32",        r: 16, a: 32,  aug: null },
  { id: "r32_a32",        r: 32, a: 32,  aug: null },
  { id: "r32_a32_aug5",   r: 32, a: 32,  aug: 5 },
  { id: "r32_a32_aug10",  r: 32, a: 32,  aug: 10 },
  { id: "r32_a64",        r: 32, a: 64,  aug: null },
  { id: "r64_a32",        r: 64, a: 32,  aug: null },
  { id: "r64_a64",        r: 64, a: 64,  aug: null },
  { id: "r64_a64_aug5",   r: 64, a: 64,  aug: 5 },
  { id: "r64_a64_aug10",  r: 64, a: 64,  aug: 10 },
  { id: "r64_a128",       r: 64, a: 128, aug: null },
];

const RANKS_KEY = "pir_lora_ranks_v1";
const SCORES_KEY = "pir_lora_scores_v1";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const CORRECTOR_PROMPT =
  "Abaixo estão pares de pergunta e resposta gerados por um chatbot. Avalie cada " +
  "resposta quanto à correção factual (correta ou incorreta) e, ao final, informe " +
  "o número total de respostas corretas.\n\n";

// ---- 2. Estado ----
let PESSOAL_ITEMS = [];   // todas as perguntas/respostas pessoais, de todas as variantes
let OBJETIVA_ITEMS = [];  // idem, objetivas
let QUESTIONS = [];        // uma entrada por id de pergunta, com .answers (todas as variantes)
let RANKS = loadJson(RANKS_KEY, {});   // { questionId: { positions: {expId: posicao}, ts } }
let SCORES = loadJson(SCORES_KEY, {}); // { experimento: { acertos, total, ts } }
let queue = [];
let cursor = 0;
let currentObjExp = null;

// ---- 3. Elementos ----
const el = {
  tabPessoal: document.getElementById("tab-pessoal"),
  tabObjetiva: document.getElementById("tab-objetiva"),
  panelPessoal: document.getElementById("panel-pessoal"),
  panelObjetiva: document.getElementById("panel-objetiva"),

  card: document.getElementById("vote-card"),
  chipExp: document.getElementById("chip-experiment"),
  chipPos: document.getElementById("chip-position"),
  question: document.getElementById("question-text"),
  answerGrid: document.getElementById("answer-grid"),
  btnSaveRank: document.getElementById("btn-save-rank"),
  btnSkip: document.getElementById("btn-skip"),
  btnPrev: document.getElementById("btn-prev"),
  progressFill: document.getElementById("progress-fill"),
  empty: document.getElementById("empty-state"),
  emptyTitle: document.getElementById("empty-title"),
  emptySub: document.getElementById("empty-sub"),
  loading: document.getElementById("loading-state"),
  filterUnvoted: document.getElementById("filter-unvoted"),

  statTotal: document.getElementById("stat-total"),
  statPending: document.getElementById("stat-pending"),
  statScored: document.getElementById("stat-scored"),

  tiles: document.getElementById("tiles"),
  toast: document.getElementById("toast"),

  btnExportJson: document.getElementById("btn-export-json"),
  btnExportCsv: document.getElementById("btn-export-csv"),
  btnImport: document.getElementById("btn-import"),
  inputImport: document.getElementById("input-import"),
  btnReset: document.getElementById("btn-reset"),

  objExperiment: document.getElementById("obj-experiment"),
  objList: document.getElementById("obj-list"),
  btnObjCopy: document.getElementById("btn-obj-copy"),
  btnObjDownload: document.getElementById("btn-obj-download"),
  scoreExpName: document.getElementById("score-exp-name"),
  scoreTotal: document.getElementById("score-total"),
  scoreTotal2: document.getElementById("score-total-2"),
  scoreInput: document.getElementById("score-input"),
  btnScoreSave: document.getElementById("btn-score-save"),
  scoreCurrent: document.getElementById("score-current"),
};

// ---- 4. Parser do historico_interacoes_*.txt ----
function parseHistorico(text, experimentId) {
  const blocks = text
    .split(/\r?\n-{3,}\r?\n?/)
    .map((b) => b.trim())
    .filter(Boolean);

  const items = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const header = lines[0].match(/^\[(\d+)\]/);
    if (!header) continue;

    const id = header[1];
    const pIndex = lines.findIndex((l) => l.startsWith("Pergunta:"));
    const rIndex = lines.findIndex((l) => l.startsWith("Resposta:"));
    if (pIndex === -1 || rIndex === -1) continue;

    const pergunta = lines
      .slice(pIndex, rIndex)
      .join("\n")
      .replace(/^Pergunta:\s*/, "")
      .trim();

    const resposta = lines
      .slice(rIndex)
      .join("\n")
      .replace(/^Resposta:\s*/, "")
      .trim();

    items.push({
      key: `${experimentId}#${id}`,
      experimento: experimentId,
      id,
      pergunta,
      resposta,
    });
  }
  return items;
}

// ---- 5. Carregamento ----
async function fetchAndParse(expId, suffix) {
  try {
    const res = await fetch(`${expId}/historico_interacoes_${suffix}.txt`);
    if (!res.ok) return [];
    const text = await res.text();
    return parseHistorico(text, expId);
  } catch {
    return [];
  }
}

async function loadAll() {
  const [pessoalResults, objetivaResults] = await Promise.all([
    Promise.all(EXPERIMENTS.map((exp) => fetchAndParse(exp.id, "pessoal"))),
    Promise.all(EXPERIMENTS.map((exp) => fetchAndParse(exp.id, "objetiva"))),
  ]);

  PESSOAL_ITEMS = pessoalResults.flat();
  OBJETIVA_ITEMS = objetivaResults.flat();

  const loadedExperiments = EXPERIMENTS.filter(
    (exp) =>
      PESSOAL_ITEMS.some((it) => it.experimento === exp.id) ||
      OBJETIVA_ITEMS.some((it) => it.experimento === exp.id)
  );

  for (const exp of loadedExperiments) {
    const opt2 = document.createElement("option");
    opt2.value = exp.id;
    opt2.textContent = exp.id;
    el.objExperiment.appendChild(opt2);
  }

  el.loading.hidden = true;

  if (loadedExperiments.length === 0) {
    el.empty.hidden = false;
    el.emptyTitle.textContent = "Nenhum histórico encontrado.";
    el.emptySub.textContent =
      "Confira se as pastas de cada variante (com historico_interacoes_pessoal.txt e historico_interacoes_objetiva.txt) estão na raiz, ao lado deste arquivo, e se você está acessando via servidor local (não abrindo o .html direto).";
    renderLeaderboard();
    return;
  }

  buildQuestions();
  rebuildQueue();
  renderCard();

  currentObjExp = loadedExperiments[0].id;
  el.objExperiment.value = currentObjExp;
  renderObjList();

  renderLeaderboard();
}

// ==================== ABA PESSOAL — agrupamento por pergunta ====================

// PRNG determinístico (seed = string) só pra embaralhar a ordem de exibição
// das respostas de cada pergunta, sem depender de Math.random.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seedStr) {
  const rand = mulberry32(hashStr(seedStr));
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQuestions() {
  const map = new Map();
  for (const it of PESSOAL_ITEMS) {
    if (!map.has(it.id)) map.set(it.id, { id: it.id, pergunta: it.pergunta, answers: [] });
    map.get(it.id).answers.push(it);
  }
  QUESTIONS = Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));

  for (const q of QUESTIONS) {
    q.shuffled = seededShuffle(q.answers, `q${q.id}-blind-v1`);
    q.shuffled.forEach((ans, idx) => {
      ans.label = LETTERS[idx] || `#${idx + 1}`;
    });
  }
}

function rebuildQueue() {
  const onlyPending = el.filterUnvoted.checked;
  queue = QUESTIONS.filter((q) => !onlyPending || !RANKS[q.id]);
  cursor = 0;
  updateStats();
}

function updateStats() {
  const total = Object.keys(RANKS).length;
  const pending = QUESTIONS.length - total;
  el.statTotal.textContent = total;
  el.statPending.textContent = Math.max(pending, 0);

  const loadedIds = new Set(
    EXPERIMENTS.filter(
      (exp) =>
        PESSOAL_ITEMS.some((it) => it.experimento === exp.id) ||
        OBJETIVA_ITEMS.some((it) => it.experimento === exp.id)
    ).map((e) => e.id)
  );
  const scoredCount = Object.keys(SCORES).filter((k) => loadedIds.has(k)).length;
  el.statScored.textContent = `${scoredCount}/${loadedIds.size}`;
}

function renderCard() {
  updateStats();

  if (queue.length === 0) {
    el.card.hidden = true;
    el.empty.hidden = false;
    el.emptyTitle.textContent = "Tudo rankeado por aqui.";
    el.emptySub.textContent = 'Desmarque "só não rankeadas" para revisar de novo.';
    el.progressFill.style.width = "0%";
    return;
  }

  if (cursor >= queue.length) cursor = queue.length - 1;
  if (cursor < 0) cursor = 0;

  el.empty.hidden = true;
  el.card.hidden = false;

  const q = queue[cursor];
  const alreadyRanked = !!RANKS[q.id];

  el.chipExp.textContent = alreadyRanked ? "✓ já rankeada" : `pergunta #${q.id}`;
  el.chipPos.textContent = `${cursor + 1} de ${queue.length}`;
  el.question.textContent = q.pergunta;

  const savedPositions = RANKS[q.id]?.positions || {};

  el.answerGrid.innerHTML = "";
  for (const ans of q.shuffled) {
    const n = q.shuffled.length;
    const card = document.createElement("div");
    card.className = "answer-card";
    card.dataset.exp = ans.experimento;

    const savedVal = savedPositions[ans.experimento];
    let options = `<option value="" ${savedVal ? "" : "selected"} disabled>posição</option>`;
    for (let p = 1; p <= n; p++) {
      options += `<option value="${p}" ${Number(savedVal) === p ? "selected" : ""}>${p}º</option>`;
    }

    card.innerHTML = `
      <div class="answer-card-head">
        <span class="answer-label">Resposta ${ans.label}</span>
        <select class="answer-rank-select" data-exp="${ans.experimento}">${options}</select>
      </div>
      <pre class="answer-card-text"></pre>
    `;
    card.querySelector(".answer-card-text").textContent = ans.resposta;
    el.answerGrid.appendChild(card);
  }

  el.progressFill.style.width = `${((cursor + 1) / queue.length) * 100}%`;
  el.btnPrev.style.visibility = cursor === 0 ? "hidden" : "visible";
}

function advance() {
  if (el.filterUnvoted.checked) {
    queue = QUESTIONS.filter((q) => !RANKS[q.id]);
    if (cursor >= queue.length) cursor = Math.max(queue.length - 1, 0);
  } else {
    cursor = Math.min(cursor + 1, queue.length - 1);
  }
  renderCard();
  renderLeaderboard();
}

function saveRanking() {
  if (queue.length === 0) return;
  const q = queue[cursor];
  const selects = el.answerGrid.querySelectorAll(".answer-rank-select");

  const positions = {};
  for (const sel of selects) {
    if (sel.value === "") {
      showToast("Dê uma posição pra cada resposta antes de salvar (pode repetir em caso de empate).");
      sel.focus();
      return;
    }
    positions[sel.dataset.exp] = Number(sel.value);
  }

  RANKS[q.id] = { positions, ts: new Date().toISOString() };
  saveJson(RANKS_KEY, RANKS);
  showToast(`Ranking salvo para a pergunta #${q.id}.`);
  advance();
}

// ==================== Pontuação do ranking (com empates) ====================

// Recebe { expId: posicaoEscolhida } e devolve { points: {expId: pontos}, maxPoints }.
// 1º lugar = maxPoints (nº de variantes comparadas nessa pergunta), último = 0.
// Posições iguais (empate) ficam na mesma faixa e recebem os mesmos pontos.
function computeTierPoints(positions) {
  const entries = Object.entries(positions);
  entries.sort((a, b) => a[1] - b[1]);
  const n = entries.length;
  const maxPoints = n;

  const tiers = [];
  let current = [entries[0]];
  for (let i = 1; i < entries.length; i++) {
    if (entries[i][1] === entries[i - 1][1]) {
      current.push(entries[i]);
    } else {
      tiers.push(current);
      current = [entries[i]];
    }
  }
  tiers.push(current);

  const k = tiers.length;
  const points = {};
  tiers.forEach((tier, i) => {
    const pts = k === 1 ? maxPoints : Math.round(maxPoints - (i * maxPoints) / (k - 1));
    tier.forEach(([expId]) => {
      points[expId] = pts;
    });
  });

  return { points, maxPoints };
}

function aggregatePessoalScores() {
  const agg = {}; // expId -> { points, max, count }
  for (const qid in RANKS) {
    const rec = RANKS[qid];
    if (!rec || !rec.positions) continue;
    const { points, maxPoints } = computeTierPoints(rec.positions);
    for (const expId in points) {
      if (!agg[expId]) agg[expId] = { points: 0, max: 0, count: 0 };
      agg[expId].points += points[expId];
      agg[expId].max += maxPoints;
      agg[expId].count += 1;
    }
  }
  return agg;
}

// ==================== ABA OBJETIVA (inalterada) ====================

function renderObjList() {
  const items = OBJETIVA_ITEMS.filter((it) => it.experimento === currentObjExp);

  el.objList.innerHTML = "";
  if (items.length === 0) {
    el.objList.innerHTML = `<div class="obj-empty">Nenhuma pergunta objetiva encontrada para essa variante.</div>`;
  } else {
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "obj-item";
      row.innerHTML = `
        <span class="obj-id">#${it.id}</span>
        <p class="obj-q">${escapeHtml(it.pergunta)}</p>
        <p class="obj-a">${escapeHtml(it.resposta)}</p>
      `;
      el.objList.appendChild(row);
    }
  }

  el.scoreExpName.textContent = currentObjExp;
  el.scoreTotal.textContent = items.length;
  el.scoreTotal2.textContent = items.length;
  el.scoreInput.max = items.length;

  const saved = SCORES[currentObjExp];
  if (saved) {
    el.scoreInput.value = saved.acertos;
    el.scoreCurrent.textContent = `Registrado: ${saved.acertos} de ${saved.total} acertos (${new Date(saved.ts).toLocaleString("pt-BR")})`;
  } else {
    el.scoreInput.value = "";
    el.scoreCurrent.textContent = "Ainda sem nota registrada para essa variante.";
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function buildCorrectorText(expId) {
  const items = OBJETIVA_ITEMS.filter((it) => it.experimento === expId);
  const body = items
    .map((it, i) => `${i + 1}) Pergunta: ${it.pergunta}\nResposta: ${it.resposta}`)
    .join("\n\n");
  return CORRECTOR_PROMPT + body;
}

function saveScore() {
  const items = OBJETIVA_ITEMS.filter((it) => it.experimento === currentObjExp);
  const total = items.length;
  const raw = el.scoreInput.value;

  if (raw === "" || isNaN(raw)) {
    showToast("Digite um número de acertos válido.");
    return;
  }
  const acertos = Math.round(Number(raw));
  if (acertos < 0 || acertos > total) {
    showToast(`O valor precisa estar entre 0 e ${total}.`);
    return;
  }

  SCORES[currentObjExp] = { acertos, total, ts: new Date().toISOString() };
  saveJson(SCORES_KEY, SCORES);
  renderObjList();
  renderLeaderboard();
  updateStats();
  showToast(`Registrado: ${acertos}/${total} acertos para ${currentObjExp}.`);
}

// ==================== Placar / Tabela de Isótopos ====================

function renderLeaderboard() {
  const pessoalAgg = aggregatePessoalScores();

  const loadedIds = new Set([
    ...PESSOAL_ITEMS.map((it) => it.experimento),
    ...OBJETIVA_ITEMS.map((it) => it.experimento),
  ]);

  const rows = EXPERIMENTS.filter((e) => loadedIds.has(e.id))
    .map((e) => {
      const score = SCORES[e.id];
      const agg = pessoalAgg[e.id];
      const pctPessoal = agg && agg.max ? (agg.points / agg.max) * 100 : null;
      const pctObjetiva = score && score.total ? (score.acertos / score.total) * 100 : null;
      const parts = [pctPessoal, pctObjetiva].filter((v) => v !== null);
      const pctCombined = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
      return { ...e, pctPessoal, pctObjetiva, pctCombined, score, agg };
    })
    .sort((a, b) => {
      if (a.pctCombined === null && b.pctCombined === null) return 0;
      if (a.pctCombined === null) return 1;
      if (b.pctCombined === null) return -1;
      return b.pctCombined - a.pctCombined;
    });

  el.tiles.innerHTML = "";
  rows.forEach((row, index) => {
    const tile = document.createElement("div");
    tile.className = "tile";
    if (row.pctCombined !== null) tile.dataset.rank = index + 1;

    const cls = (pct) =>
      pct === null ? "empty" : pct >= 70 ? "good" : pct >= 40 ? "mid" : "bad";

    const augLabel = row.aug ? ` · aug${row.aug}` : "";
    const fmt = (pct) => (pct === null ? "—" : Math.round(pct) + "%");
    const pessoalDetail = row.agg
      ? `${row.agg.count} perguntas · ${row.agg.points}/${row.agg.max} pts`
      : "sem ranking pessoal";
    const objetivaDetail = row.score ? `${row.score.acertos}/${row.score.total} acertos` : "sem nota objetiva";

    tile.innerHTML = `
      ${row.pctCombined !== null ? `<span class="tile-rank">${index + 1}</span>` : ""}
      <div class="tile-top">
        <span>r${row.r}</span>
        <span>α${row.a}</span>
      </div>
      <div>
        <div class="tile-metrics">
          <div class="tile-metric">
            <span class="tile-metric-label">Pessoal</span>
            <div class="tile-pct ${cls(row.pctPessoal)}">${fmt(row.pctPessoal)}</div>
          </div>
          <div class="tile-metric">
            <span class="tile-metric-label">Objetiva</span>
            <div class="tile-pct ${cls(row.pctObjetiva)}">${fmt(row.pctObjetiva)}</div>
          </div>
        </div>
        <div class="tile-name">${row.id}${augLabel}</div>
        <div class="tile-votes">${pessoalDetail} · ${objetivaDetail}</div>
      </div>
      <div class="tile-bar"><div class="tile-bar-fill" style="width:${row.pctCombined ?? 0}%"></div></div>
    `;
    el.tiles.appendChild(tile);
  });
}

// ==================== Persistência local ====================

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ==================== Exportar / Importar / Resetar ====================

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
}

function exportBackupJson() {
  const payload = { exportedAt: new Date().toISOString(), ranks: RANKS, scores: SCORES };
  downloadFile(`backup-piR-lora-${stamp()}.json`, JSON.stringify(payload, null, 2), "application/json");
  showToast("Backup baixado. Importe esse arquivo em outro dispositivo pra continuar.");
}

function exportSummaryCsv() {
  const pessoalAgg = aggregatePessoalScores();

  const header =
    "variante,r,alpha,aug,pessoal_perguntas_rankeadas,pessoal_pontos,pessoal_pontos_max,pessoal_pct,objetiva_acertos,objetiva_total,objetiva_pct_acertos";
  const lines = EXPERIMENTS.map((e) => {
    const agg = pessoalAgg[e.id];
    const pctP = agg && agg.max ? ((agg.points / agg.max) * 100).toFixed(1) : "";
    const score = SCORES[e.id];
    const pctO = score && score.total ? ((score.acertos / score.total) * 100).toFixed(1) : "";
    return [
      e.id,
      e.r,
      e.a,
      e.aug ?? "",
      agg ? agg.count : 0,
      agg ? agg.points : "",
      agg ? agg.max : "",
      pctP,
      score ? score.acertos : "",
      score ? score.total : "",
      pctO,
    ].join(",");
  });

  const csv = [header, ...lines].join("\n");
  downloadFile(`resumo-piR-lora-${stamp()}.csv`, csv, "text/csv");
  showToast("Resumo consolidado baixado em .csv.");
}

function importBackupFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const incomingRanks = parsed.ranks || {};
      const incomingScores = parsed.scores || {};
      const count = Object.keys(incomingRanks).length + Object.keys(incomingScores).length;
      if (!count) throw new Error("vazio");

      const ok = confirm(
        `Importar ${Object.keys(incomingRanks).length} ranking(s) e ${Object.keys(incomingScores).length} nota(s) objetiva(s)? ` +
        `Em caso de conflito, o arquivo importado prevalece.`
      );
      if (!ok) return;

      RANKS = { ...RANKS, ...incomingRanks };
      SCORES = { ...SCORES, ...incomingScores };
      saveJson(RANKS_KEY, RANKS);
      saveJson(SCORES_KEY, SCORES);
      rebuildQueue();
      renderCard();
      renderObjList();
      renderLeaderboard();
      showToast("Backup importado com sucesso.");
    } catch {
      alert("Não foi possível ler esse arquivo. Verifique se é um .json exportado por esta página.");
    }
  };
  reader.readAsText(file);
}

function resetAll() {
  const ok = confirm(
    "Isso apaga todos os rankings pessoais e notas objetivas salvos neste navegador. Se quiser guardar antes, baixe o backup .json primeiro. Continuar?"
  );
  if (!ok) return;
  RANKS = {};
  SCORES = {};
  saveJson(RANKS_KEY, RANKS);
  saveJson(SCORES_KEY, SCORES);
  rebuildQueue();
  renderCard();
  renderObjList();
  renderLeaderboard();
  showToast("Rankings e notas apagados.");
}

// ==================== Toast ====================

let toastTimer;
function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 3200);
}

// ==================== Abas ====================

function switchTab(tab) {
  const isPessoal = tab === "pessoal";
  el.tabPessoal.classList.toggle("active", isPessoal);
  el.tabObjetiva.classList.toggle("active", !isPessoal);
  el.panelPessoal.hidden = !isPessoal;
  el.panelObjetiva.hidden = isPessoal;
}

// ==================== Eventos ====================

el.tabPessoal.addEventListener("click", () => switchTab("pessoal"));
el.tabObjetiva.addEventListener("click", () => switchTab("objetiva"));

el.btnSaveRank.addEventListener("click", saveRanking);
el.btnSkip.addEventListener("click", () => {
  cursor = Math.min(cursor + 1, queue.length - 1);
  renderCard();
});
el.btnPrev.addEventListener("click", () => {
  cursor = Math.max(cursor - 1, 0);
  renderCard();
});

el.filterUnvoted.addEventListener("change", () => {
  rebuildQueue();
  renderCard();
});

el.btnExportJson.addEventListener("click", exportBackupJson);
el.btnExportCsv.addEventListener("click", exportSummaryCsv);
el.btnImport.addEventListener("click", () => el.inputImport.click());
el.inputImport.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) importBackupFile(file);
  e.target.value = "";
});
el.btnReset.addEventListener("click", resetAll);

el.objExperiment.addEventListener("change", () => {
  currentObjExp = el.objExperiment.value;
  renderObjList();
});

el.btnObjCopy.addEventListener("click", async () => {
  const text = buildCorrectorText(currentObjExp);
  try {
    await navigator.clipboard.writeText(text);
    showToast("Perguntas e respostas copiadas — cole no seu LLM corretor.");
  } catch {
    showToast("Não deu pra copiar automaticamente. Use o botão de baixar .txt.");
  }
});

el.btnObjDownload.addEventListener("click", () => {
  const text = buildCorrectorText(currentObjExp);
  downloadFile(`objetivas-${currentObjExp}.txt`, text, "text/plain");
});

el.btnScoreSave.addEventListener("click", saveScore);
el.scoreInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveScore();
});

document.addEventListener("keydown", (e) => {
  if (el.panelPessoal.hidden || el.card.hidden) return;
  const tag = document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.key === "ArrowRight") { cursor = Math.min(cursor + 1, queue.length - 1); renderCard(); }
  if (e.key === "ArrowLeft") { cursor = Math.max(cursor - 1, 0); renderCard(); }
});

// ==================== Início ====================

loadAll();
