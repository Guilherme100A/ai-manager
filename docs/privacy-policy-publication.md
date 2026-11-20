# Política de Privacidade pública do AI-Manager

O texto público está em `apps/dashboard/public/privacidade.html` e usa o contato confirmado `tuskelegalrosa@gmail.com`. Ele identifica o serviço pelo nome AI-Manager, descreve os papéis de controlador e operador conforme o uso, as categorias de dados e fornecedores, os critérios de retenção e os direitos dos titulares. Não contém CNPJ, razão social, prazo numérico ou fornecedor nominal não confirmado.

## Limite de identidade a revisar

O usuário ainda não informou o nome civil ou a razão social do responsável pela operação do serviço. A página usa **AI-Manager como identificação pública** e disponibiliza o e-mail confirmado. Isso não deve ser confundido com a identificação civil do controlador. Antes da publicação, o operador responsável deve decidir se o contexto exige acrescentar sua identificação legal; não criar esse dado por inferência.

## Verificações antes de fornecer a URL à Meta

- Conferir que o HTML não tem campos provisórios, banner de rascunho, segredos ou scripts externos.
- Rodar o teste Playwright em navegador separado, desktop e celular, no CI.
- Depois do deploy, conferir `https://<domínio-público>/privacidade.html` sem login, com `Content-Type: text/html`, conteúdo da política (não o fallback da SPA) e acesso via navegador.
- Conferir a data de atualização e o canal público após qualquer revisão factual.
- Configurar a URL pública no app da Meta e refazer o OAuth do Admin 2. A política por si só não garante aprovação/publicação do app nem acesso a contas e pixels.
- Testar um evento Purchase somente com autorização específica e mecanismo de teste; não criar compra, cobrança ou evento real para validar a política.

Referências de redação: [LGPD, arts. 9º e 18](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm), [guia da ANPD sobre controlador e operador](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/Segunda_Versao_do_Guia_de_Agentes_de_Tratamento_retificada.pdf/%40%40display-file/file) e [transferência internacional](https://www.gov.br/anpd/pt-br/assuntos/assuntos-internacionais/transferencia-internacional-de-dados).
