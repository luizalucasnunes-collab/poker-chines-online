# Pôquer Chinês Online v2.3

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
