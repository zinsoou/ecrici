/* Ecrici hosted layer: accounts, owner approval, subscription check, cloud sync.
   Does nothing until config.js is filled in (then the app stays a plain offline notebook). */
(function () {
"use strict";
const hideStyle = document.getElementById("lg-hide");
const CFG = window.ECRICI || {};
if (!CFG.url || !CFG.key || /PASTE|COLLEZ/i.test(CFG.url + CFG.key)) { if (hideStyle) hideStyle.remove();
document.documentElement.setAttribute("translate", "no"); { const m = document.createElement("meta"); m.name = "google"; m.content = "notranslate"; document.head.appendChild(m); } return; }
const BASE = CFG.url.replace(/\/+$/, "");
const K = { sess: "ecrici-session", acct: "ecrici-acct", owner: "ecrici-owner", sync: "ecrici-synced" };

/* ---------- tiny helpers ---------- */
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const lsDel = k => { try { localStorage.removeItem(k); } catch (e) {} };
const jget = k => { try { return JSON.parse(lsGet(k)); } catch (e) { return null; } };
const todayUTC = () => new Date().toISOString().slice(0, 10);
const daysFrom = iso => Math.round((new Date(iso + "T12:00:00Z") - new Date(todayUTC() + "T12:00:00Z")) / 86400000);
const lang = () => ((S && S.shop && S.shop.lang) === "en" ? "en" : "fr");

/* ---------- network ---------- */
async function http(path, o) {
  o = o || {};
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000);
  const h = { apikey: CFG.key, "Content-Type": "application/json" };
  if (o.token) h.Authorization = "Bearer " + o.token;
  Object.assign(h, o.headers || {});
  let r;
  try { r = await fetch(BASE + path, { method: o.method || "GET", headers: h, body: o.body ? JSON.stringify(o.body) : undefined, signal: ctl.signal, cache: "no-store" }); }
  catch (e) { clearTimeout(to); const x = new Error("offline"); x.offline = true; throw x; }
  clearTimeout(to);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, json: j };
}
const httpErr = r => { const e = new Error("http " + r.status); e.status = r.status; e.json = r.json; return e; };
const authErr = () => { const e = new Error("auth"); e.auth = true; return e; };

let sess = jget(K.sess), refreshing = null;
function setSess(j) {
  sess = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000, uid: (j.user && j.user.id) || (sess && sess.uid) };
  lsSet(K.sess, JSON.stringify(sess));
}
function clearSession() { sess = null; lsDel(K.sess); }
async function token() {
  if (!sess) throw authErr();
  if (sess.exp - Date.now() > 60000) return sess.access;
  if (!refreshing) {
    refreshing = (async () => {
      const r = await http("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: sess.refresh } });
      if (r.ok) { setSess(r.json); return; }
      if (r.status >= 400 && r.status < 500) { clearSession(); throw authErr(); }
      throw httpErr(r);
    })().finally(() => { refreshing = null; });
  }
  await refreshing;
  return sess.access;
}
async function api(path, o) {
  for (let i = 0; i < 2; i++) {
    const tk = await token();
    const r = await http(path, Object.assign({}, o, { token: tk }));
    if (r.status === 401) { if (i === 0) { sess.exp = 0; continue; } clearSession(); throw authErr(); }
    return r;
  }
}

/* ---------- phone number = login ---------- */
function canon(country, raw) {
  const cc = COUNTRIES[country].cc; raw = String(raw || ""); let d = raw.replace(/\D/g, "");
  if (/^\s*(\+|00)/.test(raw)) { d = d.replace(/^00/, ""); if (country === "BJ" && d.startsWith("229") && d.length === 13 && d.slice(3, 5) === "01") d = "229" + d.slice(5); return d; }
  if (d.startsWith(cc) && d.length >= cc.length + 8) return d;
  if (country === "BJ") { if (d.length === 10 && d.startsWith("01")) d = d.slice(2); return cc + d; }
  return cc + d.replace(/^0+/, "");
}
const emailOf = id => id + "@" + (CFG.emailDomain || "ecrici.app");

/* ---------- words ---------- */
const G = {
  fr: {
    tag: "Votre cahier de boutique : ventes, crédits et stock, même sans internet.",
    login: "Se connecter", signup: "Créer mon compte", have: "J'ai déjà un compte", nohave: "Nouvelle boutique ? Créer un compte",
    shop: "Nom de la boutique", country: "Pays", phone: "Numéro de téléphone", pw: "Mot de passe (6 caractères minimum)", show: "Afficher le mot de passe",
    wait: "Un instant…", offline: "Pas de connexion internet. Connectez-vous une première fois avec internet.",
    e_creds: "Numéro ou mot de passe incorrect.", e_exists: "Ce numéro a déjà un compte. Connectez-vous.", e_weak: "Mot de passe trop court (6 caractères minimum).",
    e_rate: "Trop d'essais. Réessayez dans quelques minutes.", e_phone: "Numéro de téléphone invalide.", e_name: "Écrivez le nom de la boutique.",
    e_email: "Le serveur refuse ce numéro (voir le guide de lancement).", e_other: "Erreur. Réessayez.", e_confirm: "Compte créé, mais le serveur demande une confirmation. Voir le guide.",
    pend_t: "Compte créé", pend_p: n => `Votre boutique « ${n} » attend l'approbation. Écrivez-nous sur WhatsApp pour l'activer.`,
    blk_t: "Abonnement terminé", blk_p: "Votre abonnement est terminé ou suspendu. Vos données restent sur ce téléphone. Contactez-nous pour le renouveler.",
    wa: "Écrire sur WhatsApp", check: "Vérifier maintenant", out: "Se déconnecter", backup: "Sauvegarder mes données",
    off_t: "Pas de connexion", off_p: "Impossible de vérifier votre abonnement pour l'instant. Réessayez avec internet.", retry: "Réessayer",
    err_t: "Compte introuvable", err_p: "Votre compte n'est pas encore prêt. Réessayez dans un instant.",
    chpw: "Changer le mot de passe", npw: "Nouveau mot de passe", npw2: "Répétez le mot de passe", chpw_go: "Enregistrer le mot de passe", chpw_ok: "Mot de passe changé", chpw_mismatch: "Les deux mots de passe sont différents.", chpw_weak: "6 caractères minimum.", chpw_fail: "Impossible pour le moment. Réessayez avec internet.", chpw_login: "Pour votre sécurité, déconnectez-vous puis reconnectez-vous avant de changer le mot de passe.",
    inst: "Installer l'application", ios_t: "Sur iPhone : ouvrez ce site dans Safari, touchez le bouton Partager (carré avec flèche vers le haut), puis « Sur l'écran d'accueil ».",  hint_name: "Écrivez en MAJUSCULES, ex : BOUTIQUE DE VICTOR", hint_phone: "Chiffres seulement, sans le +. Ex :",  forgot: "Mot de passe oublié ? WhatsApp", wa_pw: p => `Bonjour, j'ai oublié mon mot de passe Ecrici. Mon numéro : ${p}`,
    wa_new: (n, p) => `Bonjour, je viens de créer mon compte Ecrici pour la boutique ${n} (${p}). Merci de l'activer.`,
    wa_renew: (n, p) => `Bonjour, je souhaite renouveler mon abonnement Ecrici pour la boutique ${n} (${p}).`,
    acct: "Compte", until: d => `Actif jusqu'au ${d}`, sync_ok: "Synchronisé", sync_wait: "En attente de connexion", logout_q: "Se déconnecter ? Les données de cette boutique seront retirées de ce téléphone (elles restent dans votre compte).",
    logout_unsynced: "Des changements ne sont pas encore envoyés. Connectez-vous à internet avant de vous déconnecter.", help: "Besoin d'aide ? WhatsApp",
    price: CFG.priceText || ""
  },
  en: {
    tag: "Your shop ledger: sales, credit and stock, even without internet.",
    login: "Log in", signup: "Create my account", have: "I already have an account", nohave: "New shop? Create an account",
    shop: "Shop name", country: "Country", phone: "Phone number", pw: "Password (6 characters minimum)", show: "Show password",
    wait: "One moment…", offline: "No internet connection. Log in the first time with internet.",
    e_creds: "Wrong number or password.", e_exists: "This number already has an account. Log in.", e_weak: "Password too short (6 characters minimum).",
    e_rate: "Too many tries. Please wait a few minutes.", e_phone: "Invalid phone number.", e_name: "Enter the shop name.",
    e_email: "The server refused this number (see the launch guide).", e_other: "Error. Please try again.", e_confirm: "Account created, but the server asks for confirmation. See the guide.",
    pend_t: "Account created", pend_p: n => `Your shop “${n}” is waiting for approval. Message us on WhatsApp to activate it.`,
    blk_t: "Subscription ended", blk_p: "Your subscription has ended or was suspended. Your data stays on this phone. Contact us to renew.",
    wa: "Message on WhatsApp", check: "Check now", out: "Log out", backup: "Back up my data",
    off_t: "No connection", off_p: "We can't check your subscription right now. Try again with internet.", retry: "Try again",
    err_t: "Account not found", err_p: "Your account isn't ready yet. Try again in a moment.",
    chpw: "Change password", npw: "New password", npw2: "Repeat the password", chpw_go: "Save password", chpw_ok: "Password changed", chpw_mismatch: "The two passwords are different.", chpw_weak: "6 characters minimum.", chpw_fail: "Not possible right now. Try again with internet.", chpw_login: "For your security, log out and log in again before changing the password.",
    inst: "Install the app", ios_t: "On iPhone: open this site in Safari, tap the Share button (square with an arrow up), then \"Add to Home Screen\".",  hint_name: "Write in CAPITAL letters, e.g. VICTOR'S DRYCLEANER", hint_phone: "Digits only, no + sign. Example:",  forgot: "Forgot password? WhatsApp", wa_pw: p => `Hello, I forgot my Ecrici password. My number: ${p}`,
    wa_new: (n, p) => `Hello, I just created my Ecrici account for the shop ${n} (${p}). Please activate it.`,
    wa_renew: (n, p) => `Hello, I would like to renew my Ecrici subscription for the shop ${n} (${p}).`,
    acct: "Account", until: d => `Active until ${d}`, sync_ok: "Synced", sync_wait: "Waiting for connection", logout_q: "Log out? This shop's data will be removed from this phone (it stays in your account).",
    logout_unsynced: "Some changes are not sent yet. Connect to the internet before logging out.", help: "Need help? WhatsApp",
    price: CFG.priceText || ""
  }
};
const PH = { BJ: "01 97 00 00 11", NG: "0803 123 4567", GH: "024 123 4567", KE: "0712 345 678" };
const g = (k, ...a) => { const v = G[lang()][k]; return typeof v === "function" ? v(...a) : v; };

/* ---------- gate (full-screen screen shown until the account is valid) ---------- */
const css = document.createElement("style");
css.textContent = `#lg-gate{position:fixed;inset:0;z-index:9999;overflow:auto;background:var(--paper);color:var(--ink);font-family:var(--font-body);padding:calc(18px + env(safe-area-inset-top,0px)) 16px calc(24px + env(safe-area-inset-bottom,0px))}
#lg-gate .lg-wrap{max-width:420px;margin:0 auto;display:grid;gap:14px}
#lg-gate h1{font-family:var(--font-display);font-size:30px;margin:10px 0 0;letter-spacing:-.5px}
#lg-gate h2{font-family:var(--font-display);font-size:20px;margin:0}
#lg-gate .lg-tag{color:var(--muted);margin:0;font-size:15px}
#lg-gate .lg-top{display:flex;justify-content:flex-end}
#lg-gate .lg-msg{background:var(--warn-bg);color:var(--warn-ink);border-radius:12px;padding:10px 12px;font-size:14px}
#lg-gate .lg-err{color:var(--owed);font-size:14px;min-height:18px}
#lg-gate .lg-chk{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--muted)}
#lg-gate .lg-chk input{width:auto}
#lg-gate .lg-price{color:var(--muted);font-size:14px}
#lg-gate a.btn{text-decoration:none;text-align:center}`;
document.head.appendChild(css);
const gate = document.createElement("div"); gate.id = "lg-gate"; gate.setAttribute("role", "dialog"); gate.setAttribute("aria-modal", "true");
document.body.appendChild(gate);
if (hideStyle) hideStyle.remove();

let gateKind = "loading", mode = "login", form = { country: "BJ", phone: "", name: "" }, busyAuth = false, authErrText = "";
const COUNTRY_OPTS = () => Object.entries(COUNTRIES).map(([k, v]) => `<option value="${k}" ${form.country === k ? "selected" : ""}>${esc(v.name)} (+${v.cc})</option>`).join("");
const shopRow = () => jget(K.acct) || {};
const waLink = txt => CFG.adminWhatsapp ? `https://wa.me/${String(CFG.adminWhatsapp).replace(/\D/g, "")}?text=${encodeURIComponent(txt)}` : "";
const head = () => `<div class="lg-top"><button class="pill" data-lg="lang">${lang() === "fr" ? "FR → EN" : "EN → FR"}</button>${canInst() || isIOS() ? `<button class="pill" data-lg="install">${esc(g("inst"))}</button>` : ""}</div>${iosHelp && isIOS() ? `<div class="lg-msg" style="margin-top:10px">${esc(g("ios_t"))}</div>` : ""}<h1>Ecrici</h1><p class="lg-tag">${esc(g("tag"))}</p>`;

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone;
let iosHelp = false;
function canInst() { try { return typeof deferredInstall !== "undefined" && !!deferredInstall && !matchMedia("(display-mode: standalone)").matches; } catch (e) { return false; } }
window.addEventListener("beforeinstallprompt", () => setTimeout(() => { if (gateKind === "auth") { grab(); drawGate(); } }, 50));
function drawGate() {
  const a = shopRow();
  let h = "";
  if (gateKind === "loading") {
    h = head() + `<p class="lg-tag">${esc(g("wait"))}</p>`;
  } else if (gateKind === "auth") {
    const su = mode === "signup";
    h = head() + `<div class="card form"><h2>${esc(su ? g("signup") : g("login"))}</h2>
      ${su ? `<div class="field"><label for="lg-name">${esc(g("shop"))}</label><input id="lg-name" value="${esc(form.name)}" autocomplete="organization" autocapitalize="characters" placeholder="${esc(lang() === "fr" ? "BOUTIQUE DE VICTOR" : "VICTOR'S DRYCLEANER")}" style="text-transform:uppercase"><small style="opacity:.7;font-size:.8em">${esc(g("hint_name"))}</small></div>` : ""}
      <div class="field"><label for="lg-country">${esc(g("country"))}</label><select id="lg-country">${COUNTRY_OPTS()}</select></div>
      <div class="field"><label for="lg-phone">${esc(g("phone"))}</label><input id="lg-phone" value="${esc(form.phone)}" inputmode="tel" autocomplete="tel" placeholder="${esc(PH[form.country] || "")}"><small class="lg-hint" style="opacity:.7;font-size:.8em">${esc(g("hint_phone"))} ${esc(PH[form.country] || "")}</small></div>
      <div class="field"><label for="lg-pw">${esc(g("pw"))}</label><input id="lg-pw" type="password" autocomplete="${su ? "new-password" : "current-password"}"></div>
      <label class="lg-chk"><input type="checkbox" data-lg="showpw"> ${esc(g("show"))}</label>
      <div class="lg-err" id="lg-err" role="alert">${esc(authErrText)}</div>
      <button class="btn primary" data-lg="submit" ${busyAuth ? "disabled" : ""}>${esc(busyAuth ? g("wait") : su ? g("signup") : g("login"))}</button>
      <button class="btn small ghost" data-lg="mode" style="justify-self:start">${esc(su ? g("have") : g("nohave"))}</button>
      ${!su && CFG.adminWhatsapp ? `<button class="btn small ghost" data-lg="forgot" style="justify-self:start">${esc(g("forgot"))}</button>` : ""}</div>
      ${g("price") ? `<p class="lg-price">${esc(g("price"))}</p>` : ""}`;
  } else if (gateKind === "pending" || gateKind === "blocked") {
    const pend = gateKind === "pending";
    const w = waLink(pend ? g("wa_new", a.name || "", a.phone || "") : g("wa_renew", a.name || "", a.phone || ""));
    h = head() + `<div class="card form"><h2>${esc(pend ? g("pend_t") : g("blk_t"))}</h2>
      <div class="lg-msg">${esc(pend ? g("pend_p", a.name || "") : g("blk_p"))}</div>
      ${g("price") ? `<p class="lg-price">${esc(g("price"))}</p>` : ""}
      ${w ? `<a class="btn primary" href="${w}" target="_blank" rel="noopener">${esc(g("wa"))}</a>` : ""}
      <button class="btn" data-lg="check">${esc(g("check"))}</button>
      ${!pend && lsGet(K.owner) === (sess && sess.uid) ? `<button class="btn" data-lg="backup">${esc(g("backup"))}</button>` : ""}
      <button class="btn small ghost" data-lg="logout" style="justify-self:start">${esc(g("out"))}</button></div>`;
  } else if (gateKind === "offline" || gateKind === "error") {
    const off = gateKind === "offline";
    h = head() + `<div class="card form"><h2>${esc(off ? g("off_t") : g("err_t"))}</h2><div class="lg-msg">${esc(off ? g("off_p") : g("err_p"))}</div>
      <button class="btn primary" data-lg="check">${esc(g("retry"))}</button>
      <button class="btn small ghost" data-lg="logout" style="justify-self:start">${esc(g("out"))}</button></div>`;
  }
  gate.innerHTML = `<div class="lg-wrap">${h}</div>`;
  gate.hidden = false;
}
function showGate(kind) { gateKind = kind; drawGate(); }
function hideGate() { gate.hidden = true; gate.innerHTML = ""; gateKind = "none"; }

gate.addEventListener("click", async e => {
  const b = e.target.closest("[data-lg]"); if (!b) return;
  const act = b.dataset.lg;
  if (act === "lang") { S.shop.lang = lang() === "fr" ? "en" : "fr"; try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (x) {} drawGate(); }
  else if (act === "mode") { grab(); mode = mode === "login" ? "signup" : "login"; authErrText = ""; drawGate(); }
  else if (act === "showpw") { const p = gate.querySelector("#lg-pw"); if (p) p.type = b.checked ? "text" : "password"; }
  else if (act === "submit") submitAuth();
  else if (act === "forgot") { grab(); let id = ""; try { id = form.phone ? canon(form.country, form.phone) : ""; } catch (x) {} window.open(waLink(g("wa_pw", id ? "+" + id : "")), "_blank"); }
  else if (act === "install") { if (isIOS()) { iosHelp = !iosHelp; drawGate(); } else if (canInst()) { const d = deferredInstall; deferredInstall = null; try { d.prompt(); d.userChoice.then(() => drawGate(), () => drawGate()); } catch (x) { drawGate(); } } }
  else if (act === "check") enter();
  else if (act === "backup") { try { await backupNow(); } catch (x) {} }
  else if (act === "logout") logout(true);
});
gate.addEventListener("change", e => { if (e.target.id === "lg-country") { grab(); drawGate(); } });
gate.addEventListener("keydown", e => { if (e.key === "Enter" && gateKind === "auth" && e.target.tagName === "INPUT" && e.target.type !== "checkbox") submitAuth(); });
function grab() {
  const v = id => { const el = gate.querySelector(id); return el ? el.value : null; };
  const c = v("#lg-country"), p = v("#lg-phone"), n = v("#lg-name");
  if (c) form.country = c; if (p !== null) form.phone = p; if (n !== null) form.name = n;
}

/* ---------- sign up / log in ---------- */
function authMsg(r) {
  const j = r.json || {}, code = String(j.error_code || j.code || ""), msg = String(j.msg || j.message || j.error_description || j.error || "");
  if (r.status === 429 || /rate_limit/.test(code)) return g("e_rate");
  if (/exists/.test(code) || /already/i.test(msg)) return g("e_exists");
  if (/invalid_credentials/.test(code) || /invalid login/i.test(msg)) return g("e_creds");
  if (/weak_password/.test(code) || /password/i.test(msg)) return g("e_weak");
  if (/email/i.test(code + msg)) return g("e_email");
  return g("e_other") + " (" + r.status + ")";
}
async function submitAuth() {
  if (busyAuth) return;
  grab();
  const pw = (gate.querySelector("#lg-pw") || {}).value || "";
  const su = mode === "signup";
  const id = canon(form.country, form.phone);
  authErrText = "";
  if (id.length < 10 || id.length > 15) authErrText = g("e_phone");
  else if (su && !form.name.trim().toUpperCase()) authErrText = g("e_name");
  else if (pw.length < 6) authErrText = g("e_weak");
  if (authErrText) { drawGate(); return; }
  busyAuth = true; drawGate();
  try {
    let r;
    if (su) r = await http("/auth/v1/signup", { method: "POST", body: { email: emailOf(id), password: pw, data: { name: form.name.trim().toUpperCase(), phone: id, country: form.country } } });
    else r = await http("/auth/v1/token?grant_type=password", { method: "POST", body: { email: emailOf(id), password: pw } });
    if (!r.ok) { authErrText = authMsg(r); }
    else if (!r.json || !r.json.access_token) { authErrText = g("e_confirm"); }
    else {
      sess = null; setSess(r.json);
      if (su) { try { if (!S.shop.name || S.shop.name === "Ma Boutique") S.shop.name = form.name.trim().toUpperCase(); S.shop.country = form.country; S.shop.phone = id; } catch (e) {} }
      busyAuth = false; await enter(); return;
    }
  } catch (e) { authErrText = e.offline ? g("offline") : g("e_other"); }
  busyAuth = false; drawGate();
}

/* ---------- account status ---------- */
const valid = a => !!a && a.status === "active" && !!a.paid_until && a.paid_until >= todayUTC();
const offlineOk = a => !!a && a.uid === (sess && sess.uid) && a.status === "active" && !!a.paid_until && daysFrom(a.paid_until) >= -3;
let active = false, lastSynced = Number(lsGet(K.sync)) || 0, busyPush = false, dirtyPush = false, lastCheck = 0;

async function getShop() {
  const r = await api("/rest/v1/shops?id=eq." + sess.uid + "&select=*");
  if (!r.ok) throw httpErr(r);
  return (r.json && r.json[0]) || null;
}
async function enter() {
  if (!sess) { showGate("auth"); return; }
  showGate("loading");
  let shop;
  try { shop = await getShop(); }
  catch (e) {
    if (e.auth) { active = false; showGate("auth"); return; }
    if (e.offline || !e.status || e.status >= 500) {
      const c = jget(K.acct);
      if (offlineOk(c)) { unlockOffline(); return; }
      showGate("offline"); return;
    }
    showGate("error"); return;
  }
  if (!shop) { showGate("error"); return; }
  const a = { uid: sess.uid, status: shop.status, paid_until: shop.paid_until, name: shop.name, phone: shop.phone, country: shop.country, checked: Date.now() };
  lsSet(K.acct, JSON.stringify(a));
  if (!valid(a)) { active = false; showGate(a.status === "pending" ? "pending" : "blocked"); return; }
  try { await reconcile(shop); } catch (e) { if (e.auth) { showGate("auth"); return; } }
  active = true; lastCheck = Date.now(); hideGate(); updateStatus(); render();
}
function unlockOffline() { active = true; storeMode = "device"; hideGate(); updateStatus(); render(); }

/* ---------- data: which copy wins ---------- */
const hasReal = () => S.txs.some(x => !x.example) || S.customers.some(c => !c.example) || S.products.some(p => !p.example);
function replaceLocal(d) {
  S = migrate(d); lastSynced = S.updated || 0; lsSet(K.sync, String(lastSynced));
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {}
  ui.view = "home"; ui.modal = null; ui.draft = null; render();
}
function freshBlank(shop) {
  S = blank(); S.shop.name = shop.name || S.shop.name; S.shop.phone = shop.phone || ""; S.shop.country = shop.country || "BJ"; S.shop.lang = lang();
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {}
  lastSynced = 0; ui.view = "home"; ui.modal = null; render();
}
async function reconcile(shop) {
  const r = await api("/rest/v1/ledgers?shop_id=eq." + sess.uid + "&select=data,updated");
  if (!r.ok) throw httpErr(r);
  const row = r.json && r.json[0], owner = lsGet(K.owner), mine = owner === sess.uid || (owner == null && hasReal());
  if (row && row.data && row.data.shop) {
    if (mine) { if (row.updated > (S.updated || 0)) replaceLocal(row.data); else if (S.updated > row.updated || S.updated > lastSynced) await doPush(); else { lastSynced = S.updated; } }
    else replaceLocal(row.data);
  } else {
    if (mine) await doPush(); else { freshBlank(shop); await doPush(); }
  }
  lsSet(K.owner, sess.uid); storeMode = "account";
}
async function doPush() {
  const snap = S.updated;
  const r = await api("/rest/v1/ledgers?on_conflict=shop_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: { shop_id: sess.uid, data: S, updated: snap, updated_at: new Date().toISOString() } });
  if (!r.ok) throw httpErr(r);
  lastSynced = snap; lsSet(K.sync, String(snap)); storeMode = "account";
}
window.pushCloud = async function () {
  if (!active || !sess) return;
  if (busyPush) { dirtyPush = true; return; }
  busyPush = true;
  try { await doPush(); }
  catch (e) {
    storeMode = "device";
    if (e.auth || e.status === 401 || e.status === 403) { busyPush = false; enter(); return; }
  }
  busyPush = false; updateStatus();
  if (dirtyPush) { dirtyPush = false; window.pushCloud(); }
};
window.initCloud = function () {};

/* ---------- keep checking while the app is open ---------- */
async function refresh() {
  if (!active || !sess || Date.now() - lastCheck < 20000) return;
  lastCheck = Date.now();
  try {
    const shop = await getShop(); if (!shop) return;
    const a = { uid: sess.uid, status: shop.status, paid_until: shop.paid_until, name: shop.name, phone: shop.phone, country: shop.country, checked: Date.now() };
    lsSet(K.acct, JSON.stringify(a));
    if (!valid(a)) { active = false; showGate(a.status === "pending" ? "pending" : "blocked"); return; }
    await reconcile(shop); updateStatus();
  } catch (e) { if (e.auth) { active = false; showGate("auth"); } }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh(); else if (active) window.pushCloud();
});
window.addEventListener("online", () => { if (gateKind === "offline") enter(); else if (active) { lastCheck = 0; refresh(); } });
setInterval(() => { if (active && document.visibilityState === "visible") refresh(); }, 6 * 3600 * 1000);

/* ---------- log out ---------- */
async function logout(fromGate) {
  const owned = lsGet(K.owner) === (sess && sess.uid);
  if (owned && S.updated > lastSynced) {
    let ok = false;
    if (active) { try { await doPush(); ok = true; } catch (e) {} }
    if (!ok) { alert(g("logout_unsynced")); return; }
  }
  if (!confirm(g("logout_q"))) return;
  if (sess) { try { await api("/auth/v1/logout", { method: "POST" }); } catch (e) {} }
  [K.sess, K.acct, K.sync].forEach(lsDel);
  if (owned) { lsDel(K.owner); lsDel(LS_KEY); }
  location.reload();
}

async function changePassword() {
  const a = document.getElementById("lg-npw"), c = document.getElementById("lg-npw2"); if (!a || !c) return;
  if (a.value.length < 6) { toast(g("chpw_weak")); return; }
  if (a.value !== c.value) { toast(g("chpw_mismatch")); return; }
  try {
    const r = await api("/auth/v1/user", { method: "PUT", body: { password: a.value } });
    if (r.ok) { a.value = ""; c.value = ""; toast(g("chpw_ok")); }
    else if (/reauth|recent|login/i.test(JSON.stringify(r.json || {}))) toast(g("chpw_login"));
    else toast(r.status === 422 ? g("chpw_weak") : g("chpw_fail"));
  } catch (e) { toast(g("chpw_fail")); }
}

/* ---------- Settings: account block ---------- */
const baseSettings = window.viewSettings;
window.viewSettings = function () {
  const a = shopRow(), l = lang();
  const until = a.paid_until ? new Date(a.paid_until + "T12:00:00").toLocaleDateString(l === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
  const dirty = S.updated > lastSynced;
  const w = waLink("");
  return baseSettings() + `<section class="sec"><h2>${esc(g("acct"))}</h2><div class="card form">
    <div class="note" style="margin:0">${esc(a.phone ? "+" + a.phone : "")}${until ? " · " + esc(g("until", until)) : ""}<br>${esc(dirty ? g("sync_wait") : g("sync_ok"))}</div>
    ${w ? `<a class="btn" href="${w}" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">${esc(g("help"))}</a>` : ""}
    <div class="field"><label for="lg-npw">${esc(g("chpw"))}</label><input id="lg-npw" type="password" autocomplete="new-password" placeholder="${esc(g("npw"))}"></div>
    <div class="field"><input id="lg-npw2" type="password" autocomplete="new-password" placeholder="${esc(g("npw2"))}" aria-label="${esc(g("npw2"))}"></div>
    <button class="btn" data-lg-act="chpw">${esc(g("chpw_go"))}</button>
    <button class="btn danger" data-lg-act="logout">${esc(g("out"))}</button></div></section>`;
};
document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest("[data-lg-act]"); if (!b) return;
  e.stopPropagation();
  if (b.dataset.lgAct === "logout") logout(false);
  else if (b.dataset.lgAct === "chpw") changePassword();
}, true);

/* ---------- start ---------- */
if (sess) enter(); else showGate("auth");
})();
