"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function writeFileAtomic(targetPath, content) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(dir, `${base}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, targetPath);
    return;
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    if (error && error.code !== "EPERM" && error.code !== "EACCES") throw error;
  }

  const quotedPath = targetPath.replace(/'/g, "''");
  const command = `$target = '${quotedPath}'; $tmp = "$target.ps-tmp"; [System.IO.File]::WriteAllText($tmp, [Console]::In.ReadToEnd(), [System.Text.UTF8Encoding]::new($false)); Move-Item -LiteralPath $tmp -Destination $target -Force`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    input: content,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`PowerShell write fallback failed: ${result.stderr || result.stdout}`);
  }
}

class LuaParser {
  constructor(input) { this.input = input; this.pos = 0; }
  parse() { this.skip(); if (this.peekIdent()) { this.readIdent(); this.skip(); this.expect("="); } const value = this.parseValue(); this.skip(); return value; }
  parseValue() {
    this.skip();
    const ch = this.input[this.pos];
    if (ch === "{") return this.parseTable();
    if (ch === "\"") return this.parseString();
    if (ch === "-" || this.isDigit(ch)) return this.parseNumber();
    const ident = this.readIdent();
    if (ident === "true") return true;
    if (ident === "false") return false;
    if (ident === "nil") return null;
    if (ident) return ident;
    throw new Error(`Unexpected token near ${this.pos}`);
  }
  parseTable() {
    this.expect("{");
    const arr = [];
    const obj = {};
    let hasObjectKeys = false;
    let arrayIndex = 1;
    while (true) {
      this.skip();
      if (this.input[this.pos] === "}") { this.pos += 1; break; }
      let key = null;
      let value;
      if (this.input[this.pos] === "[") {
        this.pos += 1;
        key = this.parseValue();
        this.skip();
        this.expect("]");
        this.skip();
        this.expect("=");
        value = this.parseValue();
        hasObjectKeys = true;
      } else {
        const mark = this.pos;
        const ident = this.peekIdent() ? this.readIdent() : "";
        this.skip();
        if (ident && this.input[this.pos] === "=") {
          this.pos += 1;
          key = ident;
          value = this.parseValue();
          hasObjectKeys = true;
        } else {
          this.pos = mark;
          value = this.parseValue();
          key = arrayIndex;
          arrayIndex += 1;
        }
      }
      if (typeof key === "number" && Number.isInteger(key) && key >= 1 && !hasObjectKeys) arr[key - 1] = value;
      else obj[String(key)] = value;
      this.skip();
      if (this.input[this.pos] === "," || this.input[this.pos] === ";") this.pos += 1;
    }
    if (!hasObjectKeys) return arr;
    for (let index = 0; index < arr.length; index += 1) if (arr[index] !== undefined) obj[String(index + 1)] = arr[index];
    return obj;
  }
  parseString() {
    this.expect("\"");
    let out = "";
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      this.pos += 1;
      if (ch === "\"") return out;
      if (ch !== "\\") { out += ch; continue; }
      const esc = this.input[this.pos];
      this.pos += 1;
      if (esc === "n") out += "\n";
      else if (esc === "r") out += "\r";
      else if (esc === "t") out += "\t";
      else if (esc === "\"") out += "\"";
      else if (esc === "\\") out += "\\";
      else out += esc;
    }
    throw new Error("Unterminated Lua string");
  }
  parseNumber() {
    const start = this.pos;
    if (this.input[this.pos] === "-") this.pos += 1;
    while (this.isDigit(this.input[this.pos])) this.pos += 1;
    if (this.input[this.pos] === ".") { this.pos += 1; while (this.isDigit(this.input[this.pos])) this.pos += 1; }
    const exp = this.input[this.pos];
    if (exp === "e" || exp === "E") { this.pos += 1; if (this.input[this.pos] === "+" || this.input[this.pos] === "-") this.pos += 1; while (this.isDigit(this.input[this.pos])) this.pos += 1; }
    return Number(this.input.slice(start, this.pos));
  }
  skip() {
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch && ch.charCodeAt(0) === 0xfeff) { this.pos += 1; continue; }
      if (/\s/.test(ch)) { this.pos += 1; continue; }
      if (ch === "-" && this.input[this.pos + 1] === "-") { this.pos += 2; while (this.pos < this.input.length && !/[\r\n]/.test(this.input[this.pos])) this.pos += 1; continue; }
      break;
    }
  }
  expect(char) { this.skip(); if (this.input[this.pos] !== char) throw new Error(`Expected '${char}' near ${this.pos}`); this.pos += 1; }
  peekIdent() { return /[A-Za-z_]/.test(this.input[this.pos] || ""); }
  readIdent() { const start = this.pos; if (!this.peekIdent()) return ""; this.pos += 1; while (/[A-Za-z0-9_]/.test(this.input[this.pos] || "")) this.pos += 1; return this.input.slice(start, this.pos); }
  isDigit(ch) { return /[0-9]/.test(ch || ""); }
}

function ensureArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b)).map((key) => value[key]).filter(Boolean);
}
function plainObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function winnerKey(row) { return [row.raidId || "", row.date || "", row.time || "", row.mode || "", row.winner || "", row.itemId || "", row.item || row.label || "", row.total || "", row.rolls || ""].join("|"); }
function raidKey(row) { return row.id || row.finalizedAt || row.title || JSON.stringify(row); }
function attendanceKey(row) { return row.url ? [row.url || "", row.source || ""].join("|") : [row.raidId || "", row.source || ""].join("|"); }
function mergeArray(existing, incoming, keyFn) {
  const out = [];
  const seen = new Set();
  for (const row of [...ensureArray(existing), ...ensureArray(incoming)]) {
    const key = keyFn(row || {});
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
function mergeMap(existing, incoming) { return { ...plainObject(existing), ...plainObject(incoming) }; }
function loadJson(path) { if (!path || !fs.existsSync(path)) return {}; const text = fs.readFileSync(path, "utf8").trim(); return text ? JSON.parse(text) : {}; }
function datePart(value) { const text = String(value || ""); return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ""; }
function activeRaidDate(db) { return datePart(db && db.activeRaidId); }
function normalizeRowsForActiveRaid(rows, db) {
  const activeId = String(db && db.activeRaidId || "");
  const activeDate = activeRaidDate(db);
  if (!activeId || !activeDate) return ensureArray(rows);
  return ensureArray(rows).map((row) => {
    if (!row || typeof row !== "object") return row;
    const rowDate = datePart(row.date || row.fetchedAt || row.raidId);
    if (rowDate !== activeDate) return row;
    if (row.raidId === activeId) return row;
    return { ...row, raidId: activeId };
  });
}
function inferPhase(text) { const value = String(text || "").trim().toLowerCase(); if (!value) return ""; if (value.includes("ulduar")) return "phase2"; if (value.includes("naxx") || value.includes("obsidian") || value.includes("eye of eternity") || /\beoe\b/.test(value) || /\bos\b/.test(value)) return "phase1"; if (value.includes("trial") || value.includes("crusader") || /\btoc\b/.test(value) || value.includes("onyxia") || value.includes("northrend beasts") || value.includes("jaraxxus") || value.includes("faction champions") || value.includes("valkyr") || value.includes("val\'kyr") || value.includes("anub\'arak")) return "phase3"; if (value.includes("icecrown") || /\bicc\b/.test(value)) return "phase4"; if (value.includes("ruby") || /\brs\b/.test(value)) return "phase5"; return ""; }
function inferSnapshotPhase(id, winners, attendance, db) { const maps = [plainObject(db.raidPhases), plainObject(db.raidLogUrls), plainObject(db.raidKinds)]; const text = [id, maps[0][id] || "", maps[1][id] || "", maps[2][id] || ""].concat(winners.filter((row) => row && row.raidId === id).map((row) => `${row.item || ""} ${row.label || ""}`)).concat(attendance.filter((row) => row && row.raidId === id).map((row) => `${row.url || ""} ${row.title || ""} ${ensureArray(row.bosses).map((boss) => boss && boss.name || "").join(" ")}`)).join(" "); const inferred = inferPhase(text); if (inferred) return inferred; const hasTocItem = winners.some((row) => row && row.raidId === id && Number(row.itemId) >= 46950 && Number(row.itemId) <= 47299); return hasTocItem ? "phase3" : ""; }
function snapshotDateForId(id, winners, attendance) {
  const fromId = datePart(id);
  if (fromId) return fromId;
  const winner = winners.find((row) => row && row.raidId === id && datePart(row.date));
  if (winner) return datePart(winner.date);
  const record = attendance.find((row) => row && row.raidId === id && datePart(row.fetchedAt));
  return record ? datePart(record.fetchedAt) : "";
}
function synthesizeRaidSnapshots(existing, winners, attendance, db) {
  const out = [];
  const map = new Map();
  for (const raid of ensureArray(existing)) {
    if (!raid || typeof raid !== "object") continue;
    const id = String(raid.id || raid.finalizedAt || "");
    if (!id || map.has(id)) continue;
    const normalizedRaid = {
      ...raid,
      phase: inferPhase(raid.title || id) || raid.phase || plainObject(db.raidPhases)[id] || inferSnapshotPhase(id, winners, attendance, db),
      raidKind: raid.raidKind || plainObject(db.raidKinds)[id] || "main",
      winnerCount: raid.winnerCount || winners.filter((row) => row && row.raidId === id).length
    };
    map.set(id, normalizedRaid);
    out.push(normalizedRaid);
  }
  const ids = new Set();
  for (const row of winners) if (row && row.raidId) ids.add(String(row.raidId));
  for (const row of attendance) if (row && row.raidId) ids.add(String(row.raidId));
  for (const id of ids) {
    if (map.has(id)) continue;
    const date = snapshotDateForId(id, winners, attendance);
    const raid = {
      id,
      title: date ? `Raid ${date}` : id,
      phase: inferSnapshotPhase(id, winners, attendance, db),
      raidKind: plainObject(db.raidKinds)[id] || "main",
      finalizedAt: id,
      winnerCount: winners.filter((row) => row && row.raidId === id).length,
      lines: []
    };
    map.set(id, raid);
    out.push(raid);
  }
  return out;
}

const [, , luaPath, archivePath, attendancePath] = process.argv;
if (!luaPath || !archivePath) throw new Error("Usage: node archive-softres.js <SoftResRoller.lua> <loot-archive.json> [attendance.json]");
const db = new LuaParser(fs.readFileSync(luaPath, "utf8")).parse();
const archive = loadJson(archivePath);
const attendance = attendancePath ? loadJson(attendancePath) : [];
const mergedWinners = mergeArray(normalizeRowsForActiveRaid(archive.winners, db), normalizeRowsForActiveRaid(db.winners, db), winnerKey);
const mergedAttendance = mergeArray(normalizeRowsForActiveRaid(archive.attendance, db), normalizeRowsForActiveRaid(attendance, db), attendanceKey);
const mergedRaidSnapshots = synthesizeRaidSnapshots(mergeArray(archive.raidSnapshots, db.raidSnapshots, raidKey), mergedWinners, mergedAttendance, db);
const next = {
  version: 1,
  updatedAt: new Date().toISOString(),
  winners: mergedWinners,
  raidSnapshots: mergedRaidSnapshots,
  raidKinds: mergeMap(archive.raidKinds, db.raidKinds),
  raidPhases: mergeMap(archive.raidPhases, db.raidPhases),
  raidLogUrls: mergeMap(archive.raidLogUrls, db.raidLogUrls),
  attendance: mergedAttendance
};
if (process.env.AOL_ARCHIVE_STDOUT === "1") {
  process.stdout.write(JSON.stringify(next));
} else {
  writeFileAtomic(archivePath, JSON.stringify(next));
  console.log(`Updated archive: ${archivePath}`);
  console.log(`Archive winners: ${next.winners.length}, raids: ${next.raidSnapshots.length}, attendance: ${next.attendance.length}`);
}







