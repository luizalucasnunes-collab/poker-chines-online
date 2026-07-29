# Pôquer Chinês Online v2.6

Jogo multiplayer online para quatro jogadores, com salas públicas, partidas privadas, bots e pontuação em blocos de quatro rodadas.

## Inteligência dos bots redesenhada

### Médio

- Preserva duplas, trincas e jogos de cinco cartas.
- Evita desmontar combinações para baixar uma carta isolada.
- Economiza Ás e 2 quando não existe perigo imediato.
- Procura reduzir o número de turnos necessários para terminar.

### Difícil

- Analisa a organização exata da mão restante.
- Compara diferentes rotas para terminar em menos jogadas.
- Considera a quantidade de cartas de cada adversário.
- Evita abrir o mesmo tipo de jogo que permitiria ao próximo jogador bater.
- Pode passar quando gastar uma combinação forte seria pior que preservar a mão.

### Especialista

- Usa todas as regras dos níveis anteriores.
- Simula distribuições possíveis das cartas desconhecidas sem consultar as mãos reais.
- Estima a chance de cada combinação manter o controle da mesa.
- Quando alguém está com poucas cartas, usa jogadas maiores e mais fortes para bloquear.
- Na jogada que bate e nas últimas jogadas da rodada, prioriza combinações fortes para impedir que os adversários descartem cartas.
- Considera a pontuação acumulada e joga de forma mais agressiva próximo dos 31 pontos.

Os bots utilizam somente as próprias cartas e informações públicas: cartas já jogadas, quantidade de cartas, pontuação e ordem dos jogadores. Eles não enxergam as cartas escondidas dos adversários.

## Regras principais

- Ordem das cartas: 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K, A e 2.
- Ordem dos naipes para cartas, duplas e desempates aplicáveis: Ouros, Copas, Espadas e Paus.
- Jogos de cinco cartas: Sequência, Flush, Full House, Quadra + carta e Sequência do mesmo naipe.
- O Flush é avaliado somente pela maior carta; o naipe não altera seu valor.
- O anfitrião escolhe 30 ou 60 segundos por jogada.
- No modo por pontos, cada carta restante vale um ponto.
- Os totais são conferidos a cada bloco de quatro rodadas; se ninguém atingir 31, outro bloco começa mantendo os pontos.

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

Depois faça o commit na branch `main`. O Render deverá publicar automaticamente.

## Render

Build Command:

```bash
corepack enable && corepack prepare yarn@1.22.22 --activate && yarn install --production --non-interactive --network-timeout 600000
```

Start Command:

```bash
node server.js
```

Variável de ambiente:

```text
NODE_VERSION=24.17.0
```

## Teste do servidor

```text
/health
```

Resultado esperado:

```json
{"ok":true,"version":"2.6.0"}
```

- Organização visual da mão por números ou por naipes.
