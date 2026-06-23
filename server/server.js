// ════════════════════════════════════════════════════════════════
//  Backend mínimo: lee la base vectorial de 30X (Postgres + pgvector)
//  y la sirve al panel de administración de index.html.
//
//  Las credenciales se leen de variables de entorno (server/.env),
//  NUNCA del HTML ni hardcodeadas en el repo.
//  Uso:  cp .env.example .env  →  npm start
//        (npm start corre: node --env-file=.env server.js)
//        http://localhost:8787/api/docs
// ════════════════════════════════════════════════════════════════
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { Readable } = require("stream");

// Raiz del sitio estatico (el repo): server.js vive en server/, los estaticos un nivel arriba.
const STATIC_ROOT = path.resolve(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.normalize(path.join(STATIC_ROOT, rel));
  // Proteccion contra path traversal: el archivo debe quedar dentro de STATIC_ROOT.
  if (!filePath.startsWith(STATIC_ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

const DB = {
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || "5432", 10),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === "true"
};
const PORT = parseInt(process.env.PORT || "8787", 10);

// ── Proxy del webhook de mensajes de n8n ──────────────────────────
//  La credencial del Basic Auth vive SOLO acá, en variables de entorno
//  (server/.env, ignorado por git). El frontend ya NO la lleva: llama a
//  /api/chat y este backend le agrega el Authorization y reenvía a n8n.
//  Cloudflare está delante de n8n y bloquea User-Agents no-navegador
//  (responde "error 1010"), por eso mandamos un UA de navegador.
const N8N = {
  url:  process.env.N8N_WEBHOOK_URL  || "https://n8n.agustinynatalia.site/webhook/d7ed99fa-1b54-4d0e-abfe-7c69b9960b7e",
  user: process.env.N8N_WEBHOOK_USER || "",
  pass: process.env.N8N_WEBHOOK_PASS || ""
};
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

if (!DB.host || !DB.user || !DB.password || !DB.database) {
  console.error("Faltan credenciales. Copiá server/.env.example a server/.env y completalo.");
  process.exit(1);
}

const pool = new Pool({ ...DB, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000 });

// Preferencias para detectar columnas (pgvector / LangChain / n8n).
const CONTENT_PREF = ["text", "content", "document", "page_content", "pagecontent", "chunk", "body"];
const META_PREF    = ["metadata", "cmetadata", "meta"];
const ID_PREF      = ["id", "uuid", "pk"];

let schema = null; // { table, idCol, contentCol, metaCol }

function quote(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function introspect() {
  const { rows } = await pool.query(`
    SELECT table_name, column_name, udt_name, data_type, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  const tables = {};
  for (const r of rows) (tables[r.table_name] = tables[r.table_name] || []).push(r);

  // 1) tabla con una columna de tipo vector (pgvector)
  let chosen = null;
  for (const [t, cols] of Object.entries(tables)) {
    if (cols.some(c => c.udt_name === "vector")) { chosen = { t, cols }; break; }
  }
  // 2) fallback: tabla con jsonb + columna de texto
  if (!chosen) {
    for (const [t, cols] of Object.entries(tables)) {
      const hasJson = cols.some(c => c.udt_name === "jsonb" || c.udt_name === "json");
      const hasText = cols.some(c => c.data_type === "text" || c.data_type.includes("character"));
      if (hasJson && hasText) { chosen = { t, cols }; break; }
    }
  }
  if (!chosen) throw new Error("No encontré una tabla vectorial en el esquema 'public'.");

  const names = chosen.cols.map(c => c.column_name);
  const lower = names.map(n => n.toLowerCase());
  const pick = (prefs) => {
    for (const p of prefs) { const i = lower.indexOf(p); if (i >= 0) return names[i]; }
    return null;
  };
  const idCol = pick(ID_PREF) || names[0];
  const metaCol = pick(META_PREF);
  let contentCol = pick(CONTENT_PREF);
  if (!contentCol) {
    const textCol = chosen.cols.find(c =>
      (c.data_type === "text" || c.data_type.includes("character")) &&
      c.column_name !== idCol && c.column_name !== metaCol);
    contentCol = textCol ? textCol.column_name : null;
  }
  schema = { table: chosen.t, idCol, contentCol, metaCol };
  console.log("→ tabla vectorial:", schema.table,
    "| id:", schema.idCol, "| contenido:", schema.contentCol, "| metadata:", schema.metaCol);
  return schema;
}

async function fetchDocs(limit) {
  if (!schema) await introspect();
  const cols = [quote(schema.idCol) + " AS id"];
  cols.push((schema.contentCol ? quote(schema.contentCol) : "''") + " AS content");
  cols.push((schema.metaCol ? quote(schema.metaCol) + "::text" : "NULL") + " AS metadata");
  const sql = `SELECT ${cols.join(", ")} FROM ${quote(schema.table)} LIMIT $1`;
  const { rows } = await pool.query(sql, [limit]);
  return rows.map(r => {
    let source = "—";
    if (r.metadata) {
      try {
        const m = JSON.parse(r.metadata);
        source = m.source || m.title || m.file || m.filename || m.blobType || "—";
      } catch (e) { /* metadata no-JSON */ }
    }
    return { id: r.id, content: r.content || "", source, created: "" };
  });
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Private-Network": "true"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  if (url.pathname === "/api/docs") {
    try {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "500", 10) || 500, 2000);
      const documents = await fetchDocs(limit);
      res.writeHead(200, { ...CORS, "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ table: schema.table, count: documents.length, documents }));
    } catch (e) {
      console.error("Error en /api/docs:", e.message);
      res.writeHead(500, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }

  // Proxy del chat: agrega el Basic Auth (env vars) y reenvía a n8n, con streaming.
  if (url.pathname === "/api/chat" && req.method === "POST") {
    if (!N8N.user || !N8N.pass) {
      res.writeHead(500, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Faltan N8N_WEBHOOK_USER / N8N_WEBHOOK_PASS en el entorno del backend." }));
    }
    try {
      const body = await readBody(req);
      const auth = Buffer.from(N8N.user + ":" + N8N.pass, "utf8").toString("base64"); // UTF-8 (la pass tiene "£")
      const upstream = await fetch(N8N.url, {
        method: "POST",
        headers: {
          "Content-Type": req.headers["content-type"] || "application/json",
          "Authorization": "Basic " + auth,
          "User-Agent": BROWSER_UA
        },
        body
      });
      res.writeHead(upstream.status, {
        ...CORS,
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8"
      });
      if (upstream.body) return Readable.fromWeb(upstream.body).pipe(res);
      return res.end(await upstream.text());
    } catch (e) {
      console.error("Error en /api/chat:", e.message);
      res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, service: "30x vectordb viewer" }));
  }

  // Cualquier otra ruta GET: servir el sitio estatico (index.html, templates, assets).
  if (req.method === "GET") return serveStatic(req, res, url.pathname);

  res.writeHead(404, CORS);
  res.end();
});

server.listen(PORT, () => console.log("Backend vectordb en http://localhost:" + PORT + "/api/docs"));
