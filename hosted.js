/* Ecrici hosted layer: accounts, owner approval, subscription check, cloud sync.
   Does nothing until config.js is filled in (then the app stays a plain offline notebook). */
(function () {
"use strict";
const hideStyle = document.getElementById("lg-hide");
const CFG = window.ECRICI || {};
if (!CFG.url || !CFG.key || /PASTE|COLLEZ/i.test(CFG.url + CFG.key)) { if (hideStyle) hideStyle.remove(); return; }
const BASE = CFG.url.replace(/\/+$/, "");
const K = { sess: "ecrici-session", acct: "ecrici-acct", owner: "ecrici-owner", sync: "ecrici-synced", base: "ecrici-baseqty" };

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
let shopId = null, member = null, teamOk = true; window.__member = null;
let lid = null, branches = [], multiOk = false, ledgerName = null, branchBlocked = false;
const ledShop = x => ledgerName ? Object.assign({}, x, { name: ledgerName }) : x;
const setMember = info => { member = info && info.role === "employee" ? { id: "member", name: info.name || "", role: "staff" } : null; window.__member = member; };
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
  return cc + (COUNTRIES[country].keep0 ? d : d.replace(/^0+/, ""));
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
    join_t: "Rejoindre une boutique", code: "Code d'invitation", join_go: "Rejoindre", have_join: "J'ai un code d'invitation", join_hint: "Le propriétaire de la boutique vous a invité. Créez votre connexion.", e_invite: "Invitation invalide ou expirée. Demandez un nouveau lien au propriétaire.", e_hasshop: "Ce numéro a déjà sa propre boutique. Utilisez un autre numéro.", nolink_t: "Connexion non liée à une boutique", nolink_p: "Cet accès n'est lié à aucune boutique, ou le propriétaire l'a retiré. Demandez un nouveau lien d'invitation.", emp_blk_t: "Abonnement terminé", emp_blk_p: "L'abonnement de la boutique est terminé. Demandez au propriétaire de le renouveler.",
    tl_t: "Employés avec leur propre connexion", tl_p: "Invitez un employé : il crée sa propre connexion sur son téléphone, sans votre mot de passe. Vous pouvez le retirer à tout moment.", tl_name: "Nom de l'employé", tl_go: "Créer l'invitation", tl_pend: "Invitations en attente (valables 48 h)", tl_team: "Employés", tl_none: "Aucun employé pour l'instant.", tl_wa: "Envoyer par WhatsApp", tl_copy: "Copier le lien", tl_cancel: "Annuler", tl_remove: "Retirer", tl_rm_q: "Retirer cet employé ? Sa connexion sera supprimée.", tl_err: "Impossible pour le moment. Réessayez.", tl_full: "Maximum 10 employés et invitations.", tl_plan: "L'abonnement doit être actif pour inviter.", tl_msg: (shop, name, link) => `Bonjour ${name}, je vous invite à rejoindre ${shop} sur Ecrici. Ouvrez ce lien et créez votre connexion : ${link}`, copied: "Lien copié",
    sh_t: "Mes boutiques", sh_chip: "Boutiques", sh_p: "Gérez plusieurs boutiques avec un seul compte. Chaque boutique a ses propres clients, produits et stock.", sh_price: p => `Chaque boutique en plus : ${p} par mois.`, sh_manage: "Voir mes boutiques", sh_add: "Ajouter une boutique", sh_name: "Nom de la nouvelle boutique", sh_go: "Demander l'ajout", sh_close: "Fermer", sh_back: "Retour", sh_open: "Ouvrir", sh_cur: "Boutique ouverte", sh_pend: "En attente d'activation", sh_susp: "Suspendue", sh_all: "Vue d'ensemble de toutes les boutiques", sh_sent: "Demande envoyée. Écrivez-nous sur WhatsApp pour activer la boutique.", sh_wa: (n, s, p) => `Bonjour, je souhaite ajouter la boutique « ${n} » à mon compte Ecrici (${s}, +${p}).`, sh_err: "Impossible pour le moment. Réessayez.", sh_plan: "L'abonnement doit être actif pour ajouter une boutique.", sh_max: "Nombre maximum de boutiques atteint.", sh_pending_max: "Deux demandes sont déjà en attente. Attendez leur activation.", ov_t: "Toutes les boutiques", ov_today: "Ventes du jour", ov_month: "Ventes du mois", ov_owed: "À recevoir (crédits)", ov_all_today: "Total ventes du jour", ov_skip: n => `${n} boutique(s) pas encore synchronisée(s).`, tl_branch: "Boutique de l'employé",
    inst: "Installer l'application", f_plan: "Abonnement :", f_help: "Besoin d'aide ? WhatsApp", f_priv: "Confidentialité et conditions", ios_t: "Sur iPhone : ouvrez ce site dans Safari, touchez ••• (en bas à droite) ou le bouton Partager (carré avec flèche), touchez Partager, puis faites défiler et touchez « Sur l'écran d'accueil ».",  hint_name: "Écrivez en MAJUSCULES, ex : BOUTIQUE DE VICTOR", hint_phone: "Chiffres seulement, sans le +. Ex :",  forgot: "Mot de passe oublié ? WhatsApp", wa_pw: p => `Bonjour, j'ai oublié mon mot de passe Ecrici. Mon numéro : ${p}`,
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
    join_t: "Join a shop", code: "Invitation code", join_go: "Join", have_join: "I have an invitation code", join_hint: "The shop owner invited you. Create your login.", e_invite: "Invitation invalid or expired. Ask the owner for a new link.", e_hasshop: "This number already has its own shop. Use another number.", nolink_t: "Login not linked to a shop", nolink_p: "This login is not linked to any shop, or the owner removed it. Ask for a new invitation link.", emp_blk_t: "Plan ended", emp_blk_p: "The shop's plan has ended. Ask the owner to renew it.",
    tl_t: "Employees with their own login", tl_p: "Invite an employee: they create their own login on their phone, without your password. You can remove them at any time.", tl_name: "Employee name", tl_go: "Create invitation", tl_pend: "Pending invitations (valid 48 h)", tl_team: "Employees", tl_none: "No employees yet.", tl_wa: "Send on WhatsApp", tl_copy: "Copy link", tl_cancel: "Cancel", tl_remove: "Remove", tl_rm_q: "Remove this employee? Their login will be deleted.", tl_err: "Not possible right now. Try again.", tl_full: "Maximum 10 employees and invitations.", tl_plan: "The plan must be active to invite.", tl_msg: (shop, name, link) => `Hello ${name}, I'm inviting you to join ${shop} on Ecrici. Open this link and create your login: ${link}`, copied: "Link copied",
    sh_t: "My shops", sh_chip: "Shops", sh_p: "Manage several shops with one account. Each shop has its own customers, products and stock.", sh_price: p => `Each extra shop: ${p} per month.`, sh_manage: "See my shops", sh_add: "Add a shop", sh_name: "New shop name", sh_go: "Request this shop", sh_close: "Close", sh_back: "Back", sh_open: "Open", sh_cur: "Open now", sh_pend: "Waiting for activation", sh_susp: "Suspended", sh_all: "Overview of all shops", sh_sent: "Request sent. Message us on WhatsApp to activate the shop.", sh_wa: (n, s, p) => `Hello, I would like to add the shop "${n}" to my Ecrici account (${s}, +${p}).`, sh_err: "Not possible right now. Try again.", sh_plan: "The plan must be active to add a shop.", sh_max: "Maximum number of shops reached.", sh_pending_max: "Two requests are already waiting. Wait until they are activated.", ov_t: "All shops", ov_today: "Sales today", ov_month: "Sales this month", ov_owed: "To collect (credit)", ov_all_today: "Total sales today", ov_skip: n => `${n} shop(s) not synced yet.`, tl_branch: "Employee's shop",
    inst: "Install the app", f_plan: "Plan:", f_help: "Need help? WhatsApp", f_priv: "Privacy and terms", ios_t: "On iPhone: open this site in Safari, tap ••• (bottom right) or the Share button (square with an arrow), tap Share, then scroll and tap \"Add to Home Screen\".",  hint_name: "Write in CAPITAL letters, e.g. VICTOR'S DRYCLEANER", hint_phone: "Digits only, no + sign. Example:",  forgot: "Forgot password? WhatsApp", wa_pw: p => `Hello, I forgot my Ecrici password. My number: ${p}`,
    wa_new: (n, p) => `Hello, I just created my Ecrici account for the shop ${n} (${p}). Please activate it.`,
    wa_renew: (n, p) => `Hello, I would like to renew my Ecrici subscription for the shop ${n} (${p}).`,
    acct: "Account", until: d => `Active until ${d}`, sync_ok: "Synced", sync_wait: "Waiting for connection", logout_q: "Log out? This shop's data will be removed from this phone (it stays in your account).",
    logout_unsynced: "Some changes are not sent yet. Connect to the internet before logging out.", help: "Need help? WhatsApp",
    price: CFG.priceText || ""
  }
};
const PH = { BJ: "01 97 00 00 11", NG: "0803 123 4567", GH: "024 123 4567", KE: "0712 345 678", TG: "90 12 34 56", CI: "07 01 23 45 67", SN: "77 123 45 67", BF: "70 12 34 56", ML: "70 12 34 56", NE: "90 12 34 56", CM: "6 71 23 45 67", ZA: "082 123 4567", RW: "078 123 4567", TZ: "0712 345 678", UG: "0772 123 456" };
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
#lg-gate a.btn{text-decoration:none;text-align:center}
#lg-gate .lg-foot{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);display:grid;gap:6px;text-align:center;color:var(--muted);font-size:13px}
#lg-gate .lg-foot a{color:var(--muted);text-decoration:underline}`;
document.head.appendChild(css);
const gate = document.createElement("div"); gate.id = "lg-gate"; gate.setAttribute("role", "dialog"); gate.setAttribute("aria-modal", "true");
document.body.appendChild(gate);
if (hideStyle) hideStyle.remove();
document.documentElement.setAttribute("translate", "no"); { const m = document.createElement("meta"); m.name = "google"; m.content = "notranslate"; document.head.appendChild(m); }

let gateKind = "loading", mode = "login", form = { country: "BJ", phone: "", name: "", code: "" }, busyAuth = false, authErrText = "";
try {
  const jc = new URLSearchParams(location.search).get("join");
  if (jc) { lsSet("ecrici-join", String(jc).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16)); history.replaceState(null, "", location.pathname); }
  form.code = lsGet("ecrici-join") || ""; if (form.code) mode = "join";
} catch (e) {}
const COUNTRY_OPTS = () => Object.entries(COUNTRIES).map(([k, v]) => `<option value="${k}" ${form.country === k ? "selected" : ""}>${esc(v.name)} (+${v.cc})</option>`).join("");
const shopRow = () => jget(K.acct) || {};
const waLink = txt => CFG.adminWhatsapp ? `https://wa.me/${String(CFG.adminWhatsapp).replace(/\D/g, "")}?text=${encodeURIComponent(txt)}` : "";
const head = () => `<div class="lg-top"><button class="pill" data-lg="lang">${lang() === "fr" ? "FR → EN" : "EN → FR"}</button>${canInst() || isIOS() ? `<button class="pill" data-lg="install">${esc(g("inst"))}</button>` : ""}</div>${iosHelp && isIOS() ? `<div class="lg-msg" style="margin-top:10px">${esc(g("ios_t"))}</div>` : ""}<h1>Ecrici</h1><p class="lg-tag">${esc(g("tag"))}</p>`;

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone;
let iosHelp = false;
function canInst() { try { return typeof deferredInstall !== "undefined" && !!deferredInstall && !matchMedia("(display-mode: standalone)").matches; } catch (e) { return false; } }
window.addEventListener("beforeinstallprompt", () => setTimeout(() => { if (gateKind === "auth") { grab(); drawGate(); } }, 50));
const foot = () => {
  const w = waLink(""), y = new Date().getFullYear();
  return `<div class="lg-foot">${g("price") ? `<div>${esc(g("f_plan"))} <b>${esc(g("price"))}</b></div>` : ""}
    <div>${w ? `<a href="${w}" target="_blank" rel="noopener">${esc(g("f_help"))}</a> · ` : ""}<a href="privacy.html" target="_blank" rel="noopener">${esc(g("f_priv"))}</a></div>
    <div>© ${y} Ecrici</div></div>`;
};
function drawGate() {
  const a = shopRow();
  let h = "";
  if (gateKind === "loading") {
    h = head() + `<p class="lg-tag">${esc(g("wait"))}</p>`;
  } else if (gateKind === "auth") {
    const su = mode === "signup", jn = mode === "join";
    h = head() + `<div class="card form"><h2>${esc(jn ? g("join_t") : su ? g("signup") : g("login"))}</h2>
      ${jn ? `<p class="lg-tag" style="margin:0">${esc(g("join_hint"))}</p>` : ""}
      ${su ? `<div class="field"><label for="lg-name">${esc(g("shop"))}</label><input id="lg-name" value="${esc(form.name)}" autocomplete="organization" autocapitalize="characters" placeholder="${esc(lang() === "fr" ? "BOUTIQUE DE VICTOR" : "VICTOR'S DRYCLEANER")}" style="text-transform:uppercase"></div>` : ""}
      <div class="field"><label for="lg-country">${esc(g("country"))}</label><select id="lg-country">${COUNTRY_OPTS()}</select></div>
      <div class="field"><label for="lg-phone">${esc(g("phone"))}</label><input id="lg-phone" value="${esc(form.phone)}" inputmode="tel" autocomplete="tel" placeholder="${esc(PH[form.country] || "")}"><small class="lg-hint" style="opacity:.7;font-size:.8em">${esc(g("hint_phone"))} ${esc(PH[form.country] || "")}</small></div>
      <div class="field"><label for="lg-pw">${esc(g("pw"))}</label><input id="lg-pw" type="password" autocomplete="${su || jn ? "new-password" : "current-password"}"></div>
      ${jn ? `<div class="field"><label for="lg-code">${esc(g("code"))}</label><input id="lg-code" value="${esc(form.code)}" autocomplete="off" autocapitalize="characters" style="text-transform:uppercase"></div>` : ""}
      <label class="lg-chk"><input type="checkbox" data-lg="showpw"> ${esc(g("show"))}</label>
      <div class="lg-err" id="lg-err" role="alert">${esc(authErrText)}</div>
      <button class="btn primary" data-lg="submit" ${busyAuth ? "disabled" : ""}>${esc(busyAuth ? g("wait") : jn ? g("join_go") : su ? g("signup") : g("login"))}</button>
      <button class="btn small ghost" data-lg="mode" style="justify-self:start">${esc(su || jn ? g("have") : g("nohave"))}</button>
      ${!su && !jn ? `<button class="btn small ghost" data-lg="tojoin" style="justify-self:start">${esc(g("have_join"))}</button>` : ""}
      ${!su && !jn && CFG.adminWhatsapp ? `<button class="btn small ghost" data-lg="forgot" style="justify-self:start">${esc(g("forgot"))}</button>` : ""}</div>`;
  } else if (gateKind === "pending" || gateKind === "blocked") {
    const pend = gateKind === "pending";
    const w = waLink(pend ? g("wa_new", a.name || "", a.phone || "") : g("wa_renew", a.name || "", a.phone || ""));
    h = head() + `<div class="card form"><h2>${esc(member ? g("emp_blk_t") : pend ? g("pend_t") : g("blk_t"))}</h2>
      <div class="lg-msg">${esc(member ? g("emp_blk_p") : pend ? g("pend_p", a.name || "") : g("blk_p"))}</div>
      ${w && !member ? `<a class="btn primary" href="${w}" target="_blank" rel="noopener">${esc(g("wa"))}</a>` : ""}
      <button class="btn" data-lg="check">${esc(g("check"))}</button>
      ${!pend && !member && lsGet(K.owner) === (sess && sess.uid) ? `<button class="btn" data-lg="backup">${esc(g("backup"))}</button>` : ""}
      <button class="btn small ghost" data-lg="logout" style="justify-self:start">${esc(g("out"))}</button></div>`;
  } else if (gateKind === "nolink") {
    h = head() + `<div class="card form"><h2>${esc(g("nolink_t"))}</h2><div class="lg-msg">${esc(g("nolink_p"))}</div>
      <button class="btn primary" data-lg="tojoin">${esc(g("have_join"))}</button>
      <button class="btn small ghost" data-lg="forcelogout" style="justify-self:start">${esc(g("out"))}</button></div>`;
  } else if (gateKind === "offline" || gateKind === "error") {
    const off = gateKind === "offline";
    h = head() + `<div class="card form"><h2>${esc(off ? g("off_t") : g("err_t"))}</h2><div class="lg-msg">${esc(off ? g("off_p") : g("err_p"))}</div>
      <button class="btn primary" data-lg="check">${esc(g("retry"))}</button>
      <button class="btn small ghost" data-lg="logout" style="justify-self:start">${esc(g("out"))}</button></div>`;
  }
  gate.innerHTML = `<div class="lg-wrap">${h}${gateKind === "loading" ? "" : foot()}</div>`;
  gate.hidden = false;
}
function showGate(kind) { gateKind = kind; drawGate(); }
function hideGate() { gate.hidden = true; gate.innerHTML = ""; gateKind = "none"; }

gate.addEventListener("click", async e => {
  const b = e.target.closest("[data-lg]"); if (!b) return;
  const act = b.dataset.lg;
  if (act === "lang") { S.shop.lang = lang() === "fr" ? "en" : "fr"; try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (x) {} drawGate(); }
  else if (act === "mode") { grab(); mode = mode === "login" ? "signup" : "login"; authErrText = ""; drawGate(); }
  else if (act === "tojoin") { grab(); mode = "join"; authErrText = ""; gateKind = "auth"; drawGate(); }
  else if (act === "forcelogout") forceLogout();
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
  const c = v("#lg-country"), p = v("#lg-phone"), n = v("#lg-name"), cd = v("#lg-code");
  if (c) form.country = c; if (p !== null) form.phone = p; if (n !== null) form.name = n; if (cd !== null) form.code = cd.toUpperCase().replace(/[^A-Z0-9]/g, "");
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
  const su = mode === "signup", jn = mode === "join";
  const id = canon(form.country, form.phone);
  authErrText = "";
  if (id.length < 10 || id.length > 15) authErrText = g("e_phone");
  else if (su && !form.name.trim().toUpperCase()) authErrText = g("e_name");
  else if (pw.length < 6) authErrText = g("e_weak");
  else if (jn && form.code.length < 6) authErrText = g("e_invite");
  if (authErrText) { drawGate(); return; }
  busyAuth = true; drawGate();
  try {
    let r;
    if (su) r = await http("/auth/v1/signup", { method: "POST", body: { email: emailOf(id), password: pw, data: { name: form.name.trim().toUpperCase(), phone: id, country: form.country } } });
    else if (jn) {
      r = await http("/auth/v1/signup", { method: "POST", body: { email: emailOf(id), password: pw, data: { join: form.code, phone: id, country: form.country } } });
      if (!r.ok && /exists|already/i.test(String((r.json || {}).error_code || "") + String((r.json || {}).msg || ""))) r = await http("/auth/v1/token?grant_type=password", { method: "POST", body: { email: emailOf(id), password: pw } });
    }
    else r = await http("/auth/v1/token?grant_type=password", { method: "POST", body: { email: emailOf(id), password: pw } });
    if (!r.ok) { authErrText = authMsg(r); }
    else if (!r.json || !r.json.access_token) { authErrText = g("e_confirm"); }
    else {
      sess = null; setSess(r.json);
      if (jn) {
        const jr = await api("/rest/v1/rpc/team_join", { method: "POST", body: { p_code: form.code } });
        const m = String((jr.json && (jr.json.message || jr.json.msg)) || "");
        if (!jr.ok && !/already in a team/i.test(m)) { authErrText = /already has a shop/i.test(m) ? g("e_hasshop") : g("e_invite"); busyAuth = false; drawGate(); return; }
      }
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
  const r = await api("/rest/v1/shops?id=eq." + (shopId || sess.uid) + "&select=*");
  if (!r.ok) throw httpErr(r);
  return (r.json && r.json[0]) || null;
}
async function loadMe() {
  const r = await api("/rest/v1/rpc/me_info", { method: "POST", body: {} });
  if (r.status === 404) { teamOk = false; return { role: "owner", shop_id: sess.uid, legacy: true }; }
  if (!r.ok) throw httpErr(r);
  teamOk = true;
  return r.json || {};
}
async function enter() {
  if (!sess) { showGate("auth"); return; }
  showGate("loading");
  let shop;
  try {
    const info = await loadMe();
    if (info.role === "none") { setMember(null); shopId = null; lid = null; showGate("nolink"); return; }
    shopId = info.shop_id || sess.uid; setMember(info);
    lid = info.ledger_id || shopId; ledgerName = member ? (info.branch_name || null) : null; branchBlocked = !!member && info.branch_ok === false;
    if (!member) {
      await loadBranches();
      const ab = lsGet("ecrici-branch");
      if (ab) {
        const br = branches.find(b => b.id === ab);
        if (br && br.status === "active") { lid = ab; ledgerName = br.name; }
        else if (multiOk) { stashOut(ab); stashIn(shopId); lsDel("ecrici-branch"); location.reload(); return; }
        else lid = ab;
      }
    }
    shop = await getShop();
  }
  catch (e) {
    if (e.auth) { active = false; showGate("auth"); return; }
    if (e.offline || !e.status || e.status >= 500) {
      const c = jget(K.acct);
      if (offlineOk(c)) { shopId = c.shopId || sess.uid; lid = c.lid || shopId; ledgerName = c.ledgerName || null; branches = c.branches || []; multiOk = !!c.branches; setMember(c.role === "employee" ? { role: "employee", name: c.mname } : null); unlockOffline(); return; }
      showGate("offline"); return;
    }
    showGate("error"); return;
  }
  if (!shop) { showGate("error"); return; }
  const a = { uid: sess.uid, shopId, lid, ledgerName, branches: member || !multiOk ? undefined : branches, role: member ? "employee" : "owner", mname: member ? member.name : "", status: shop.status, paid_until: shop.paid_until, name: shop.name, phone: shop.phone, country: shop.country, checked: Date.now() };
  lsSet(K.acct, JSON.stringify(a));
  if (!valid(a) || branchBlocked) { active = false; showGate(member ? "blocked" : a.status === "pending" ? "pending" : "blocked"); return; }
  try { await reconcile(ledShop(shop)); } catch (e) { if (e.auth) { showGate("auth"); return; } }
  lsDel("ecrici-join"); form.code = ""; if (mode === "join") mode = "login";
  active = true; lastCheck = Date.now(); hideGate(); updateStatus(); render();
}
function unlockOffline() { active = true; storeMode = "device"; hideGate(); updateStatus(); render(); }

/* ---------- data: which copy wins ---------- */
const hasReal = () => S.txs.some(x => !x.example) || S.customers.some(c => !c.example) || S.products.some(p => !p.example);
function replaceLocal(d) {
  S = migrate(d); lastSynced = S.updated || 0; lsSet(K.sync, String(lastSynced)); saveBase();
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {}
  ui.view = "home"; ui.modal = null; ui.draft = null; render();
}
function freshBlank(shop) {
  S = blank(); S.shop.name = shop.name || S.shop.name; S.shop.phone = shop.phone || ""; S.shop.country = shop.country || "BJ"; S.shop.lang = lang();
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {}
  lastSynced = 0; ui.view = "home"; ui.modal = null; render();
}
/* ---------- merging two copies (nothing is lost when two phones save) ---------- */
function saveBase() { try { const m = {}; (S.products || []).forEach(p => { m[p.id] = p.qty; }); lsSet(K.base, JSON.stringify(m)); } catch (e) {} }
function unionById(a, b, pick) {
  const out = [], seen = new Map();
  (a || []).forEach(x => { seen.set(x.id, x); out.push(x); });
  (b || []).forEach(y => { const x = seen.get(y.id); if (!x) { seen.set(y.id, y); out.push(y); } else if (pick) { const i = out.indexOf(x), z = pick(x, y); out[i] = z; seen.set(y.id, z); } });
  return out;
}
function mergeLedgers(loc, rem) {
  let base = {}; try { base = JSON.parse(lsGet(K.base) || "{}") || {}; } catch (e) {}
  const m = Object.assign({}, rem, loc);
  m.shop = member ? rem.shop : loc.shop;
  m.txs = unionById(loc.txs, rem.txs, (x, y) => (x.void ? x : y.void ? y : x)).sort((a, b) => (a.no || 0) - (b.no || 0));
  m.customers = unionById(loc.customers, rem.customers, (x, y) => x);
  m.staff = unionById(loc.staff, rem.staff, (x, y) => x);
  m.expenses = unionById(loc.expenses, rem.expenses, (x, y) => x);
  m.expRules = unionById(loc.expRules, rem.expRules, (x, y) => (String(x.next) >= String(y.next) ? x : y));
  m.products = unionById(loc.products, rem.products, (x, y) => {
    const b0 = base[x.id], z = Object.assign({}, x);
    if (typeof b0 === "number") z.qty = Math.round((x.qty + y.qty - b0) * 1000) / 1000;
    return z;
  });
  m.counter = Math.max(loc.counter || 0, rem.counter || 0, ...m.txs.map(t => t.no || 0));
  m.updated = Math.max(Date.now(), (loc.updated || 0) + 1, (rem.updated || 0) + 1);
  return m;
}
function applyMerged(m) {
  S = migrate(m);
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {}
  try { render(); } catch (e) {}
}
async function reconcile(shop) {
  const r = await api("/rest/v1/ledgers?shop_id=eq." + lid + "&select=data,updated");
  if (!r.ok) throw httpErr(r);
  const row = r.json && r.json[0], owner = lsGet(K.owner), mine = owner === lid || (!member && owner == null && hasReal());
  if (row && row.data && row.data.shop) {
    if (mine) {
      const remoteChanged = row.updated > lastSynced, localChanged = (S.updated || 0) > lastSynced;
      if (remoteChanged && !localChanged) replaceLocal(row.data);
      else if (remoteChanged && localChanged) { applyMerged(mergeLedgers(S, row.data)); lastSynced = row.updated; lsSet(K.sync, String(lastSynced)); await doPush(); }
      else if (localChanged) await doPush();
      else { lastSynced = S.updated || lastSynced; }
    } else replaceLocal(row.data);
  } else {
    if (mine) await doPush(); else { freshBlank(shop); await doPush(); }
  }
  lsSet(K.owner, lid); storeMode = "account";
}
async function doPush() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const snap = S.updated, body = { data: S, updated: snap, updated_at: new Date().toISOString() };
    if (lastSynced > 0) {
      const r = await api("/rest/v1/ledgers?shop_id=eq." + lid + "&updated=eq." + lastSynced, { method: "PATCH", headers: { Prefer: "return=representation" }, body });
      if (!r.ok) throw httpErr(r);
      if (Array.isArray(r.json) && r.json.length) { lastSynced = snap; lsSet(K.sync, String(snap)); saveBase(); storeMode = "account"; return; }
    }
    const g2 = await api("/rest/v1/ledgers?shop_id=eq." + lid + "&select=data,updated");
    if (!g2.ok) throw httpErr(g2);
    const row = g2.json && g2.json[0];
    if (!row) {
      const r = await api("/rest/v1/ledgers", { method: "POST", headers: { Prefer: "return=minimal" }, body: Object.assign({ shop_id: lid }, body) });
      if (r.ok) { lastSynced = snap; lsSet(K.sync, String(snap)); saveBase(); storeMode = "account"; return; }
      if (r.status === 409) continue;
      throw httpErr(r);
    }
    if (row.updated === snap) { lastSynced = snap; lsSet(K.sync, String(snap)); saveBase(); storeMode = "account"; return; }
    applyMerged(mergeLedgers(S, row.data));
    lastSynced = row.updated; lsSet(K.sync, String(lastSynced));
  }
  throw new Error("sync busy");
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
    const shop = await getShop(); if (!shop) { if (member) enter(); return; }
    const a = { uid: sess.uid, shopId, lid, ledgerName, branches: member || !multiOk ? undefined : branches, role: member ? "employee" : "owner", mname: member ? member.name : "", status: shop.status, paid_until: shop.paid_until, name: shop.name, phone: shop.phone, country: shop.country, checked: Date.now() };
    lsSet(K.acct, JSON.stringify(a));
    if (!valid(a)) { active = false; showGate(a.status === "pending" ? "pending" : "blocked"); return; }
    await reconcile(ledShop(shop)); updateStatus();
  } catch (e) { if (e.auth) { active = false; showGate("auth"); } }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh(); else if (active) window.pushCloud();
});
window.addEventListener("online", () => { if (gateKind === "offline") enter(); else if (active) { lastCheck = 0; refresh(); } });
setInterval(() => { if (active && document.visibilityState === "visible") refresh(); }, 6 * 3600 * 1000);

/* ---------- log out ---------- */
async function logout(fromGate) {
  const owned = lsGet(K.owner) === (lid || shopId || (sess && sess.uid));
  if (owned && S.updated > lastSynced) {
    let ok = false;
    if (active) { try { await doPush(); ok = true; } catch (e) {} }
    if (!ok) { alert(g("logout_unsynced")); return; }
  }
  if (!confirm(g("logout_q"))) return;
  if (sess) { try { await api("/auth/v1/logout", { method: "POST" }); } catch (e) {} }
  [K.sess, K.acct, K.sync].forEach(lsDel); clearStash();
  if (owned) { lsDel(K.owner); lsDel(LS_KEY); }
  location.reload();
}

window.__logout = () => logout(false);
async function forceLogout() {
  if (sess) { try { await api("/auth/v1/logout", { method: "POST" }); } catch (e) {} }
  [K.sess, K.acct, K.sync, K.owner, K.base, "ecrici-join"].forEach(lsDel); clearStash(); lsDel(LS_KEY);
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

/* ---------- Settings: employees with their own login ---------- */
const team = { loaded: false, loading: false, at: 0, members: [], pending: [], err: "" };
async function loadTeam() {
  if (team.loading) return; team.loading = true;
  try {
    const a = await api("/rest/v1/rpc/team_list", { method: "POST", body: {} });
    const b = await api("/rest/v1/rpc/team_pending", { method: "POST", body: {} });
    if (a.ok && b.ok) { team.members = a.json || []; team.pending = b.json || []; team.err = ""; } else team.err = g("tl_err");
  } catch (e) { team.err = g("tl_err"); }
  team.loaded = true; team.loading = false; team.at = Date.now();
  if (ui.view === "set") { try { render(); } catch (e) {} }
}
const inviteLink = c => location.origin + location.pathname.replace(/[^/]*$/, "") + "?join=" + c;
async function teamCall(fn, body) {
  try {
    const r = await api("/rest/v1/rpc/" + fn, { method: "POST", body });
    if (!r.ok) { const m = String((r.json && (r.json.message || r.json.msg)) || ""); team.err = /plan inactive/i.test(m) ? g("tl_plan") : /too many/i.test(m) ? g("tl_full") : g("tl_err"); }
    else team.err = "";
  } catch (e) { team.err = g("tl_err"); }
  team.loaded = false; await loadTeam();
}
function teamSection() {
  if (member || !active || !teamOk) return "";
  if (!team.loading && (!team.loaded || Date.now() - team.at > 15000)) loadTeam();
  const mainNm = (lid === shopId ? ledName() : shopRow().name) || "", actBr = branches.filter(b => b.status === "active");
  const brName = id => id ? ((branches.find(b => b.id === id) || {}).name || "") : (branches.length ? mainNm : "");
  const rows = team.members.map(m => `<div class="row" style="cursor:default"><div class="main"><div class="name">${esc(m.name)}</div>${brName(m.branch_id) ? `<div class="sub">${esc(brName(m.branch_id))}</div>` : ""}</div><button class="btn small danger" data-lg-act="tm-remove" data-id="${esc(m.user_id)}">${esc(g("tl_remove"))}</button></div>`).join("");
  const pend = team.pending.map(p => { const link = inviteLink(p.code), msg = g("tl_msg", (p.branch_id ? brName(p.branch_id) : mainNm), p.name, link);
    return `<div class="card flush" style="background:var(--paper);padding:10px;display:grid;gap:8px"><div class="name">${esc(p.name)}</div>${brName(p.branch_id) ? `<div class="sub">${esc(brName(p.branch_id))}</div>` : ""}<div class="note" style="word-break:break-all;margin:0">${esc(link)}</div><div class="actions"><a class="btn small primary" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener" style="text-decoration:none">${esc(g("tl_wa"))}</a><button class="btn small" data-lg-act="tm-copy" data-link="${esc(link)}">${esc(g("tl_copy"))}</button><button class="btn small" data-lg-act="tm-cancel" data-id="${esc(p.code)}">${esc(g("tl_cancel"))}</button></div></div>`; }).join("");
  return `<section class="sec"><h2>${esc(g("tl_t"))}</h2><div class="card form"><p class="note" style="margin:0">${esc(g("tl_p"))}</p>
    ${team.err ? `<div class="err" role="alert">${esc(team.err)}</div>` : ""}
    <div class="field"><label for="tm-name">${esc(g("tl_name"))}</label><input id="tm-name" autocomplete="off"></div>
    ${actBr.length ? `<div class="field"><label for="tm-branch">${esc(g("tl_branch"))}</label><select id="tm-branch"><option value="">${esc(mainNm)}</option>${actBr.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("")}</select></div>` : ""}
    <button class="btn primary" data-lg-act="tm-invite">${esc(g("tl_go"))}</button>
    ${team.pending.length ? `<div class="note" style="margin:0;font-weight:600">${esc(g("tl_pend"))}</div>${pend}` : ""}
    <div class="note" style="margin:0;font-weight:600">${esc(g("tl_team"))}</div>
    ${team.members.length ? `<div class="card flush" style="background:var(--paper)">${rows}</div>` : `<div class="note" style="margin:0">${esc(g("tl_none"))}</div>`}</div></section>`;
}

/* ---------- Settings: account block ---------- */
const baseSettings = window.viewSettings;
window.viewSettings = function () {
  const a = shopRow(), l = lang();
  const until = a.paid_until ? new Date(a.paid_until + "T12:00:00").toLocaleDateString(l === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
  const dirty = S.updated > lastSynced;
  const w = waLink("");
  return baseSettings() + shopsSection() + teamSection() + `<section class="sec"><h2>${esc(g("acct"))}</h2><div class="card form">
    <div class="note" style="margin:0">${esc(a.phone ? "+" + a.phone : "")}${until ? " · " + esc(g("until", until)) : ""}<br>${esc(dirty ? g("sync_wait") : g("sync_ok"))}</div>
    ${w ? `<a class="btn" href="${w}" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">${esc(g("help"))}</a>` : ""}
    <div class="field"><label for="lg-npw">${esc(g("chpw"))}</label><input id="lg-npw" type="password" autocomplete="new-password" placeholder="${esc(g("npw"))}"></div>
    <div class="field"><input id="lg-npw2" type="password" autocomplete="new-password" placeholder="${esc(g("npw2"))}" aria-label="${esc(g("npw2"))}"></div>
    <button class="btn" data-lg-act="chpw">${esc(g("chpw_go"))}</button>
    <a class="btn" href="privacy.html" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">${esc(g("f_priv"))}</a>
    <button class="btn danger" data-lg-act="logout">${esc(g("out"))}</button></div></section>`;
};
document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest("[data-lg-act]"); if (!b) return;
  e.stopPropagation();
  if (b.dataset.lgAct === "shops") { sh.open = true; sh.view = "list"; sh.err = ""; sh.msg = ""; sh.wa = ""; drawShops(); }
  else if (b.dataset.lgAct === "sh-veil") { if (e.target === b) { sh.open = false; drawShops(); } }
  else if (b.dataset.lgAct === "sh-close") { sh.open = false; drawShops(); }
  else if (b.dataset.lgAct === "sh-open") switchLedger(b.dataset.id);
  else if (b.dataset.lgAct === "sh-all") { sh.view = "overview"; loadOverview(); }
  else if (b.dataset.lgAct === "sh-back") { sh.view = "list"; drawShops(); }
  else if (b.dataset.lgAct === "sh-add") addShop();
  else if (b.dataset.lgAct === "logout") logout(false);
  else if (b.dataset.lgAct === "chpw") changePassword();
  else if (b.dataset.lgAct === "tm-invite") { const n = ((document.getElementById("tm-name") || {}).value || "").trim(); if (n) { const bs = document.getElementById("tm-branch"), body = { p_name: n }; if (bs && bs.value) body.p_branch = bs.value; teamCall("team_invite", body); } }
  else if (b.dataset.lgAct === "tm-copy") copyText(b.dataset.link);
  else if (b.dataset.lgAct === "tm-cancel") teamCall("team_cancel", { p_code: b.dataset.id });
  else if (b.dataset.lgAct === "tm-remove") { if (confirm(g("tl_rm_q"))) teamCall("team_remove", { target: b.dataset.id }); }
}, true);

/* ---------- several shops in one account ---------- */
const sh = { open: false, view: "list", msg: "", err: "", busy: false, ov: null, ovBusy: false };
const STASH_KEYS = () => [LS_KEY, K.sync, K.base, K.owner];
const stashOut = id => STASH_KEYS().forEach(k => { const v = lsGet(k); if (v != null) lsSet("ecrici-stash:" + id + ":" + k, v); else lsDel("ecrici-stash:" + id + ":" + k); });
const stashIn = id => STASH_KEYS().forEach(k => { const v = lsGet("ecrici-stash:" + id + ":" + k); if (v != null) lsSet(k, v); else lsDel(k); });
function clearStash() { try { Object.keys(localStorage).filter(k => k.indexOf("ecrici-stash:") === 0 || k === "ecrici-branch").forEach(k => localStorage.removeItem(k)); } catch (e) {} }
async function loadBranches() {
  try {
    const r = await api("/rest/v1/rpc/branch_list", { method: "POST", body: {} });
    if (r.status === 404) { multiOk = false; branches = []; return; }
    if (!r.ok) throw httpErr(r);
    multiOk = true; branches = r.json || [];
  } catch (e) { if (e.auth) throw e; /* keep what we know when offline */ }
}
async function switchLedger(target, force) {
  if (target === lid) return;
  if (!force && active && S.updated > lastSynced) { try { await doPush(); } catch (e) { alert(g("logout_unsynced")); return; } }
  stashOut(lid); stashIn(target);
  if (target === shopId) lsDel("ecrici-branch"); else lsSet("ecrici-branch", target);
  location.reload();
}
const ledName = () => (S && S.shop && S.shop.name) || "";
window.__shopChip = () => (!member && active && multiOk && branches.length) ? `<button class="pill" data-lg-act="shops" aria-haspopup="dialog">${esc(g("sh_chip"))} ▾</button>` : "";
const extraPrice = () => CFG.extraPriceText || "+700 FCFA";
function shopsSection() {
  if (member || !active || !multiOk) return "";
  return `<section class="sec"><h2>${esc(g("sh_t"))}</h2><div class="card form"><p class="note" style="margin:0">${esc(g("sh_p"))} ${esc(g("sh_price", extraPrice()))}</p>
    <button class="btn primary" data-lg-act="shops">${esc(branches.length ? g("sh_manage") : g("sh_add"))}</button></div></section>`;
}
const statLabel = s => s === "active" ? "" : s === "pending" ? g("sh_pend") : g("sh_susp");
function drawShops() {
  let el = document.getElementById("lg-shops");
  if (!sh.open) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement("div"); el.id = "lg-shops"; document.body.appendChild(el); }
  const a = shopRow(), mainName = (lid === shopId ? ledName() : a.name) || a.name || "";
  let inner = "";
  if (sh.view === "overview") {
    const o = sh.ov;
    inner = `<div class="dlg"><h2>${esc(g("ov_t"))}</h2>${sh.ovBusy || !o ? `<p class="note" style="margin:0">${esc(g("wait"))}</p>` : `
      ${o.rows.map(r => `<div class="card flush" style="background:var(--paper);padding:10px;display:grid;gap:4px"><div class="name">${esc(r.name)}</div>
        <div class="stat" style="padding:2px 0;border:0"><span>${esc(g("ov_today"))}</span><span class="num">${money(r.today)}</span></div>
        <div class="stat" style="padding:2px 0;border:0"><span>${esc(g("ov_month"))}</span><span class="num">${money(r.month)}</span></div>
        <div class="stat" style="padding:2px 0;border:0"><span>${esc(g("ov_owed"))}</span><span class="num">${money(r.owed)}</span></div></div>`).join("")}
      <div class="total"><span>${esc(g("ov_all_today"))}</span><span class="num">${money(o.today)}</span></div>
      <div class="stat" style="border:0;padding:0"><span>${esc(g("ov_month"))}</span><span class="num">${money(o.month)}</span></div>
      <div class="stat" style="border:0;padding:0"><span>${esc(g("ov_owed"))}</span><span class="num">${money(o.owed)}</span></div>
      ${o.skipped ? `<p class="note" style="margin:0">${esc(g("ov_skip", o.skipped))}</p>` : ""}`}
      <div class="actions"><button class="btn" data-lg-act="sh-back">${esc(g("sh_back"))}</button></div></div>`;
  } else {
    const rows = [{ id: shopId, name: mainName, status: "active" }].concat(branches);
    inner = `<div class="dlg"><h2>${esc(g("sh_t"))}</h2>
      <div class="card flush">${rows.map(b => { const cur = b.id === lid, ok = b.status === "active";
        return `<button class="row" ${ok && !cur ? `data-lg-act="sh-open" data-id="${esc(b.id)}"` : "disabled"} style="${ok ? "" : "opacity:.6;cursor:default"}"><div class="main"><div class="name">${esc(b.name || "")}</div><div class="sub">${esc(cur ? g("sh_cur") : statLabel(b.status))}</div></div>${ok && !cur ? `<span class="badge paid">${esc(g("sh_open"))}</span>` : ""}</button>`; }).join("")}</div>
      ${branches.some(b => b.status === "active") ? `<button class="btn" data-lg-act="sh-all">${esc(g("sh_all"))}</button>` : ""}
      <div class="field"><label for="sh-name">${esc(g("sh_name"))}</label><input id="sh-name" autocomplete="off" autocapitalize="characters" style="text-transform:uppercase"></div>
      <p class="note" style="margin:0">${esc(g("sh_price", extraPrice()))}</p>
      ${sh.err ? `<div class="err" role="alert">${esc(sh.err)}</div>` : ""}
      ${sh.msg ? `<div class="lg-msg" style="background:var(--warn-bg);color:var(--warn-ink);border-radius:12px;padding:10px 12px;font-size:14px">${esc(sh.msg)}</div>${waLink(sh.wa || "") && sh.wa ? `<a class="btn primary" href="${waLink(sh.wa)}" target="_blank" rel="noopener" style="text-decoration:none">${esc(g("wa"))}</a>` : ""}` : ""}
      <button class="btn primary" data-lg-act="sh-add" ${sh.busy ? "disabled" : ""}>${esc(sh.busy ? g("wait") : g("sh_go"))}</button>
      <button class="btn" data-lg-act="sh-close">${esc(g("sh_close"))}</button></div>`;
  }
  el.innerHTML = `<div class="veil" data-lg-act="sh-veil"><div class="sheet" role="dialog" aria-modal="true">${inner}</div></div>`;
}
function ledgerStats(d) {
  const tk = new Date().toLocaleDateString("sv"), mk = tk.slice(0, 7), bal = {}; let today = 0, month = 0;
  (d.txs || []).forEach(x => { if (x.void) return; const day = new Date(x.date).toLocaleDateString("sv");
    if (x.type === "sale") { if (day === tk) today += x.total; if (day.slice(0, 7) === mk) month += x.total; if (x.cust) bal[x.cust] = (bal[x.cust] || 0) + x.total - x.paid; }
    else if (x.cust) bal[x.cust] = (bal[x.cust] || 0) - x.amount; });
  return { today, month, owed: Object.values(bal).reduce((s, v) => s + Math.max(0, v), 0) };
}
async function loadOverview() {
  sh.ovBusy = true; sh.ov = null; drawShops();
  let remote = {};
  try { const r = await api("/rest/v1/ledgers?select=shop_id,data"); if (r.ok) (r.json || []).forEach(x => { remote[x.shop_id] = x.data; }); } catch (e) {}
  const list = [{ id: shopId, name: (lid === shopId ? ledName() : shopRow().name) || "" }].concat(branches.filter(b => b.status === "active").map(b => ({ id: b.id, name: b.name })));
  const rows = []; let skipped = 0;
  list.forEach(s => { const d = s.id === lid ? S : remote[s.id]; if (!d) { skipped++; return; } rows.push(Object.assign({ name: s.name }, ledgerStats(d))); });
  sh.ov = { rows, skipped, today: rows.reduce((s, r) => s + r.today, 0), month: rows.reduce((s, r) => s + r.month, 0), owed: rows.reduce((s, r) => s + r.owed, 0) };
  sh.ovBusy = false; drawShops();
}
async function addShop() {
  const el = document.getElementById("sh-name"), n = ((el && el.value) || "").trim().toUpperCase();
  sh.err = ""; sh.msg = "";
  if (!n) { sh.err = g("e_name"); drawShops(); return; }
  sh.busy = true; drawShops();
  try {
    const r = await api("/rest/v1/rpc/branch_add", { method: "POST", body: { p_name: n } });
    if (!r.ok) { const m = String((r.json && (r.json.message || r.json.msg)) || ""); sh.err = /plan inactive/i.test(m) ? g("sh_plan") : /too many pending/i.test(m) ? g("sh_pending_max") : /too many/i.test(m) ? g("sh_max") : g("sh_err"); }
    else { await loadBranches(); const a = shopRow(); lsSet(K.acct, JSON.stringify(Object.assign(a, { branches }))); sh.msg = g("sh_sent"); sh.wa = g("sh_wa", n, a.name || "", a.phone || ""); try { render(); } catch (e) {} }
  } catch (e) { sh.err = e.offline ? g("offline") : g("sh_err"); }
  sh.busy = false; drawShops();
}

/* ---------- start ---------- */
if (sess) enter(); else showGate("auth");
})();
