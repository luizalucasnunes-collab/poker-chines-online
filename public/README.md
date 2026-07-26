# Pôquer Chinês Online v2.1

Jogo multiplayer online para quatro jogadores, com salas públicas, bots e partidas por pontos.

## Regras de pontuação

- Cada rodada começa com 13 cartas por jogador.
- Quando alguém bate, os outros três jogadores têm uma última oportunidade, em ordem, para jogar uma combinação superior ou passar.
- A rodada só termina depois dessas três jogadas finais.
- Cada jogador soma a quantidade de cartas que restou em sua mão.
- A pontuação é conferida ao final de cada bloco de 4 rodadas.
- Se alguém tiver 31 pontos ou mais, essa pessoa perde e a partida termina.
- Se ninguém atingir 31, começa outro bloco de 4 rodadas, mantendo os pontos acumulados.
- O objetivo é permanecer com a menor pontuação.

## Publicação

Build Command:

```bash
corepack enable && corepack prepare yarn@1.22.22 --activate && yarn install --production --non-interactive --network-timeout 600000
```

Start Command:

```bash
node server.js
```
