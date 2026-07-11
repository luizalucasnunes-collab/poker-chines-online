# Pôquer Chinês Online

Jogo multiplayer online para **quatro pessoas**, com 13 cartas para cada jogador.

## Recursos

- Salas privadas com código de cinco caracteres.
- Link de convite.
- Quatro jogadores reais.
- Servidor controla e valida as cartas.
- Reconexão após atualizar a página ou perder a internet.
- Partida pausada enquanto alguém estiver desconectado.
- Revanche com os mesmos jogadores.
- Interface para computador e celular.
- Regra inicial obrigatória com o 3 de Ouros.

## Rodar no computador para testar

Instale o Node.js 20 ou superior.

No terminal, dentro da pasta do projeto:

```bash
npm install
npm start
```

Abra:

```text
http://localhost:3000
```

Para simular quatro jogadores no mesmo computador, abra uma janela normal, uma janela anônima e outros navegadores/perfis.

## Publicar no Render

1. Crie um repositório no GitHub.
2. Coloque todos os arquivos deste projeto no repositório.
3. No Render, escolha **New > Blueprint** e conecte o repositório.
4. O arquivo `render.yaml` configurará o serviço.
5. Após a publicação, o Render fornecerá um endereço público.
6. Abra esse endereço, crie a sala e envie o convite aos outros jogadores.

Também é possível criar um **Web Service** manualmente:

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

## Observações

- As salas ficam apenas na memória do servidor.
- Se o serviço for reiniciado, as salas ativas são encerradas.
- O projeto foi preparado para uma única instância de servidor.
- Para escalar para várias instâncias, use um armazenamento compartilhado e um adaptador do Socket.IO, como Redis.
