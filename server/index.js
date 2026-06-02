"use strict";

// Witsoc plugin server.
//
// Pure-Node HTTP fronter that shells out to `data/venv/bin/wit`. Endpoints:
//   GET  /health                                 → liveness
//   GET  /api/info                               → venv path + wit version
//   GET  /api/list?dir=<abs>                     → recursive .wit + .lean list
//   GET  /api/lean-files?dir=<abs>               → .lean files in the current worktree
//   GET  /api/file?path=<abs>                    → raw text
//   PUT  /api/file?path=<abs>                    → body = new content
//   POST /api/lake-build?path=<abs>              → lake build in nearest Lake project
//   POST /api/check?path=<abs>                   → wit check stdout/stderr/exit
//   POST /api/verify?path=<abs>[&step=N.M]       → wit verify stdout
//   POST /api/context?path=<abs>                 → wit context stdout
//   POST /api/receipt?path=<abs>                 → body = verifier output → wit receipt (stdin)
//   GET  /api/receipt?path=<abs>                 → current .wit.receipt.json (or null)
//   POST /api/parse?path=<abs>                   → JSON proof tree (regex parser fallback)

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");

const PORT = parseInt(process.env.PORT || "0", 10);
const PLUGIN_ID = process.env.PLUGIN_ID || "witsoc";
const PLUGIN_DIR = path.resolve(__dirname, "..");
const VENV_DIR = process.env.WITSOC_VENV || path.join(PLUGIN_DIR, "data", "venv");
const WIT = path.join(VENV_DIR, "bin", "wit");
const PLANE_SERVER_URL = process.env.PLANE_SERVER_URL || "http://127.0.0.1:5495";
const PLANE_TOOL_BIN = process.env.PLANE_TOOL_BIN || "";

const startedAt = new Date().toISOString();

function sendJson(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}
function sendText(res, code, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function runCommand(command, args, opts = {}, stdin = null) {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeoutMs || 60000,
      maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
      env: process.env,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exit_code: err ? (err.code || 1) : 0,
        signal: err ? err.signal || null : null,
        stdout: stdout ? stdout.toString() : "",
        stderr: (stderr ? stderr.toString() : "") || (err && err.message ? err.message : ""),
        timed_out: err ? !!err.killed : false,
      });
    });
    if (stdin != null && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}
function runWit(args, stdin = null, timeoutMs = 60000, cwd = undefined) {
  return runCommand(WIT, args, { cwd, timeoutMs, maxBuffer: 4 * 1024 * 1024 }, stdin);
}

function existingPathKind(p) {
  try {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
  } catch (_) { /* handled by caller */ }
  return null;
}

function fileWorkDir(p) {
  const kind = existingPathKind(p);
  if (kind === "directory") return p;
  if (kind === "file") return path.dirname(p);
  return null;
}

function findLakeProject(p, stopRoot = null) {
  let dir = fileWorkDir(p);
  const searched = [];
  const leanToolchains = [];
  if (!dir) return { projectRoot: null, searched, leanToolchains };
  dir = path.resolve(dir);
  const root = stopRoot ? path.resolve(stopRoot) : null;
  while (true) {
    searched.push(dir);
    if (fs.existsSync(path.join(dir, "lean-toolchain"))) leanToolchains.push(dir);
    if (fs.existsSync(path.join(dir, "lakefile.lean")) || fs.existsSync(path.join(dir, "lakefile.toml"))) {
      return { projectRoot: dir, searched, leanToolchains };
    }
    if (root && dir === root) return { projectRoot: null, searched, leanToolchains };
    const parent = path.dirname(dir);
    if (parent === dir) return { projectRoot: null, searched, leanToolchains };
    dir = parent;
  }
}

function normalizeRoot(root) {
  if (!root) return null;
  const resolved = path.resolve(root);
  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : null;
}

function isInsideRoot(p, root) {
  const resolvedPath = path.resolve(p);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolvedPath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function guardedPath(rawPath, rawRoot) {
  if (!rawPath) return { error: "path_required" };
  const p = path.resolve(rawPath);
  const root = normalizeRoot(rawRoot);
  if (rawRoot && !root) return { error: "root_not_found", root: rawRoot };
  if (root && !isInsideRoot(p, root)) return { error: "path_outside_worktree", path: p, root };
  return { path: p, root };
}

function isRecognizedFile(p) {
  return p.toLowerCase().endsWith(".wit") || p.toLowerCase().endsWith(".lean");
}
function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? require("https") : require("http");
    const req = lib.get(url, { timeout: timeoutMs }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (r.statusCode < 200 || r.statusCode >= 300) return reject(new Error(`HTTP ${r.statusCode}: ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// ─── .wit parser (regex, fallback when wit binary unavailable) ────────────
//
// Walks the source for top-level `MODULE`, `THEOREM`, `LEMMA`, `PROPOSITION`,
// `COROLLARY`, `CONJECTURE`, `PROOF OF`, and step labels like `[1]`, `[2.1]`
// with their keyword + claim text. This isn't a full parser — it lets the
// iframe show a tree even if the venv hasn't been built yet, or if witsoc's
// CLI exits with a parse error we'd like to surface gracefully.
function parseWitText(source) {
  const lines = source.split(/\r?\n/);
  const result = {
    status: "UNVERIFIED",
    module: null,
    claims: [],   // [{kind, name, line}]
    proofs: [],   // [{name, steps: [{label, keyword, claim, by, line}], qed}]
  };

  // Header line "-- Status: VERIFIED|UNVERIFIED|REJECTED"
  for (const line of lines) {
    const m = line.match(/^--\s*Status:\s*(\w+)/i);
    if (m) { result.status = m[1].toUpperCase(); break; }
    if (!line.startsWith("--") && line.trim() !== "") break;
  }

  // MODULE name
  for (const line of lines) {
    const m = line.match(/^\s*MODULE\s+([A-Za-z_][\w]*)/);
    if (m) { result.module = m[1]; break; }
  }

  // Claims and proofs
  let cur = null;            // current proof being parsed
  const KIND_RE = /^\s*(THEOREM|LEMMA|PROPOSITION|COROLLARY|CONJECTURE)\s+([A-Za-z_][\w]*)/;
  const PROOF_RE = /^\s*PROOF\s+OF\s+([A-Za-z_][\w]*)/;
  const STEP_RE  = /^\s*\[([\d.]+)\]\s+(HAVE|SHOW|ASSUME|LET|CONSIDER|SUFFICES|CASE|CITE|GAP)\b\s*(.*)$/;
  const QED_RE   = /^\s*QED(?:\s+\[([\d.]+)\])?\s*(?:BY\s+(.*))?$/i;
  const BY_RE    = /^\s*BY\s+(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(KIND_RE))) {
      result.claims.push({ kind: m[1], name: m[2], line: i + 1 });
      continue;
    }
    if ((m = line.match(PROOF_RE))) {
      cur = { name: m[1], steps: [], qed: null, line: i + 1 };
      result.proofs.push(cur);
      continue;
    }
    if (cur && (m = line.match(STEP_RE))) {
      cur.steps.push({
        label: m[1],
        keyword: m[2],
        claim: m[3].trim(),
        by: null,
        line: i + 1,
      });
      continue;
    }
    if (cur && cur.steps.length && (m = line.match(BY_RE))) {
      // Attach BY to the previous step (and any continuation lines).
      const last = cur.steps[cur.steps.length - 1];
      last.by = (last.by ? last.by + " " : "") + m[1].trim();
      continue;
    }
    if (cur && (m = line.match(QED_RE))) {
      cur.qed = { label: m[1] || null, by: m[2] || null, line: i + 1 };
    }
  }
  return result;
}

function parseLeanText(source) {
  const lines = source.split(/\r?\n/);
  const result = {
    mode: "lean",
    imports: [],
    declarations: [],
  };
  const DECL_RE = /^\s*(theorem|lemma|def|example|instance|class|structure|inductive|abbrev)\s+([A-Za-z_][\w'.]*)?/;
  const IMPORT_RE = /^\s*import\s+(.+?)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(IMPORT_RE);
    if (m) {
      result.imports.push({ module: m[1].trim(), line: i + 1 });
      continue;
    }
    m = line.match(DECL_RE);
    if (m) {
      result.declarations.push({
        kind: m[1],
        name: m[2] || "(anonymous)",
        line: i + 1,
        text: line.trim(),
      });
    }
  }
  return result;
}

// ─── .soc parser ─────────────────────────────────────────────────────────

function parseSocText(source) {
  const lines = source.split(/\r?\n/);
  const result = {
    goal: null,
    progress_a: null,
    progress_b: null,
    insights_since: null,
    queue: [],     // [{done: bool, text, line}]
    insights: [],  // [{text, line}]
    log: [],       // [{text, line}]
  };
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    let m;
    if ((m = line.match(/^\s*GOAL:\s*(.*)$/i))) { result.goal = m[1].trim(); continue; }
    if ((m = line.match(/^\s*PROGRESS:\s*(\d+)\s*\/\s*(\d+)/i))) {
      result.progress_a = parseInt(m[1], 10);
      result.progress_b = parseInt(m[2], 10);
      continue;
    }
    if ((m = line.match(/^\s*INSIGHTS_SINCE_LAST_UPDATE:\s*(\d+)/i))) {
      result.insights_since = parseInt(m[1], 10); continue;
    }
    if (/^\s*QUEUE:/i.test(line))    { section = "queue";    continue; }
    if (/^\s*INSIGHTS:/i.test(line)) { section = "insights"; continue; }
    if (/^\s*LOG:/i.test(line))      { section = "log";      continue; }

    if (section === "queue" && (m = line.match(/^\s*-\s*\[([ x])\]\s*(.*)$/))) {
      result.queue.push({ done: m[1] === "x", text: m[2].trim(), line: i + 1 });
    } else if (section === "insights" && (m = line.match(/^\s*-\s*(.*)$/))) {
      const txt = m[1].trim();
      if (txt && txt !== "(none yet)") result.insights.push({ text: txt, line: i + 1 });
    } else if (section === "log" && (m = line.match(/^\s*-\s*(.*)$/))) {
      const txt = m[1].trim();
      if (txt) result.log.push({ text: txt, line: i + 1 });
    }
  }
  return result;
}

// ─── List walker ─────────────────────────────────────────────────────────

function listFiles(rootDir, exts, maxDepth = 8, max = 500) {
  const out = [];
  const skip = new Set(["node_modules", ".git", ".venv", "__pycache__", "dist", "build"]);
  function walk(dir, depth) {
    if (depth > maxDepth || out.length >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= max) return;
      if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && exts.some((x) => entry.name.toLowerCase().endsWith(x))) {
        out.push({ path: full, name: entry.name, rel: path.relative(rootDir, full) });
      }
    }
  }
  walk(rootDir, 0);
  return out;
}
async function resolveDeepRunWorktrees({ orchestratorId, sessionId, worktree }) {
  const roots = [];
  const seen = new Set();
  function add(p, label = null) {
    if (!p || seen.has(p) || !fs.existsSync(p)) return;
    seen.add(p);
    roots.push({ path: p, label: label || p });
  }
  add(worktree, "specified worktree");
  if (sessionId) {
    const snap = await getJson(`${PLANE_SERVER_URL}/sessions/${encodeURIComponent(sessionId)}`);
    const s = snap && snap.session;
    if (s) add(s.worktree || s.folder, `session ${sessionId}`);
  }
  if (orchestratorId) {
    const snap = await getJson(`${PLANE_SERVER_URL}/orchestrator/${encodeURIComponent(orchestratorId)}/sessions`);
    for (const s of ((snap && snap.sessions) || [])) {
      add(s.worktree || s.folder, `${s.role || "session"} ${s.id || ""}`.trim());
    }
  }
  return roots;
}

// ─── Receipt I/O ─────────────────────────────────────────────────────────

function receiptPath(witPath) { return witPath + ".receipt.json"; }
function readReceipt(witPath) {
  const p = receiptPath(witPath);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// ─── HTTP server ─────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (u.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true, plugin: PLUGIN_ID, pid: process.pid,
      started_at: startedAt, uptime_seconds: Math.round(process.uptime()),
    });
  }

  if (u.pathname === "/api/info") {
    let witVersion = null;
    if (fs.existsSync(WIT)) {
      try {
        const pkg = path.join(VENV_DIR, "lib");
        const r = await new Promise((resolve) => {
          execFile(path.join(VENV_DIR, "bin", "python"), ["-c",
            "import importlib.metadata as m;\ntry:\n  print(m.version('wit-lang'))\nexcept Exception:\n  print(m.version('witsoc'))"
          ], { timeout: 5000 }, (err, stdout) => resolve(stdout || ""));
        });
        witVersion = (r || "").trim().split("\n")[0] || null;
      } catch (_) { witVersion = null; }
    }
    return sendJson(res, 200, {
      plugin: PLUGIN_ID, pid: process.pid, port: PORT,
      venv: VENV_DIR, wit: WIT, wit_version: witVersion,
      wit_available: fs.existsSync(WIT),
    });
  }

  if (u.pathname === "/api/list") {
    const dir = u.searchParams.get("dir");
    if (!dir) return sendJson(res, 400, { error: "dir_required" });
    const root = normalizeRoot(dir);
    if (!root) return sendJson(res, 404, { error: "dir_not_found", dir });
    const files = listFiles(root, [".wit", ".lean"], 20, 1000);
    const wits = files.filter((f) => f.name.toLowerCase().endsWith(".wit"));
    const leans = files.filter((f) => f.name.toLowerCase().endsWith(".lean"));
    return sendJson(res, 200, { dir: root, files, wit_files: wits, lean_files: leans });
  }

  if (u.pathname === "/api/lean-files") {
    const dir = u.searchParams.get("dir");
    const root = normalizeRoot(dir);
    if (!root) return sendJson(res, 404, { error: "dir_not_found", dir });
    try {
      const roots = [{ path: root, label: "current worktree" }];
      const leanFiles = [];
      for (const root of roots) {
        for (const f of listFiles(root.path, [".lean"], 10, 1000)) {
          leanFiles.push({ ...f, root: root.path, root_label: root.label });
        }
      }
      return sendJson(res, 200, { roots, lean_files: leanFiles });
    } catch (err) {
      return sendJson(res, 500, { error: "lean_files_failed", message: err.message });
    }
  }

  if (u.pathname === "/api/file") {
    const guard = guardedPath(u.searchParams.get("path"), u.searchParams.get("root"));
    if (guard.error) return sendJson(res, 400, guard);
    const p = guard.path;
    if (!isRecognizedFile(p)) return sendJson(res, 400, { error: "recognized_file_required", path: p });
    if (req.method === "GET") {
      try { return sendText(res, 200, fs.readFileSync(p, "utf8")); }
      catch (err) { return sendJson(res, 404, { error: "read_failed", message: err.message }); }
    }
    if (req.method === "PUT") {
      try {
        const body = await readBody(req);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body);
        return sendJson(res, 200, { ok: true, bytes: body.length });
      } catch (err) {
        return sendJson(res, 500, { error: "write_failed", message: err.message });
      }
    }
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  if (u.pathname === "/api/check") {
    const guard = guardedPath(u.searchParams.get("path"), u.searchParams.get("root"));
    if (guard.error) return sendJson(res, 400, guard);
    const p = guard.path;
    if (!p.toLowerCase().endsWith(".wit")) return sendJson(res, 400, { error: "wit_file_required", path: p });
    if (!fs.existsSync(WIT)) return sendJson(res, 503, { error: "wit_unavailable", message: "venv not provisioned; activate the plugin" });
    const r = await runWit(["check", p], null, 60000, fileWorkDir(p));
    return sendJson(res, 200, r);
  }

  if (u.pathname === "/api/lake-build") {
    const guard = guardedPath(u.searchParams.get("path"), u.searchParams.get("root"));
    if (guard.error) return sendJson(res, 400, guard);
    const p = guard.path;
    if (!isRecognizedFile(p)) return sendJson(res, 400, { error: "recognized_file_required", path: p });
    const kind = existingPathKind(p);
    if (!kind) return sendJson(res, 404, { error: "path_not_found", path: p });
    const lake = findLakeProject(p, guard.root);
    if (!lake.projectRoot) {
      return sendJson(res, 404, {
        error: "lake_project_not_found",
        message: "No lakefile.lean or lakefile.toml was found above the selected file.",
        path: p,
        searched_dirs: lake.searched,
        lean_toolchain_dirs: lake.leanToolchains,
      });
    }
    const r = await runCommand("lake", ["build"], {
      cwd: lake.projectRoot,
      timeoutMs: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return sendJson(res, 200, {
      ...r,
      project_root: lake.projectRoot,
      command: "lake build",
      searched_dirs: lake.searched,
      lean_toolchain_dirs: lake.leanToolchains,
    });
  }

  if (u.pathname === "/api/verify") {
    const guard = guardedPath(u.searchParams.get("path"), u.searchParams.get("root"));
    if (guard.error) return sendJson(res, 400, guard);
    const p = guard.path;
    if (!p.toLowerCase().endsWith(".wit")) return sendJson(res, 400, { error: "wit_file_required", path: p });
    if (!fs.existsSync(WIT)) return sendJson(res, 503, { error: "wit_unavailable" });
    const step = u.searchParams.get("step");
    const args = step ? ["verify", p, "--step", step] : ["verify", p];
    const r = await runWit(args, null, 60000, fileWorkDir(p));
    return sendJson(res, 200, r);
  }

  if (u.pathname === "/api/context") {
    const guard = guardedPath(u.searchParams.get("path"), u.searchParams.get("root"));
    if (guard.error) return sendJson(res, 400, guard);
    const p = guard.path;
    if (!p.toLowerCase().endsWith(".wit")) return sendJson(res, 400, { error: "wit_file_required", path: p });
    if (!fs.existsSync(WIT)) return sendJson(res, 503, { error: "wit_unavailable" });
    const step = u.searchParams.get("step");
    const args = step ? ["context", p, "--step", step] : ["context", p];
    const r = await runWit(args, null, 60000, fileWorkDir(p));
    return sendJson(res, 200, r);
  }

  if (u.pathname === "/api/receipt") {
    const guard = guardedPath(u.searchParams.get("path"), u.searchParams.get("root"));
    if (guard.error) return sendJson(res, 400, guard);
    const p = guard.path;
    if (!p.toLowerCase().endsWith(".wit")) return sendJson(res, 400, { error: "wit_file_required", path: p });
    const rp = receiptPath(p);
    if (req.method === "GET") {
      return sendJson(res, 200, { receipt: readReceipt(p), receipt_path: rp });
    }
    if (req.method === "POST") {
      if (!fs.existsSync(WIT)) return sendJson(res, 503, { error: "wit_unavailable" });
      const body = await readBody(req);
      const r = await runWit(["receipt", p], body, 60000, fileWorkDir(p));
      return sendJson(res, 200, { ...r, receipt: readReceipt(p), receipt_path: rp });
    }
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  if (u.pathname === "/api/parse") {
    const guard = guardedPath(u.searchParams.get("path"), u.searchParams.get("root"));
    if (guard.error) return sendJson(res, 400, guard);
    const p = guard.path;
    if (!isRecognizedFile(p)) return sendJson(res, 400, { error: "recognized_file_required", path: p });
    try {
      const source = fs.readFileSync(p, "utf8");
      const parsed = p.toLowerCase().endsWith(".lean") ? parseLeanText(source) : parseWitText(source);
      return sendJson(res, 200, { path: p, parsed, receipt: readReceipt(p), receipt_path: p.toLowerCase().endsWith(".wit") ? receiptPath(p) : null });
    } catch (err) {
      return sendJson(res, 500, { error: "parse_failed", message: err.message });
    }
  }

  if (u.pathname === "/api/soc") {
    return sendJson(res, 404, { error: "unsupported_file_type", message: "Only .wit and .lean files are recognized." });
  }

  sendJson(res, 404, { error: "not_found", path: u.pathname });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`[witsoc] listening on 127.0.0.1:${server.address().port}, pid=${process.pid}\n`);
});

const shutdown = (signal) => {
  process.stdout.write(`[witsoc] received ${signal}, exiting\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
