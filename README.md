# Pôquer Chinês Online v3.0

## Bots revisados

- **Médio:** usa planejamento da mão, preserva combinações e sempre joga a melhor opção legal em vez de passar aleatoriamente.
- **Difícil:** calcula a melhor divisão completa da mão e só passa quando preservar a estrutura é realmente superior.
- **Especialista:** acrescenta contagem de cartas públicas e simulações das distribuições possíveis, sem enxergar mãos escondidas.
- Todos os níveis respeitam o 3♦ inicial, J–Q–K–A–2 proibida, Flush por naipe, batida, relógio e pontuação.

- Bot Especialista refeito com planejamento exato da mão, decisão estratégica de passe e estimativa pública de controle da mesa.

- Organização pessoal da mão por número ou por naipe, com preferência salva no navegador.
Jogo multiplayer online para quatro jogadores, com salas públicas ou privadas, bots inteligentes, relógio por jogada, pontuação por blocos e chat dentro da sala.

## Chat da sala

- Disponível na sala de espera, durante a partida e entre rodadas.
- O botão **Chat** permanece no canto inferior direito.
- Mensagens novas aparecem em um contador quando o painel está fechado.
- As últimas 100 mensagens ficam disponíveis enquanto a sala existir.
- Cada mensagem aceita até 280 caracteres.
- O servidor limita envios muito rápidos para evitar spam.
- Somente jogadores humanos que estão na sala podem enviar mensagens.
- O histórico continua durante as rodadas, blocos e revanches da mesma sala.

## Regras e recursos principais

- 4 jogadores, usando as 52 cartas.
- Ordem das cartas: 3 até 2.
- Ordem dos naipes: ♦ Ouros, ♥ Copas, ♠ Espadas e ♣ Paus.
- O Flush é comparado primeiro pelo naipe e depois pela maior carta.
- A sequência J-Q-K-A-2 é proibida; a maior sequência é 10-J-Q-K-A.
- Bots Médio, Difícil e Especialista.
- Tempo de 30 ou 60 segundos por jogada.
- Dica temporária que levanta e depois abaixa as cartas.
- Confirmação coletiva para próxima rodada, próximo bloco ou revanche.

## Estrutura do projeto

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
