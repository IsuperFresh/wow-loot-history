(function () {
  "use strict";

  const els = {
    sourceMeta: document.getElementById("sourceMeta"),
    status: document.getElementById("status"),
    phaseSelect: document.getElementById("phaseSelect"),
    raidSelect: document.getElementById("raidSelect"),
    winnerLabel: document.querySelector('label[for="winnerFilter"]'),
    winnerFilter: document.getElementById("winnerFilter"),
    typeFilter: document.getElementById("typeFilter"),
    viewTabs: document.querySelectorAll(".viewTab"),
    raidTitle: document.getElementById("raidTitle"),
    statPlayersLabel: document.getElementById("statPlayers")?.previousElementSibling,
    statPlayers: document.getElementById("statPlayers"),
    statItemsLabel: document.getElementById("statItems")?.previousElementSibling,
    statItems: document.getElementById("statItems"),
    statRaidsLabel: document.getElementById("statRaids")?.previousElementSibling,
    statRaids: document.getElementById("statRaids"),
    summaryList: document.getElementById("summaryList")
  };

  let rawDb = null;
  let extraCsvText = "";
  let activeView = "loot";
  let attendanceSort = "percent";
  let attendanceBucket = "all";
  let attendanceRange = "all";
  let attendanceLimit = 5;
  let performanceSort = "dps";
  let performanceBossFilter = "all";
  const PERFORMANCE_MIN_BOSSES = 20;
  let model = {
    winners: [],
    reserves: [],
    raids: [],
    itemSources: new Map(),
    attendance: []
  };

  const PHASES = [
    { id: "", label: "All phases" },
    { id: "phase1", label: "Phase 1 (Naxxramas, OS, EoE)" },
    { id: "phase2", label: "Phase 2 (Ulduar)" },
    { id: "phase3", label: "Phase 3 (ToC, Onyxia)" },
    { id: "phase4", label: "Phase 4 (ICC)" },
    { id: "phase5", label: "Phase 5 (Ruby Sanctum)" }
  ];

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

    const raidPhaseOverrides = db.raidPhases && typeof db.raidPhases === "object" ? db.raidPhases : {};
    const raids = ensureArray(db.raidSnapshots).map((raid, index) => {
      const id = raid.id || String(index + 1);
      const title = raid.title || `Raid ${index + 1}`;
      return {
        id,
        title,
        phase: raid.phase || raidPhaseOverrides[id] || inferPhase(title),
        finalizedAt: raid.finalizedAt || "",
        winnerCount: raid.winnerCount || 0,
        lines: ensureArray(raid.lines)
      };
    });
    const raidPhaseMap = new Map(raids.map((raid) => [raid.id, raid.phase || ""]));
    winners.forEach((row) => {
      row.phase = raidPhaseMap.get(row.raidId) || inferPhase(row.raidId);
    });

    const itemSources = buildItemSources(allReserveRows);
    const playerOverrides = parsePlayerSpecOverrides(db.playerSpecOverrides);
    const playerInfo = buildPlayerInfo(winners, allReserveRows, playerOverrides);
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

  function parsePlayerSpecOverrides(overrides) {
    const rows = [];
    if (!overrides || typeof overrides !== "object") return rows;
    Object.entries(overrides).forEach(([name, value]) => {
      if (!value || typeof value !== "object") return;
      rows.push({
        player: name,
        className: value.class || value.className || "",
        spec: value.spec || ""
      });
    });
    return rows;
  }

  function buildPlayerInfo(winners, reserves, overrides = []) {
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
    overrides.forEach((row) => {
      const key = normalizeName(row.player);
      if (!key) return;
      map.set(key, { className: row.className || "", spec: row.spec || "" });
    });
    return map;
  }

  function normalizeName(name) {
    return String(name || "").trim().toLowerCase();
  }

  function phaseLabel(phaseId) {
    return PHASES.find((phase) => phase.id === phaseId)?.label || "All phases";
  }

  function inferPhase(text) {
    const value = normalizeName(text);
    if (!value) return "";
    if (value.includes("ulduar")) return "phase2";
    if (value.includes("naxx") || value.includes("obsidian") || value.includes("eye of eternity") || /\beoe\b/.test(value) || /\bos\b/.test(value)) return "phase1";
    if (value.includes("trial") || /\btoc\b/.test(value) || value.includes("onyxia")) return "phase3";
    if (value.includes("icecrown") || /\bicc\b/.test(value)) return "phase4";
    if (value.includes("ruby") || /\brs\b/.test(value)) return "phase5";
    return "";
  }

  function raidTitle(raidId) {
    return model.raids.find((raid) => raid.id === raidId)?.title || "";
  }

  function raidPhase(raidId) {
    const raid = model.raids.find((item) => item.id === raidId);
    return raid?.phase || inferPhase(raid?.title || raidId);
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

  function loadLua(luaText, meta, defaultCsvText = "", attendanceRows = []) {
    try {
      setStatus("");
      rawDb = new LuaParser(luaText).parse();
      extraCsvText = defaultCsvText || "";
      model = normalize(rawDb, extraCsvText);
      model.attendance = normalizeAttendance(attendanceRows);
      mergeAttendancePlayerInfo(model.attendance);
      renderFilters();
      render();
      els.sourceMeta.textContent = meta || "Loaded from browser file";
    } catch (error) {
      setStatus(`Could not parse SoftResRoller.lua: ${error.message}`);
      console.error(error);
    }
  }

  function renderFilters() {
    fillSelect(els.phaseSelect, "All phases", PHASES.slice(1).map((phase) => ({ label: phase.label, value: phase.id })));
    renderRaidFilter();
    renderTypeFilter(unique(model.winners.map((row) => displayMode(row.mode))).sort((a, b) => modeOrder(a) - modeOrder(b) || a.localeCompare(b)));
  }

  function renderRaidFilter() {
    const selectedPhase = els.phaseSelect.value;
    const raidOptions = isLogView() ? attendanceRaidOptions() : lootRaidOptions();
    const filteredOptions = raidOptions.filter((raid) => !selectedPhase || raid.phase === selectedPhase);
    fillSelect(els.raidSelect, "All raids", filteredOptions.map((raid) => ({ label: raid.title, value: raid.id })));
  }

  function lootRaidOptions() {
    const lootRaidIds = new Set(model.winners.map((row) => row.raidId).filter(Boolean));
    const raids = model.raids.filter((raid) => lootRaidIds.has(raid.id));
    if (raids.length) return raids;
    return unique(model.winners.map((row) => row.raidId).filter(Boolean)).map((id) => ({
      id,
      title: id,
      phase: inferPhase(id)
    }));
  }

  function attendanceRaidOptions() {
    const map = new Map();
    model.raids.forEach((raid) => {
      map.set(raid.id, raid);
    });
    model.attendance.forEach((record) => {
      if (!record.raidId) return;
      if (!map.has(record.raidId)) {
        map.set(record.raidId, {
          id: record.raidId,
          title: record.title || record.raidId,
          phase: record.phase || inferPhase(record.title || record.raidId),
          url: record.url || ""
        });
      }
    });
    return Array.from(map.values()).sort(compareLogDateDesc);
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

  function renderTypeFilter(values) {
    const current = selectedTypeValues();
    const orderedValues = ["SR", "MS", "OS", "DE"]
      .filter((mode) => values.includes(mode))
      .concat(values.filter((mode) => !["SR", "MS", "OS", "DE"].includes(mode)));
    els.typeFilter.innerHTML = "";
    const all = typeChoice("ALL", "", current.length === 0);
    els.typeFilter.append(all);
    orderedValues.forEach((value) => {
      els.typeFilter.append(typeChoice(value, value, current.includes(value)));
    });
  }

  function typeChoice(label, value, checked) {
    const wrap = document.createElement("label");
    wrap.className = "typeChoice";
    wrap.classList.add(value ? `type${String(value).replace(/[^A-Za-z0-9]/g, "")}` : "typeAll");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = value;
    input.checked = checked;
    const span = document.createElement("span");
    span.textContent = label;
    wrap.append(input, span);
    return wrap;
  }

  function selectedTypeValues() {
    const allChecked = els.typeFilter.querySelector('input[value=""]')?.checked;
    if (allChecked) return [];
    return Array.from(els.typeFilter.querySelectorAll('input[type="checkbox"]:checked'))
      .map((input) => input.value)
      .filter(Boolean);
  }

  function render() {
    syncSearchControl();
    const selectedPhase = els.phaseSelect.value;
    const selectedRaidId = els.raidSelect.value;
    const selectedTypes = selectedTypeValues();
    const winnerQuery = els.winnerFilter.value.trim().toLowerCase();
    const selectedRaid = (isLogView() ? attendanceRaidOptions() : lootRaidOptions()).find((raid) => raid.id === selectedRaidId);
    const rows = model.winners.filter((row) => {
      if (selectedPhase && row.phase !== selectedPhase) return false;
      if (selectedRaidId && row.raidId !== selectedRaidId) return false;
      if (selectedTypes.length && !selectedTypes.includes(displayMode(row.mode))) return false;
      if (winnerQuery && !String(row.winner).toLowerCase().includes(winnerQuery)) return false;
      return true;
    });
    const groups = buildLootGroups(rows);

    if (activeView === "attendance") {
      const allAttendanceRecords = model.attendance.filter((record) => {
        if (selectedPhase && record.phase !== selectedPhase) return false;
        if (selectedRaidId && record.raidId !== selectedRaidId) return false;
        return true;
      }).sort(compareLogDateDesc);
      const attendanceRecords = selectedRaidId ? allAttendanceRecords : applyAttendanceRange(allAttendanceRecords);
      const roster = attendanceRoster(selectedPhase);
      const marks = attendanceRecords.reduce((sum, record) => sum + record.players.length, 0);
      setSummaryLabels("Players", "Marks", "Raids");
      els.raidTitle.textContent = selectedRaid
        ? `${selectedRaid.title} attendance`
        : selectedPhase ? `${phaseLabel(selectedPhase)} attendance` : "Attendance";
      els.statPlayers.textContent = roster.length;
      els.statItems.textContent = marks;
      els.statRaids.textContent = attendanceRecords.length;
      renderAttendance(attendanceRecords, roster, selectedRaidId, winnerQuery);
      return;
    }

    if (activeView === "performance") {
      const allPerformanceRecords = model.attendance.filter((record) => {
        if (selectedPhase && record.phase !== selectedPhase) return false;
        if (selectedRaidId && record.raidId !== selectedRaidId) return false;
        return true;
      }).sort(compareLogDateDesc);
      const performanceRecords = selectedRaidId ? allPerformanceRecords : applyAttendanceRange(allPerformanceRecords);
      syncPerformanceBossFilter(performanceRecords);
      const roster = attendanceRoster(selectedPhase);
      const players = performanceRows(performanceRecords, roster, winnerQuery, performanceRequiresMinBosses(), performanceBossFilter);
      const samples = performanceBossEntries(performanceRecords, performanceBossFilter).reduce((sum, entry) => sum + entry.boss.performance.length, 0);
      setSummaryLabels("Players", "Boss samples", "Logs");
      els.raidTitle.textContent = selectedRaid
        ? `${selectedRaid.title} performance`
        : selectedPhase ? `${phaseLabel(selectedPhase)} performance` : "Performance";
      els.statPlayers.textContent = players.length;
      els.statItems.textContent = samples;
      els.statRaids.textContent = performanceRecords.length;
      renderPerformance(performanceRecords, players, selectedRaidId);
      return;
    }

    setSummaryLabels("Players", "Items", "Raids saved");
    els.raidTitle.textContent = selectedRaid ? selectedRaid.title : selectedPhase ? phaseLabel(selectedPhase) : selectedRaidId || "All raids";
    els.statPlayers.textContent = groups.length;
    els.statItems.textContent = rows.length;
    els.statRaids.textContent = selectedRaidId ? (rows.length ? 1 : 0) : unique(rows.map((row) => row.raidId)).length;
    renderSummary(groups);
    refreshWowheadLinks();
  }

  function syncSearchControl() {
    if (els.winnerLabel) els.winnerLabel.textContent = isLogView() ? "Player" : "Winner";
    els.winnerFilter.placeholder = isLogView() ? "All players" : "All winners";
  }

  function setSummaryLabels(players, items, raids) {
    if (els.statPlayersLabel) els.statPlayersLabel.textContent = players;
    if (els.statItemsLabel) els.statItemsLabel.textContent = items;
    if (els.statRaidsLabel) els.statRaidsLabel.textContent = raids;
  }

  function isLogView() {
    return activeView === "attendance" || activeView === "performance";
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

  function normalizeAttendance(rows) {
    return ensureArray(rows)
      .map((record) => {
        const title = record.title || raidTitle(record.raidId) || record.raidId || "";
        return {
          raidId: record.raidId || "",
          title,
          phase: record.phase || raidPhase(record.raidId) || inferPhase(title),
          source: record.source || "addon",
          url: record.url || "",
          fetchedAt: record.fetchedAt || "",
          players: unique(ensureArray(record.players).map((name) => String(name || "").trim()).filter(Boolean)).sort((a, b) => a.localeCompare(b)),
          skipped: unique(ensureArray(record.skipped).map((name) => String(name || "").trim()).filter(Boolean)).sort((a, b) => a.localeCompare(b)),
          performance: normalizePerformance(record.performance, numberValue(record.minDamageOrHealing) >= 200000),
          bosses: normalizeBosses(record.bosses, numberValue(record.minDamageOrHealing) >= 200000),
          bossCount: Math.max(1, Math.trunc(numberValue(record.bossCount) || ensureArray(record.bosses).length || 1)),
          error: record.error || ""
        };
      })
      .filter((record) => record.raidId || record.url);
  }

  function normalizePerformance(rows, legacyTakenAsDamage = false) {
    return ensureArray(rows)
      .filter((row) => row && typeof row === "object")
      .map((row) => normalizePerformanceMetric(row, legacyTakenAsDamage))
      .filter((row) => row.name);
  }

  function normalizePerformanceMetric(row, legacyTakenAsDamage = false) {
    const metric = {
      name: String(row.name || row.player || "").trim(),
      dps: numberValue(row.dps),
      hps: numberValue(row.hps),
      damageDone: numberValue(row.damageDone),
      healingDone: numberValue(row.healingDone),
      damageTaken: numberValue(row.damageTaken),
      damageTakenPerSecond: numberValue(row.damageTakenPerSecond || row.dtps),
      className: String(row.className || row.class || "").trim(),
      spec: String(row.spec || "").trim()
    };
    if (legacyTakenAsDamage && !metric.dps && !metric.hps && !metric.damageDone && metric.damageTaken > 0) {
      metric.damageDone = metric.damageTaken;
      metric.damageTaken = 0;
    }
    return metric;
  }

  function normalizeBosses(rows, legacyTakenAsDamage = false) {
    return ensureArrayObject(rows)
      .filter((row) => row && typeof row === "object")
      .map((row) => ({
        name: String(row.name || "").trim(),
        mode: String(row.mode || "").trim(),
        duration: String(row.duration || "").trim(),
        url: String(row.url || "").trim(),
        players: unique(ensureArray(row.players).map((name) => String(name || "").trim()).filter(Boolean)).sort((a, b) => a.localeCompare(b)),
        skipped: unique(ensureArray(row.skipped).map((name) => String(name || "").trim()).filter(Boolean)).sort((a, b) => a.localeCompare(b)),
        performance: normalizePerformance(row.performance, legacyTakenAsDamage),
        error: row.error || ""
      }))
      .filter((row) => row.name || row.performance.length);
  }

  function mergeAttendancePlayerInfo(attendanceRecords) {
    if (!model?.playerInfo) return;
    const mergeMetric = (metric) => {
      if (!metric?.name) return;
      const className = String(metric.className || "").trim();
      const spec = String(metric.spec || "").trim();
      if (!className && !spec) return;
      const key = normalizeName(metric.name);
      if (!key) return;
      const existing = model.playerInfo.get(key) || { name: metric.name, className: "", spec: "" };
      model.playerInfo.set(key, {
        ...existing,
        name: existing.name || metric.name,
        className: existing.className || className,
        spec: existing.spec || spec
      });
    };

    ensureArray(attendanceRecords).forEach((record) => {
      ensureArray(record.performance).forEach(mergeMetric);
      ensureArray(record.bosses).forEach((boss) => ensureArray(boss.performance).forEach(mergeMetric));
    });
  }

  function ensureArrayObject(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return [value];
    return [];
  }

  function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function attendanceRoster(selectedPhase = "") {
    const names = [];
    model.winners.forEach((row) => {
      if (selectedPhase && row.phase !== selectedPhase) return;
      if (row.winner && !isDisenchantName(row.winner)) names.push(row.winner);
    });
    model.attendance.forEach((record) => {
      if (selectedPhase && record.phase !== selectedPhase) return;
      record.players.forEach((name) => names.push(name));
    });
    return unique(names).sort((a, b) => a.localeCompare(b));
  }

  function renderAttendance(records, roster, selectedRaidId, playerQuery = "") {
    els.summaryList.innerHTML = "";
    if (!records.length) {
      els.summaryList.append(empty("No attendance logs for this raid/filter yet."));
      return;
    }

    const fragment = document.createDocumentFragment();
    if (selectedRaidId) {
      records.forEach((record) => fragment.append(attendanceRaidCard(record, roster, false, playerQuery)));
    } else {
      fragment.append(attendanceOverviewCard(records, roster, playerQuery));
      records.forEach((record) => fragment.append(attendanceRaidCard(record, roster, true, playerQuery)));
    }
    els.summaryList.append(fragment);
  }

  function renderPerformance(records, players, selectedRaidId) {
    els.summaryList.innerHTML = "";
    if (!records.length) {
      els.summaryList.append(empty("No performance logs for this raid/filter yet."));
      return;
    }

    if (!records.some((record) => record.performance.length)) {
      els.summaryList.append(empty("No performance metrics saved yet. Run update.ps1 -RefreshAttendance when uwu logs are available."));
      return;
    }

    const card = document.createElement("article");
    card.className = "lootCard performanceCard";
    const header = document.createElement("div");
    header.className = "lootCardHeader";
    const title = document.createElement("h3");
    title.textContent = selectedRaidId ? "Raid performance" : "All raids performance";
    const stats = document.createElement("div");
    stats.className = "lootCardStats";
    const count = document.createElement("strong");
    count.className = "countBadge";
    count.textContent = `${records.length} log${records.length === 1 ? "" : "s"}`;
    stats.append(count);
    header.append(title, stats);

    const table = document.createElement("div");
    table.className = "performanceTable";
    table.append(performanceHeaderRow());
    sortPerformanceRows(players).forEach((player) => table.append(performanceRow(player)));
    if (table.children.length === 1) {
      table.append(empty("No players match this search."));
    }

    card.append(header, performanceControls(records), table);
    els.summaryList.append(card);
  }

  function syncPerformanceBossFilter(records) {
    if (performanceBossFilter === "all") return;
    const selected = normalizeName(performanceBossFilter);
    const hasBoss = availablePerformanceBosses(records).some((boss) => normalizeName(boss) === selected);
    if (!hasBoss) performanceBossFilter = "all";
  }

  function availablePerformanceBosses(records) {
    return unique(records.flatMap((record) => ensureArray(record.bosses).map((boss) => String(boss.name || "").trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));
  }

  function performanceRequiresMinBosses() {
    return attendanceRange !== "last" && performanceBossFilter === "all";
  }

  function performanceRows(records, roster, playerQuery = "", requireMinBosses = true, bossFilter = "all") {
    const bossEntries = performanceBossEntries(records, bossFilter);
    const isBossFiltered = bossFilter !== "all";
    const totalCount = isBossFiltered ? bossEntries.length : records.length;
    const map = new Map();
    const get = (name) => {
      const key = normalizeName(name);
      if (!map.has(key)) {
        map.set(key, {
          name,
          attended: 0,
          total: totalCount,
          samples: 0,
          bossSamples: 0,
          bossDamageValues: [],
          dpsValues: [],
          bossHealingValues: [],
          hpsValues: [],
          takenPerSecondValues: [],
          instanceDamageValues: []
        });
      }
      return map.get(key);
    };

    filterNames(roster, playerQuery).forEach((name) => get(name));
    if (isBossFiltered) {
      bossEntries.forEach(({ boss }) => {
        boss.players.forEach((name) => {
          if (!playerQuery || normalizeName(name).includes(normalizeName(playerQuery))) get(name).attended += 1;
        });
      });
    } else {
      records.forEach((record) => {
        const present = new Set(record.players.map(normalizeName));
        present.forEach((key) => {
          const name = record.players.find((player) => normalizeName(player) === key) || key;
          if (!playerQuery || normalizeName(name).includes(normalizeName(playerQuery))) get(name).attended += 1;
        });
      });
    }

    records.forEach((record) => {
      const present = new Set(record.players.map(normalizeName));
      record.performance.forEach((metric) => {
        if (playerQuery && !normalizeName(metric.name).includes(normalizeName(playerQuery))) return;
        if (!present.has(normalizeName(metric.name))) return;
        if (isBossFiltered && !playerWasOnBossInRecord(record, metric.name, bossFilter)) return;
        const row = get(metric.name);
        if (metric.damageDone > 0) row.instanceDamageValues.push(metric.damageDone);
      });
    });

    bossEntries.forEach(({ boss }) => {
      const present = new Set(boss.players.map(normalizeName));
      boss.performance.forEach((metric) => {
        if (playerQuery && !normalizeName(metric.name).includes(normalizeName(playerQuery))) return;
        if (!present.has(normalizeName(metric.name))) return;
        const row = get(metric.name);
        const hasMetric = metric.dps || metric.hps || metric.damageTakenPerSecond || metric.damageTaken;
        if (hasMetric) row.samples += 1;
        row.bossSamples += 1;
        if (metric.damageDone > 0) row.bossDamageValues.push(metric.damageDone);
        if (metric.dps > 0) row.dpsValues.push(metric.dps);
        if (metric.healingDone > 0) row.bossHealingValues.push(metric.healingDone);
        if (metric.hps > 0) row.hpsValues.push(metric.hps);
        if (metric.damageTakenPerSecond > 0) row.takenPerSecondValues.push(metric.damageTakenPerSecond);
      });
    });

    return Array.from(map.values()).map((row) => {
      const percent = row.total ? Math.round((row.attended / row.total) * 100) : 0;
      return {
        ...row,
        percent,
        hasEnoughPerformance: !requireMinBosses || row.bossSamples >= PERFORMANCE_MIN_BOSSES,
        avgDamageDone: median(row.bossDamageValues),
        avgDps: median(row.dpsValues),
        avgHealingDone: median(row.bossHealingValues),
        avgHps: median(row.hpsValues),
        avgDamageTaken: median(row.takenPerSecondValues),
        avgInstanceDamage: median(row.instanceDamageValues)
      };
    }).filter((row) => row.attended || row.samples);
  }

  function performanceBossEntries(records, bossFilter = "all") {
    const filterKey = normalizeName(bossFilter);
    return records.flatMap((record) => ensureArray(record.bosses)
      .filter((boss) => bossFilter === "all" || normalizeName(boss.name) === filterKey)
      .map((boss) => ({ record, boss })));
  }

  function playerWasOnBossInRecord(record, playerName, bossFilter) {
    const playerKey = normalizeName(playerName);
    return performanceBossEntries([record], bossFilter)
      .some(({ boss }) => ensureArray(boss.players).some((name) => normalizeName(name) === playerKey));
  }

  function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function attendanceOverviewCard(records, roster, playerQuery = "") {
    const card = document.createElement("article");
    card.className = "lootCard attendanceCard";
    const header = document.createElement("div");
    header.className = "lootCardHeader";
    const title = document.createElement("h3");
    title.textContent = "All raids attendance";
    const stats = document.createElement("div");
    stats.className = "lootCardStats";
    const count = document.createElement("strong");
    count.className = "countBadge";
    count.textContent = `${records.length} log${records.length === 1 ? "" : "s"}`;
    const marks = document.createElement("p");
    marks.textContent = `${records.reduce((sum, record) => sum + record.players.length, 0)} attendance marks`;
    stats.append(count, marks);
    header.append(title, stats);

    const players = attendanceRows(records, roster, playerQuery);
    const visibleRows = sortAttendanceRows(players.filter(attendanceBucketMatch));
    const groups = document.createElement("div");
    groups.className = "attendanceGroups";

    const full = visibleRows.filter((row) => row.attended === row.total && row.total > 0);
    const partial = visibleRows.filter((row) => row.percent > 50 && row.attended < row.total);
    const low = visibleRows.filter((row) => row.attended > 0 && row.percent <= 50);
    const missing = visibleRows.filter((row) => row.attended === 0);
    if (!visibleRows.length) {
      groups.append(empty(playerQuery ? "No players match this search." : "No players match this attendance filter."));
    } else if (attendanceBucket === "all") {
      groups.append(attendanceGroupSection("Full attendance", full));
      groups.append(attendanceGroupSection("Partial attendance", partial));
      if (low.length) groups.append(attendanceGroupSection("Low attendance", low));
      if (missing.length) groups.append(attendanceGroupSection("No attendance", missing));
    } else {
      groups.append(attendanceGroupSection(attendanceBucketLabel(attendanceBucket), visibleRows));
    }

    card.append(header, attendanceControls(), groups);
    return card;
  }

  function attendanceRaidCard(record, roster, compact = false, playerQuery = "") {
    const card = document.createElement(compact ? "details" : "article");
    card.className = "lootCard attendanceCard";
    if (compact) card.classList.add("attendanceCardCompact");
    const raid = model.raids.find((item) => item.id === record.raidId);
    const titleText = raid ? raid.title : record.title || record.raidId || "Raid log";

    const header = document.createElement("div");
    header.className = "lootCardHeader";
    const titleWrap = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const meta = document.createElement("p");
    meta.className = "attendanceMeta";
    meta.textContent = record.error ? `Log error: ${record.error}` : `Fetched ${record.fetchedAt || "-"}`;
    titleWrap.append(title, meta);

    const stats = document.createElement("div");
    stats.className = "lootCardStats";
    const count = document.createElement("strong");
    count.className = "countBadge";
    count.textContent = `${record.players.length} present`;
    const linkLine = document.createElement("p");
    if (record.url) {
      const link = document.createElement("a");
      link.href = record.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Open log";
      linkLine.append(link);
    } else {
      linkLine.textContent = "No log URL";
    }
    stats.append(count, linkLine);
    header.append(titleWrap, stats);

    const presentSet = new Set(record.players.map(normalizeName));
    const missing = roster.filter((name) => !presentSet.has(normalizeName(name)));
    const body = document.createElement("div");
    body.className = "attendanceBody";
    if (compact) {
      const summary = document.createElement("summary");
      summary.className = "attendanceCardSummary";
      summary.append(header);
      body.append(attendancePeopleBlock("Present", filterNames(record.players, playerQuery), "present"));
      body.append(attendancePeopleBlock("Missing", filterNames(missing, playerQuery), "missing"));
      card.append(summary, body);
      return card;
    }
    body.append(attendancePeopleBlock("Present", filterNames(record.players, playerQuery), "present"));
    body.append(attendancePeopleBlock("Missing", filterNames(missing, playerQuery), "missing"));
    card.append(header, body);
    return card;
  }

  function attendanceRows(records, roster, playerQuery = "") {
    return filterNames(roster, playerQuery).map((name) => {
      const attended = records.filter((record) => record.players.some((player) => normalizeName(player) === normalizeName(name))).length;
      const total = records.length;
      const missed = Math.max(0, total - attended);
      const percent = total ? Math.round((attended / total) * 100) : 0;
      return { name, attended, total, missed, percent };
    });
  }

  function attendanceControls() {
    const controls = document.createElement("div");
    controls.className = "attendanceControls";

    const sortWrap = document.createElement("label");
    sortWrap.className = "attendanceSortControl";
    const sortText = document.createElement("span");
    sortText.textContent = "Sort";
    const sortSelect = document.createElement("select");
    [
      ["percent", "By %"],
      ["attended", "By attended"],
      ["name", "By name"]
    ].forEach(([value, label]) => {
      sortSelect.append(new Option(label, value));
    });
    sortSelect.value = attendanceSort;
    sortSelect.addEventListener("input", () => {
      attendanceSort = sortSelect.value;
      render();
    });
    sortWrap.append(sortText, sortSelect);

    const buckets = document.createElement("div");
    buckets.className = "attendanceBucketFilters";
    ["all", "full", "partial", "low", "missing"].forEach((bucket) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "attendanceBucket";
      button.classList.toggle("active", attendanceBucket === bucket);
      button.textContent = attendanceBucketLabel(bucket);
      button.addEventListener("click", () => {
        attendanceBucket = bucket;
        render();
      });
      buckets.append(button);
    });

    controls.append(sortWrap, rangeControls(), buckets);
    return controls;
  }

  function performanceControls(records) {
    const controls = document.createElement("div");
    controls.className = "attendanceControls performanceControls";

    const sortWrap = document.createElement("label");
    sortWrap.className = "attendanceSortControl";
    const sortText = document.createElement("span");
    sortText.textContent = "Sort";
    const sortSelect = document.createElement("select");
    [
      ["dps", "By DPS"],
      ["damage", "By dmg"],
      ["hps", "By HPS"],
      ["heal", "By heal"],
      ["taken", "By taken"],
      ["instance", "By inst dmg"],
      ["attendance", "By attendance"],
      ["name", "By name"]
    ].forEach(([value, label]) => {
      sortSelect.append(new Option(label, value));
    });
    if (!["dps", "damage", "hps", "heal", "taken", "instance", "attendance", "name"].includes(performanceSort)) performanceSort = "dps";
    sortSelect.value = performanceSort;
    sortSelect.addEventListener("input", () => {
      performanceSort = sortSelect.value;
      render();
    });
    sortWrap.append(sortText, sortSelect);

    const bossWrap = document.createElement("label");
    bossWrap.className = "attendanceSortControl";
    const bossText = document.createElement("span");
    bossText.textContent = "Boss";
    const bossSelect = document.createElement("select");
    bossSelect.append(new Option("All bosses", "all"));
    availablePerformanceBosses(records).forEach((boss) => bossSelect.append(new Option(boss, boss)));
    bossSelect.value = performanceBossFilter;
    bossSelect.addEventListener("input", () => {
      performanceBossFilter = bossSelect.value;
      render();
    });
    bossWrap.append(bossText, bossSelect);

    controls.append(sortWrap, bossWrap, rangeControls());
    return controls;
  }

  function rangeControls() {
    const wrap = document.createElement("div");
    wrap.className = "attendanceRangeControl";
    const all = rangeButton("All time", "all");
    const last = rangeButton("Last", "last");
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "999";
    input.value = String(attendanceLimit);
    input.addEventListener("input", () => {
      const value = Math.max(1, Math.min(999, Number(input.value) || 1));
      attendanceLimit = value;
      attendanceRange = "last";
      render();
    });
    wrap.append(all, last, input);
    return wrap;
  }

  function rangeButton(label, value) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "attendanceRangeButton";
    button.classList.toggle("active", attendanceRange === value);
    button.textContent = label;
    button.addEventListener("click", () => {
      attendanceRange = value;
      render();
    });
    return button;
  }

  function applyAttendanceRange(records) {
    if (attendanceRange !== "last") return records;
    return records.slice(0, Math.max(1, attendanceLimit));
  }

  function performanceHeaderRow() {
    const row = document.createElement("div");
    row.className = "performanceRow performanceHeader";
    ["Player", "Att", "Med dmg", "Med DPS", "Med heal", "Med HPS", "Med taken/s", "Med inst dmg"].forEach((label) => {
      const cell = document.createElement("span");
      cell.textContent = label;
      row.append(cell);
    });
    return row;
  }

  function performanceRow(player) {
    const row = document.createElement("div");
    row.className = "performanceRow";
    const nameCell = document.createElement("span");
    nameCell.className = "attendanceName";
    const token = playerClassToken(player.name);
    if (token) nameCell.classList.add(`class${token}`);
    nameCell.textContent = player.name;

    const attendance = document.createElement("strong");
    attendance.textContent = `${player.attended}/${player.total} (${player.percent}%)`;
    attendance.title = `${player.bossSamples} boss kills counted`;
    const damage = document.createElement("span");
    damage.textContent = player.hasEnoughPerformance ? (player.avgDamageDone ? formatNumber(player.avgDamageDone) : "-") : "Not enough data";
    if (!player.hasEnoughPerformance) {
      damage.className = "performanceInsufficient";
      damage.title = `${player.bossSamples}/${PERFORMANCE_MIN_BOSSES} boss kills counted`;
    }
    const heal = document.createElement("span");
    heal.textContent = player.hasEnoughPerformance ? (player.avgHealingDone ? formatNumber(player.avgHealingDone) : "-") : "-";
    const dps = document.createElement("span");
    dps.textContent = player.hasEnoughPerformance ? (player.avgDps ? formatNumber(player.avgDps) : "-") : "-";
    const hps = document.createElement("span");
    hps.textContent = player.hasEnoughPerformance ? (player.avgHps ? formatNumber(player.avgHps) : "-") : "-";
    const taken = document.createElement("span");
    taken.textContent = player.hasEnoughPerformance ? (player.avgDamageTaken ? formatNumber(player.avgDamageTaken) : "-") : "-";
    const instanceDamage = document.createElement("span");
    instanceDamage.textContent = player.hasEnoughPerformance ? (player.avgInstanceDamage ? formatNumber(player.avgInstanceDamage) : "-") : "-";
    row.append(nameCell, attendance, damage, dps, heal, hps, taken, instanceDamage);
    return row;
  }

  function sortPerformanceRows(rows) {
    return rows.sort((a, b) => {
      if (performanceSort === "name") return a.name.localeCompare(b.name);
      if (performanceSort === "attendance") return b.percent - a.percent || b.attended - a.attended || a.name.localeCompare(b.name);
      if (a.hasEnoughPerformance !== b.hasEnoughPerformance) return Number(b.hasEnoughPerformance) - Number(a.hasEnoughPerformance);
      if (performanceSort === "dps") return b.avgDps - a.avgDps || b.avgDamageDone - a.avgDamageDone || a.name.localeCompare(b.name);
      if (performanceSort === "heal") return b.avgHealingDone - a.avgHealingDone || b.avgDamageDone - a.avgDamageDone || a.name.localeCompare(b.name);
      if (performanceSort === "hps") return b.avgHps - a.avgHps || b.avgHealingDone - a.avgHealingDone || a.name.localeCompare(b.name);
      if (performanceSort === "taken") return b.avgDamageTaken - a.avgDamageTaken || b.avgDamageDone - a.avgDamageDone || a.name.localeCompare(b.name);
      if (performanceSort === "instance") return b.avgInstanceDamage - a.avgInstanceDamage || b.avgDamageDone - a.avgDamageDone || a.name.localeCompare(b.name);
      return b.avgDamageDone - a.avgDamageDone || b.avgHealingDone - a.avgHealingDone || a.name.localeCompare(b.name);
    });
  }

  function formatNumber(value) {
    return Math.round(value).toLocaleString("en-US");
  }

  function filterNames(names, query) {
    const value = normalizeName(query);
    if (!value) return names;
    return names.filter((name) => normalizeName(name).includes(value));
  }

  function sortAttendanceRows(rows) {
    return rows.sort((a, b) => {
      if (attendanceSort === "name") return a.name.localeCompare(b.name);
      if (attendanceSort === "attended") return b.attended - a.attended || b.percent - a.percent || a.name.localeCompare(b.name);
      return b.percent - a.percent || b.attended - a.attended || a.name.localeCompare(b.name);
    });
  }

  function attendanceBucketMatch(row) {
    if (attendanceBucket === "full") return row.percent === 100;
    if (attendanceBucket === "partial") return row.percent > 50 && row.percent < 100;
    if (attendanceBucket === "low") return row.percent > 0 && row.percent <= 50;
    if (attendanceBucket === "missing") return row.percent === 0;
    return true;
  }

  function attendanceBucketLabel(bucket) {
    return {
      all: "All",
      full: "Full",
      partial: "Partial",
      low: "Low",
      missing: "Missing"
    }[bucket] || "All";
  }

  function compareLogDateDesc(a, b) {
    const diff = logTimestamp(b) - logTimestamp(a);
    if (diff) return diff;
    return logLabel(b).localeCompare(logLabel(a));
  }

  function logTimestamp(record) {
    const urlDate = String(record.url || "").match(/\/reports\/(\d{2})-(\d{2})-(\d{2})--(\d{2})-(\d{2})/i);
    if (urlDate) {
      const [, yy, month, day, hour, minute] = urlDate;
      return Date.UTC(2000 + Number(yy), Number(month) - 1, Number(day), Number(hour), Number(minute));
    }

    const labelDate = logLabel(record).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (labelDate) {
      const [, day, month, year] = labelDate;
      return Date.UTC(Number(year), Number(month) - 1, Number(day));
    }

    const isoDate = logLabel(record).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (isoDate) {
      const [, year, month, day, hour = "0", minute = "0"] = isoDate;
      return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
    }

    return 0;
  }

  function logLabel(record) {
    return String(record.title || record.raidId || record.id || record.finalizedAt || "");
  }

  function attendanceGroupSection(title, rows) {
    const section = document.createElement("section");
    section.className = "attendanceGroupSection";
    const heading = document.createElement("h4");
    heading.textContent = `${title} (${rows.length})`;
    const table = document.createElement("div");
    table.className = "attendanceTable";
    rows.forEach((row) => table.append(attendanceRow(row)));
    section.append(heading, table);
    return section;
  }

  function attendancePeopleBlock(title, names, kind) {
    const block = document.createElement("section");
    block.className = "attendanceBlock";
    const heading = document.createElement("h4");
    heading.textContent = `${title} (${names.length})`;
    const list = document.createElement("div");
    list.className = "attendancePeople";
    names.forEach((name) => {
      const item = document.createElement("span");
      item.className = `attendancePerson ${kind}`;
      const token = playerClassToken(name);
      if (token) item.classList.add(`class${token}`);
      item.textContent = name;
      list.append(item);
    });
    block.append(heading, list);
    return block;
  }

  function attendanceCompactStats(present, missing, total) {
    const stats = document.createElement("div");
    stats.className = "attendanceCompactStats";
    [
      ["Present", present, "present"],
      ["Missing", missing, "missing"],
      ["Roster", total, "total"]
    ].forEach(([label, value, kind]) => {
      const item = document.createElement("span");
      item.className = `attendanceCompactStat ${kind}`;
      item.textContent = `${label}: ${value}`;
      stats.append(item);
    });
    return stats;
  }

  function attendanceRow(player) {
    const row = document.createElement("div");
    row.className = "attendanceRow";
    row.classList.add(player.percent === 100 ? "full" : player.percent === 0 ? "none" : "partial");
    const nameCell = document.createElement("span");
    nameCell.className = "attendanceName";
    const token = playerClassToken(player.name);
    if (token) nameCell.classList.add(`class${token}`);
    nameCell.textContent = player.name;
    const countCell = document.createElement("strong");
    countCell.textContent = `${player.attended}/${player.total}`;
    const percentCell = document.createElement("span");
    percentCell.textContent = `${player.percent}%`;
    row.append(nameCell, countCell, percentCell);
    return row;
  }

  function isDisenchantName(name) {
    const key = normalizeName(name);
    return key === "disenchant" || key === "disenchant items";
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
    const playerName = document.createElement("a");
    playerName.className = "playerName playerLink";
    playerName.href = armoryUrl(group.name);
    playerName.target = "_blank";
    playerName.rel = "noreferrer";
    playerName.title = `Open ${group.name} on Warmane Armory`;
    playerName.textContent = group.name;
    name.append(playerName);
    if (mainSpec) {
      const specText = document.createElement("span");
      specText.className = `playerSpec class${classToken(group.className)}`;
      specText.textContent = ` - ${mainSpec}`;
      name.append(specText);
    }
    titleWrap.append(name);

    const stats = document.createElement("div");
    stats.className = "lootCardStats";
    const count = document.createElement("strong");
    count.className = "countBadge";
    count.textContent = `count ${group.items.length}`;
    const meta = document.createElement("p");
    meta.textContent = modeSummary(group.modeCounts);
    stats.append(count, meta);
    header.append(titleWrap, stats);

    const list = document.createElement("div");
    list.className = "lootLines";
    group.items.forEach((item) => list.append(lootLine(item)));

    card.append(header, list);
    return card;
  }

  function lootLine(item) {
    const row = document.createElement("div");
    row.className = "lootLine";

    const slot = document.createElement("span");
    slot.className = "slotName";
    slot.textContent = `${item.slot || "Other"}:`;

    const itemName = item.itemId ? document.createElement("a") : document.createElement("span");
    itemName.className = "itemName";
    itemName.textContent = `[${item.item || "Unknown item"}]`;
    if (item.itemId) {
      itemName.href = `https://www.wowhead.com/wotlk/item=${item.itemId}`;
      itemName.target = "_blank";
      itemName.rel = "noreferrer";
      itemName.dataset.wowhead = `item=${item.itemId}`;
    }

    const mode = document.createElement("span");
    mode.className = `lootMode mode${String(item.mode || "").replace(/[^A-Za-z0-9]/g, "")}`;
    mode.textContent = item.mode || "Other";

    const date = document.createElement("span");
    date.className = "lootDate";
    date.textContent = item.date || "-";

    row.append(slot, itemName, mode, date);
    return row;
  }

  function refreshWowheadLinks() {
    if (window.$WowheadPower && typeof window.$WowheadPower.refreshLinks === "function") {
      window.$WowheadPower.refreshLinks();
    }
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

  function classToken(className) {
    return String(className || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
  }

  function playerClassToken(name) {
    const info = model.playerInfo?.get(normalizeName(name));
    return classToken(info?.className || "");
  }

  function armoryUrl(name) {
    return `https://armory.warmane.com/character/${encodeURIComponent(name)}/Onyxia`;
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

  els.phaseSelect.addEventListener("input", () => {
    renderRaidFilter();
    render();
  });
  [els.raidSelect, els.winnerFilter].forEach((control) => control.addEventListener("input", render));
  els.typeFilter.addEventListener("change", (event) => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    const allInput = els.typeFilter.querySelector('input[value=""]');
    const modeInputs = Array.from(els.typeFilter.querySelectorAll('input[type="checkbox"]')).filter((item) => item.value);

    if (!input.value && input.checked) {
      modeInputs.forEach((item) => {
        item.checked = false;
      });
    } else if (input.value && input.checked && allInput) {
      allInput.checked = false;
    }

    if (allInput && !allInput.checked && modeInputs.every((item) => !item.checked)) {
      allInput.checked = true;
    }

    render();
  });
  els.viewTabs.forEach((button) => {
    button.addEventListener("click", () => {
      activeView = button.dataset.view || "loot";
      els.viewTabs.forEach((item) => item.classList.toggle("active", item === button));
      renderRaidFilter();
      render();
    });
  });

  const payload = window.SOFTRES_PAYLOAD;
  const payloadLua = typeof payload?.lua === "string" ? payload.lua : payload?.lua?.value;
  if (payload && payloadLua) {
    loadLua(payloadLua, "Guild raid loot history", payload.defaultCsv || "", payload.attendance || []);
  } else {
    setStatus("No generated data found. Run update-site.bat to rebuild assets/data.js.");
    els.sourceMeta.textContent = "Waiting for SoftResRoller.lua";
  }
})();
