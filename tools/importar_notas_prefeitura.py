import csv, json, re, collections, unicodedata, datetime as dt
D = "/home/claude/imp/dados/"
pac = json.load(open(D + "out_pacientes.json"))
at = json.load(open(D + "out_atendimentos.json"))
nplan = json.load(open(D + "out_notas.json"))

def norm(s):
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s.lower())).strip()
STOP = {"de", "da", "do", "das", "dos", "e"}
def toks(s): return [t for t in norm(s).split() if t not in STOP]
def score(a, b):
    a, b = toks(a), toks(b)
    if not a or not b or a[0] != b[0]: return 0
    sa, sb = set(a), set(b); i = len(sa & sb)
    return 0.95 if i == len(sa) or i == len(sb) else i / len(sa | sb)
def brl(s): return float(s.replace(".", "").replace(",", ".")) if s else None
def dmy(s):
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", s or "")
    if not m: return None
    try: return dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError: return None

por_cpf = collections.defaultdict(list)
for p in pac:
    c = re.sub(r"\D", "", p.get("cpf") or "")
    if len(c) == 6: por_cpf[c].append(p["amigo_id"])  # Amigo devolve só os 6 dígitos do meio
por_nome = collections.defaultdict(set)
for p in pac: por_nome[" ".join(toks(p["nome"]))].add(p["amigo_id"])
nome_pac = {p["amigo_id"]: p["nome"] for p in pac}
at_por_pac = collections.defaultdict(list)
for a in at:
    if a.get("amigo_patient_id"): at_por_pac[a["amigo_patient_id"]].append(a)

rows = [x for x in csv.reader(open("nfse.csv", encoding="utf-8"), delimiter=";") if x and x[0] == "2"]
notas, mt = [], collections.Counter()
for x in rows:
    num, emit, sit, canc, valor, iss = x[1], dmy(x[2]), x[22], dmy(x[23]), brl(x[26]), brl(x[30])
    cpf = re.sub(r"\D", "", x[34]); nome = x[37].strip(); disc = x[165]
    tipo = "consulta" if "consulta" in disc.lower() else "imposto"
    m = re.search(r"prestado (?:no )?dia (\d{2}/\d{2}/\d{4})", disc, re.I)
    dserv = dmy(m.group(1)) if m else None
    pid, how = None, "sem_match"
    meio = cpf[3:9] if len(cpf) == 11 else None
    cand = [i for i in por_cpf.get(meio, []) if score(nome, nome_pac[i]) > 0] if meio else []
    if len(cand) == 1: pid, how = cand[0], "cpf"
    elif len(cand) > 1: pid, how = max(cand, key=lambda i: score(nome, nome_pac[i])), "cpf_nome"
    if pid is None:
        ids = por_nome.get(" ".join(toks(nome)))
        if ids and len(ids) == 1: pid, how = next(iter(ids)), "nome_exato"
        else:
            best = max(((score(nome, nome_pac[i]), i) for i in nome_pac), default=(0, None))
            if best[0] >= 0.9: pid, how = best[1], "nome_aprox"
    # atendimento: data do serviço, senão emissão; o mais próximo antes (até 60 dias), valor igual pesa
    aref = None
    if pid:
        alvo = dserv or emit
        cands = []
        for a in at_por_pac[pid]:
            d = dt.date.fromisoformat(a["data"]); diff = (alvo - d).days
            if -3 <= diff <= 60:
                cands.append((abs(diff) - (30 if a["valor"] and valor and abs(a["valor"] - valor) < 0.01 else 0), a))
        if cands: aref = f'{min(cands, key=lambda c: c[0])[1]["aba"]}!{min(cands, key=lambda c: c[0])[1]["linha"]}'
    mt[how] += 1
    notas.append({"numero": num, "tipo": tipo, "valor": valor, "emitida_em": emit.isoformat(), "status": "cancelada" if sit == "C" else "emitida",
                  "cancelada_em": canc.isoformat() if canc else None, "match": how, "amigo_patient_id": pid, "atendimento_ref": aref,
                  "cpf_tomador": (f"{cpf[:3]}.{cpf[3:6]}.{cpf[6:9]}-{cpf[9:]}" if len(cpf) == 11 else cpf or None), "tomador": nome,
                  "codigo_verificacao": x[3], "iss": iss, "discriminacao": disc, "data_servico": dserv.isoformat() if dserv else None})

# conciliação: parcelas da planilha x notas da Prefeitura (mesmo paciente, mesmo valor, até 25 dias)
usadas, pares = set(), []
pref_por_pac = collections.defaultdict(list)
for n in notas:
    if n["amigo_patient_id"] and n["status"] == "emitida": pref_por_pac[n["amigo_patient_id"]].append(n)
for p in nplan:
    if p["fonte"] != "planilha_nf" or not p.get("amigo_patient_id") or p.get("valor") is None: continue
    ref = p.get("emitida_em") or p.get("prevista_para")
    if not ref: continue
    ref = dt.date.fromisoformat(ref)
    c = [n for n in pref_por_pac[p["amigo_patient_id"]] if n["numero"] not in usadas and abs(n["valor"] - p["valor"]) < 0.01
         and abs((dt.date.fromisoformat(n["emitida_em"]) - ref).days) <= 25]
    if c:
        n = min(c, key=lambda n: abs((dt.date.fromisoformat(n["emitida_em"]) - ref).days))
        usadas.add(n["numero"]); pares.append({"fonte_ref": p["fonte_ref"], "numero": n["numero"]})

json.dump({"tabela": "notas_prefeitura", "linhas": notas}, open("load_pref.json", "w"), ensure_ascii=False)
json.dump({"tabela": "conciliar", "linhas": pares}, open("load_conc.json", "w"), ensure_ascii=False)
print("notas:", len(notas), dict(mt), "| canceladas:", sum(n["status"] == "cancelada" for n in notas),
      "| ligadas a atendimento:", sum(bool(n["atendimento_ref"]) for n in notas))
print("parcelas da planilha conciliadas:", len(pares), "de", sum(1 for p in nplan if p["fonte"] == "planilha_nf"))
por_ano = collections.defaultdict(lambda: [0, 0.0])
for n in notas:
    if n["status"] == "emitida": por_ano[n["emitida_em"][:4]][0] += 1; por_ano[n["emitida_em"][:4]][1] += n["valor"]
for y in sorted(por_ano): print(y, por_ano[y][0], "R$ %.2f" % por_ano[y][1])
