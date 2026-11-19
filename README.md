# Fechamento de pacientes · Clínica TM

App de celular para a secretária registrar a saída de cada paciente.

## Fluxo
1. Celular abre o app (web/index.html, salvo na tela inicial).
2. App puxa a agenda do dia no Amigo (via Edge Function, token fica no servidor).
3. Ao salvar:
   - recibo vai para o Storage do Supabase (bucket privado `recibos/AAAA/MM/`)
   - registro completo vai para a tabela `fechamentos`
   - linha entra na aba do mês do Controle de Atendimentos (Data, Nome, Valor, Procedimentos, Como conheceu, Obs, Forma de pagamento, Parcelas, Próxima consulta, Recibo)
   - resumo entra na `fila_prontuario`, lançada como Evolução no Amigo no fechamento do dia (a API do Amigo não grava prontuário)

## Estrutura
- `supabase/migrations/` tabelas, bucket, view da fila, leitura de segredos do Vault
- `supabase/functions/fechamento/` Edge Function (Deno). `lib.ts` é a lógica pura (testável)
- `index.html`, `manifest.webmanifest`, `icon.png`: app estático (GitHub Pages, raiz do repo)

## Segredos (Vault ou secrets da função)
- `APP_PIN` código que a secretária digita uma vez
- `AMIGO_TOKEN` token Bearer da integração do Amigo
- `GOOGLE_SA_JSON` JSON da conta de serviço do Google com acesso de editor à planilha

## Deploy
1. Aplicar a migração no projeto Supabase.
2. `supabase functions deploy fechamento --no-verify-jwt`
3. Gravar os segredos: `select vault.create_secret('<valor>', 'APP_PIN');` (idem para os outros)
4. Em `web/index.html`, trocar `__SUPABASE_URL__` e `__SUPABASE_ANON_KEY__`.
5. Publicar `web/` no GitHub Pages.
6. Compartilhar a planilha com o e-mail da conta de serviço (editor).

## Próximos meses
A função acha as colunas pelo nome do cabeçalho na linha 2. Se a aba nova não tiver
Forma de pagamento / Parcelas / Próxima consulta / Recibo, essas informações vão para a Obs.
