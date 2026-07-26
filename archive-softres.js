"use strict";

const fs = require("fs");

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
    map.set(id, raid);
    out.push(raid);
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
      phase: plainObject(db.raidPhases)[id] || "",
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
fs.writeFileSync(archivePath, JSON.stringify(next), "utf8");
console.log(`Updated archive: ${archivePath}`);
console.log(`Archive winners: ${next.winners.length}, raids: ${next.raidSnapshots.length}, attendance: ${next.attendance.length}`);
