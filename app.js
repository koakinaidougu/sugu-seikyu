"use strict";

const PARAMS = {
  // 税率は百分率の整数(percent)で保持し、除算時のみ行う。小数rateを直接掛けると
  // 浮動小数誤差でMath.floorの結果が1円ずれることがあるため。
  taxRates: [
    { id: "r10", label: "10%", percent: 10 },
    { id: "r8", label: "8%(軽減)", percent: 8 },
    { id: "r0", label: "対象外", percent: 0 },
  ],
  withholding: { rateLow: 0.1021, rateHigh: 0.2042, threshold: 1000000, fixedOverThreshold: 102100 },
  freeLimits: { clients: 3, docs: 5, banks: 1 },
  logoMaxBytes: 512000,
};
// リリース前に本番コードのSHA-256ハッシュへ差し替える（平文コードはリポジトリに含めない）
const PRO_CODE_HASHES = [
  "5ebacf2e89cec53bd5cdf1529830ac86c7ecb974144b997b9fa1f09a33c33dd1",
];

const DOC_TYPE_INFO = {
  invoice: { title: "請求書", grandLabel: "ご請求金額", dateLabel: "支払期限", isReceipt: false },
  estimate: { title: "御見積書", grandLabel: "御見積金額", dateLabel: "有効期限", isReceipt: false },
  delivery: { title: "納品書", grandLabel: "合計金額", dateLabel: "納品日", isReceipt: false },
  receipt: { title: "領収書", grandLabel: "領収金額", dateLabel: "", isReceipt: true },
};

/* ===================== localStorage層 ===================== */

let storageAvailable = true;

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      storageAvailable = false;
      showSaveBanner();
      return false;
    }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* noop */ }
  },
};

function showSaveBanner() {
  const banner = document.getElementById("save-banner");
  if (banner) banner.hidden = false;
}

let toastTimer = null;
function showToast(message) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("toast-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("toast-visible"), 2200);
}

function checkStorageAvailable() {
  try {
    const testKey = "sq_storage_test";
    localStorage.setItem(testKey, "1");
    localStorage.removeItem(testKey);
    return true;
  } catch (e) {
    return false;
  }
}

const ALL_KEYS = ["sq_meta", "sq_issuer", "sq_clients", "sq_banks", "sq_docs", "sq_settings", "sq_pro"];

function migrate(fromVersion) {
  // schemaVersion 1が現行の唯一の版。将来の版上げ時にここへ変換処理を追加する。
}

function ensureMeta() {
  const meta = store.get("sq_meta", null);
  if (!meta) {
    store.set("sq_meta", { schemaVersion: 1 });
  } else if (meta.schemaVersion !== 1) {
    migrate(meta.schemaVersion);
  }
}

/* ===================== 計算ロジック ===================== */

function floorSafe(n) {
  return Math.floor(n + 1e-9);
}

function calcItemAmount(qty, unitPrice) {
  const q = Math.max(0, Number(qty) || 0);
  const p = Math.max(0, Number(unitPrice) || 0);
  return Math.floor(q * p);
}

function calcTotals(items, taxMode, withholdingOn) {
  const groups = {};
  for (const r of PARAMS.taxRates) groups[r.id] = { percent: r.percent, label: r.label, raw: 0, hasItems: false };

  for (const item of items) {
    const amount = calcItemAmount(item.qty, item.unitPrice);
    const g = groups[item.taxId] || groups.r0;
    g.raw += amount;
    g.hasItems = true;
  }

  let subtotal = 0;
  let tax = 0;
  const breakdown = [];
  for (const r of PARAMS.taxRates) {
    const g = groups[r.id];
    if (!g.hasItems) continue;
    let groupTax, groupExclusive;
    if (taxMode === "incl") {
      groupTax = floorSafe((g.raw * g.percent) / (100 + g.percent));
      groupExclusive = g.raw - groupTax;
    } else {
      groupExclusive = g.raw;
      groupTax = floorSafe((g.raw * g.percent) / 100);
    }
    subtotal += groupExclusive;
    tax += groupTax;
    breakdown.push({ id: r.id, label: g.label, exclusive: groupExclusive, tax: groupTax });
  }

  let withholding = 0;
  if (withholdingOn) {
    const w = PARAMS.withholding;
    withholding = subtotal <= w.threshold
      ? floorSafe(subtotal * w.rateLow)
      : floorSafe((subtotal - w.threshold) * w.rateHigh) + w.fixedOverThreshold;
  }

  const grand = subtotal + tax - withholding;
  return { subtotal, tax, withholding, grand, breakdown };
}

function uid(prefix) {
  return prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

function yen(n) {
  return "¥" + Math.round(n).toLocaleString("ja-JP");
}

/* ===================== Pro状態 ===================== */

let proUnlocked = false;

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeProCode(raw) {
  return (raw || "").trim().toUpperCase();
}

function loadProStatus() {
  const pro = store.get("sq_pro", null);
  if (pro && pro.unlocked) {
    if (PRO_CODE_HASHES.includes(pro.codeHash)) {
      return { unlocked: true, rotated: false };
    }
    store.set("sq_pro", { unlocked: false, codeHash: null, activatedAt: null });
    return { unlocked: false, rotated: true };
  }
  return { unlocked: false, rotated: false };
}

async function activatePro(rawCode) {
  const trimmed = normalizeProCode(rawCode);
  if (!trimmed) return { ok: false, message: "コードを入力してください。" };
  const hash = await sha256Hex(trimmed);
  if (PRO_CODE_HASHES.includes(hash)) {
    store.set("sq_pro", { unlocked: true, codeHash: hash, activatedAt: Date.now() });
    proUnlocked = true;
    return { ok: true };
  }
  return { ok: false, message: "コードが正しくありません。購入時のファイルをご確認ください。" };
}

function updateProUI() {
  const badge = document.getElementById("pro-badge");
  const openBtn = document.getElementById("btn-open-pro");
  badge.hidden = !proUnlocked;
  openBtn.hidden = proUnlocked;

  document.getElementById("pro-status-text").textContent = proUnlocked
    ? "Pro版が有効です。"
    : "未解除です。";

  document.getElementById("pro-settings-group").hidden = !proUnlocked;
  document.getElementById("pro-logo-group").hidden = !proUnlocked;
  document.getElementById("pro-backup-group").hidden = !proUnlocked;
  document.getElementById("history-search").hidden = !proUnlocked;
}

/* ===================== タブ切替 ===================== */

const TABS = ["create", "history", "clients", "settings"];

function switchTab(tab) {
  if (!TABS.includes(tab)) tab = "create";
  for (const t of TABS) {
    document.getElementById("view-" + t).hidden = t !== tab;
  }
  for (const btn of document.querySelectorAll(".tab-btn")) {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
  }
  if (tab === "history") renderHistoryList();
  if (tab === "clients") renderClientsList();
  if (tab === "settings") renderBanksList();
}

function initTabs() {
  for (const btn of document.querySelectorAll(".tab-btn")) {
    btn.addEventListener("click", () => {
      location.hash = "#" + btn.dataset.tab;
    });
  }
  window.addEventListener("hashchange", () => {
    switchTab(location.hash.replace("#", "") || "create");
  });
  switchTab(location.hash.replace("#", "") || "create");
}

/* ===================== 品目行 ===================== */

function addItemRow(data) {
  const tpl = document.getElementById("item-row-template");
  const frag = tpl.content.cloneNode(true);
  const row = frag.querySelector(".item-row");
  if (data) {
    row.querySelector(".item-name").value = data.name || "";
    row.querySelector(".item-qty").value = data.qty != null ? data.qty : 1;
    row.querySelector(".item-price").value = data.unitPrice != null ? data.unitPrice : 0;
    row.querySelector(".item-tax").value = data.taxId || "r10";
  }
  document.getElementById("items-tbody").appendChild(frag);
  updateItemsWarning();
}

function clearItemRows() {
  document.getElementById("items-tbody").innerHTML = "";
}

function updateItemsWarning() {
  const count = document.querySelectorAll("#items-tbody .item-row").length;
  document.getElementById("items-warning").hidden = count <= 20;
}

function getItemsFromForm() {
  const rows = document.querySelectorAll("#items-tbody .item-row");
  const items = [];
  for (const row of rows) {
    const qtyInput = row.querySelector(".item-qty");
    const priceInput = row.querySelector(".item-price");
    const qty = Number(qtyInput.value);
    const price = Number(priceInput.value);
    qtyInput.classList.toggle("field-invalid", isNaN(qty) || qty < 0);
    priceInput.classList.toggle("field-invalid", isNaN(price) || price < 0);
    items.push({
      name: row.querySelector(".item-name").value,
      qty: qty,
      unitPrice: price,
      taxId: row.querySelector(".item-tax").value,
    });
  }
  return items;
}

function initItemsTableEvents() {
  const tbody = document.getElementById("items-tbody");
  tbody.addEventListener("input", renderPreview);
  tbody.addEventListener("change", renderPreview);
  tbody.addEventListener("click", (e) => {
    const row = e.target.closest(".item-row");
    if (!row) return;
    if (e.target.classList.contains("item-del")) {
      row.remove();
      updateItemsWarning();
      renderPreview();
    } else if (e.target.classList.contains("item-up")) {
      const prev = row.previousElementSibling;
      if (prev) tbody.insertBefore(row, prev);
      renderPreview();
    } else if (e.target.classList.contains("item-down")) {
      const next = row.nextElementSibling;
      if (next) tbody.insertBefore(next, row);
      renderPreview();
    }
  });
  document.getElementById("btn-add-item").addEventListener("click", () => {
    addItemRow(null);
    renderPreview();
  });
}

/* ===================== 作成タブ：フォーム↔プレビュー ===================== */

let editingDocId = null;

function currentDocTypeInfo() {
  const type = document.getElementById("f-doctype").value;
  return DOC_TYPE_INFO[type] || DOC_TYPE_INFO.invoice;
}

function gatherFormDoc() {
  const type = document.getElementById("f-doctype").value;
  const taxMode = document.getElementById("f-taxmode-incl").checked ? "incl" : "excl";
  const withholding = document.getElementById("f-withholding").checked;
  const items = getItemsFromForm();
  const totals = calcTotals(items, taxMode, withholding);
  return {
    id: editingDocId,
    type,
    docNo: document.getElementById("f-doc-no").value,
    issueDate: document.getElementById("f-issue-date").value,
    dueDate: document.getElementById("f-due-date").value,
    clientSnapshot: {
      name: document.getElementById("f-client-name").value,
      honorific: document.getElementById("f-client-honorific").value,
      zip: document.getElementById("f-client-zip").value,
      address: document.getElementById("f-client-address").value,
      person: document.getElementById("f-client-person").value,
    },
    items,
    taxMode,
    withholding,
    bankId: document.getElementById("f-bank-select").value,
    note: document.getElementById("f-note").value,
    totals: { subtotal: totals.subtotal, tax: totals.tax, withholding: totals.withholding, grand: totals.grand },
  };
}

function renderPreview() {
  const type = document.getElementById("f-doctype").value;
  const info = DOC_TYPE_INFO[type] || DOC_TYPE_INFO.invoice;
  const taxMode = document.getElementById("f-taxmode-incl").checked ? "incl" : "excl";
  const withholdingOn = document.getElementById("f-withholding").checked;
  const items = getItemsFromForm();
  const totals = calcTotals(items, taxMode, withholdingOn);

  document.getElementById("sheet-title").textContent = info.title;
  document.getElementById("sheet-docno").textContent = document.getElementById("f-doc-no").value
    ? "No. " + document.getElementById("f-doc-no").value
    : "";

  const clientName = document.getElementById("f-client-name").value;
  const honorific = document.getElementById("f-client-honorific").value;
  document.getElementById("sheet-client-name").textContent = clientName ? clientName + " " + honorific : "";
  document.getElementById("sheet-client-address").textContent = document.getElementById("f-client-address").value;

  const dueDateVal = document.getElementById("f-due-date").value;
  const dueDateEl = document.getElementById("sheet-due-date");
  const expiryEl = document.getElementById("sheet-estimate-expiry");
  expiryEl.hidden = true;
  dueDateEl.hidden = true;
  if (dueDateVal && info.dateLabel) {
    if (type === "estimate") {
      expiryEl.hidden = false;
      expiryEl.textContent = info.dateLabel + "：" + dueDateVal;
    } else {
      dueDateEl.hidden = false;
      dueDateEl.textContent = info.dateLabel + "：" + dueDateVal;
    }
  }

  const issuer = store.get("sq_issuer", {});
  document.getElementById("sheet-issuer-name").textContent = issuer.name || "";
  document.getElementById("sheet-issuer-address").textContent = [issuer.zip, issuer.address].filter(Boolean).join(" ");
  document.getElementById("sheet-issuer-tel").textContent = issuer.tel ? "TEL " + issuer.tel : "";
  document.getElementById("sheet-issuer-invoiceno").textContent = issuer.invoiceNo ? "登録番号 " + issuer.invoiceNo : "";

  const settings = store.get("sq_settings", {});
  const logoEl = document.getElementById("sheet-logo");
  if (proUnlocked && settings.logoDataUrl) {
    logoEl.src = settings.logoDataUrl;
    logoEl.hidden = false;
  } else {
    logoEl.hidden = true;
  }
  const sealEl = document.getElementById("sheet-seal");
  if (proUnlocked && settings.sealDataUrl) {
    sealEl.src = settings.sealDataUrl;
    sealEl.hidden = false;
  } else {
    sealEl.hidden = true;
  }

  document.getElementById("sheet-grand-label").textContent = info.grandLabel;
  document.getElementById("sheet-grand-amount").textContent = yen(totals.grand);

  const itemsBody = document.getElementById("sheet-items-tbody");
  itemsBody.innerHTML = "";
  for (const item of items) {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = item.name;
    const tdQty = document.createElement("td");
    tdQty.textContent = String(item.qty);
    const tdPrice = document.createElement("td");
    tdPrice.textContent = yen(Math.max(0, Number(item.unitPrice) || 0));
    const tdAmount = document.createElement("td");
    tdAmount.textContent = yen(calcItemAmount(item.qty, item.unitPrice));
    tr.append(tdName, tdQty, tdPrice, tdAmount);
    itemsBody.appendChild(tr);
  }

  const breakdownBody = document.getElementById("sheet-taxbreakdown-tbody");
  breakdownBody.innerHTML = "";
  for (const g of totals.breakdown) {
    const tr = document.createElement("tr");
    const tdLabel = document.createElement("td");
    tdLabel.textContent = g.label;
    const tdExclusive = document.createElement("td");
    tdExclusive.textContent = yen(g.exclusive);
    const tdTax = document.createElement("td");
    tdTax.textContent = yen(g.tax);
    tr.append(tdLabel, tdExclusive, tdTax);
    breakdownBody.appendChild(tr);
  }
  document.getElementById("sheet-taxbreakdown").hidden = totals.breakdown.length === 0;

  document.getElementById("sheet-subtotal").textContent = yen(totals.subtotal);
  document.getElementById("sheet-tax").textContent = yen(totals.tax);
  const wRow = document.getElementById("sheet-withholding-row");
  wRow.hidden = !withholdingOn;
  document.getElementById("sheet-withholding").textContent = yen(totals.withholding);
  document.getElementById("sheet-taxmode-note").hidden = taxMode !== "incl";

  const receiptReason = document.getElementById("sheet-receipt-reason");
  const noteVal = document.getElementById("f-note").value;
  if (info.isReceipt) {
    receiptReason.hidden = false;
    document.getElementById("sheet-receipt-note").textContent = noteVal || "お品代";
  } else {
    receiptReason.hidden = true;
  }

  const banks = store.get("sq_banks", []);
  const bankId = document.getElementById("f-bank-select").value;
  const bank = banks.find((b) => b.id === bankId);
  document.getElementById("sheet-bank").textContent = !info.isReceipt && bank ? "お振込先：" + bank.label : "";
  document.getElementById("sheet-note").textContent = info.isReceipt ? "" : noteVal;

  updateItemsWarning();
}

function updateNoteLabel() {
  const info = currentDocTypeInfo();
  const noteLabel = document.querySelector('label[for="f-note"]');
  if (noteLabel) noteLabel.textContent = info.isReceipt ? "但し書き" : "備考";
  const dueLabel = document.querySelector('label[for="f-due-date"]');
  const dueField = document.getElementById("f-due-date");
  if (dueLabel) dueLabel.textContent = info.dateLabel || "支払期限";
  dueField.hidden = info.isReceipt;
  if (dueLabel) dueLabel.hidden = info.isReceipt;
}

function updateConvertButton() {
  const type = document.getElementById("f-doctype").value;
  document.getElementById("btn-convert-to-invoice").hidden = !(proUnlocked && type === "estimate");
}

function resetFormForNewDoc() {
  editingDocId = null;
  document.getElementById("f-doctype").value = "invoice";
  document.getElementById("f-client-select").value = "";
  document.getElementById("f-client-name").value = "";
  document.getElementById("f-client-honorific").value = "御中";
  document.getElementById("f-client-zip").value = "";
  document.getElementById("f-client-address").value = "";
  document.getElementById("f-client-person").value = "";
  document.getElementById("f-issue-date").value = todayStr();
  document.getElementById("f-due-date").value = "";
  document.getElementById("f-doc-no").value = "";
  document.getElementById("f-withholding").checked = false;
  document.getElementById("f-taxmode-excl").checked = true;
  document.getElementById("f-bank-select").value = "";
  document.getElementById("f-note").value = "";
  clearItemRows();
  addItemRow(null);
  updateNoteLabel();
  updateConvertButton();
  renderPreview();
}

function loadDocIntoForm(doc) {
  editingDocId = null; // 複製として新規保存する（同一IDでは上書きしない）
  document.getElementById("f-doctype").value = doc.type;
  document.getElementById("f-client-select").value = "";
  document.getElementById("f-client-name").value = doc.clientSnapshot.name || "";
  document.getElementById("f-client-honorific").value = doc.clientSnapshot.honorific || "御中";
  document.getElementById("f-client-zip").value = doc.clientSnapshot.zip || "";
  document.getElementById("f-client-address").value = doc.clientSnapshot.address || "";
  document.getElementById("f-client-person").value = doc.clientSnapshot.person || "";
  document.getElementById("f-issue-date").value = doc.issueDate || "";
  document.getElementById("f-due-date").value = doc.dueDate || "";
  document.getElementById("f-doc-no").value = doc.docNo || "";
  document.getElementById("f-withholding").checked = !!doc.withholding;
  document.getElementById("f-taxmode-excl").checked = doc.taxMode !== "incl";
  document.getElementById("f-taxmode-incl").checked = doc.taxMode === "incl";
  document.getElementById("f-bank-select").value = doc.bankId || "";
  document.getElementById("f-note").value = doc.note || "";
  clearItemRows();
  if (doc.items.length === 0) addItemRow(null);
  for (const item of doc.items) addItemRow(item);
  updateNoteLabel();
  updateConvertButton();
  renderPreview();
  location.hash = "#create";
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function initCreateFormEvents() {
  const formInputs = [
    "f-client-name", "f-client-honorific", "f-client-zip", "f-client-address", "f-client-person",
    "f-issue-date", "f-due-date", "f-doc-no", "f-withholding", "f-taxmode-excl", "f-taxmode-incl",
    "f-bank-select", "f-note",
  ];
  for (const id of formInputs) {
    const el = document.getElementById(id);
    el.addEventListener("input", renderPreview);
    el.addEventListener("change", renderPreview);
  }

  document.getElementById("f-doctype").addEventListener("change", (e) => {
    const value = e.target.value;
    if (value !== "invoice" && !proUnlocked) {
      e.target.value = "invoice";
      openProModal();
      return;
    }
    updateNoteLabel();
    updateConvertButton();
    renderPreview();
  });

  document.getElementById("f-client-select").addEventListener("change", (e) => {
    const clients = store.get("sq_clients", []);
    const c = clients.find((x) => x.id === e.target.value);
    if (c) {
      document.getElementById("f-client-name").value = c.name;
      document.getElementById("f-client-honorific").value = c.honorific;
      document.getElementById("f-client-zip").value = c.zip;
      document.getElementById("f-client-address").value = c.address;
      document.getElementById("f-client-person").value = c.person;
      renderPreview();
    }
  });

  document.getElementById("btn-convert-to-invoice").addEventListener("click", () => {
    document.getElementById("f-doctype").value = "invoice";
    updateNoteLabel();
    updateConvertButton();
    renderPreview();
  });

  document.getElementById("btn-auto-number").addEventListener("click", () => {
    if (!proUnlocked) { openProModal(); return; }
    const settings = store.get("sq_settings", { numbering: { prefix: "INV-{YYYY}-", next: 1, pad: 4 } });
    const numbering = settings.numbering || { prefix: "INV-{YYYY}-", next: 1, pad: 4 };
    const year = (document.getElementById("f-issue-date").value || todayStr()).slice(0, 4);
    const num = String(numbering.next).padStart(numbering.pad, "0");
    const docNo = numbering.prefix.replace("{YYYY}", year) + num;
    document.getElementById("f-doc-no").value = docNo;
    numbering.next += 1;
    settings.numbering = numbering;
    store.set("sq_settings", settings);
    renderPreview();
  });

  document.getElementById("btn-new-doc").addEventListener("click", () => {
    const hasContent = document.getElementById("f-client-name").value.trim() ||
      [...document.querySelectorAll("#items-tbody .item-name")].some((el) => el.value.trim());
    if (hasContent && !confirm("現在の入力内容を破棄して新規作成しますか？（保存済みの場合は履歴に残っています）")) return;
    resetFormForNewDoc();
  });

  document.getElementById("btn-save-doc").addEventListener("click", saveCurrentDoc);
  document.getElementById("btn-print").addEventListener("click", () => window.print());
}

function saveCurrentDoc() {
  const docs = store.get("sq_docs", []);
  const doc = gatherFormDoc();
  const isNew = !doc.id;
  if (isNew && !proUnlocked && docs.length >= PARAMS.freeLimits.docs) {
    openProModal();
    return;
  }
  if (isNew) {
    doc.id = uid("d");
  }
  doc.savedAt = Date.now();
  const idx = docs.findIndex((d) => d.id === doc.id);
  if (idx >= 0) {
    docs[idx] = doc;
  } else {
    docs.push(doc);
  }
  const ok = store.set("sq_docs", docs);
  if (ok) {
    editingDocId = doc.id;
    showToast("保存しました。");
  }
}

/* ===================== 履歴タブ ===================== */

function renderHistoryList() {
  const docs = store.get("sq_docs", []).slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const countText = proUnlocked ? docs.length + "件" : docs.length + "件 / " + PARAMS.freeLimits.docs + "件（無料）";
  document.getElementById("history-count").textContent = countText;

  const searchInput = document.getElementById("history-search");
  const query = proUnlocked ? searchInput.value.trim().toLowerCase() : "";
  const filtered = query
    ? docs.filter((d) => {
        const hay = [d.docNo, d.clientSnapshot && d.clientSnapshot.name, d.issueDate].join(" ").toLowerCase();
        return hay.includes(query);
      })
    : docs;

  const list = document.getElementById("history-list");
  list.innerHTML = "";
  for (const doc of filtered) {
    const info = DOC_TYPE_INFO[doc.type] || DOC_TYPE_INFO.invoice;
    const card = document.createElement("div");
    card.className = "card-item";
    const main = document.createElement("div");
    main.className = "card-main";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = info.title + "　" + (doc.docNo || "(番号なし)");
    const sub = document.createElement("div");
    sub.className = "card-sub";
    const clientName = doc.clientSnapshot ? doc.clientSnapshot.name : "";
    sub.textContent = [clientName, doc.issueDate, yen(doc.totals ? doc.totals.grand : 0)].filter(Boolean).join(" / ");
    main.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const dupBtn = document.createElement("button");
    dupBtn.type = "button";
    dupBtn.className = "btn btn-small";
    dupBtn.textContent = "複製して編集";
    dupBtn.addEventListener("click", () => loadDocIntoForm(doc));
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-small btn-danger";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => {
      if (!confirm("この履歴を削除しますか？")) return;
      const all = store.get("sq_docs", []).filter((d) => d.id !== doc.id);
      store.set("sq_docs", all);
      renderHistoryList();
    });
    actions.append(dupBtn, delBtn);

    card.append(main, actions);
    list.appendChild(card);
  }
}

function initHistoryEvents() {
  document.getElementById("history-search").addEventListener("input", renderHistoryList);
}

/* ===================== 取引先タブ ===================== */

function renderClientsList() {
  const clients = store.get("sq_clients", []);
  const countText = proUnlocked ? clients.length + "件" : clients.length + "件 / " + PARAMS.freeLimits.clients + "件（無料）";
  document.getElementById("clients-count").textContent = countText;

  const list = document.getElementById("clients-list");
  list.innerHTML = "";
  for (const c of clients) {
    const card = document.createElement("div");
    card.className = "card-item";
    const main = document.createElement("div");
    main.className = "card-main";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = c.name + " " + (c.honorific || "");
    const sub = document.createElement("div");
    sub.className = "card-sub";
    sub.textContent = [c.zip, c.address].filter(Boolean).join(" ");
    main.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-small";
    editBtn.textContent = "編集";
    editBtn.addEventListener("click", () => startEditClient(c));
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-small btn-danger";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => {
      if (!confirm("この取引先を削除しますか？")) return;
      const all = store.get("sq_clients", []).filter((x) => x.id !== c.id);
      store.set("sq_clients", all);
      renderClientsList();
      populateClientSelect();
    });
    actions.append(editBtn, delBtn);

    card.append(main, actions);
    list.appendChild(card);
  }
}

function startEditClient(c) {
  document.getElementById("c-edit-id").value = c.id;
  document.getElementById("c-name").value = c.name;
  document.getElementById("c-honorific").value = c.honorific;
  document.getElementById("c-zip").value = c.zip;
  document.getElementById("c-address").value = c.address;
  document.getElementById("c-person").value = c.person;
  document.getElementById("btn-cancel-client-edit").hidden = false;
}

function resetClientForm() {
  document.getElementById("c-edit-id").value = "";
  document.getElementById("c-name").value = "";
  document.getElementById("c-honorific").value = "御中";
  document.getElementById("c-zip").value = "";
  document.getElementById("c-address").value = "";
  document.getElementById("c-person").value = "";
  document.getElementById("btn-cancel-client-edit").hidden = true;
}

function populateClientSelect() {
  const clients = store.get("sq_clients", []);
  const select = document.getElementById("f-client-select");
  const current = select.value;
  select.innerHTML = '<option value="">-- 保存済みの取引先から選択 --</option>';
  for (const c of clients) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
  select.value = current;
}

function initClientsEvents() {
  document.getElementById("btn-add-client").addEventListener("click", () => {
    const name = document.getElementById("c-name").value.trim();
    if (!name) { showToast("会社名・氏名を入力してください。"); return; }
    const editId = document.getElementById("c-edit-id").value;
    const clients = store.get("sq_clients", []);
    const newClientData = {
      name,
      honorific: document.getElementById("c-honorific").value,
      zip: document.getElementById("c-zip").value,
      address: document.getElementById("c-address").value,
      person: document.getElementById("c-person").value,
    };
    if (editId) {
      const idx = clients.findIndex((x) => x.id === editId);
      if (idx >= 0) clients[idx] = Object.assign({ id: editId }, newClientData);
    } else {
      if (!proUnlocked && clients.length >= PARAMS.freeLimits.clients) {
        openProModal();
        return;
      }
      clients.push(Object.assign({ id: uid("c") }, newClientData));
    }
    store.set("sq_clients", clients);
    resetClientForm();
    renderClientsList();
    populateClientSelect();
  });

  document.getElementById("btn-cancel-client-edit").addEventListener("click", resetClientForm);
}

/* ===================== 設定タブ：発行者・振込先 ===================== */

function loadIssuerForm() {
  const issuer = store.get("sq_issuer", {});
  document.getElementById("s-issuer-name").value = issuer.name || "";
  document.getElementById("s-issuer-zip").value = issuer.zip || "";
  document.getElementById("s-issuer-address").value = issuer.address || "";
  document.getElementById("s-issuer-tel").value = issuer.tel || "";
  document.getElementById("s-issuer-email").value = issuer.email || "";
  document.getElementById("s-issuer-invoiceno").value = issuer.invoiceNo || "";
}

function initIssuerEvents() {
  document.getElementById("btn-save-issuer").addEventListener("click", () => {
    const issuer = {
      name: document.getElementById("s-issuer-name").value,
      zip: document.getElementById("s-issuer-zip").value,
      address: document.getElementById("s-issuer-address").value,
      tel: document.getElementById("s-issuer-tel").value,
      email: document.getElementById("s-issuer-email").value,
      invoiceNo: document.getElementById("s-issuer-invoiceno").value,
    };
    store.set("sq_issuer", issuer);
    renderPreview();
    showToast("発行者情報を保存しました。");
  });
}

function renderBanksList() {
  const banks = store.get("sq_banks", []);
  const list = document.getElementById("banks-list");
  list.innerHTML = "";
  for (const b of banks) {
    const card = document.createElement("div");
    card.className = "card-item";
    const main = document.createElement("div");
    main.className = "card-main";
    main.textContent = b.label;
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-small btn-danger";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => {
      if (!confirm("この振込先を削除しますか？")) return;
      const all = store.get("sq_banks", []).filter((x) => x.id !== b.id);
      store.set("sq_banks", all);
      renderBanksList();
      populateBankSelect();
    });
    actions.appendChild(delBtn);
    card.append(main, actions);
    list.appendChild(card);
  }
}

function populateBankSelect() {
  const banks = store.get("sq_banks", []);
  const select = document.getElementById("f-bank-select");
  const current = select.value;
  select.innerHTML = '<option value="">-- 振込先を選択 --</option>';
  for (const b of banks) {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.label;
    select.appendChild(opt);
  }
  select.value = current;
}

function initBanksEvents() {
  document.getElementById("btn-add-bank").addEventListener("click", () => {
    const label = document.getElementById("s-bank-label").value.trim();
    if (!label) { showToast("振込先を入力してください。"); return; }
    const banks = store.get("sq_banks", []);
    if (!proUnlocked && banks.length >= PARAMS.freeLimits.banks) {
      openProModal();
      return;
    }
    banks.push({ id: uid("b"), label });
    store.set("sq_banks", banks);
    document.getElementById("s-bank-label").value = "";
    renderBanksList();
    populateBankSelect();
  });
}

/* ===================== 設定タブ：Pro機能 ===================== */

function initProActivation() {
  document.getElementById("btn-activate-pro").addEventListener("click", async () => {
    const code = document.getElementById("s-pro-code").value;
    const result = await activatePro(code);
    const msgEl = document.getElementById("pro-activate-message");
    msgEl.hidden = false;
    if (result.ok) {
      msgEl.textContent = "Pro版を有効化しました。";
      msgEl.classList.remove("warning-text");
      updateProUI();
      updateConvertButton();
      renderPreview();
    } else {
      msgEl.textContent = result.message;
      msgEl.classList.add("warning-text");
    }
  });

  document.getElementById("btn-open-pro").addEventListener("click", openProModal);

  document.getElementById("s-pro-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("btn-activate-pro").click(); }
  });
}

function loadNumberingForm() {
  const settings = store.get("sq_settings", {});
  const numbering = settings.numbering || { prefix: "INV-{YYYY}-", next: 1, pad: 4 };
  document.getElementById("s-num-prefix").value = numbering.prefix;
  document.getElementById("s-num-next").value = numbering.next;
  document.getElementById("s-num-pad").value = numbering.pad;
}

function initNumberingEvents() {
  document.getElementById("btn-save-numbering").addEventListener("click", () => {
    const settings = store.get("sq_settings", {});
    settings.numbering = {
      prefix: document.getElementById("s-num-prefix").value || "INV-{YYYY}-",
      next: Math.max(1, Number(document.getElementById("s-num-next").value) || 1),
      pad: Math.max(1, Math.min(8, Number(document.getElementById("s-num-pad").value) || 4)),
    };
    store.set("sq_settings", settings);
    showToast("採番設定を保存しました。");
  });
}

function estimateDataUrlBytes(dataUrl) {
  if (!dataUrl) return 0;
  const base64 = dataUrl.split(",")[1] || "";
  return Math.floor(base64.length * 0.75);
}

function initLogoEvents() {
  document.getElementById("s-logo-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const settings = store.get("sq_settings", {});
      const otherBytes = estimateDataUrlBytes(settings.sealDataUrl);
      const newBytes = estimateDataUrlBytes(reader.result);
      const errEl = document.getElementById("logo-error");
      if (otherBytes + newBytes > PARAMS.logoMaxBytes) {
        errEl.hidden = false;
        errEl.textContent = "ロゴ・角印の合計サイズが500KBを超えています。別の画像を選んでください。";
        return;
      }
      errEl.hidden = true;
      settings.logoDataUrl = reader.result;
      store.set("sq_settings", settings);
      renderPreview();
    };
    reader.readAsDataURL(file);
  });

  document.getElementById("btn-clear-logo").addEventListener("click", () => {
    const settings = store.get("sq_settings", {});
    settings.logoDataUrl = null;
    store.set("sq_settings", settings);
    document.getElementById("s-logo-file").value = "";
    renderPreview();
  });

  document.getElementById("s-seal-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const settings = store.get("sq_settings", {});
      const otherBytes = estimateDataUrlBytes(settings.logoDataUrl);
      const newBytes = estimateDataUrlBytes(reader.result);
      const errEl = document.getElementById("logo-error");
      if (otherBytes + newBytes > PARAMS.logoMaxBytes) {
        errEl.hidden = false;
        errEl.textContent = "ロゴ・角印の合計サイズが500KBを超えています。別の画像を選んでください。";
        return;
      }
      errEl.hidden = true;
      settings.sealDataUrl = reader.result;
      store.set("sq_settings", settings);
      renderPreview();
    };
    reader.readAsDataURL(file);
  });

  document.getElementById("btn-clear-seal").addEventListener("click", () => {
    const settings = store.get("sq_settings", {});
    settings.sealDataUrl = null;
    store.set("sq_settings", settings);
    document.getElementById("s-seal-file").value = "";
    renderPreview();
  });
}

function initBackupEvents() {
  document.getElementById("btn-export-json").addEventListener("click", () => {
    const data = {};
    for (const key of ALL_KEYS) data[key] = store.get(key, null);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sugu-seikyu-backup-" + todayStr() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById("s-import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm("現在のデータを上書きして復元します。よろしいですか？")) {
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        for (const key of ALL_KEYS) {
          if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== null) {
            store.set(key, data[key]);
          }
        }
        showToast("復元が完了しました。画面を再読み込みします。");
        setTimeout(() => location.reload(), 900);
      } catch (err) {
        showToast("ファイルの読み込みに失敗しました。正しいバックアップファイルか確認してください。");
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  });
}

function initResetEvents() {
  document.getElementById("btn-reset-all").addEventListener("click", () => {
    if (!confirm("すべてのデータを消去します。よろしいですか？")) return;
    if (!confirm("本当に消去してよろしいですか？この操作は取り消せません。")) return;
    for (const key of ALL_KEYS) store.remove(key);
    location.reload();
  });
}

/* ===================== Proモーダル ===================== */

function openProModal() {
  document.getElementById("pro-modal").hidden = false;
}
function closeProModal() {
  document.getElementById("pro-modal").hidden = true;
}
function initProModal() {
  document.getElementById("btn-close-pro-modal").addEventListener("click", closeProModal);
  document.getElementById("pro-modal").addEventListener("click", (e) => {
    if (e.target.id === "pro-modal") closeProModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("pro-modal").hidden) closeProModal();
  });
}

/* ===================== フッター ===================== */

function initFooterLinks() {
  const map = { "footer-link-usage": "usage", "footer-link-faq": "faq", "footer-link-privacy": "privacy" };
  for (const [btnId, targetId] of Object.entries(map)) {
    document.getElementById(btnId).addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.getElementById(targetId);
      if (target) target.scrollIntoView({ behavior: "smooth" });
    });
  }
}

/* ===================== 初期化 ===================== */

function init() {
  if (!checkStorageAvailable()) {
    storageAvailable = false;
    showSaveBanner();
  } else {
    ensureMeta();
  }

  const proResult = loadProStatus();
  proUnlocked = proResult.unlocked;
  if (proResult.rotated) {
    const msgEl = document.getElementById("pro-activate-message");
    msgEl.hidden = false;
    msgEl.textContent = "コードが更新されました。BOOTHの購入履歴から最新ファイルを再取得してください。";
  }

  updateProUI();
  initItemsTableEvents();
  initCreateFormEvents();
  initHistoryEvents();
  initClientsEvents();
  initIssuerEvents();
  initBanksEvents();
  initProActivation();
  initNumberingEvents();
  initLogoEvents();
  initBackupEvents();
  initResetEvents();
  initProModal();
  initFooterLinks();

  loadIssuerForm();
  loadNumberingForm();
  populateClientSelect();
  populateBankSelect();
  renderBanksList();
  resetFormForNewDoc();

  initTabs();
}

document.addEventListener("DOMContentLoaded", init);
