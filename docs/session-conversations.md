# Conversas entre contas selecionadas

No detalhe de cada conta participante, abra **Conversas entre contas**, escolha **Rodízio automático**, informe o tema e salve com as conversas ativas. Autorize os números em Contatos, conecte as sessões e habilite a IA com uma chave válida. Cada conta participa de uma conversa por vez.

Com `CONVERSATIONS_AUTO_ROTATE=true` (padrão do compose), toda conta que nunca salvou essa configuração já entra no rodízio com os valores padrão: basta conectar e autorizar os números em Contatos. Para tirar uma conta, desative e salve no painel. Com `false`, só participam as contas ativadas manualmente.

Configurações antigas continuam como pares fixos até o operador escolher rodízio. No modo fixo, basta selecionar a outra conta em uma sessão, sem criar vínculo inverso. Um par fixo ativo reserva suas duas contas e não participa do rodízio.

## Distribuição dos pares

Antes de verificar os envios, o worker reúne contas habilitadas para rodízio, conectadas, em WARMING/STABLE, autorizadas e com cota própria disponível. Exclui contas ocupadas, interrompidas ou na pausa entre rodadas. Ordena pela última formação de par, colocando primeiro quem nunca participou ou está esperando há mais tempo. Escolhe um parceiro diferente do anterior quando houver alternativa para os dois lados.

Com três contas, A/B podem iniciar enquanto C aguarda. Após a rodada e a pausa, C ganha prioridade e conversa com A ou B. Com quatro contas, o sistema pode formar A/B e C/D e depois A/C e B/D. Não garante ordem exata quando disponibilidade, cotas ou pausas diferirem.

O par e a reserva da outra conta ficam no Redis. Reinícios preservam uma conversa pendente. O parceiro só muda ao concluir a rodada ou interrompê-la sem mensagem pendente; não há redistribuição durante um envio sem confirmação. O tema é o da conta que iniciou a rodada. O par usa o menor teto de falas por rodada e o maior intervalo configurado entre as duas contas. Cada participante conserva seu próprio teto diário.

Os padrões são 20 envios por conta nas últimas 24 horas, seis falas por rodada (somando A e B), cinco minutos de intervalo depois do recebimento confirmado e 30 minutos entre rodadas. Esses valores são configuráveis, exceto a pausa entre rodadas. O ciclo é verificado a cada minuto; executar agora verifica as condições, sem ignorar a espera ou os limites.

## Caminho de uma fala

1. O worker verifica ativação, conexão, estado WARMING/STABLE, autorização dos dois contatos e cotas das duas contas.
2. O modelo pequeno gera a próxima fala usando o tema e até dez falas anteriores. Sem pesquisa web, escalada para modelo grande ou respostas automáticas a clientes.
3. O estado reserva a fala no Redis antes do envio. O SendPipeline aplica seus gates normais e enfileira no MessageQueue/BullMQ. A entrega segue o caminho existente de transporte e antiban.
4. A próxima fala só é autorizada quando a mensagem estiver enviada e houver uma mensagem inbound persistida na sessão destinatária, vinda do número remetente, com o mesmo texto e criada após a reserva. Recibos de envio sozinhos não autorizam resposta.
5. Após confirmação, o turno muda para a outra conta. Ao terminar a rodada, o par espera 30 minutos. O histórico da rodada é então limpo.

Uma fala esperada deste fluxo é persistida e passa pelo opt-out antes de ser consumida pela automação. Ela não vira sugestão de IA ou resposta do roteador. Outras mensagens continuam seguindo o tratamento existente. Identificadores LID com telefone alternativo usam `fromAlt` para reconhecer o número real.

## Cotas e maturação

Não existe cota extra de aquecimento: mensagens privadas, convites, mensagens nos grupos e estas conversas compartilham os limites por minuto, hora e dia. Para conversar, vale o menor entre o teto configurado e o limite diário efetivo da conta. A automação não tenta completar obrigatoriamente a cota e interrompe a geração quando qualquer participante fica sem capacidade. O teto padrão de 20 precisa ser aumentado no painel se o operador desejar acompanhar limites de maturação maiores.

O recurso não acelera o cronograma de sete dias, não altera o score e não garante confiança ou ausência de bloqueios no WhatsApp. Entradas em grupos continuam usando sua cota separada de entradas.

## Persistência e falhas

Configuração, parceiro atual, última formação de par, histórico limitado, rascunho, próxima execução e mensagem pendente ficam no Redis (AOF do compose). Uma reserva global serializa os pares e as configurações. Ela é renovada antes do enqueue; uma execução que perdeu a reserva não envia.

Reinícios aguardam a mensagem pendente em vez de gerar outra. Rejeição explícita de um gate reaproveita o rascunho no próximo intervalo. Resultado incerto, falha/cancelamento da fila ou duas horas sem confirmação interrompem o par. Depois de resolver uma mensagem conhecida na fila, desativar e reativar o par permite uma nova rodada sem reenviar a fala antiga. Se uma queda ocorrer entre a reserva e a gravação do identificador da mensagem, a recuperação automática é bloqueada: requer análise do histórico de envios. Essa escolha pode perder uma fala, mas evita repetições automáticas.

Desativar impede novos enqueues; mensagens que já estão na fila seguem seus controles de cancelamento existentes. Pausar a sessão também aplica os controles existentes da sessão/fila.

## API autenticada

- `GET /api/sessions/:id/conversation`: configuração, estado e cotas.
- `PUT /api/sessions/:id/conversation`: `{ mode: "rotating" | "fixed", enabled, targetSessionId, topic, maxMessagesPerDay, turnsPerConversation, intervalMinutes }`.
- `POST /api/sessions/:id/conversation/run`: solicita verificação em segundo plano (202).

Configurações e enqueues são auditados. Nenhuma nova chamada direta a `sendMessage` foi criada. A API acessa o worker pela ponte interna autenticada, com lista fechada de métodos.

## Verificação

Testes com modelo e fila simulados verificam distribuição com três/quatro contas, troca de parceiros, prioridade de espera, cotas próprias, compatibilidade dos pares fixos e alternância condicionada ao inbound, espera entre falas/rodadas, bloqueio por limite/estado/consentimento, restart, concorrência, perda de reserva, rejeições e falhas. Não executam conversas reais nem chamadas pagas.
