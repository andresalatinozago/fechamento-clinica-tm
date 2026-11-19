// Edge Function "fechamento" · Clínica TM
// Rotas (todas com ?acao=):
//   GET  agenda&data=AAAA-MM-DD   pacientes do dia no Amigo + quem já foi fechado
//   GET  listas                   procedimentos e origens
//   POST procedimento  {nome}     adiciona procedimento novo
//   POST salvar (multipart)       campo "dados" (JSON) + arquivo "recibo"
//   GET  recibo&t=<token>         abre o recibo (link usado na planilha)
// Autenticação: header x-app-pin (exceto recibo, que usa token próprio por registro).

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  abaDoMes, celulasLinha, colLetra, dataBR, Fechamento, filtrarAgenda, jaLancado, mapearColunas,
  nomeArquivoRecibo, ORIGENS, primeiraLinhaLivre, resumoProntuario, serialData, titleCaseNome, validar,
} from "./lib.ts";

const PLANILHA_ID = "18ivp69UGYTkfjNyIyj-TSve2z7_huZavLmm73qQyxfo";
const AMIGO_BASE = "https://amigobot-api.amigoapp.com.br";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-app-pin, authorization, apikey",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8" } });

// ---------- Segredos: env primeiro, depois Vault ----------
const cache: Record<string, string> = {};
async function segredo(nome: string): Promise<string> {
  if (cache[nome]) return cache[nome];
  const env = Deno.env.get(nome);
  if (env) return (cache[nome] = env);
  const { data, error } = await sb.rpc("get_app_secret", { p_name: nome });
  if (error || !data) throw new Error(`Segredo ${nome} não configurado`);
  return (cache[nome] = data as string);
}

// ---------- Amigo ----------
async function amigo(path: string) {
  const r = await fetch(`${AMIGO_BASE}/${path}`, { headers: { authorization: `Bearer ${await segredo("AMIGO_TOKEN")}` } });
  if (!r.ok) throw new Error(`Amigo ${r.status}: ${await r.text()}`);
  return r.json();
}

// ---------- Google Sheets (conta de serviço) ----------
let gToken: { token: string; exp: number } | null = null;
const b64url = (b: ArrayBuffer | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function googleToken(): Promise<string> {
  if (gToken && gToken.exp > Date.now() + 60_000) return gToken.token;
  const sa = JSON.parse(await segredo("GOOGLE_SA_JSON"));
  const agora = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: agora, exp: agora + 3600,
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${header}.${claim}.${b64url(sig)}`,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Google auth: ${JSON.stringify(j)}`);
  gToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return gToken.token;
}

async function sheets(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${PLANILHA_ID}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await googleToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Sheets ${r.status}: ${j.error?.message ?? JSON.stringify(j)}`);
  return j;
}

async function gravarNaPlanilha(f: Fechamento, linkRecibo: string | null) {
  const aba = abaDoMes(f.data_atendimento);
  const g = await sheets(`/values/${encodeURIComponent(`'${aba}'!A2:Z1000`)}?valueRenderOption=UNFORMATTED_VALUE`);
  const vals: unknown[][] = g.values ?? [];
  if (!vals.length) throw new Error(`Aba ${aba} sem cabeçalho na linha 2`);
  const c = mapearColunas(vals[0].map(String));
  const dados = vals.slice(1);

  const { data: procs } = await sb.from("procedimentos").select("nome, rotulo_planilha");
  const rotulos = Object.fromEntries((procs ?? []).map((p) => [p.nome, p.rotulo_planilha]));

  const serial = serialData(f.data_atendimento);
  const [y, m, d] = f.data_atendimento.slice(0, 10).split("-");
  if (jaLancado(dados, c, f.paciente_nome, serial, `${Number(d)}/${Number(m)}/${y.slice(2)}`)) {
    return { aba, linha: null as number | null, status: "duplicado" };
  }
  const linha = primeiraLinhaLivre(dados, c.nome, 3);
  const cel = celulasLinha(f, c, rotulos, linkRecibo);
  const data = cel.map((x) => ({ range: `'${aba}'!${colLetra(x.col)}${linha}`, values: [[x.valor]] }));
  await sheets(`/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  return { aba, linha, status: "ok" };
}

// ---------- Rotas ----------
async function exigirPin(req: Request) {
  const pin = req.headers.get("x-app-pin") ?? "";
  if (!pin || pin !== (await segredo("APP_PIN"))) throw Object.assign(new Error("PIN inválido"), { status: 401 });
}

async function rotaAgenda(url: URL) {
  const dia = url.searchParams.get("data") ?? new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const r = await amigo(`attendances?start_date=${dia}&end_date=${dia}&status=ALL`);
  const lista = filtrarAgenda(r.data ?? []);
  const { data: feitos } = await sb.from("fechamentos")
    .select("amigo_attendance_id, paciente_nome")
    .gte("data_atendimento", `${dia}T00:00:00-03:00`).lte("data_atendimento", `${dia}T23:59:59-03:00`);
  const ids = new Set((feitos ?? []).map((x) => x.amigo_attendance_id).filter(Boolean));
  return json({ data: dia, pacientes: lista.map((p) => ({ ...p, fechado: ids.has(p.attendance_id) })), fechados_avulsos: (feitos ?? []).filter((x) => !x.amigo_attendance_id).map((x) => x.paciente_nome) });
}

async function rotaListas() {
  const { data } = await sb.from("procedimentos").select("nome").eq("ativo", true).order("ordem").order("nome");
  return json({ procedimentos: (data ?? []).map((p) => p.nome), origens: ORIGENS });
}

async function rotaNovoProcedimento(req: Request) {
  const { nome } = await req.json();
  const limpo = String(nome ?? "").trim().replace(/\s+/g, " ");
  if (limpo.length < 2) return json({ erro: "Nome muito curto" }, 400);
  const bonito = limpo.charAt(0).toUpperCase() + limpo.slice(1);
  const { error } = await sb.from("procedimentos").upsert(
    { nome: bonito, rotulo_planilha: limpo.toLowerCase(), ordem: 200, ativo: true }, { onConflict: "nome" });
  if (error) return json({ erro: error.message }, 500);
  return json({ ok: true, nome: bonito });
}

async function rotaSalvar(req: Request) {
  const form = await req.formData();
  const f = JSON.parse(String(form.get("dados") ?? "{}")) as Fechamento;
  f.paciente_nome = titleCaseNome(f.paciente_nome ?? "");
  const erros = validar(f);
  const arquivo = form.get("recibo");
  const temArquivo = arquivo instanceof File && arquivo.size > 0;
  const houvePagamento = f.forma_pagamento !== "ja_pago" && f.valor_pago > 0;
  if (houvePagamento && !temArquivo) erros.push("Foto do recibo");
  if (erros.length) return json({ erro: "Falta preencher: " + erros.join(", ") }, 400);

  // Já salvo (toque duplo)? devolve o que já existe
  const { data: existente } = await sb.from("fechamentos").select("planilha_status, planilha_linha").eq("id", f.id).maybeSingle();
  if (existente) return json({ ok: true, repetido: true, ...existente });

  let caminho: string | null = null;
  if (temArquivo) {
    const file = arquivo as File;
    const ext = (file.name.split(".").pop() || (file.type.includes("pdf") ? "pdf" : "jpg")).toLowerCase();
    caminho = nomeArquivoRecibo(f, ext);
    const up = await sb.storage.from("recibos").upload(caminho, file, { contentType: file.type || "image/jpeg", upsert: false });
    if (up.error) return json({ erro: `Recibo não subiu: ${up.error.message}` }, 500);
  }

  const resumo = resumoProntuario(f);
  const { data: ins, error } = await sb.from("fechamentos").insert({
    id: f.id,
    data_atendimento: `${f.data_atendimento.slice(0, 16)}:00-03:00`,
    paciente_nome: f.paciente_nome,
    amigo_patient_id: f.amigo_patient_id ?? null,
    amigo_attendance_id: f.amigo_attendance_id ?? null,
    valor_pago: f.valor_pago,
    forma_pagamento: f.forma_pagamento,
    pagamentos: f.pagamentos ?? [],
    parcelas: f.parcelas ?? null,
    agendou_proxima: f.agendou_proxima,
    proxima_consulta: f.agendou_proxima && f.proxima_consulta
      ? (f.proxima_consulta.length > 10 ? `${f.proxima_consulta}:00-03:00` : `${f.proxima_consulta}T00:00:00-03:00`) : null,
    procedimentos: f.procedimentos,
    obs_procedimento: f.obs_procedimento || null,
    paciente_antiga: f.paciente_antiga,
    como_conheceu: f.paciente_antiga ? null : f.como_conheceu,
    recibo_path: caminho,
    resumo_prontuario: resumo,
  }).select("recibo_token").single();
  if (error) return json({ erro: `Não salvou: ${error.message}` }, 500);

  const link = caminho ? `${Deno.env.get("SUPABASE_URL")}/functions/v1/fechamento?acao=recibo&t=${ins.recibo_token}` : null;
  let planilha: { aba: string; linha: number | null; status: string; erro?: string };
  try {
    planilha = await gravarNaPlanilha(f, link);
  } catch (e) {
    planilha = { aba: abaDoMes(f.data_atendimento), linha: null, status: "erro", erro: String((e as Error).message) };
  }
  await sb.from("fechamentos").update({
    planilha_status: planilha.status, planilha_aba: planilha.aba, planilha_linha: planilha.linha, planilha_erro: planilha.erro ?? null,
  }).eq("id", f.id);

  return json({ ok: true, planilha, resumo, recibo: !!caminho, data: dataBR(f.data_atendimento) });
}

async function rotaRecibo(url: URL) {
  const t = url.searchParams.get("t") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(t)) return new Response("Link inválido", { status: 400 });
  const { data } = await sb.from("fechamentos").select("recibo_path").eq("recibo_token", t).maybeSingle();
  if (!data?.recibo_path) return new Response("Recibo não encontrado", { status: 404 });
  const s = await sb.storage.from("recibos").createSignedUrl(data.recibo_path, 120);
  if (s.error) return new Response("Erro ao abrir recibo", { status: 500 });
  return Response.redirect(s.data.signedUrl, 302);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const acao = url.searchParams.get("acao");
  try {
    if (acao === "recibo") return await rotaRecibo(url);
    await exigirPin(req);
    if (acao === "agenda") return await rotaAgenda(url);
    if (acao === "listas") return await rotaListas();
    if (acao === "procedimento" && req.method === "POST") return await rotaNovoProcedimento(req);
    if (acao === "salvar" && req.method === "POST") return await rotaSalvar(req);
    if (acao === "ping") return json({ ok: true });
    return json({ erro: "Rota desconhecida" }, 404);
  } catch (e) {
    const err = e as Error & { status?: number };
    return json({ erro: err.message }, err.status ?? 500);
  }
});
