# Pesquisa: regras de projetos parecidos (06/10/2026)

Comparação das regras do ai-manager com projetos de multi-sessão, aquecimento e antiban de WhatsApp.

**Fontes lidas no código:** baileys-antiban 4.10 (dependência deste projeto), Baileys (`DisconnectReason`),
EvolutionAPI, ookamiiixd/baileys-api, JonasCaetanoSz/maturador-de-chips e EduardoDos-SantosP/maturador-whatsapp.
**Não lidos:** wppconnect e whatsapp-web.js (a busca no GitHub falhou).

## 1. Quedas e reconexão

| Projeto | Regra |
|---|---|
| Baileys (`lib/Types`) | 428 connectionClosed, 408 connectionLost/timedOut, 503 unavailableService, 515 restartRequired, 500 badSession, 440 connectionReplaced, 401 loggedOut, 403 forbidden |
| EvolutionAPI (`whatsapp.baileys.service.ts:428`) | reconecta sempre, na hora e sem limite, exceto 401/403/402/406; quedas não afetam nada |
| baileys-api (`src/wa.ts`) | máx. 5 tentativas, intervalo configurável (padrão 0), 515 reconecta na hora, só para no 401 |
| baileys-antiban (`sessionStability.js`) | espera por código: 408 → 5 s, 500 → 10 s, 503 → 60 s, 429 → 5 min |

⚠️ O baileys-antiban classifica 428 como fatal ("conexão substituída"), o que contradiz o Baileys (428 =
connectionClosed). **Não copiar.**

## 2. Score de saúde

- **baileys-antiban** (`health.js`): olha só a **última hora**. Quedas só pesam a partir de **3 em 1 h** (+30).
  403 vale +40, 401 vale +60, 5 ou mais falhas valem +20. O score **melhora 5 pontos por minuto** desde o último
  evento ruim (2/min se for 403/401). Faixas: medium ≥ 15 (reduzir 50%), high ≥ 40 (reduzir 80%), critical ≥ 80
  (parar). O preset conservative pausa em medium; os outros, em high.
- EvolutionAPI e os maturadores não têm score; o maturador-de-chips só para o chip quando ele é desconectado ou banido.

## 3. Aquecimento

- **baileys-antiban** (`presets.js`, `warmup.js`), preset conservative: 10 dias, 15 no 1º dia, ×1,8 por dia,
  5 por minuto, 100 por hora, 2,5 a 7 s entre mensagens, +4 s em conversa nova, digitação de ~30 ms por caractere
  (até 3 s). O padrão **sorteia o crescimento entre 1,5 e 2,2 por conta**. Conta **72 h inativa recomeça o aquecimento**.
- maturador-de-chips: 1 a 10 s entre mensagens, 50 por conta antes de trocar de par, digitação de 2 a 4,5 s.
- maturador-whatsapp (`index.ts:52`): 30 a 90 s entre mensagens, pula 25% dos pares por sorteio.

## 4. Conteúdo e grupos

- baileys-antiban: no máximo 3 mensagens idênticas por hora (conservative).
- `groupOperationGuard.js`: 3 adições a cada 10 min, 2 criações a cada 10 min, 10 consultas de convite a cada 10 min.
- Erros `account_reachout_restricted` ou `rate-overlimit` exigem parar.

## 5. Proxy

- baileys-antiban (README:385): IP de datacenter (VPS) seria marcado pelo WhatsApp; recomenda proxy residencial
  ou 4G. *Afirmação do README, não verificada.*
- `proxyRotator.js`: troca de proxy após 3 falhas e deixa o falho de molho por 10 min.
- Nenhum projeto tem regra explícita de "1 número por IP".

## Sugestões para o ai-manager

| # | Sugestão | Status |
|---|---|---|
| 1 | Score: quedas isoladas não punem; só a 3ª em diante dentro de 60 min; a queda conta uma vez só (sem "tendência") | **feito em 06/10** |
| 2 | DEGRADED reduz o ritmo (limites × 0,5) em vez de parar de enviar | **feito em 06/10** |
| 3 | Espera por código antes de reconectar: 503 → 60 s, 429 → 5 min | pendente |
| 4 | Aquecimento: crescimento sorteado entre 1,5 e 2,2 por chip e reinício após 72 h inativo | pendente |
| 5 | Proxy residencial BR no chip1, chip2 e chip 4 (hoje saem pelo IP da VPS, OVH Canadá) | pendente |
| 6 | Decaimento do score no tempo (janela curta, como o antiban) em vez da janela de 24 h | pendente (avaliar após observar o item 1) |
