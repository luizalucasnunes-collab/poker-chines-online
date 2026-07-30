# Pôquer Chinês Online v2.5

Jogo multiplayer online para quatro jogadores, com salas públicas, partidas privadas e bots inteligentes.

## Bots médio e difícil

### Médio

- Preserva duplas, trincas e jogos de cinco cartas.
- Avalia quantas jogadas ainda precisa para terminar.
- Economiza Ás e 2 quando não há perigo imediato.
- Fica mais agressivo quando um adversário está perto de bater.
- Prioriza reduzir as cartas na jogada final.

### Difícil

- Usa planejamento por combinações da mão restante.
- Estima o menor número de turnos para terminar.
- Analisa as cartas já jogadas para valorizar cartas de controle.
- Pode passar estrategicamente para não destruir uma mão forte.
- Ajusta a agressividade conforme a pontuação e o risco dos adversários.
- Escolhe entre decisões equivalentes para não ficar previsível.

A inteligência usa apenas informações públicas sobre os adversários: quantidade de cartas, jogadas e passes. O bot não consulta as cartas escondidas dos outros jogadores.

## Atualização no GitHub

Envie todo o conteúdo desta pasta para a raiz do repositório:

```text
public/
  app.js
  index.html
  style.css

server.js
package.json
package-lock.json
render.yaml
README.md
.gitignore
```

Depois faça um commit na branch `main`. O Render deverá publicar automaticamente.

## Render

Build Command:

```bash
corepack enable && corepack prepare yarn@1.22.22 --activate && yarn install --production --non-interactive --network-timeout 600000
```

Start Command:

```bash
node server.js
```

Variável:

```text
NODE_VERSION=24.17.0
```

## Relógio por jogada

Antes de iniciar, o anfitrião escolhe **30 ou 60 segundos** para cada jogada. O contador é controlado pelo servidor e aparece para todos os jogadores.

- Com uma jogada na mesa, o fim do tempo gera um passe automático.
- Com a mesa livre, o sistema baixa automaticamente a combinação válida mais econômica para evitar que a partida fique travada.
- Se alguém desconectar, a partida e o relógio ficam pausados; ao reconectar, o jogador recebe um novo tempo completo.
- Os últimos 10 segundos aparecem em alerta, e os últimos 5 segundos ficam destacados em vermelho.


## Novidades da versão 2.5

- Nível de bot **Especialista**, com análise da estrutura da mão e risco dos adversários.
- Flush comparado primeiro pelo naipe e depois pela maior carta.
- A dica destaca as cartas temporariamente e depois as abaixa.
- Todos os jogadores humanos podem confirmar a próxima rodada ou revanche; ela começa quando todos estiverem prontos.

## Novidades da versão 2.6

- A combinação **J-Q-K-A-2** deixou de ser reconhecida como sequência.
- A maior sequência permitida é **10-J-Q-K-A**.
- A correção vale para jogadores, bots, dicas e jogadas automáticas por tempo esgotado.
- Caso J-Q-K-A-2 seja do mesmo naipe, continua sendo um **Flush**, mas não uma Sequência do mesmo naipe.

