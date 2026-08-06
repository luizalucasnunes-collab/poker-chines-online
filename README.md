# Pôquer Chinês Online v4.2

Versão completa preparada para funcionar online sem mensalidade usando:

- **Render Free Web Service** para Node.js, Express e Socket.IO;
- **Neon Free PostgreSQL** para usuários, partidas e rankings persistentes;
- **GitHub** para versionamento e deploy automático.

## Variáveis obrigatórias no Render

```text
DATABASE_URL
SESSION_SECRET
ONLINE_ONLY=true
NODE_ENV=production
```

## Comandos

```text
Build Command: npm ci --omit=dev
Start Command: node server.js
Health Check: /health
```

## Resultado esperado do health check

```json
{
  "ok": true,
  "version": "4.2.0",
  "hosting": "render-free",
  "storage": {
    "backend": "postgres",
    "persistent": true,
    "configured": true
  }
}
```

O servidor cria automaticamente as tabelas necessárias no primeiro início.
