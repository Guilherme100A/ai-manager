# Convite entre sessões

Na página **Grupos**, selecione a sessão A, marque os grupos que poderão participar do sorteio, escolha a sessão B e clique em **Enviar convite e entrar**.

O worker sorteia um grupo entre os selecionados em que A é admin e B ainda não participa. A obtém o link de convite e envia uma mensagem privada para B pela fila e pelo SendPipeline existentes. Depois que B recebe exatamente esse link de A, B aceita o convite no WhatsApp. O painel confirma a entrada pela lista de grupos de B ou informa que ela aguarda confirmação/aprovação.

As duas sessões precisam estar conectadas e em WARMING/STABLE, com números diferentes. B precisa ser um contato autorizado no sistema: os limites de envio, opt-out, warm-up e antiban continuam valendo.

Cada clique executa um único fluxo. Não há agendamento nem aceite de convites recebidos fora desse fluxo. O sorteio exclui grupos em que A não é admin, grupos fora da seleção e grupos onde B já é membro. Não altera a privacidade da conta e não remove grupos existentes.

O recebimento tem prazo de 30 segundos. Ao expirar, o sistema não aceita o convite e tenta cancelar a mensagem ainda pendente. Uma mensagem que já esteja em processamento pode acabar sendo enviada depois; isso não provoca entrada tardia. O listener temporário é removido em sucesso ou falha.

A auditoria registra início e resultado, sem copiar o código de convite. Há bloqueio de concorrência e intervalo de 60 segundos por sessão após cada tentativa; esse intervalo fica em memória e reinicia com o worker. Aprovação exigida pelo próprio grupo continua dependendo do WhatsApp/admin.

API autenticada:

```http
POST /api/sessions/:sourceSessionId/groups/invite-flow
Authorization: Bearer <token>
Content-Type: application/json

{"targetSessionId":"<uuid de B>","groupIds":["<jid do grupo>@g.us"]}
```

Resposta: `groupId`, `targetSessionId`, `messageId` e `result` (`joined` ou `awaiting_confirmation`). O FakeTransport padrão não aceita convites; os testes injetam métodos de convite e recebimento sem acessar o WhatsApp real.
