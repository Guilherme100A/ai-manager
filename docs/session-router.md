# Comunicação entre sessões

Fluxo: contato → sessão A → SessionRouter → SendPipeline → fila de B → mesmo contato.

O módulo está em `packages/core/src/session-router`. Ele usa o pacote de domínio já existente para evitar uma dependência circular com o mecanismo de envio. SessionManager e os transportes continuam responsáveis pela conexão e entrega; não conhecem os vínculos.

## Usar no painel

1. Abra **Vínculos de sessões**.
2. Escolha A (recebe), B (responde), texto recebido e resposta fixa.
3. Crie o vínculo desativado e confira a regra. Exemplo: A recebe `oi`; B envia `Olá!` ao contato que escreveu para A.
4. Ative o envio automático. O contato precisa estar cadastrado com consentimento, sem opt-out. B precisa estar conectada e dentro dos limites de envio.

As regras comparam o texto completo, ignorando maiúsculas e espaços nas bordas. Não encaminham mídia nem usam IA para gerar a resposta. Sem vínculo correspondente, o fluxo de sugestões de IA existente permanece. Quando há envio enfileirado pelo router, não se cria uma segunda sugestão para a mesma entrada.

## Proteções e limites

- Mensagens próprias, grupos e remetentes sem telefone identificável são ignorados pelo recebimento existente.
- O opt-out é processado antes do router. O consentimento é consultado antes de disparar e novamente pelo pipeline de envio.
- Mensagens provenientes de números cadastrados como sessões não disparam o router. Isso encerra os caminhos entre contas gerenciadas e evita ciclos. Mantenha os telefones das sessões corretos.
- A chave persistente `(link_id, inbound_id)` evita disparar a mesma regra duas vezes, inclusive entre processos. A reivindicação ocorre antes de enfileirar; uma queda nesse intervalo pode deixar uma execução `claimed` sem envio. Ela não é repetida automaticamente, para evitar duplicatas.
- `queued` indica enfileiramento, não entrega. A fila mantém o estado real da mensagem. Falhas mostram o código no painel.
- Desativar impede novos disparos observados após a alteração; não cancela mensagens já enfileiradas ou um processamento em curso.
- Vários vínculos correspondentes geram uma resposta por vínculo. Não configure regras duplicadas se não quiser respostas múltiplas.
- Reiniciar o serviço não reprocessa entradas antigas. As regras são lidas novamente a cada nova mensagem.
- Excluir um vínculo desativado também remove o histórico de execuções dele. A auditoria administrativa e as mensagens da fila permanecem.

## API e banco

Todas as rotas exigem a autenticação já existente:

- `GET /api/session-links`: vínculos.
- `POST /api/session-links`: `{ sourceSessionId, targetSessionId, rules: { matchText, replyText } }`; sempre cria desativado.
- `PATCH /api/session-links/:id`: `{ enabled: true | false }`.
- `DELETE /api/session-links/:id`: remove vínculo.
- `GET /api/session-links/runs`: últimas 100 execuções.

O banco recebe uma migração aditiva para `session_links` e `session_route_runs`. Ela é aplicada pelo mecanismo de migrações já usado na inicialização. Não é necessário recriar o banco.

## Validação local

Use `pnpm install --frozen-lockfile`, `pnpm typecheck` e `pnpm build`. Os testes do router são executados com `pnpm --filter @wsm/core exec vitest run src/session-router/router.unit.test.ts`. Neste ambiente, a instalação foi concluída com `--ignore-scripts` para manter bloqueados os scripts de instalação de dependências; a compilação e os testes com transporte simulado funcionaram assim. A conexão real com WhatsApp não foi testada.

Hono foi fixado em `4.13.8` na API e worker: a versão `4.13.9` do repositório original foi bloqueada pela política de idade mínima de publicação do ambiente. O lockfile mantém a integridade publicada da versão anterior; nenhuma política de segurança foi desativada.

Verificado nesta alteração: tipos dos cinco pacotes; compilação de banco, core, API, worker e painel; lint dos módulos novos e integração; 10 testes do router, 8 de recebimento no worker, 132 da API e 23 do cliente/roteamento do painel. Dois testes da API inicialmente falharam por ausência de Redis e passaram ao repetir com Redis isolado. As migrações foram aplicadas em bancos descartáveis. Um teste de navegador com API simulada verificou criação, ativação, desativação e exclusão do vínculo. Nenhuma sessão real foi conectada ou mensagem real enviada.
