"""Converte staging (planilha + Amigo) em pacientes, atendimentos e notas fiscais."""
import json, re, unicodedata, datetime as dt, collections, sys

D = "dados/"
planilha = json.load(open(D + "planilha.json"))
amigo_at = json.load(open(D + "amigo_atend.json"))
amigo_pac = {p["id"]: p["dados"] for p in json.load(open(D + "amigo_pac.json"))}

MESES = {"jan": 1, "fev": 2, "mar": 3, "abr": 4, "mai": 5, "jun": 6, "jul": 7, "ago": 8, "set": 9, "out": 10, "nov": 11, "dez": 12}
MES_NOME = {"janeiro": 1, "fevereiro": 2, "marco": 3, "abril": 4, "maio": 5, "junho": 6, "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10, "novembro": 11, "dezembro": 12}
EPOCH = dt.date(1899, 12, 30)

def norm(s):
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s.lower())).strip()

STOP = {"de", "da", "do", "das", "dos", "e"}
def toks(s): return [t for t in norm(s).split() if t not in STOP]

def aba_mes(aba):
    n = norm(aba).replace(" ", "")
    m = re.match(r"([a-z]+)(\d{2})$", n)
    if not m: return None
    nome, yy = m.groups()
    mes = MESES.get(nome[:3])
    return (2000 + int(yy), mes) if mes else None

def brl(x):
    if x is None or x == "": return None
    if isinstance(x, (int, float)): return round(float(x), 2)
    s = str(x).strip()
    if re.fullmatch(r"\d+\.\d{1,2}", s): return round(float(s), 2)
    m = re.search(r"-?\d[\d.]*,?\d*", s.replace("R$", ""))
    if not m: return None
    v = m.group().replace(".", "").replace(",", ".")
    try: return round(float(v), 2)
    except ValueError: return None

def data_cel(v, f, ano, mes):
    d = None
    if isinstance(v, (int, float)) and 30000 < v < 60000:
        d = EPOCH + dt.timedelta(days=int(v))
    else:
        m = re.search(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?", str(f or v or ""))
        if m:
            dd, mm = int(m.group(1)), int(m.group(2))
            try: d = dt.date(ano, mm, dd)
            except ValueError: d = None
    if d and (d.year != ano):  # ano digitado errado (ex.: 24/2/04)
        try: d = d.replace(year=ano)
        except ValueError: pass
    # data muito fora do mês da aba: mantém só se for mês vizinho
    if d and abs((d.year * 12 + d.month) - (ano * 12 + mes)) > 1:
        d = None
    return d

# ---------- abas mensais ----------
por_aba = collections.defaultdict(list)
for r in planilha: por_aba[r["aba"]].append(r)

def acha_cabecalho(linhas):
    for r in linhas[:6]:
        h = [norm(x) for x in r["f"]]
        if any(x in ("cliente nome completo", "nome") for x in h): return r, h
    return None, None

atendimentos = []
ultimo_cab = None
abas_mes = sorted([a for a in por_aba if aba_mes(a)], key=lambda a: aba_mes(a))
for aba in abas_mes:
    ano, mes = aba_mes(aba)
    linhas = sorted(por_aba[aba], key=lambda r: r["linha"])
    cab_row, h = acha_cabecalho(linhas)
    if h is None: h = ultimo_cab; cab_linha = 0
    else: cab_linha = cab_row["linha"]; ultimo_cab = h
    sub = None
    nxt = [r for r in linhas if r["linha"] == cab_linha + 1]
    if nxt and sum(1 for x in nxt[0]["f"] if norm(x) in ("proced", "fez")) >= 2:
        sub = [norm(x) for x in nxt[0]["f"]]
    idx = lambda pred: next((i for i, x in enumerate(h) if pred(x)), None)
    c_data = idx(lambda x: x.startswith("data"))
    c_nome = idx(lambda x: x in ("cliente nome completo", "nome"))
    c_valor = idx(lambda x: x == "valor")
    c_origem = idx(lambda x: x.startswith("como conheceu") or x == "origem")
    c_metodo = idx(lambda x: x.startswith("metodo") or x == "forma de pagamento")
    c_obs = [i for i, x in enumerate(h) if x in ("obs", "obs ") or x.startswith("obs")]
    c_indic = idx(lambda x: x.startswith("indicado por"))
    c_nf = idx(lambda x: x.startswith("notas fiscais"))
    c_nf2 = idx(lambda x: x.startswith("ultima nf emitida") or x.startswith("conferencia nf"))
    # procedimentos
    procs, valores_neg, fez = [], [], {}
    if sub:
        for i, x in enumerate(sub):
            if x == "proced": procs.append(i); fez[i] = i + 1
    else:
        for i, x in enumerate(h):
            if x.startswith("procedimento") or x == "proced":
                procs.append(i)
                if x == "procedimento":  # colunas vazias à direita fazem parte (formato antigo)
                    j = i + 1
                    while j < len(h) and h[j] == "" and j not in (c_valor,):
                        procs.append(j); j += 1
            if x.startswith("valor negociado"): valores_neg.append(i)
    procs = sorted(set(procs))
    ultima_data = None
    for r in linhas:
        if r["linha"] <= cab_linha + (1 if sub else 0): continue
        v, f = r["v"], r["f"]
        g = lambda i: (f[i] if i is not None and i < len(f) else "")
        gv = lambda i: (v[i] if i is not None and i < len(v) else None)
        nome = str(g(c_nome)).strip()
        if not nome or norm(nome) in ("false", "true", "total", "nome") or len(norm(nome)) < 3: continue
        if re.fullmatch(r"[\d\s.,R$]+", nome): continue
        if re.match(r"\d", nome) or "total" in norm(nome): continue
        dcel = g(c_data) if c_data is not None else ""
        if str(dcel).strip() and not re.search(r"\d{1,2}/\d{1,2}", str(dcel)) and not isinstance(gv(c_data), (int, float)): continue
        d = data_cel(gv(c_data), g(c_data), ano, mes) if c_data is not None else None
        if d is None: d = ultima_data or dt.date(ano, mes, 1)
        ultima_data = d
        if valores_neg:
            valor = round(sum(brl(gv(i)) or 0 for i in valores_neg), 2)
        else:
            valor = brl(gv(c_valor)) if c_valor is not None else None
            if valor is None and c_valor is not None: valor = brl(g(c_valor))
        lista = []
        for i in procs:
            p = str(g(i)).strip()
            if not p or norm(p) in ("false", "true"): continue
            if i in fez and norm(g(fez[i])) == "false": p += " (não realizado)"
            lista.append(p.lower())
        obs = [str(g(i)).strip() for i in c_obs if str(g(i)).strip()]
        if c_indic is not None and str(g(c_indic)).strip(): obs.append("indicado por " + str(g(c_indic)).strip())
        atendimentos.append({
            "aba": aba, "linha": r["linha"], "data": d.isoformat(), "nome_planilha": re.sub(r"\s+", " ", nome).strip(" ,"),
            "valor": valor, "procedimentos": lista,
            "forma_pagamento": (str(g(c_metodo)).strip() or None) if c_metodo is not None else None,
            "origem": (str(g(c_origem)).strip().lower() or None) if c_origem is not None else None,
            "obs": " · ".join(obs) or None,
            "nf_texto": " | ".join(x for x in (str(g(c_nf)).strip(), str(g(c_nf2)).strip()) if x) or None,
        })

# ---------- casamento com o Amigo ----------
am_por_dia = collections.defaultdict(list)
for a in amigo_at:
    if not a.get("patient_id"): continue
    dia = (a["inicio"] or "")[:10]
    am_por_dia[dia].append(a)
pac_por_nome = collections.defaultdict(set)
for pid, p in amigo_pac.items():
    pac_por_nome[" ".join(toks(p.get("name")))].add(pid)

def score(n1, n2):
    a, b = toks(n1), toks(n2)
    if not a or not b: return 0
    if a[0] != b[0] and not (a[0].startswith(b[0]) or b[0].startswith(a[0])): return 0
    sa, sb = set(a), set(b)
    inter = len(sa & sb)
    if inter == len(sa) or inter == len(sb): return 0.9 + 0.1 * inter / max(len(sa), len(sb))
    return inter / len(sa | sb)

IGN = re.compile(r"^nf\b|representante|hands on|fabi - atendimentos|laser fabi", re.I)
usados = set()
for at in atendimentos:
    d = dt.date.fromisoformat(at["data"])
    melhor = (0, None)
    for delta in (0, -1, 1, -2, 2, -3, 3):
        dia = (d + dt.timedelta(days=delta)).isoformat()
        for a in am_por_dia.get(dia, []):
            if IGN.search(a.get("evento") or "") or IGN.search(a.get("nome") or ""): continue
            s = score(at["nome_planilha"], a.get("nome")) - abs(delta) * 0.02 - (0.05 if a.get("cancelado") else 0)
            if s > melhor[0]: melhor = (s, a)
        if melhor[0] >= 0.85: break
    if melhor[0] >= 0.6:
        a = melhor[1]
        at.update(amigo_patient_id=a["patient_id"], amigo_attendance_id=a["id"], match="amigo_agenda" if melhor[0] >= 0.85 else "amigo_agenda_aprox")
    else:
        ids = pac_por_nome.get(" ".join(toks(at["nome_planilha"])))
        if ids and len(ids) == 1:
            at.update(amigo_patient_id=next(iter(ids)), amigo_attendance_id=None, match="nome_exato")
        else:
            at.update(amigo_patient_id=None, amigo_attendance_id=None, match="sem_match")

# ---------- notas fiscais ----------
notas = {}
def add_nf(chave, **k):
    if chave in notas:
        for kk, vv in k.items():
            if vv not in (None, "") and notas[chave].get(kk) in (None, ""): notas[chave][kk] = vv
        if k.get("status") == "cancelada": notas[chave]["status"] = "cancelada"
    else:
        notas[chave] = k

def dmy(s, ano_padrao):
    m = re.search(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?", s or "")
    if not m: return None
    y = m.group(3); y = (2000 + int(y)) if y and len(y) == 2 else (int(y) if y else ano_padrao)
    try: return dt.date(y, int(m.group(2)), int(m.group(1))).isoformat()
    except ValueError: return None

# (a) texto de NF nas abas mensais
for at in atendimentos:
    t = at.get("nf_texto")
    if not t: continue
    ano = int(at["data"][:4])
    for m in re.finditer(r"NF\s*(\d{3,5})([^|+;]*)", t):
        num, resto = m.group(1), m.group(2)
        tipo = "imposto" if re.search(r"imposto", resto, re.I) else ("consulta" if re.search(r"consulta", resto, re.I) else None)
        vm = re.search(r"R\$\s*([\d.]+(?:,\d{2})?)", resto)
        em = re.search(r"(\d{1,2}/\d{1,2}/\d{2,4})", resto)
        status = "cancelada" if re.search(r"cancelad", resto, re.I) else "emitida"
        add_nf("nf:" + num, numero=num, tipo=tipo, valor=brl(vm.group(1)) if vm else None,
               emitida_em=dmy(em.group(1), ano) if em else None, status=status,
               nome_planilha=at["nome_planilha"], amigo_patient_id=at.get("amigo_patient_id"),
               atendimento_ref=f'{at["aba"]}!{at["linha"]}', fonte="planilha_mes", match=at["match"], obs=None,
               parcela=None, valor_total_pacote=None, prevista_para=None, enviada=None)

# (b) abas "Notas fiscais 20XX" (parcelas de pacotes)
for aba in [a for a in por_aba if norm(a).startswith("notas fiscais")]:
    ano = int(re.search(r"(\d{4})", aba).group(1))
    linhas = sorted(por_aba[aba], key=lambda r: r["linha"])
    cab = next((r for r in linhas if sum(1 for x in r["f"] if norm(x) == "nome") >= 2), None)
    if not cab: continue
    h = [norm(x) for x in cab["f"]]
    rot = next((r for r in linhas if r["linha"] == cab["linha"] - 1), None)
    rotulos = [norm(x) for x in (rot["f"] if rot else [])]
    blocos = [i for i, x in enumerate(h) if x == "nome"]
    for bi, ini in enumerate(blocos):
        fim = blocos[bi + 1] if bi + 1 < len(blocos) else len(h)
        cols = {h[i]: i for i in range(ini, fim)}
        mes = None
        for i in range(ini, max(-1, ini - 3), -1):
            if i < len(rotulos) and rotulos[i] in MES_NOME: mes = MES_NOME[rotulos[i]]; break
        if mes is None:
            for i in range(ini, min(fim, len(rotulos))):
                if rotulos[i] in MES_NOME: mes = MES_NOME[rotulos[i]]; break
        if mes is None: mes = 1 if bi == 0 and "janeiro" not in rotulos else None
        if mes is None: continue
        for r in linhas:
            if r["linha"] <= cab["linha"]: continue
            f = r["f"]; g = lambda k: (str(f[cols[k]]).strip() if k in cols and cols[k] < len(f) else "")
            nome = g("nome")
            if not nome or norm(nome) == "nome": continue
            nome_limpo = re.split(r"\s+-\s+|\s*-nfs", nome)[0].strip()
            prev = g("emitir nfs em"); emit = g("emitida em")
            env = norm(g("enviado s n"))
            if "nao encontrada" in norm(emit): status = "nao_encontrada"
            elif dmy(emit, ano): status = "emitida"
            elif "emitida em" not in cols and env.startswith("s"): status = "emitida"
            elif dt.date(ano, mes, 1) > dt.date.today(): status = "programada"
            else: status = "sem_confirmacao"
            ids = pac_por_nome.get(" ".join(toks(nome_limpo)))
            pid, mt = (next(iter(ids)), "nome_exato") if ids and len(ids) == 1 else (None, "sem_match")
            if pid is None:  # tenta casar com atendimento já casado
                cand = [a for a in atendimentos if a.get("amigo_patient_id") and score(nome_limpo, a["nome_planilha"]) >= 0.9]
                if cand: pid, mt = cand[0]["amigo_patient_id"], "via_atendimento"
            prev_d = dmy(prev, ano)
            if prev_d: prev_d = dt.date.fromisoformat(prev_d).replace(month=mes).isoformat() if False else prev_d
            add_nf(f"{aba}!{r['linha']}!{ini}", numero=None, tipo=None, valor=brl(g("valor da nota")),
                   valor_total_pacote=brl(g("valor total")), parcela=g("parcela") or None,
                   prevista_para=(dt.date(ano, mes, min(int(re.match(r"\d+", prev).group()), 28)).isoformat() if re.match(r"\d+", prev) else None),
                   emitida_em=dmy(emit, ano), enviada=(True if env.startswith("s") else False if env.startswith("n") else None),
                   status=status, obs=g("obs") or None, nome_planilha=nome, amigo_patient_id=pid,
                   atendimento_ref=None, fonte="planilha_nf", match=mt)

# ---------- pacientes ----------
origem_por_pac = {}
for at in sorted(atendimentos, key=lambda a: a["data"]):
    pid = at.get("amigo_patient_id")
    if pid and pid not in origem_por_pac and at.get("origem") and "antig" not in at["origem"]:
        origem_por_pac[pid] = at["origem"]
pacientes = []
for pid, p in amigo_pac.items():
    cpf = re.sub(r"\D", "", str(p.get("cpf") or ""))
    pacientes.append({"amigo_id": pid, "nome": (p.get("name") or "").strip(), "nome_norm": " ".join(toks(p.get("name"))),
                      "cpf": f"{cpf[:3]}.{cpf[3:6]}.{cpf[6:9]}-{cpf[9:]}" if len(cpf) == 11 else (cpf or None),
                      "email": p.get("email") or None,
                      "celular": p.get("contact_cellphone") or None, "idade_amigo": p.get("age"),
                      "convenio": (p.get("health_insurance") or {}).get("name") if isinstance(p.get("health_insurance"), dict) else (p.get("health_insurance") or None),
                      "cadastrado_amigo_em": p.get("created_at"), "primeira_origem": origem_por_pac.get(pid)})

for at in atendimentos:
    at["fonte"] = "planilha"; at["fonte_ref"] = f'{at["aba"]}!{at["linha"]}'
notas_l = [dict(v, fonte_ref=k) for k, v in notas.items()]
json.dump(pacientes, open(D + "out_pacientes.json", "w"), ensure_ascii=False)
json.dump(atendimentos, open(D + "out_atendimentos.json", "w"), ensure_ascii=False)
json.dump(notas_l, open(D + "out_notas.json", "w"), ensure_ascii=False)

# ---------- diagnóstico (sem nomes) ----------
c = collections.Counter(a["match"] for a in atendimentos)
print("atendimentos:", len(atendimentos), dict(c))
por_ano = collections.defaultdict(lambda: [0, 0.0, 0])
for a in atendimentos:
    y = a["data"][:4]; por_ano[y][0] += 1; por_ano[y][1] += a["valor"] or 0; por_ano[y][2] += a["match"] == "sem_match"
for y in sorted(por_ano): print(" ", y, "atend:", por_ano[y][0], "valor: R$ %.2f" % por_ano[y][1], "sem match:", por_ano[y][2])
print("pacientes Amigo:", len(pacientes), "com CPF:", sum(1 for p in pacientes if p["cpf"]))
print("notas:", len(notas_l), dict(collections.Counter(n["fonte"] for n in notas_l)), dict(collections.Counter(n["status"] for n in notas_l)), "match:", dict(collections.Counter(n["match"] for n in notas_l)))
sem_proc = sum(1 for a in atendimentos if not a["procedimentos"]); print("sem procedimento:", sem_proc, "| sem valor:", sum(1 for a in atendimentos if a["valor"] is None))
