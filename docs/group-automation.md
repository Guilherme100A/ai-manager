# Entrada automática em grupos e mensagem diária

Na página **Grupos**, selecione uma conta e configure **Entrada automática e mensagem diária**. A ativação é individual e fica desativada por padrão. Informe os temas para a busca, o teto de entradas por 24 horas e, opcionalmente, outra sessão para receber os convites. Também é possível sortear outra conta com automação ativa.

## Limite é de entradas, não de mensagens recebidas

A regra usa o nível de warm-up e o fator de redução de saúde já existentes:

`limite de entradas = min(teto configurado, limite diário efetivo de envio, floor((dia de warm-up + 1) × fator efetivo))`

O dia de warm-up é contado a partir de zero. Com fator 1 e teto 5: dia inicial = 1 entrada por 24 horas, segundo dia = 2, terceiro = 3, até 5. Uma redução de saúde também pode reduzir esse número. Uma conta pausada, degradada ou desconectada não executa a rotina.

O contador usa uma janela móvel de 24 horas e é persistido no Redis com AOF. Reservas de tentativa são gravadas antes de aceitar convites para impedir que uma falha ou reinício gere várias entradas. Tentativas com resultado incerto também consomem a reserva; essa regra é conservadora. Nenhuma entrada é feita quando o número permitido já foi consumido.

**O volume de mensagens dos grupos não participa desse cálculo.** Não existe estimativa de 20 mensagens por grupo, limite sobre o total de grupos em que a conta participa, observação obrigatória por 24 horas nem saída automática de grupos. A rotina pode fazer outras entradas no mesmo dia enquanto houver vagas. O timer verifica as contas a cada minuto.

## Busca e entrada

O modelo usa somente `modelSmall` das configurações de IA do painel, sem promoção para o modelo grande. Faz uma pesquisa web, limitada a uma execução por chamada e ao domínio `chat.whatsapp.com`. Os candidatos são aceitos somente quando a URL apareceu nos resultados reais da ferramenta, além de passar pela validação do domínio HTTPS e do código. O Baileys consulta os metadados do convite antes de entrar. A pesquisa fica em cache por conta/tema por 24 horas; os grupos já gerenciados não são sorteados novamente desse cache.

O sistema não inventa convites: se a busca não encontrar um novo link público, informa isso e aguarda a renovação do cache. Alterar o tema ou reativar a automação renova a busca. É necessária uma chave Anthropic e a IA habilitada; a pesquisa web também precisa estar disponível para a chave/modelo selecionado.

Depois que A entra e a participação é confirmada, envia o convite no privado de B pela fila e pelo SendPipeline existentes. B deve ter automação ativa, estar conectada, ter uma vaga de entrada e não ser membro do grupo. Seu número precisa ser um contato autorizado para receber a mensagem privada. A não precisa ser admin: o link público encontrado é reutilizado e confirmado para aquele grupo.

B aceita somente o convite recebido de A durante esse fluxo. A entrada é confirmada pela lista de grupos; grupos que exigem aprovação ficam pendentes até a aprovação externa. Os grupos anteriores da conta não são alterados.

## Mensagem por dia

Para cada grupo confirmado e gerenciado pela rotina, o modelo pequeno gera uma mensagem curta sobre o nome, descrição e tema do grupo. Não lê conversas do grupo para gerar o texto. Varia o conteúdo em relação ao texto anterior e rejeita mensagens vazias, longas ou com links.

Há no máximo uma geração de texto por grupo/dia. A mensagem gerada é guardada: se os gates rejeitarem o envio por falta de capacidade, o próximo ciclo reaproveita o mesmo texto. Há uma reserva de envio por grupo/dia no fuso `America/Sao_Paulo`, persistida antes do enqueue. Uma falha incerta não provoca um segundo envio no mesmo dia. Isso pode fazer a mensagem daquele dia ser perdida em uma queda entre a reserva e o enqueue.

Se a mensagem anterior ainda estiver pendente, não empilha outra. Se uma mensagem antiga acabou de ser enviada no dia atual, ela já conta para esse dia. Os gates de warm-up e limites por minuto/hora/dia, a fila BullMQ e a entrega com antiban continuam sendo usados. Se o limite de envio da conta não permitir uma mensagem em todos os grupos, alguns envios serão adiados; o limite nunca é aumentado automaticamente.

Grupos em que somente admins podem escrever podem receber a conta, mas a rotina não posta neles se ela não for admin. A atividade recebida no grupo não interfere nos envios automáticos.

## API autenticada

- `GET /api/sessions/:id/groups/automation`: configurações, limite, contador de entradas/tentativas, grupos gerenciados e status.
- `PUT /api/sessions/:id/groups/automation`: `{ "enabled": true, "query": "jogos", "maxEntriesPerDay": 5, "targetSessionId": null }`.
- `POST /api/sessions/:id/groups/automation/run`: solicita um ciclo em segundo plano; responde `202` e respeita as mesmas vagas e cache.

Configurações e reservas ficam no Redis já existente, sem migrations adicionais. As ações são auditadas no banco, sem incluir os códigos de convite. Leases com renovação serializam operações entre workers. Testes usam modelo, transportes e armazenamento falsos; não entram nem enviam mensagens no WhatsApp real.
