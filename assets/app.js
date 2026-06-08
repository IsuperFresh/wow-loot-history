(function () {
  "use strict";

  const els = {
    sourceMeta: document.getElementById("sourceMeta"),
    status: document.getElementById("status"),
    fileInput: document.getElementById("fileInput"),
    raidSelect: document.getElementById("raidSelect"),
    winnerFilter: document.getElementById("winnerFilter"),
    typeFilter: document.getElementById("typeFilter"),
    raidTitle: document.getElementById("raidTitle"),
    statPlayers: document.getElementById("statPlayers"),
    statItems: document.getElementById("statItems"),
    statRaids: document.getElementById("statRaids"),
    summaryList: document.getElementById("summaryList")
  };

  let rawDb = null;
  let extraCsvText = "";
  let model = {
    winners: [],
    reserves: [],
    raids: [],
    itemSources: new Map()
  };

  class LuaParser {
    constructor(input) {
      this.input = input;
      this.pos = 0;
    }

    parse() {
      this.skip();
      if (this.peekIdent()) {
        this.readIdent();
        this.skip();
        this.expect("=");
      }
      const value = this.parseValue();
      this.skip();
      return value;
    }

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
        if (this.input[this.pos] === "}") {
          this.pos += 1;
          break;
        }

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

        if (typeof key === "number" && Number.isInteger(key) && key >= 1 && !hasObjectKeys) {
          arr[key - 1] = value;
        } else {
          obj[String(key)] = value;
        }

        this.skip();
        if (this.input[this.pos] === "," || this.input[this.pos] === ";") {
          this.pos += 1;
        }
      }

      if (!hasObjectKeys) return arr;
      for (let index = 0; index < arr.length; index += 1) {
        if (arr[index] !== undefined) obj[String(index + 1)] = arr[index];
      }
      return obj;
    }

    parseString() {
      this.expect("\"");
      let out = "";
      while (this.pos < this.input.length) {
        const ch = this.input[this.pos];
        this.pos += 1;
        if (ch === "\"") return out;
        if (ch !== "\\") {
          out += ch;
          continue;
        }
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
      if (this.input[this.pos] === ".") {
        this.pos += 1;
        while (this.isDigit(this.input[this.pos])) this.pos += 1;
      }
      const exp = this.input[this.pos];
      if (exp === "e" || exp === "E") {
        this.pos += 1;
        if (this.input[this.pos] === "+" || this.input[this.pos] === "-") this.pos += 1;
        while (this.isDigit(this.input[this.pos])) this.pos += 1;
      }
      return Number(this.input.slice(start, this.pos));
    }

    skip() {
      while (this.pos < this.input.length) {
        const ch = this.input[this.pos];
        if (ch && ch.charCodeAt(0) === 0xfeff) {
          this.pos += 1;
          continue;
        }
        if (/\s/.test(ch)) {
          this.pos += 1;
          continue;
        }
        if (ch === "-" && this.input[this.pos + 1] === "-") {
          this.pos += 2;
          while (this.pos < this.input.length && !/[\r\n]/.test(this.input[this.pos])) {
            this.pos += 1;
          }
          continue;
        }
        break;
      }
    }

    expect(char) {
      this.skip();
      if (this.input[this.pos] !== char) {
        throw new Error(`Expected '${char}' near ${this.pos}`);
      }
      this.pos += 1;
    }

    peekIdent() {
      return /[A-Za-z_]/.test(this.input[this.pos] || "");
    }

    readIdent() {
      const start = this.pos;
      if (!this.peekIdent()) return "";
      this.pos += 1;
      while (/[A-Za-z0-9_]/.test(this.input[this.pos] || "")) this.pos += 1;
      return this.input.slice(start, this.pos);
    }

    isDigit(ch) {
      return /[0-9]/.test(ch || "");
    }
  }

  function parseCsv(csvText) {
    if (!csvText || typeof csvText !== "string") return [];
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;

    for (let i = 0; i < csvText.length; i += 1) {
      const ch = csvText[i];
      if (quoted) {
        if (ch === "\"" && csvText[i + 1] === "\"") {
          field += "\"";
          i += 1;
        } else if (ch === "\"") {
          quoted = false;
        } else {
          field += ch;
        }
        continue;
      }

      if (ch === "\"") quoted = true;
      else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (ch !== "\r") {
        field += ch;
      }
    }

    if (field || row.length) {
      row.push(field);
      rows.push(row);
    }

    const header = rows.shift() || [];
    return rows
      .filter((line) => line.some(Boolean))
      .map((line) => Object.fromEntries(header.map((name, index) => [name, line[index] || ""])));
  }

  function normalize(db, defaultCsvText) {
    const winners = ensureArray(db.winners).map((row, index) => {
      const item = plainItem(row.item || row.label || "");
      const mode = String(row.mode || "").trim() || "Other";
      return {
        id: index + 1,
        date: row.date || "",
        time: row.time || "",
        mode,
        winner: row.winner || "",
        item,
        itemId: row.itemId || "",
        slot: row.slot || "",
        className: row.class || "",
        spec: row.spec || "",
        rolls: row.rolls || "",
        total: row.total || "",
        raidId: row.raidId || ""
      };
    });

    const currentCsvRows = parseCsv(db.csv);
    const defaultCsvRows = parseCsv(defaultCsvText);
    const reserveSeen = new Set();
    const reserves = currentCsvRows.map((row, index) => ({
      id: index + 1,
      item: plainItem(row.Item || ""),
      itemId: row.ItemId || "",
      from: row.From || "",
      player: row.Name || "",
      className: row.Class || "",
      spec: row.Spec || "",
      note: row.Note || "",
      plus: row.Plus || "",
      date: row.Date || ""
    })).filter((row) => {
      const key = [row.item, row.itemId, row.player, row.className, row.spec, row.date].join("|");
      if (reserveSeen.has(key)) return false;
      reserveSeen.add(key);
      return Boolean(row.item || row.player);
    });
    const allReserveRows = [...currentCsvRows, ...defaultCsvRows].map((row, index) => ({
      id: index + 1,
      item: plainItem(row.Item || ""),
      itemId: row.ItemId || "",
      from: row.From || "",
      player: row.Name || "",
      className: row.Class || "",
      spec: row.Spec || "",
      note: row.Note || "",
      plus: row.Plus || "",
      date: row.Date || ""
    }));

    const raids = ensureArray(db.raidSnapshots).map((raid, index) => ({
      id: raid.id || String(index + 1),
      title: raid.title || `Raid ${index + 1}`,
      finalizedAt: raid.finalizedAt || "",
      winnerCount: raid.winnerCount || 0,
      lines: ensureArray(raid.lines)
    }));

    const itemSources = buildItemSources(allReserveRows);
    const playerInfo = buildPlayerInfo(winners, allReserveRows);
    winners.forEach((row) => {
      const info = playerInfo.get(normalizeName(row.winner));
      if (!row.className && info?.className) row.className = info.className;
      if (!row.spec && info?.spec) row.spec = info.spec;
      row.source = itemSources.get(String(row.itemId)) || itemSources.get(normItem(row.item)) || "";
    });

    return { winners, reserves, raids, playerInfo, itemSources };
  }

  const FALLBACK_ITEM_SOURCES = {
    45108: "Flame Leviathan",
    45112: "Flame Leviathan",
    45113: "Flame Leviathan",
    45136: "Razorscale",
    45139: "Razorscale",
    45140: "Razorscale",
    45142: "Razorscale",
    45158: "Ignis the Furnace Master",
    45162: "Ignis the Furnace Master",
    45165: "Ignis the Furnace Master",
    45225: "The Iron Council",
    45227: "The Iron Council",
    45244: "The Iron Council",
    45258: "XT-002 Deconstructor",
    45261: "Kologarn",
    45275: "Kologarn",
    45320: "Razorscale",
    45443: "XT-002 Deconstructor",
    45451: "Hodir",
    45459: "Hodir",
    45479: "Freya",
    45491: "Freya",
    45503: "General Vezax",
    45505: "General Vezax",
    45523: "Yogg-Saron",
    45529: "General Vezax",
    45538: "Thorim",
    45539: "General Vezax",
    45543: "Yogg-Saron",
    45544: "Yogg-Saron",
    45605: "The Iron Council",
    45634: "Hodir",
    45639: "Thorim",
    45640: "Thorim",
    45641: "Hodir",
    45642: "Hodir",
    45654: "Freya",
    45655: "Freya",
    45656: "Yogg-Saron",
    45658: "Yogg-Saron"
  };

  function buildItemSources(rows) {
    const map = new Map();
    Object.entries(FALLBACK_ITEM_SOURCES).forEach(([itemId, source]) => map.set(itemId, source));
    rows.forEach((row) => {
      if (!row.from) return;
      if (row.itemId) map.set(String(row.itemId), row.from);
      if (row.item) map.set(normItem(row.item), row.from);
    });
    return map;
  }

  function buildPlayerInfo(winners, reserves) {
    const map = new Map();
    const remember = (name, className, spec) => {
      const key = normalizeName(name);
      if (!key || (!className && !spec)) return;
      const current = map.get(key) || { className: "", spec: "" };
      if (!current.className && className) current.className = className;
      if (!current.spec && spec) current.spec = spec;
      map.set(key, current);
    };

    reserves.forEach((row) => remember(row.player, row.className, row.spec));
    winners.forEach((row) => remember(row.winner, row.className, row.spec));
    return map;
  }

  function normalizeName(name) {
    return String(name || "").trim().toLowerCase();
  }

  function normItem(item) {
    return plainItem(item).trim().toLowerCase();
  }

  function ensureArray(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return [];
    return Object.keys(value)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => value[key]);
  }

  function plainItem(value) {
    const text = String(value || "");
    const linkMatch = text.match(/\|h\[([^\]]+)\]\|h/);
    if (linkMatch) return linkMatch[1];
    const bracketMatch = text.match(/\[([^\]]+)\]/);
    return bracketMatch ? bracketMatch[1] : text;
  }

  function setStatus(message) {
    els.status.hidden = !message;
    els.status.textContent = message || "";
  }

  function loadLua(luaText, meta, defaultCsvText = "") {
    try {
      setStatus("");
      rawDb = new LuaParser(luaText).parse();
      extraCsvText = defaultCsvText || "";
      model = normalize(rawDb, extraCsvText);
      renderFilters();
      render();
      els.sourceMeta.textContent = meta || "Loaded from browser file";
    } catch (error) {
      setStatus(`Could not parse SoftResRoller.lua: ${error.message}`);
      console.error(error);
    }
  }

  function renderFilters() {
    const raidOptions = model.raids.length
      ? model.raids
      : unique(model.winners.map((row) => row.raidId).filter(Boolean)).map((id) => ({ id, title: id }));
    fillSelect(els.raidSelect, "All raids", raidOptions.map((raid) => ({ label: raid.title, value: raid.id })));
    fillSelect(els.typeFilter, "All types", unique(model.winners.map((row) => displayMode(row.mode))).sort());
  }

  function fillSelect(select, label, values) {
    const current = select.value;
    select.innerHTML = "";
    select.append(new Option(label, ""));
    values.forEach((value) => {
      if (typeof value === "object") select.append(new Option(value.label, value.value));
      else select.append(new Option(value, value));
    });
    const options = Array.from(select.options).map((option) => option.value);
    if (options.includes(current)) select.value = current;
  }

  function render() {
    const selectedRaidId = els.raidSelect.value;
    const selectedType = els.typeFilter.value;
    const winnerQuery = els.winnerFilter.value.trim().toLowerCase();
    const selectedRaid = model.raids.find((raid) => raid.id === selectedRaidId);
    const rows = model.winners.filter((row) => {
      if (selectedRaidId && row.raidId !== selectedRaidId) return false;
      if (selectedType && displayMode(row.mode) !== selectedType) return false;
      if (winnerQuery && !String(row.winner).toLowerCase().includes(winnerQuery)) return false;
      return true;
    });
    const groups = buildLootGroups(rows);

    els.raidTitle.textContent = selectedRaid ? selectedRaid.title : selectedRaidId || "All raids";
    els.statPlayers.textContent = groups.length;
    els.statItems.textContent = rows.length;
    els.statRaids.textContent = model.raids.length || unique(model.winners.map((row) => row.raidId)).length;
    renderSummary(groups);
  }

  function buildLootGroups(lootRows) {
    const map = new Map();
    const get = (name) => {
      if (!map.has(name)) {
        map.set(name, { name, className: "", spec: "", items: [], modeCounts: new Map() });
      }
      return map.get(name);
    };

    lootRows.forEach((row) => {
      if (!row.winner) return;
      const player = get(row.winner);
      if (!player.className && row.className) player.className = row.className;
      if (!player.spec && row.spec) player.spec = row.spec;
      const mode = displayMode(row.mode);
      player.modeCounts.set(mode, (player.modeCounts.get(mode) || 0) + 1);
      player.items.push({ ...row, mode });
    });

    return Array.from(map.values()).sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
  }

  function renderSummary(groups) {
    els.summaryList.innerHTML = "";
    if (!groups.length) {
      els.summaryList.append(empty("No loot for this raid/filter."));
      return;
    }

    const fragment = document.createDocumentFragment();
    groups.forEach((group) => fragment.append(summaryCard(group)));
    els.summaryList.append(fragment);
  }

  function matches(row, query) {
    if (!query) return true;
    return Object.values(row).some((value) => String(value || "").toLowerCase().includes(query));
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function cell(text) {
    const td = document.createElement("td");
    td.textContent = text || "";
    return td;
  }

  function itemCell(name, itemId) {
    const td = document.createElement("td");
    const span = document.createElement("span");
    span.className = "itemName";
    span.textContent = name || "Unknown item";
    td.append(span);
    if (itemId) td.title = `Item ID: ${itemId}`;
    return td;
  }

  function modeCell(mode) {
    const td = document.createElement("td");
    const span = document.createElement("span");
    const clean = String(mode || "Other").replace(/[^A-Za-z0-9]/g, "");
    span.className = `mode mode${clean || "Other"}`;
    span.textContent = mode || "Other";
    td.append(span);
    return td;
  }

  function summaryCard(group) {
    const card = document.createElement("article");
    card.className = "lootCard";

    const header = document.createElement("div");
    header.className = "lootCardHeader";
    const titleWrap = document.createElement("div");
    const name = document.createElement("h3");
    const mainSpec = [group.className, group.spec].filter(Boolean).join(" ");
    name.textContent = mainSpec ? `${group.name} - ${mainSpec}` : group.name;
    const meta = document.createElement("p");
    meta.textContent = modeSummary(group.modeCounts);
    titleWrap.append(name, meta);
    const count = document.createElement("strong");
    count.className = "countBadge";
    count.textContent = `count ${group.items.length}`;
    header.append(titleWrap, count);

    const list = document.createElement("div");
    list.className = "lootLines";
    group.items.forEach((item) => list.append(lootLine(item)));

    card.append(header, list);
    return card;
  }

  function lootLine(item) {
    const row = document.createElement("div");
    row.className = "lootLine";
    const left = document.createElement("div");
    left.className = "lootItem";
    const slot = document.createElement("span");
    slot.className = "slotName";
    slot.textContent = `${item.slot || "Other"}:`;
    const itemName = document.createElement("span");
    itemName.className = "itemName";
    itemName.textContent = `[${item.item || "Unknown item"}]`;
    left.append(slot, itemName);

    const right = document.createElement("div");
    right.className = `lootDate mode${String(item.mode || "").replace(/[^A-Za-z0-9]/g, "")}`;
    right.textContent = [item.source || "Unknown boss", `${item.date || "-"} - ${item.mode}`].join(" | ");
    row.append(left, right);
    return row;
  }

  function modeSummary(modeCounts) {
    return Array.from(modeCounts.entries())
      .sort((a, b) => modeOrder(a[0]) - modeOrder(b[0]) || a[0].localeCompare(b[0]))
      .map(([mode, count]) => `${mode} x${count}`)
      .join(" - ");
  }

  function displayMode(mode) {
    const raw = String(mode || "Other").trim();
    if (raw === "AUTO" || raw === "AUTO SR") return "SR";
    return raw;
  }

  function modeOrder(mode) {
    return { MS: 1, SR: 2, OS: 3, DE: 4 }[mode] || 20;
  }

  function empty(message) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = message;
    return div;
  }

  [els.raidSelect, els.winnerFilter, els.typeFilter].forEach((control) => control.addEventListener("input", render));

  if (els.fileInput) {
    els.fileInput.addEventListener("change", async () => {
      const file = els.fileInput.files[0];
      if (!file) return;
      const text = await file.text();
      loadLua(text, `Loaded ${file.name} in this browser`, extraCsvText);
    });
  }

  const payload = window.SOFTRES_PAYLOAD;
  const payloadLua = typeof payload?.lua === "string" ? payload.lua : payload?.lua?.value;
  if (payload && payloadLua) {
    loadLua(payloadLua, "Guild raid loot history", payload.defaultCsv || "");
  } else {
    setStatus("No generated data found. Run update.ps1 or use Load Lua.");
    els.sourceMeta.textContent = "Waiting for SoftResRoller.lua";
  }
})();
