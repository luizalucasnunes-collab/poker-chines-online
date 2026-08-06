# Pôquer Chinês Online v3.1

## Alterações principais

- O **Flush é comparado somente pelos valores das cartas**, começando pela maior.
- O naipe não é usado para desempatar Flushes.
- O chat e seu botão foram removidos.
- Interface inicial, sala de espera, mesa, cartas, botões, modais e versão móvel foram redesenhados.
- Mantidos os bots Médio, Difícil e Especialista corrigidos.
- Mantidos o relógio de 30 ou 60 segundos, a dica temporária, a revanche coletiva e a organização da mão.
- A sequência J-Q-K-A-2 permanece proibida.

## Regra de comparação do Flush

As cinco cartas são ordenadas da maior para a menor. A comparação ocorre nesta ordem:

1. maior carta;
2. segunda maior;
3. terceira maior;
4. quarta maior;
5. menor carta.

O naipe não interfere. Se dois Flushes tiverem exatamente os mesmos valores, eles têm a mesma força.

## Render

Build Command:

```text
corepack enable && corepack prepare yarn@1.22.22 --activate && yarn install --production --non-interactive --network-timeout 600000
```

Start Command:

```text
node server.js
```

Health check:

```text
/health
```
