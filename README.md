# Pôquer Chinês Online v4.3

## Alterações visuais

- **Montserrat** aplicada aos títulos, números de seção e destaques.
- **Inter** aplicada aos textos, formulários, botões e interface.
- Escala tipográfica ampliada e reorganizada para desktop e celular.
- Verso das cartas substituído pelo **símbolo vermelho central da primeira página do PDF enviado**.
- O símbolo foi extraído com fundo transparente e aplicado sobre carta marfim, com borda vermelha.
- Naipes vermelhos continuam vermelhos; espadas e paus continuam pretos.

## Hospedagem

Mantém a arquitetura gratuita:

- Render Free para o servidor online;
- Neon PostgreSQL para usuários e rankings;
- GitHub para o código.

## Atualização

Envie todos os arquivos deste pacote para o mesmo repositório já conectado ao Render. O endereço online permanece o mesmo.

Build Command: `npm ci --omit=dev`

Start Command: `node server.js`

Health Check: `/health`
