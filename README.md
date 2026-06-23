# Recruitment 30X

Interfaz para administrar el agente de IA de **30X** (alias *Rocky 30x*). Estética de marca: negro + acento lima-amarillo.

## Qué incluye

- **`index.html`** — Landing + consola de chat para conversar con el agente (streaming), y un panel **Administrar** para gestionar la base de conocimiento (subir PDFs y ver la base vectorial).
- **`templates/`** — Variantes generadas: una consola standalone para copiar/pegar y una plantilla de email HTML (Gmail) para el "Asesor".
- **`server/`** — Backend local mínimo que lee la base vectorial (Postgres + pgvector) y la sirve al panel.

## Arquitectura

| Acción | Camino |
|---|---|
| Chatear con el agente | navegador → webhook n8n (respuesta en streaming) |
| Subir PDF a la base | navegador → webhook n8n → embeddings → `vectordb` |
| Ver la base vectorial | navegador → backend local (`server/`) → Postgres `vectordb` |

## Correr el backend

```bash
cd server
cp .env.example .env   # completá las credenciales reales
npm install
npm start              # http://localhost:8787/api/docs
```

> Las credenciales viven en `server/.env` (ignorado por git), nunca en el HTML.
