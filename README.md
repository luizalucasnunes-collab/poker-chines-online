# Pôquer Chinês Online — v5.0

## Identidade visual aprovada

Direção Bauhaus / modernista com três cores principais:

- Vermelho: `#D41C1C`
- Preto carvão: `#292727`
- Creme quente: `#EEE0C6`

Tipografia:
- Montserrat: títulos e destaques
- Inter: textos, controles e dados

Princípios:
- fundo escuro contínuo;
- geometria modular;
- ausência de sombras;
- contornos finos;
- vermelho usado como ação/destaque;
- cartas J/Q/K/A com figuras geométricas abstratas, sem personagens da família real;
- ♠ e ♣ permanecem pretos nas cartas claras;
- ♦ e ♥ permanecem vermelhos.

## Regras consolidadas

- 4 jogadores, 13 cartas por jogador.
- Ordem: 3 < 4 < 5 < 6 < 7 < 8 < 9 < 10 < J < Q < K < A < 2.
- O portador do 3♦ inicia e a primeira jogada deve conter o 3♦.
- Jogadas: carta, dupla, trinca ou combinação de cinco cartas.
- Cinco cartas: Sequência < Flush < Full House < Quadra + carta < Sequência do mesmo naipe.
- Flush é comparado somente pelos valores das cartas, da maior para a menor. Naipe não desempata Flush.
- 2-3-4-5-6 é uma sequência válida e é a sequência mais forte.
- 10-J-Q-K-A é a maior sequência normal.
- J-Q-K-A-2 é proibida como sequência.
- Depois da batida, os outros três jogadores possuem exatamente uma última oportunidade em ordem para jogar ou passar.
- No modo por pontos, cada carta restante vale 1 ponto.
- A conferência é feita em blocos de 4 rodadas.
- Se ninguém atingir 31 pontos ao fim do bloco, outro bloco de 4 começa mantendo o acumulado.
- Ao atingir o limite, maior total perde e menor total vence.
- Cronômetro configurável em 30 ou 60 segundos.
- Bots Médio, Difícil e Especialista.
- Revanche depende da confirmação dos jogadores humanos.

## Usuários e ranking

- Cadastro e login persistentes em PostgreSQL/Neon.
- Ranking separado entre Partidas Únicas e Blocos de 4.
- Cada vitória cadastrada vale 1 ponto na modalidade correspondente.
- Bots não entram no ranking de usuários.

## Hospedagem

Preparado para:
- Render Free Web Service
- Neon PostgreSQL
- GitHub

Variáveis:
- `DATABASE_URL`
- `SESSION_SECRET`
- `ONLINE_ONLY=true`
- `NODE_ENV=production`

Build:
`npm ci --omit=dev`

Start:
`node server.js`

Health:
`/health`
