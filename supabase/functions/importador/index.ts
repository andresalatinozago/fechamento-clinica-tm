// Edge Function "importador" · Clínica TM
// Carrega dados brutos (planilha + Amigo) para o schema staging. Só leitura nas fontes.
// Auth: header x-admin-key (segredo ADMIN_KEY no Vault).
//   GET ?acao=abas                                 lista abas da planilha
//   GET ?acao=planilha&abas=A,B                    carrega abas inteiras (A1:AZ)
//   GET ?acao=amigo_agenda&inicio=AAAA-MM-DD&fim=  carrega atendimentos do Amigo (janelas de 85 dias)
//   GET ?acao=amigo_pacientes&lim=150              busca cadastro dos pacientes ainda não carregados

import { createClient } from "jsr:@supabase/supabase-js@2";

const PLANILHA_ID = "18ivp69UGYTkfjNyIyj-TSve2z7_huZavLmm73qQyxfo";
const AMIGO_BASE = "https://amigobot-api.amigoapp.com.br";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });

const cache: Record<string, string> = {};
async function segredo(nome: string) {
  if (cache[nome]) return cache[nome];
  const env = Deno.env.get(nome);
  if (env) return (cache[nome] = env);
  const { data, error } = await sb.rpc("get_app_secret", { p_name: nome });
  if (error || !data) throw new Error(`Segredo ${nome} não configurado`);
  return (cache[nome] = data as string);
}

let gToken: { token: string; exp: number } | null = null;
const b64url = (b: ArrayBuffer | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function googleToken() {
  if (gToken && gToken.exp > Date.now() + 60_000) return gToken.token;
  const sa = JSON.parse(await segredo("GOOGLE_SA_JSON"));
  const agora = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const c = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: agora, exp: agora + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (x) => x.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${c}`));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${h}.${c}.${b64url(sig)}` });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Google auth: ${JSON.stringify(j)}`);
  gToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return gToken.token;
}
async function sheetsGet(path: string) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${PLANILHA_ID}${path}`, { headers: { authorization: `Bearer ${await googleToken()}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(`Sheets ${r.status}: ${j.error?.message}`);
  return j;
}

async function amigo(path: string) {
  for (let t = 0; t < 3; t++) {
    const r = await fetch(`${AMIGO_BASE}/${path}`, { headers: { authorization: `Bearer ${await segredo("AMIGO_TOKEN")}` } });
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500 * (t + 1))); continue; }
    if (!r.ok) throw new Error(`Amigo ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  throw new Error("Amigo 429 persistente");
}

async function rotaAbas() {
  const j = await sheetsGet("?fields=sheets.properties(title,gridProperties)");
  return json(j.sheets.map((s: any) => ({ aba: s.properties.title, linhas: s.properties.gridProperties.rowCount, colunas: s.properties.gridProperties.columnCount })));
}

async function rotaPlanilha(url: URL) {
  const abas = (url.searchParams.get("abas") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const out: Record<string, number> = {};
  for (const aba of abas) {
    const rng = encodeURIComponent(`'${aba}'!A1:AZ5000`);
    const [u, f] = await Promise.all([
      sheetsGet(`/values/${rng}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
      sheetsGet(`/values/${rng}?valueRenderOption=FORMATTED_VALUE`),
    ]);
    const vu: unknown[][] = u.values ?? [], vf: unknown[][] = f.values ?? [];
    const linhas = [];
    for (let i = 0; i < Math.max(vu.length, vf.length); i++) {
      const v = vu[i] ?? [], fm = vf[i] ?? [];
      if (!v.some((x) => String(x ?? "").trim() !== "")) continue;
      linhas.push({ aba, linha: i + 1, v, f: fm });
    }
    let n = 0;
    for (let i = 0; i < linhas.length; i += 500) {
      const { data, error } = await sb.rpc("staging_upsert_planilha", { p: linhas.slice(i, i + 500) });
      if (error) throw new Error(`${aba}: ${error.message}`);
      n += data as number;
    }
    out[aba] = n;
  }
  return json({ ok: true, linhas: out });
}

const addDias = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

async function rotaAmigoAgenda(url: URL) {
  const inicio = url.searchParams.get("inicio")!, fim = url.searchParams.get("fim")!;
  let total = 0; const janelas: string[] = [];
  for (let a = inicio; a <= fim; a = addDias(a, 85)) {
    const b = addDias(a, 84) < fim ? addDias(a, 84) : fim;
    const r = await amigo(`attendances?start_date=${a}&end_date=${b}&status=ALL`);
    const itens = r.data ?? [];
    for (let i = 0; i < itens.length; i += 500) {
      const { data, error } = await sb.rpc("staging_upsert_amigo_atend", { p: itens.slice(i, i + 500) });
      if (error) throw new Error(error.message);
      total += data as number;
    }
    janelas.push(`${a}..${b}: ${itens.length}`);
  }
  return json({ ok: true, total, janelas });
}

async function rotaAmigoPacientes(url: URL) {
  const lim = Number(url.searchParams.get("lim") ?? "150");
  const { data: ids, error } = await sb.rpc("staging_pacientes_pendentes", { lim });
  if (error) throw new Error(error.message);
  let ok = 0, falha = 0;
  const lista = (ids ?? []) as number[];
  for (let i = 0; i < lista.length; i += 5) {
    await Promise.all(lista.slice(i, i + 5).map(async (id) => {
      try {
        const r = await amigo(`patients/${id}`);
        await sb.rpc("staging_upsert_amigo_paciente", { p_id: id, p_dados: r.data ?? r, p_erro: null }); ok++;
      } catch (e) {
        await sb.rpc("staging_upsert_amigo_paciente", { p_id: id, p_dados: null, p_erro: String((e as Error).message) }); falha++;
      }
    }));
  }
  return json({ ok: true, buscados: lista.length, sucesso: ok, falha });
}

async function rotaExport(url: URL) {
  const { data, error } = await sb.rpc("exportar_staging", { p_tabela: url.searchParams.get("tabela") });
  if (error) throw new Error(error.message);
  return json(data ?? []);
}

async function rotaCarregar(req: Request) {
  const { tabela, linhas } = await req.json();
  let n = 0;
  for (let i = 0; i < linhas.length; i += 400) {
    const lote = linhas.slice(i, i + 400);
    const { data, error } = tabela === "notas_prefeitura" ? await sb.rpc("carregar_notas_prefeitura", { p_linhas: lote })
      : tabela === "conciliar" ? await sb.rpc("conciliar_parcelas", { p_pares: lote })
      : await sb.rpc("carregar_lote", { p_tabela: tabela, p_linhas: lote });
    if (error) throw new Error(`${tabela} lote ${i}: ${error.message}`);
    n += data as number;
  }
  return json({ ok: true, tabela, gravadas: n });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    if ((req.headers.get("x-admin-key") ?? "") !== (await segredo("ADMIN_KEY"))) return json({ erro: "não autorizado" }, 401);
    const acao = url.searchParams.get("acao");
    if (acao === "abas") return await rotaAbas();
    if (acao === "planilha") return await rotaPlanilha(url);
    if (acao === "amigo_agenda") return await rotaAmigoAgenda(url);
    if (acao === "amigo_pacientes") return await rotaAmigoPacientes(url);
    if (acao === "export") return await rotaExport(url);
    if (acao === "carregar" && req.method === "POST") return await rotaCarregar(req);
    return json({ erro: "rota desconhecida" }, 404);
  } catch (e) {
    return json({ erro: String((e as Error).message) }, 500);
  }
});
