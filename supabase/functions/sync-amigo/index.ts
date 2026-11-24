// Edge Function "sync-amigo" · Clínica TM
// Copia a agenda e o cadastro de pacientes do Amigo para o banco (schema amigo).
// Chamada pelo pg_cron a cada 15 min e sob demanda (public.sync_amigo_agora()).
// Autenticação: header x-admin-key = segredo ADMIN_KEY do Vault.
// Parâmetros (query): dias_antes (padrão 7), dias_depois (padrão 120), pacientes (padrão 40),
//   ou inicio=AAAA-MM-DD&fim=AAAA-MM-DD para recarregar um período.

import { createClient } from "jsr:@supabase/supabase-js@2";

const AMIGO_BASE = "https://amigobot-api.amigoapp.com.br";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const cache: Record<string, string> = {};
async function segredo(nome: string) {
  if (cache[nome]) return cache[nome];
  const env = Deno.env.get(nome);
  if (env) return (cache[nome] = env);
  const { data, error } = await sb.rpc("get_app_secret", { p_name: nome });
  if (error || !data) throw new Error(`Segredo ${nome} não configurado`);
  return (cache[nome] = data as string);
}

async function amigo(path: string, tentativa = 1): Promise<any> {
  const r = await fetch(`${AMIGO_BASE}/${path}`, { headers: { authorization: `Bearer ${await segredo("AMIGO_TOKEN")}` } });
  if (r.status === 429 && tentativa < 4) { await new Promise((ok) => setTimeout(ok, 1500 * tentativa)); return amigo(path, tentativa + 1); }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Amigo ${r.status} em ${path.split("?")[0]}`);
  return r.json();
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const somaDias = (s: string, n: number) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const hojeSP = () => iso(new Date(Date.now() - 3 * 3600_000));

async function syncAgenda(inicio: string, fim: string) {
  let lidos = 0, alterados = 0;
  for (let a = inicio; a <= fim; a = somaDias(a, 85)) {
    const b = somaDias(a, 84) < fim ? somaDias(a, 84) : fim;
    const r = await amigo(`attendances?start_date=${a}&end_date=${b}&status=ALL`);
    const itens = r?.data ?? [];
    lidos += itens.length;
    if (itens.length) {
      const { data, error } = await sb.rpc("amigo_upsert_agendamentos", { itens });
      if (error) throw new Error(`Banco (agenda): ${error.message}`);
      alterados += data ?? 0;
    }
  }
  return { lidos, alterados };
}

async function syncPacientes(lim: number) {
  if (lim <= 0) return { buscados: 0 };
  const { data: ids, error } = await sb.rpc("amigo_pacientes_para_atualizar", { lim });
  if (error) throw new Error(`Banco (pacientes): ${error.message}`);
  const itens: unknown[] = [];
  for (const id of (ids ?? []) as number[]) {
    const p = await amigo(`patients/${id}`);
    if (p) itens.push(p.data ?? p);
  }
  if (itens.length) {
    const r = await sb.rpc("amigo_upsert_pacientes", { itens });
    if (r.error) throw new Error(`Banco (pacientes): ${r.error.message}`);
  }
  return { buscados: itens.length };
}

Deno.serve(async (req) => {
  const inicioRun = new Date().toISOString();
  const url = new URL(req.url);
  let modo = "rotina";
  try {
    const chave = req.headers.get("x-admin-key") ?? "";
    if (!chave || chave !== (await segredo("ADMIN_KEY"))) return json({ erro: "não autorizado" }, 401);
    const hoje = hojeSP();
    let inicio = url.searchParams.get("inicio"), fim = url.searchParams.get("fim");
    if (inicio && fim) modo = "periodo";
    else {
      inicio = somaDias(hoje, -Number(url.searchParams.get("dias_antes") ?? 7));
      fim = somaDias(hoje, Number(url.searchParams.get("dias_depois") ?? 120));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio!) || !/^\d{4}-\d{2}-\d{2}$/.test(fim!)) return json({ erro: "datas inválidas" }, 400);
    const agenda = await syncAgenda(inicio!, fim!);
    const pacientes = await syncPacientes(Math.min(200, Number(url.searchParams.get("pacientes") ?? 40)));
    const detalhes = { inicio, fim, ...agenda, ...pacientes };
    await sb.rpc("ops_registrar_sync", { p_fonte: "amigo", p_modo: modo, p_ok: true, p_detalhes: detalhes, p_erro: null, p_inicio: inicioRun });
    return json({ ok: true, ...detalhes });
  } catch (e) {
    const msg = String((e as Error).message);
    await sb.rpc("ops_registrar_sync", { p_fonte: "amigo", p_modo: modo, p_ok: false, p_detalhes: null, p_erro: msg, p_inicio: inicioRun });
    return json({ ok: false, erro: msg }, 500);
  }
});
