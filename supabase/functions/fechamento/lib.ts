// Lógica pura (sem Deno/Supabase), testável em Node.

export const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

export const FORMAS: Record<string, string> = {
  ja_pago: "Já estava pago",
  pix: "Pix",
  debito: "Débito",
  credito_vista: "Crédito à vista",
  credito_parcelado: "Crédito parcelado",
  dois_cartoes: "2 cartões",
  cartao_pix: "Cartão + Pix",
};

export const ORIGENS: Record<string, string> = {
  indicacao: "indicação",
  google: "google",
  instagram: "instagram",
  chatgpt: "chatgpt",
  site: "site",
  tiktok: "tiktok",
  nao_sei: "não sei",
};

export const NF_TIPOS: Record<string, string> = {
  nao: "",
  nao_pagou: "não pagou",
  com: "", // texto montado a partir das notas (textoNF)
  // legado (versões antigas do app)
  consulta: "pendente: consulta",
  imposto: "pendente: imposto",
  consulta_imposto: "pendente: consulta + imposto",
};

// Eventos da agenda do Amigo que não são paciente
const IGNORAR = [/^nf\b/i, /representante/i, /hands on/i, /fabi - atendimentos particulares/i, /laser fabi/i];

export interface Pagamento { metodo: string; valor: number; parcelas?: number }

export interface Fechamento {
  id: string;
  data_atendimento: string;      // "2026-11-19T18:30" horário de Brasília
  paciente_nome: string;
  amigo_patient_id?: number | null;
  amigo_attendance_id?: number | null;
  valor_pago: number;
  forma_pagamento: string;
  pagamentos: Pagamento[];
  parcelas?: number | null;
  agendou_proxima: boolean;
  proxima_consulta?: string | null; // "2026-12-03" ou "2026-12-03T15:00"
  procedimentos: string[];        // nomes do app
  obs_procedimento?: string | null;
  paciente_antiga: boolean;
  como_conheceu?: string | null;  // chave de ORIGENS
  nf_tipo?: string | null;        // chave de NF_TIPOS
  nf_plano?: PlanoNF | null;      // quando nf_tipo = "com"
}

// ---------- Notas fiscais ----------
// Consulta = nota de consulta (a única que pode ser fracionada, mês a mês).
// Imposto = nota de procedimento estético (sempre uma só).
export interface PlanoNF {
  consultas_qtd: number;          // 0 = nenhuma
  consulta_valor: number;         // valor de cada nota de consulta
  consulta_primeira?: string;     // AAAA-MM-DD (padrão: dia do atendimento)
  consulta_dias?: number;         // intervalo entre notas (padrão 30)
  consulta_ultima_valor?: number | null; // se a última for diferente (ex.: 9×700 + 600)
  imposto_valor: number;          // 0 = sem nota de imposto
  imposto_data?: string;          // padrão: dia do atendimento
}
export interface NotaPlanejada {
  tipo: "consulta" | "imposto"; valor: number; data: string; parcela: string | null; obs: string;
}

const DIAS_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const isoUTC = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const paraIso = (dt: Date) => dt.toISOString().slice(0, 10);
export function somaDias(iso: string, n: number): string { const d = isoUTC(iso); d.setUTCDate(d.getUTCDate() + n); return paraIso(d); }
/** Sábado e domingo passam para segunda. */
export function diaUtil(iso: string): { data: string; movida: boolean; dow: number } {
  const dow = isoUTC(iso).getUTCDay();
  if (dow === 6) return { data: somaDias(iso, 2), movida: true, dow };
  if (dow === 0) return { data: somaDias(iso, 1), movida: true, dow };
  return { data: iso.slice(0, 10), movida: false, dow };
}
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function gerarNotas(p: PlanoNF, dataAtendimento: string): NotaPlanejada[] {
  const dia = dataAtendimento.slice(0, 10);
  const notas: NotaPlanejada[] = [];
  const n = Math.max(0, Math.floor(p.consultas_qtd || 0));
  const primeira = (p.consulta_primeira || dia).slice(0, 10);
  const passo = p.consulta_dias && p.consulta_dias > 0 ? Math.floor(p.consulta_dias) : 30;
  for (let k = 0; k < n; k++) {
    const original = somaDias(primeira, k * passo);
    const u = diaUtil(original);
    const valor = k === n - 1 && n > 1 && p.consulta_ultima_valor != null ? p.consulta_ultima_valor : p.consulta_valor;
    let obs = n > 1 ? `Pacote de ${dataBR(dia)}, a cada ${passo} dias` : "consulta";
    if (u.movida) obs = `${passo} dias caiu em ${ddmm(original)} (${DIAS_SEMANA[u.dow]}), passou para ${ddmm(u.data)}`;
    notas.push({ tipo: "consulta", valor: r2(valor), data: u.data, parcela: n > 1 ? `${k + 1}/${n}` : null, obs });
  }
  if (p.imposto_valor > 0) {
    const u = diaUtil((p.imposto_data || dia).slice(0, 10));
    notas.push({ tipo: "imposto", valor: r2(p.imposto_valor), data: u.data, parcela: null, obs: "imposto (procedimento)" });
  }
  return notas;
}

export const somaNotas = (notas: NotaPlanejada[]) => r2(notas.reduce((s, x) => s + x.valor, 0));

/** Texto da coluna "notas fiscais" do Controle (é a fila que o fechamento do dia lê). */
export function textoNF(f: Fechamento, notas: NotaPlanejada[] | null): string {
  if (f.nf_tipo !== "com") return NF_TIPOS[f.nf_tipo ?? ""] ?? "";
  if (!notas?.length) return "";
  const dia = f.data_atendimento.slice(0, 10);
  const partes: string[] = [];
  const cons = notas.filter((x) => x.tipo === "consulta");
  const p = f.nf_plano!;
  if (cons.length === 1) partes.push(`consulta ${brl(cons[0].valor)}${cons[0].data !== dia ? ` em ${ddmm(cons[0].data)}` : ""}`);
  if (cons.length > 1) {
    const passo = p.consulta_dias && p.consulta_dias > 0 ? p.consulta_dias : 30;
    let t = `${cons.length} consultas de ${brl(p.consulta_valor)} a cada ${passo} dias`;
    const ult = cons[cons.length - 1].valor;
    if (ult !== r2(p.consulta_valor)) t += ` (última ${brl(ult)})`;
    t += cons[0].data !== dia ? `, a 1ª em ${ddmm(cons[0].data)}` : "";
    partes.push(t);
  }
  const imp = notas.find((x) => x.tipo === "imposto");
  if (imp) partes.push(`imposto ${brl(imp.valor)}${imp.data !== dia ? ` em ${ddmm(imp.data)}` : ""}`);
  let txt = `pendente: ${partes.join(" + ")}`;
  const soma = somaNotas(notas);
  if (Math.abs(soma - f.valor_pago) > 0.009) txt += ` · soma das notas ${brl(soma)} diferente do valor pago ${brl(f.valor_pago)}`;
  return txt;
}

/** Abas "Notas fiscais AAAA": um bloco por mês (Nome, Emitir NFS em, ..., Obs). Os blocos não têm largura fixa. */
export interface BlocoNF { mes: number; nome: number; emitir?: number; total?: number; parcela?: number; valor?: number; obs?: number; fim: number }
export function blocosNotas(linha1: unknown[], linha2: unknown[]): BlocoNF[] {
  const h = linha2.map(norm);
  const inicios = h.map((s, i) => (s === "nome" ? i : -1)).filter((i) => i >= 0);
  const meses = MESES.map(norm);
  const blocos: BlocoNF[] = [];
  inicios.forEach((ini, bi) => {
    const fim = bi + 1 < inicios.length ? inicios[bi + 1] : h.length;
    let mes = -1;
    for (let c = ini; c < fim; c++) { const m = meses.indexOf(norm(linha1[c])); if (m >= 0) { mes = m; break; } }
    if (mes < 0 && bi === 0) mes = 0; // janeiro às vezes fica sem rótulo
    if (mes < 0) return;
    const achar = (p: (s: string) => boolean) => { for (let c = ini; c < fim; c++) if (p(h[c])) return c; return undefined; };
    blocos.push({
      mes, nome: ini, fim,
      emitir: achar((s) => s.startsWith("emitir")),
      total: achar((s) => s === "valor total"),
      parcela: achar((s) => s === "parcela"),
      valor: achar((s) => s.startsWith("valor da nota")),
      obs: achar((s) => s === "obs"),
    });
  });
  return blocos;
}

/** Linhas (a partir da 3) a escrever nas abas de notas. dados = valores da linha 3 em diante. */
export function celulasNotas(
  notas: NotaPlanejada[], nome: string, valorTotal: number, blocos: BlocoNF[], dados: unknown[][],
): { linha: number; col: number; valor: string | number }[] {
  const ocupadas = new Map<number, number>(); // bloco.nome -> próxima linha livre
  const out: { linha: number; col: number; valor: string | number }[] = [];
  for (const n of notas) {
    const mes = Number(n.data.slice(5, 7)) - 1;
    const b = blocos.find((x) => x.mes === mes);
    if (!b) throw new Error(`Bloco de ${MESES[mes]} não encontrado`);
    let linha = ocupadas.get(b.nome) ?? primeiraLinhaLivre(dados, b.nome, 3);
    ocupadas.set(b.nome, linha + 1);
    out.push({ linha, col: b.nome, valor: titleCaseNome(nome) });
    // Textos no formato da planilha (pt-BR): o Sheets converte em data e moeda mesmo em linha sem formatação
    if (b.emitir !== undefined) out.push({ linha, col: b.emitir, valor: dataBR(n.data, false) });
    if (b.total !== undefined) out.push({ linha, col: b.total, valor: brl(valorTotal) });
    if (b.parcela !== undefined && n.parcela) out.push({ linha, col: b.parcela, valor: `'${n.parcela}` });
    if (b.valor !== undefined) out.push({ linha, col: b.valor, valor: brl(n.valor) });
    if (b.obs !== undefined) out.push({ linha, col: b.obs, valor: n.obs });
  }
  return out;
}

export const norm = (s: unknown) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export function titleCaseNome(nome: string): string {
  const minusc = new Set(["de", "da", "do", "das", "dos", "e", "la", "del"]);
  return nome.trim().replace(/\s+/g, " ").split(" ").map((p, i) => {
    const l = p.toLowerCase();
    if (i > 0 && minusc.has(l)) return l;
    return l.charAt(0).toUpperCase() + l.slice(1);
  }).join(" ");
}

export function abaDoMes(dataIso: string): string {
  const [y, m] = dataIso.slice(0, 10).split("-").map(Number);
  return `${MESES[m - 1]}${String(y).slice(2)}`;
}

// Número serial de data do Google Sheets (1899-12-30 = 0)
export function serialData(dataIso: string): number {
  const [y, m, d] = dataIso.slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

export const brl = (v: number) =>
  "R$ " + v.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");

export function dataBR(iso: string, comHora = true): string {
  const [d, t] = iso.split("T");
  const [y, m, dd] = d.split("-");
  const base = `${dd}/${m}/${y}`;
  return comHora && t ? `${base} ${t.slice(0, 5)}` : base;
}

export function textoPagamento(f: Fechamento): string {
  const forma = FORMAS[f.forma_pagamento] ?? f.forma_pagamento;
  if (f.forma_pagamento === "credito_parcelado") return `${forma} ${f.parcelas ?? "?"}x`;
  if (f.forma_pagamento === "dois_cartoes" || f.forma_pagamento === "cartao_pix") {
    const partes = f.pagamentos.map((p) => {
      const nome = p.metodo === "pix" ? "Pix" : "Cartão";
      const parc = p.metodo !== "pix" && p.parcelas && p.parcelas > 1 ? ` ${p.parcelas}x` : p.metodo !== "pix" ? " à vista" : "";
      return `${nome} ${brl(p.valor)}${parc}`;
    });
    return `${forma}: ${partes.join(" + ")}`;
  }
  return forma;
}

export function validar(f: Fechamento): string[] {
  const erros: string[] = [];
  if (!f.id) erros.push("id ausente");
  if (!f.paciente_nome?.trim()) erros.push("Nome do paciente");
  if (!f.data_atendimento) erros.push("Data do atendimento");
  if (!(f.forma_pagamento in FORMAS)) erros.push("Método de pagamento");
  if (!(f.valor_pago >= 0)) erros.push("Valor pago");
  if (!f.procedimentos?.length) erros.push("Procedimento realizado");
  if (f.forma_pagamento === "credito_parcelado" && !(f.parcelas && f.parcelas >= 2)) erros.push("Número de parcelas");
  if (f.forma_pagamento === "dois_cartoes" || f.forma_pagamento === "cartao_pix") {
    const soma = f.pagamentos.reduce((s, p) => s + (p.valor || 0), 0);
    if (Math.abs(soma - f.valor_pago) > 0.01) erros.push(`Soma dos pagamentos (${brl(soma)}) diferente do valor pago (${brl(f.valor_pago)})`);
  }
  if (f.agendou_proxima && !f.proxima_consulta) erros.push("Data da próxima consulta");
  if (!(f.nf_tipo && f.nf_tipo in NF_TIPOS)) erros.push("Nota fiscal");
  if (f.nf_tipo === "com") {
    const p = f.nf_plano;
    if (!p) erros.push("Notas fiscais (plano)");
    else {
      if (!(p.consultas_qtd >= 0 && p.consultas_qtd <= 60)) erros.push("Quantidade de notas de consulta");
      if (p.consultas_qtd > 0 && !(p.consulta_valor > 0)) erros.push("Valor da nota de consulta");
      if (!(p.imposto_valor >= 0)) erros.push("Valor da nota de imposto");
      if (!(p.consultas_qtd > 0) && !(p.imposto_valor > 0)) erros.push("Pelo menos uma nota");
    }
  }
  if (!f.paciente_antiga && !(f.como_conheceu && f.como_conheceu in ORIGENS)) erros.push("Como conheceu");
  return erros;
}

export function resumoProntuario(f: Fechamento): string {
  const linhas = [
    `Atendimento em ${dataBR(f.data_atendimento)}.`,
    `Procedimentos realizados: ${f.procedimentos.join(", ")}.`,
  ];
  if (f.obs_procedimento?.trim()) linhas.push(`Detalhes: ${f.obs_procedimento.trim()}.`);
  linhas.push(`Pagamento: ${brl(f.valor_pago)} (${textoPagamento(f)}).`);
  linhas.push(f.agendou_proxima && f.proxima_consulta
    ? `Próxima consulta agendada para ${dataBR(f.proxima_consulta)}.`
    : "Não agendou próxima consulta.");
  return linhas.join("\n");
}

export function filtrarAgenda(itens: any[]) {
  return itens
    .filter((a) => !a.canceled)
    .filter((a) => {
      const nome = `${a.agenda_event?.name ?? ""} ${a.patient?.name ?? ""}`;
      return !IGNORAR.some((r) => r.test(a.agenda_event?.name ?? "") || r.test(a.patient?.name ?? "")) && nome.trim();
    })
    .map((a) => ({
      attendance_id: a.id,
      patient_id: a.patient_id,
      nome: titleCaseNome(a.patient?.name ?? ""),
      hora: String(a.start_date).slice(11, 16), // já vem em Brasília
      inicio: String(a.start_date).slice(0, 16),
      evento: a.agenda_event?.name ?? "",
      telefone: a.patient?.contact_cellphone ?? null,
    }))
    .sort((x, y) => x.inicio.localeCompare(y.inicio));
}

// ---------- Planilha ----------

export interface Colunas {
  data: number; nome: number; valor: number; procs: number[]; origem: number; obs: number;
  forma?: number; parcelas?: number; proxima?: number; recibo?: number; nf?: number;
}

export function mapearColunas(cabecalho: string[]): Colunas {
  const h = cabecalho.map(norm);
  const idx = (pred: (s: string) => boolean) => h.findIndex(pred);
  const procs = h.map((s, i) => (s === "procedimento" ? i : -1)).filter((i) => i >= 0);
  const c: Colunas = {
    data: idx((s) => s === "data"),
    nome: idx((s) => s.startsWith("cliente")),
    valor: idx((s) => s === "valor"),
    procs,
    origem: idx((s) => s.startsWith("como conheceu")),
    obs: idx((s) => s === "obs"),
  };
  const opt = (k: keyof Colunas, p: (s: string) => boolean) => { const i = idx(p); if (i >= 0) (c as any)[k] = i; };
  opt("forma", (s) => s.startsWith("forma de pagamento"));
  opt("parcelas", (s) => s === "parcelas");
  opt("proxima", (s) => s.startsWith("proxima consulta"));
  opt("recibo", (s) => s.startsWith("recibo"));
  opt("nf", (s) => s.startsWith("notas fiscais") || s === "nota fiscal" || s === "nf");
  const faltando = (["data", "nome", "valor", "origem", "obs"] as const).filter((k) => (c as any)[k] < 0);
  if (!procs.length) faltando.push("procedimento" as any);
  if (faltando.length) throw new Error(`Colunas não encontradas no cabeçalho: ${faltando.join(", ")}`);
  return c;
}

// linhas = valores a partir da linha 3 da planilha (índice 0 = linha 3)
export function primeiraLinhaLivre(linhas: unknown[][], colNome: number, linhaInicial = 3): number {
  for (let i = 0; i < linhas.length; i++) {
    if (!String(linhas[i]?.[colNome] ?? "").trim()) return linhaInicial + i;
  }
  return linhaInicial + linhas.length;
}

export function jaLancado(linhas: unknown[][], c: Colunas, nome: string, serial: number, dataFormatadaBR: string): boolean {
  const n = norm(nome);
  return linhas.some((l) => {
    if (norm(l?.[c.nome]) !== n) return false;
    const d = l?.[c.data];
    if (typeof d === "number") return d === serial;
    // Valor formatado "qui., 19/11/26"
    return String(d ?? "").includes(dataFormatadaBR);
  });
}

export function colLetra(i: number): string {
  let s = ""; i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/** Monta as células a escrever. Retorna [{col, valor, formula?}] */
export function celulasLinha(
  f: Fechamento, c: Colunas, rotulos: Record<string, string>, linkRecibo: string | null,
): { col: number; valor: string | number; formula?: boolean }[] {
  const cel: { col: number; valor: string | number; formula?: boolean }[] = [];
  cel.push({ col: c.data, valor: serialData(f.data_atendimento) });
  cel.push({ col: c.nome, valor: titleCaseNome(f.paciente_nome) });
  cel.push({ col: c.valor, valor: Math.round(f.valor_pago * 100) / 100 });

  const procs = f.procedimentos.map((p) => rotulos[p] ?? p.toLowerCase());
  const extras = procs.slice(c.procs.length);
  procs.slice(0, c.procs.length).forEach((p, i) => cel.push({ col: c.procs[i], valor: p }));

  cel.push({ col: c.origem, valor: f.paciente_antiga ? "paciente antiga" : (ORIGENS[f.como_conheceu ?? ""] ?? "não sei") });

  const obs: string[] = [];
  if (f.obs_procedimento?.trim()) obs.push(f.obs_procedimento.trim());
  if (extras.length) obs.push(`+ ${extras.join(", ")}`);
  if (f.forma_pagamento === "ja_pago") obs.push("já estava pago");
  const pag = textoPagamento(f);
  if (c.forma === undefined) obs.push(`Pagamento: ${pag}`);
  if (c.proxima === undefined && f.agendou_proxima && f.proxima_consulta) obs.push(`Próxima: ${dataBR(f.proxima_consulta)}`);
  const nf = textoNF(f, f.nf_tipo === "com" && f.nf_plano ? gerarNotas(f.nf_plano, f.data_atendimento) : null);
  if (nf) {
    if (c.nf !== undefined) cel.push({ col: c.nf, valor: nf });
    else obs.push(`NF ${nf}`);
  }
  if (obs.length) cel.push({ col: c.obs, valor: obs.join(" · ") });

  if (c.forma !== undefined) cel.push({ col: c.forma, valor: pag });
  if (c.parcelas !== undefined) {
    const p = f.forma_pagamento === "credito_parcelado" ? (f.parcelas ?? "") :
      f.forma_pagamento === "dois_cartoes" || f.forma_pagamento === "cartao_pix"
        ? f.pagamentos.filter((x) => x.metodo !== "pix").map((x) => `${x.parcelas ?? 1}x`).join(" + ")
        : f.forma_pagamento === "credito_vista" ? 1 : "";
    if (p !== "") cel.push({ col: c.parcelas, valor: p as any });
  }
  if (c.proxima !== undefined) cel.push({ col: c.proxima, valor: f.agendou_proxima && f.proxima_consulta ? dataBR(f.proxima_consulta) : "não agendou" });
  if (c.recibo !== undefined && linkRecibo) cel.push({ col: c.recibo, valor: `=HYPERLINK("${linkRecibo}";"ver recibo")`, formula: true });
  return cel;
}

export function nomeArquivoRecibo(f: Fechamento, ext: string): string {
  const slug = norm(f.paciente_nome).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const d = f.data_atendimento.slice(0, 10);
  const [y, m] = d.split("-");
  return `${y}/${m}/${d}_${slug}_${f.valor_pago.toFixed(2).replace(".", ",")}_${f.id.slice(0, 8)}.${ext}`;
}
