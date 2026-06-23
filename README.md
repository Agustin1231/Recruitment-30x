# Recruitment 30X

Interfaz web del agente conversacional de onboarding de **30X** (alias *Rocky 30x*), construido como prueba técnica del programa Tech Volunteer.

El agente responde preguntas sobre la organización consultando una base de conocimiento vectorial (RAG sobre documentos internos). La página incluye el chat, un panel de administración para alimentar y auditar esa base, y plantillas auxiliares. Estética de marca: negro + acento lima-amarillo.

URL en producción: https://recruitment-30x.agustinynatalia.site

## Contenido del repo

| Ruta | Qué es |
|---|---|
| `index.html` | Landing + consola de chat (respuesta en streaming) + panel **Administrar** (login, subir PDFs, ver la base vectorial). |
| `server/server.js` | Backend Node sin dependencias de framework: sirve los estáticos del repo y expone `/api/docs`, que lee la base vectorial (Postgres + pgvector) y la devuelve como JSON. |
| `server/.env.example` | Plantilla de variables de entorno (credenciales reales NUNCA se versionan). |
| `package.json` (raíz) | Define `npm start` → `node server/server.js`. Habilita el build Node de Coolify (nixpacks). |
| `templates/asesor-standalone.html` | Consola de chat autocontenida para copiar/pegar. |
| `templates/email-asesor.html` | Plantilla de email HTML (Gmail) para el "Asesor". |

## Arquitectura

La página es estática, pero la lógica vive en dos backends:

```
                 ┌─────────────────────────── navegador (index.html) ───────────────────────────┐
                 │  chat            subir PDF                 ver base vectorial                  │
                 └────┬────────────────┬─────────────────────────────┬──────────────────────────-┘
                      │                │                             │
            webhook n8n        webhook n8n                   /api/docs (mismo origen)
        (respuesta streaming)  (parseo + embeddings)        server/server.js (Node)
                      │                │                             │
                      ▼                ▼                             ▼
              flujo "Recruitment 30x" en n8n           ┌──────────────────────────────┐
              (RAG: base_conocimiento / team_humano)   │ Postgres + pgvector (vectordb)│
                      │                │               │      tabla  n8n_vectors        │
                      └───── embeddings + retrieve ─────┤  (text-embedding-3-small,      │
                                                        │   1536 dimensiones)            │
                                                        └──────────────────────────────┘
```

| Acción | Camino |
|---|---|
| Chatear con el agente | navegador → webhook n8n `…/webhook/d7ed99fa-…` (respuesta en streaming) |
| Subir PDF a la base | navegador → webhook n8n `…/webhook/subir-pdf-30x` (multipart, campo `data`) → extrae texto → embeddings → INSERT en `n8n_vectors` |
| Ver la base vectorial | navegador → `/api/docs` (mismo origen) → `server.js` → SELECT sobre `n8n_vectors` |

### Backend de lectura (`server/server.js`)

- Sirve el sitio estático (todo el repo) y, en `/api/docs`, devuelve los documentos de la tabla vectorial.
- Introspecciona el esquema `public` para localizar la tabla con columna `vector` (pgvector) y deduce las columnas de id, contenido y metadata. No asume nombres fijos.
- Las credenciales se leen de variables de entorno, nunca del HTML ni del repo.
- Protección contra path traversal al servir archivos estáticos.

## Variables de entorno

| Variable | Descripción |
|---|---|
| `PGHOST` | Host de Postgres con pgvector. |
| `PGPORT` | Puerto (la instancia de la prueba usa `5434`). |
| `PGDATABASE` | Base de datos (`vectordb`). |
| `PGUSER` / `PGPASSWORD` | Credenciales de conexión. |
| `PGSSL` | `true`/`false`. |
| `PORT` | Puerto en el que escucha el servidor (default `8787`; en el deploy de Coolify es `80`). |

## Correr en local

```bash
cp server/.env.example server/.env   # completá las credenciales reales
cd server && npm install && cd ..
PORT=8787 node --env-file=server/.env server/server.js
# → http://localhost:8787  (página) y  http://localhost:8787/api/docs  (base vectorial)
```

> `server/.env` está ignorado por git: las credenciales NUNCA se suben al repo.

## Despliegue (Coolify)

La app corre como un único servicio Node en Coolify (build pack `nixpacks`), de modo que el mismo contenedor sirve la página y `/api/docs` en el mismo origen.

- El `package.json` de la raíz (`start: node server/server.js`) es lo que dispara el build de Node.
- Las variables de entorno (`PG*`, `PORT`) se configuran en el panel de Coolify, no en el repo.
- `PORT` debe coincidir con el puerto al que rutea Traefik. En este deploy es `80`.
- Push a `main` dispara el redeploy automático por webhook.
