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
let langTouched = false;
const cLang = c => { try { return (COUNTRIES[c] && COUNTRIES[c].lang) === "en" ? "en" : "fr"; } catch (e) { return "fr"; } };
const PW_COMMON = ["password","passw0rd","motdepasse","azerty","azertyui","qwerty","qwertyui","admin","welcome","iloveyou","ecrici","bienvenue","abc123","letmein"];
function pwProblem(pw, phone) {
  const p = String(pw || ""), low = p.toLowerCase(), digits = String(phone || "").replace(/\D/g, "");
  if (p.length < 8) return true;
  if (new Set(p).size < 4) return true;
  if (!/[a-z]/i.test(p) || !/\d/.test(p)) return true;
  const seq = "0123456789012345678901234567890 abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i + 6 <= low.length; i++) { const w = low.slice(i, i + 6); if (seq.includes(w) || seq.includes([...w].reverse().join(""))) return true; }
  if (PW_COMMON.some(w => low.includes(w) && low.length <= w.length + 4)) return true;
  if (digits.length >= 6 && p.replace(/\D/g, "").includes(digits.slice(-6))) return true;
  return false;
}
const langInit = () => { try { if (!localStorage.getItem("ecrici-lang-init")) { localStorage.setItem("ecrici-lang-init", "1"); if (/^en/i.test(navigator.language || "") && S && S.shop && S.shop.lang === "fr" && S.shop.name === "Ma Boutique") S.shop.lang = "en"; } } catch (e) {} };
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
const PRICES = { BJ:["FCFA",1000,700], TG:["FCFA",1000,700], CI:["FCFA",1000,700], SN:["FCFA",1000,700], BF:["FCFA",1000,700], ML:["FCFA",1000,700], NE:["FCFA",1000,700], CM:["FCFA",1000,700],
  NG:["\u20a6",2500,2000,1], GH:["GH\u20b5",20,15,1], KE:["KSh",250,150,1], ZA:["R",30,20,1], RW:["RWF",2500,1500], TZ:["TZS",4500,3000], UG:["UGX",6500,4500] };
const priceOf = cc => { const o = (CFG.prices && CFG.prices[cc]) || {}, d = PRICES[cc] || PRICES.BJ; return { cur: o.cur || d[0], base: Number(o.base) || d[1], extra: Number(o.extra) || d[2], pre: o.pre != null ? !!o.pre : !!d[3] }; };
const fmtMoney = (n, cc, l) => { const p = priceOf(cc), s = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, l === "fr" ? "\u202f" : ","); return p.pre ? p.cur + s : s + " " + p.cur; };
const curCountry = () => { try { if (typeof S !== "undefined" && S && S.shop && S.shop.country && PRICES[S.shop.country] && gateKind !== "auth" && gateKind !== "loading") return S.shop.country; } catch (e) {} return form.country; };
const G = {
  fr: {
    tag: "Le cahier de votre activité : ventes, crédits et reçus, même sans internet.",
    login: "Se connecter", signup: "Créer mon compte", have: "J'ai déjà un compte", nohave: "Nouveau ? Créer un compte",
    shop: "Nom de votre activité", country: "Pays", phone: "Numéro de téléphone", pw: "Mot de passe (8 caractères ou plus, lettres et chiffres)", pw_login: "Mot de passe", show: "Afficher le mot de passe",
    wait: "Un instant…", offline: "Pas de connexion internet. Connectez-vous une première fois avec internet.",
    e_creds: "Numéro ou mot de passe incorrect.", e_exists: "Ce numéro a déjà un compte. Connectez-vous.", e_weak: "Choisissez un mot de passe plus fort : 8 caractères minimum avec des lettres et des chiffres, sans suite comme 12345678 ni votre numéro.",
    e_rate: "Trop d'essais. Réessayez dans quelques minutes.", e_phone: "Numéro de téléphone invalide.", e_name: "Écrivez le nom de votre activité.",
    e_email: "Le serveur refuse ce numéro (voir le guide de lancement).", e_other: "Erreur. Réessayez.", e_confirm: "Compte créé, mais le serveur demande une confirmation. Voir le guide.",
    pend_t: "Compte créé", pend_p: n => `Votre compte « ${n} » attend l'approbation. Écrivez-nous sur WhatsApp pour l'activer.`,
    blk_t: "Abonnement terminé", blk_p: "Votre abonnement est terminé ou suspendu. Vos données restent sur ce téléphone. Contactez-nous pour le renouveler.",
    del_btn: "Supprimer mon compte", del_t: "Supprimer mon compte", del_p: "Cette action est définitive. Votre compte, toutes vos boutiques, vos clients, produits, ventes et les connexions de vos employés seront effacés de nos serveurs et de ce téléphone. L'abonnement déjà payé n'est pas remboursé.", del_bk: "Sauvegarder mes données d'abord", del_pw: "Votre mot de passe", del_word: "Écrivez SUPPRIMER pour confirmer", del_key: "SUPPRIMER", del_go: "Supprimer définitivement", del_no: "Annuler", del_bad: "Mot de passe incorrect.", del_miss: "Écrivez SUPPRIMER et votre mot de passe.", del_fail: "Impossible de supprimer pour le moment. Vérifiez internet et réessayez.", del_ok: "Compte supprimé.",
    wa: "Écrire sur WhatsApp", check: "Vérifier maintenant", out: "Se déconnecter", backup: "Sauvegarder mes données",
    off_t: "Pas de connexion", off_p: "Impossible de vérifier votre abonnement pour l'instant. Réessayez avec internet.", retry: "Réessayer",
    err_t: "Compte introuvable", err_p: "Votre compte n'est pas encore prêt. Réessayez dans un instant.",
    chpw: "Changer le mot de passe", npw: "Nouveau mot de passe", npw2: "Répétez le mot de passe", chpw_go: "Enregistrer le mot de passe", chpw_ok: "Mot de passe changé", chpw_mismatch: "Les deux mots de passe sont différents.", chpw_weak: "Mot de passe trop faible : 8 caractères minimum avec des lettres et des chiffres, sans suite comme 12345678.", chpw_fail: "Impossible pour le moment. Réessayez avec internet.", chpw_login: "Pour votre sécurité, déconnectez-vous puis reconnectez-vous avant de changer le mot de passe.",
    join_t: "Rejoindre une équipe", code: "Code d'invitation", join_go: "Rejoindre", have_join: "J'ai un code d'invitation", join_hint: "Le propriétaire vous a invité. Créez votre connexion.", e_invite: "Invitation invalide ou expirée. Demandez un nouveau lien au propriétaire.", e_hasshop: "Ce numéro a déjà sa propre boutique. Utilisez un autre numéro.", nolink_t: "Connexion non liée à une boutique", nolink_p: "Cet accès n'est lié à aucune boutique, ou le propriétaire l'a retiré. Demandez un nouveau lien d'invitation.", emp_blk_t: "Abonnement terminé", emp_blk_p: "L'abonnement de la boutique est terminé. Demandez au propriétaire de le renouveler.",
    tl_t: "Employés avec leur propre connexion", tl_p: "Invitez un employé : il crée sa propre connexion sur son téléphone, sans votre mot de passe. Vous pouvez le retirer à tout moment.", tl_name: "Nom de l'employé", tl_go: "Créer l'invitation", tl_pend: "Invitations en attente (valables 48 h)", tl_team: "Employés", tl_none: "Aucun employé pour l'instant.", tl_wa: "Envoyer par WhatsApp", tl_copy: "Copier le lien", tl_cancel: "Annuler", tl_remove: "Retirer", tl_rm_q: "Retirer cet employé ? Sa connexion sera supprimée.", tl_err: "Impossible pour le moment. Réessayez.", tl_full: "Maximum 10 employés et invitations.", tl_plan: "L'abonnement doit être actif pour inviter.", tl_msg: (shop, name, link) => `Bonjour ${name}, je vous invite à rejoindre ${shop} sur Ecrici. Ouvrez ce lien et créez votre connexion : ${link}`, copied: "Lien copié",
    sh_t: "Mes activités", sh_chip: "Activités", sh_p: "Gérez plusieurs activités ou adresses avec un seul compte. Chacune a ses propres clients, produits et cahier.", sh_price: p => `Chaque activité en plus : ${p} par mois.`, sh_manage: "Voir mes boutiques", sh_add: "Ajouter une boutique", sh_name: "Nom de la nouvelle boutique", sh_go: "Demander l'ajout", sh_close: "Fermer", sh_back: "Retour", sh_open: "Ouvrir", sh_cur: "Boutique ouverte", sh_pend: "En attente d'activation", sh_susp: "Suspendue", sh_all: "Vue d'ensemble de toutes les boutiques", sh_sent: "Demande envoyée. Écrivez-nous sur WhatsApp pour activer la boutique.", sh_wa: (n, s, p) => `Bonjour, je souhaite ajouter la boutique « ${n} » à mon compte Ecrici (${s}, +${p}).`, sh_err: "Impossible pour le moment. Réessayez.", sh_plan: "L'abonnement doit être actif pour ajouter une boutique.", sh_max: "Nombre maximum de boutiques atteint.", sh_pending_max: "Deux demandes sont déjà en attente. Attendez leur activation.", ov_t: "Toutes les boutiques", ov_today: "Ventes du jour", ov_month: "Ventes du mois", ov_owed: "À recevoir (crédits)", ov_all_today: "Total ventes du jour", ov_skip: n => `${n} boutique(s) pas encore synchronisée(s).`, tl_branch: "Boutique de l'employé",
    ab_h: "Ecrici, le cahier de votre activité", ab_p: "Ecrici est une application simple pour les petites entreprises (commerces, services, hôtels, locations…) : notez vos ventes ou paiements, suivez les crédits de vos clients, gérez votre stock si besoin et envoyez des reçus PDF sur WhatsApp. Elle fonctionne même sans internet.",
    ab_li: ["Ventes et reçus PDF au nom du client", "Crédits et dettes des clients avec rappels WhatsApp", "Stock de produits et services", "Bilan du jour et du mois : ventes, dépenses, bénéfice", "Plusieurs boutiques et employés avec leur propre accès", "Marche sur téléphone, tablette et ordinateur"],
    faq_h: "Questions fréquentes",
    faq: [["Ecrici marche-t-il sans internet ?", "Oui. Vous continuez à vendre sans réseau. Tout est enregistré sur le téléphone puis synchronisé avec votre compte dès que vous avez internet."], ["Puis-je envoyer les reçus sur WhatsApp ?", "Oui, chaque vente produit un reçu ou une facture PDF que vous envoyez en un geste."], ["Combien coûte Ecrici ?", "À partir de 1 000 FCFA par mois, avec un essai gratuit de 7 jours. Chaque boutique en plus coûte un peu plus."], ["Puis-je gérer plusieurs boutiques et des employés ?", "Oui. Chaque boutique a ses propres livres et chaque employé a sa propre connexion."], ["Puis-je supprimer mon compte ?", "Oui, à tout moment. Dans l'application : Réglages, Compte, « Supprimer mon compte ». Votre compte et toutes vos données sont effacés de nos serveurs. Faites une sauvegarde avant."]],
    biz_l: "Type d'activité", biz_shop: "Boutique / supermarché / commerce", biz_electronics: "Électronique (téléphones, ordinateurs, TV, groupes électrogènes)", biz_pharmacy: "Pharmacie", biz_food: "Restaurant / bar / alimentation", biz_beauty: "Salon / coiffure / beauté", biz_health: "Clinique / hôpital / laboratoire", biz_school: "École / formation", biz_repair: "Artisans et réparations (plombier, électricien, garage, couture…)", biz_travel: "Voyages & tourisme", biz_services: "Autres services", biz_rent: "Location (propriétaire)", biz_hotel: "Hôtel / auberge",
    inst: "Installer l'application", f_plan: "Abonnement :", f_help: "Besoin d'aide ? WhatsApp", f_priv: "Confidentialité", f_terms: "Conditions d'utilisation", f_mkt: "Vous cherchez à acheter ? Parcourir Ecrici Market", ios_t: "Sur iPhone : ouvrez ce site dans Safari, touchez ••• (en bas à droite) ou le bouton Partager (carré avec flèche), touchez Partager, puis faites défiler et touchez « Sur l'écran d'accueil ».",  rf_t: "Parrainez un ami", rf_p: g => `Présentez Ecrici à un commerçant. Quand il fait son premier paiement, vous recevez ${g}. Il écrit votre numéro dans « Recommandé par » ou ouvre votre lien.`, rf_copy: "Copier mon lien", rf_wa: "Envoyer sur WhatsApp", rf_msg: (l) => `Bonjour 😊 J'utilise Ecrici pour gérer mes ventes, mes crédits et mon stock. Essayez-le gratuitement pendant 7 jours : ${l}`, pay_btn: "Abonnement : payer ou renouveler", pay_t: "Abonnement Ecrici", pay_len: "Choisissez la durée", pay_m1: "1 mois", pay_m3: "3 mois", pay_m12: "12 mois", pay_to: a => `Envoyez ${a} à :`, pay_nodet: "Écrivez-nous sur WhatsApp pour recevoir les détails de paiement.", pay_ref: "Référence du paiement ou nom de l'expéditeur", pay_go: "J'ai payé", pay_cp: "Copier les détails", pay_cpd: "Copié", pay_wa: "Écrire sur WhatsApp", pay_ok_t: "Merci !", pay_ok_p: "Nous vérifions votre paiement. Votre abonnement sera activé dans les 24 heures, souvent bien plus vite.", pay_chk: "Actualiser", pay_cls: "Fermer", pay_fail: "Envoi impossible. Vérifiez la connexion et réessayez.", pay_msg: (n, p, a, m) => `Bonjour, j'ai payé mon abonnement Ecrici (${m} mois, ${a}) pour la boutique ${n} (${p}).`, ref_l: "Recommandé par (facultatif)", ref_h: "Nom ou numéro de la personne qui vous a présenté Ecrici.", hint_name: "Écrivez en MAJUSCULES, ex : BOUTIQUE DE VICTOR", hint_phone: "Chiffres seulement, sans le +. Ex :",  forgot: "Mot de passe oublié ? WhatsApp", terms_a: "En créant un compte, vous acceptez les", terms_b: "conditions d'utilisation", terms_d: "et la", terms_e: "politique de confidentialité", terms_c: ": pas d'arnaque ni d'articles illégaux. Ecrici peut désactiver une page signalée.", wa_pw: p => `Bonjour, j'ai oublié mon mot de passe Ecrici. Mon numéro : ${p}`,
    wa_new: (n, p) => `Bonjour, je viens de créer mon compte Ecrici pour la boutique ${n} (${p}). Merci de l'activer.`,
    wa_renew: (n, p) => `Bonjour, je souhaite renouveler mon abonnement Ecrici pour la boutique ${n} (${p}).`,
    acct: "Compte", until: d => `Actif jusqu'au ${d}`, sync_ok: "Synchronisé", sync_wait: "En attente de connexion", logout_q: "Se déconnecter ? Les données de cette boutique seront retirées de ce téléphone (elles restent dans votre compte).",
    logout_unsynced: "Des changements ne sont pas encore envoyés. Connectez-vous à internet avant de vous déconnecter.", help: "Besoin d'aide ? WhatsApp",
    get price() { const c = curCountry(); return fmtMoney(priceOf(c).base, c, "fr") + " / mois"; }
  },
  en: {
    tag: "Your business ledger: sales, credit and receipts, even without internet.",
    login: "Log in", signup: "Create my account", have: "I already have an account", nohave: "New here? Create an account",
    shop: "Business name", country: "Country", phone: "Phone number", pw: "Password (8+ characters, letters and numbers)", pw_login: "Password", show: "Show password",
    wait: "One moment…", offline: "No internet connection. Log in the first time with internet.",
    e_creds: "Wrong number or password.", e_exists: "This number already has an account. Log in.", e_weak: "Choose a stronger password: at least 8 characters with letters and numbers, not a sequence like 12345678 and not your phone number.",
    e_rate: "Too many tries. Please wait a few minutes.", e_phone: "Invalid phone number.", e_name: "Enter your business name.",
    e_email: "The server refused this number (see the launch guide).", e_other: "Error. Please try again.", e_confirm: "Account created, but the server asks for confirmation. See the guide.",
    pend_t: "Account created", pend_p: n => `Your account “${n}” is waiting for approval. Message us on WhatsApp to activate it.`,
    blk_t: "Subscription ended", blk_p: "Your subscription has ended or was suspended. Your data stays on this phone. Contact us to renew.",
    del_btn: "Delete my account", del_t: "Delete my account", del_p: "This cannot be undone. Your account, all your shops, customers, products, sales and your employees' logins will be erased from our servers and from this phone. A subscription you already paid is not refunded.", del_bk: "Back up my data first", del_pw: "Your password", del_word: "Type DELETE to confirm", del_key: "DELETE", del_go: "Delete for good", del_no: "Cancel", del_bad: "Wrong password.", del_miss: "Type DELETE and your password.", del_fail: "Could not delete right now. Check your internet and try again.", del_ok: "Account deleted.",
    wa: "Message on WhatsApp", check: "Check now", out: "Log out", backup: "Back up my data",
    off_t: "No connection", off_p: "We can't check your subscription right now. Try again with internet.", retry: "Try again",
    err_t: "Account not found", err_p: "Your account isn't ready yet. Try again in a moment.",
    chpw: "Change password", npw: "New password", npw2: "Repeat the password", chpw_go: "Save password", chpw_ok: "Password changed", chpw_mismatch: "The two passwords are different.", chpw_weak: "Password too weak: at least 8 characters with letters and numbers, no sequence like 12345678.", chpw_fail: "Not possible right now. Try again with internet.", chpw_login: "For your security, log out and log in again before changing the password.",
    join_t: "Join a team", code: "Invitation code", join_go: "Join", have_join: "I have an invitation code", join_hint: "The owner invited you. Create your login.", e_invite: "Invitation invalid or expired. Ask the owner for a new link.", e_hasshop: "This number already has its own shop. Use another number.", nolink_t: "Login not linked to a shop", nolink_p: "This login is not linked to any shop, or the owner removed it. Ask for a new invitation link.", emp_blk_t: "Plan ended", emp_blk_p: "The shop's plan has ended. Ask the owner to renew it.",
    tl_t: "Employees with their own login", tl_p: "Invite an employee: they create their own login on their phone, without your password. You can remove them at any time.", tl_name: "Employee name", tl_go: "Create invitation", tl_pend: "Pending invitations (valid 48 h)", tl_team: "Employees", tl_none: "No employees yet.", tl_wa: "Send on WhatsApp", tl_copy: "Copy link", tl_cancel: "Cancel", tl_remove: "Remove", tl_rm_q: "Remove this employee? Their login will be deleted.", tl_err: "Not possible right now. Try again.", tl_full: "Maximum 10 employees and invitations.", tl_plan: "The plan must be active to invite.", tl_msg: (shop, name, link) => `Hello ${name}, I'm inviting you to join ${shop} on Ecrici. Open this link and create your login: ${link}`, copied: "Link copied",
    sh_t: "My businesses", sh_chip: "Businesses", sh_p: "Manage several businesses or locations with one account. Each has its own customers, items and books.", sh_price: p => `Each extra business: ${p} per month.`, sh_manage: "See my shops", sh_add: "Add a shop", sh_name: "New shop name", sh_go: "Request this shop", sh_close: "Close", sh_back: "Back", sh_open: "Open", sh_cur: "Open now", sh_pend: "Waiting for activation", sh_susp: "Suspended", sh_all: "Overview of all shops", sh_sent: "Request sent. Message us on WhatsApp to activate the shop.", sh_wa: (n, s, p) => `Hello, I would like to add the shop "${n}" to my Ecrici account (${s}, +${p}).`, sh_err: "Not possible right now. Try again.", sh_plan: "The plan must be active to add a shop.", sh_max: "Maximum number of shops reached.", sh_pending_max: "Two requests are already waiting. Wait until they are activated.", ov_t: "All shops", ov_today: "Sales today", ov_month: "Sales this month", ov_owed: "To collect (credit)", ov_all_today: "Total sales today", ov_skip: n => `${n} shop(s) not synced yet.`, tl_branch: "Employee's shop",
    ab_h: "Ecrici, your business ledger", ab_p: "Ecrici is a simple app for small businesses (shops, services, hotels, rentals…): record sales or payments, track customer credit, manage stock if you need it and send PDF receipts on WhatsApp. It works even without internet.",
    ab_li: ["Sales and PDF receipts named after the customer", "Customer credit and debts with WhatsApp reminders", "Stock of products and services", "Daily and monthly report: sales, expenses, profit", "Several shops and employees, each with their own login", "Works on phone, tablet and computer"],
    faq_h: "Frequently asked questions",
    faq: [["Does Ecrici work without internet?", "Yes. You keep selling when the network is down. Everything saves on the phone and syncs to your account when you are back online."], ["Can I send receipts on WhatsApp?", "Yes. Every sale makes a PDF receipt or invoice you can send in one tap."], ["How much does Ecrici cost?", "It starts from a low monthly price per shop, with a 7-day free trial. Extra shops cost a little more. The price for your country is shown at the bottom of this page."], ["Can I manage several shops and employees?", "Yes. Each shop has its own books and each employee has their own login."], ["Can I delete my account?", "Yes, at any time. In the app: Settings, Account, \"Delete my account\". Your account and all your data are erased from our servers. Make a backup first."]],
    biz_l: "Type of business", biz_shop: "Shop / supermarket / general trade", biz_electronics: "Electronics (phones, laptops, TVs, generators)", biz_pharmacy: "Pharmacy / chemist", biz_food: "Restaurant / bar / food", biz_beauty: "Salon / barber / beauty", biz_health: "Clinic / hospital / lab", biz_school: "School / training", biz_repair: "Artisans & repairs (plumber, electrician, garage, tailoring…)", biz_travel: "Travel & tours", biz_services: "Other services", biz_rent: "Rentals (landlord)", biz_hotel: "Hotel / guesthouse", rf_t: "Refer a friend", rf_p: g => `Introduce Ecrici to a shop owner. When they make their first payment, you get ${g}. They write your number under "Referred by" or open your link.`, rf_copy: "Copy my link", rf_wa: "Send on WhatsApp", rf_msg: (l) => `Hello 😊 I use Ecrici to manage my sales, credit and stock. Try it free for 7 days: ${l}`, pay_btn: "Subscription: pay or renew", pay_t: "Ecrici subscription", pay_len: "Choose how long", pay_m1: "1 month", pay_m3: "3 months", pay_m12: "12 months", pay_to: a => `Send ${a} to:`, pay_nodet: "Message us on WhatsApp to get the payment details.", pay_ref: "Payment reference or sender name", pay_go: "I have paid", pay_cp: "Copy details", pay_cpd: "Copied", pay_wa: "Message us on WhatsApp", pay_ok_t: "Thank you!", pay_ok_p: "We are checking your payment. Your subscription will be active within 24 hours, often much sooner.", pay_chk: "Refresh", pay_cls: "Close", pay_fail: "Could not send. Check your connection and try again.", pay_msg: (n, p, a, m) => `Hello, I paid my Ecrici subscription (${m} months, ${a}) for the shop ${n} (${p}).`, ref_l: "Referred by (optional)", ref_h: "Name or number of the person who introduced you to Ecrici.", inst: "Install the app", f_plan: "Plan:", f_help: "Need help? WhatsApp", f_priv: "Privacy", f_terms: "Terms of use", f_mkt: "Looking to buy? Browse Ecrici Market", ios_t: "On iPhone: open this site in Safari, tap ••• (bottom right) or the Share button (square with an arrow), tap Share, then scroll and tap \"Add to Home Screen\".",  hint_name: "Write in CAPITAL letters, e.g. VICTOR'S DRYCLEANER", hint_phone: "Digits only, no + sign. Example:",  forgot: "Forgot password? WhatsApp", terms_a: "By creating an account you accept the", terms_b: "terms of use", terms_d: "and the", terms_e: "privacy policy", terms_c: ": no scams or illegal items. Ecrici can turn off a reported page.", wa_pw: p => `Hello, I forgot my Ecrici password. My number: ${p}`,
    wa_new: (n, p) => `Hello, I just created my Ecrici account for the shop ${n} (${p}). Please activate it.`,
    wa_renew: (n, p) => `Hello, I would like to renew my Ecrici subscription for the shop ${n} (${p}).`,
    acct: "Account", until: d => `Active until ${d}`, sync_ok: "Synced", sync_wait: "Waiting for connection", logout_q: "Log out? This shop's data will be removed from this phone (it stays in your account).",
    logout_unsynced: "Some changes are not sent yet. Connect to the internet before logging out.", help: "Need help? WhatsApp",
    get price() { const c = curCountry(); return fmtMoney(priceOf(c).base, c, "en") + " / month"; }
  }
};
const PH = { BJ: "01 97 00 00 11", NG: "0803 123 4567", GH: "024 123 4567", KE: "0712 345 678", TG: "90 12 34 56", CI: "07 01 23 45 67", SN: "77 123 45 67", BF: "70 12 34 56", ML: "70 12 34 56", NE: "90 12 34 56", CM: "6 71 23 45 67", ZA: "082 123 4567", RW: "078 123 4567", TZ: "0712 345 678", UG: "0772 123 456" };
const g = (k, ...a) => { const v = G[lang()][k]; return typeof v === "function" ? v(...a) : v; };

/* ---------- gate (full-screen screen shown until the account is valid) ---------- */
const css = document.createElement("style");
css.textContent = `#lg-gate{position:fixed;inset:0;z-index:9999;overflow:auto;background:var(--paper);color:var(--ink);font-family:var(--font-body);padding:calc(18px + env(safe-area-inset-top,0px)) 16px calc(24px + env(safe-area-inset-bottom,0px))}
#lg-gate .lg-wrap{max-width:420px;margin:0 auto;display:grid;gap:14px}
#lg-gate .lg-about{margin-top:18px;padding-top:16px;border-top:1px solid var(--line);color:var(--ink)}#lg-gate .lg-about h2{font-size:18px;margin:0 0 6px}#lg-gate .lg-about h3{font-size:16px;margin:16px 0 4px;font-family:var(--font-display)}#lg-gate .lg-about details{border-top:1px solid var(--line)}#lg-gate .lg-about details:last-of-type{border-bottom:1px solid var(--line)}#lg-gate .lg-about summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 2px;font-size:14.5px;font-weight:600;color:var(--ink)}#lg-gate .lg-about summary::-webkit-details-marker{display:none}#lg-gate .lg-about summary::after{content:"";flex:none;width:8px;height:8px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(45deg);transition:transform .15s;margin-right:4px}#lg-gate .lg-about details[open] summary::after{transform:rotate(-135deg)}#lg-gate .lg-about details p{padding:0 2px 12px}#lg-gate .lg-about p,#lg-gate .lg-about li{font-size:14px;line-height:1.5;color:var(--muted);margin:0}#lg-gate .lg-about ul{margin:8px 0 0;padding-left:18px;display:grid;gap:3px}
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

let gateKind = "loading", mode = "login", form = { country: "BJ", phone: "", name: "", code: "", ref: "" }, busyAuth = false, authErrText = "";
try {
  const jc = new URLSearchParams(location.search).get("join");
  if (jc) { lsSet("ecrici-join", String(jc).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16)); history.replaceState(null, "", location.pathname); }
  form.code = lsGet("ecrici-join") || ""; if (form.code) mode = "join";
  const rf = new URLSearchParams(location.search).get("ref");
  if (rf) { lsSet("ecrici-ref", String(rf).replace(/[<>"]/g, "").trim().slice(0, 60)); history.replaceState(null, "", location.pathname); }
  form.ref = lsGet("ecrici-ref") || ""; form.biz = form.biz || "shop"; if (form.ref && !form.code) mode = "signup";
} catch (e) {}
const COUNTRY_OPTS = () => Object.entries(COUNTRIES).map(([k, v]) => `<option value="${k}" ${form.country === k ? "selected" : ""}>${esc(v.name)} (+${v.cc})</option>`).join("");
const shopRow = () => jget(K.acct) || {};
const waLink = txt => CFG.adminWhatsapp ? `https://wa.me/${String(CFG.adminWhatsapp).replace(/\D/g, "")}?text=${encodeURIComponent(txt)}` : "";
const head = () => `<div class="lg-top"><button class="pill" data-lg="lang">${lang() === "fr" ? "English" : "Français"}</button>${canInst() || isIOS() ? `<button class="pill" data-lg="install">${esc(g("inst"))}</button>` : ""}</div>${iosHelp && isIOS() ? `<div class="lg-msg" style="margin-top:10px">${esc(g("ios_t"))}</div>` : ""}<h1>Ecrici</h1><p class="lg-tag">${esc(g("tag"))}</p>`;

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone;
let iosHelp = false;
function canInst() { try { return typeof deferredInstall !== "undefined" && !!deferredInstall && !matchMedia("(display-mode: standalone)").matches; } catch (e) { return false; } }
window.addEventListener("beforeinstallprompt", () => setTimeout(() => { if (gateKind === "auth") { grab(); drawGate(); } }, 50));
const about = () => `<section class="lg-about"><h2>${esc(g("ab_h"))}</h2><p>${esc(g("ab_p"))}</p><ul>${g("ab_li").map(x => `<li>${esc(x)}</li>`).join("")}</ul><h3>${esc(g("faq_h"))}</h3>${g("faq").map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</section>`;
const foot = () => {
  const w = waLink(""), y = new Date().getFullYear();
  return `<div class="lg-foot">${g("price") ? `<div>${esc(g("f_plan"))} <b>${esc(g("price"))}</b></div>` : ""}
    <div>${w ? `<a href="${w}" target="_blank" rel="noopener">${esc(g("f_help"))}</a> · ` : ""}<a href="privacy.html" target="_blank" rel="noopener">${esc(g("f_priv"))}</a> · <a href="terms.html" target="_blank" rel="noopener">${esc(g("f_terms"))}</a></div>
    <div><a href="market.html">${esc(g("f_mkt"))}</a></div>
    <div>© ${y} Ecrici</div></div>`;
};
function drawGate() {
  langInit();
  const a = shopRow();
  let h = "";
  if (gateKind === "loading") {
    h = head() + `<p class="lg-tag">${esc(g("wait"))}</p>`;
  } else if (gateKind === "auth") {
    const su = mode === "signup", jn = mode === "join";
    h = head() + `<div class="card form"><h2>${esc(jn ? g("join_t") : su ? g("signup") : g("login"))}</h2>
      ${jn ? `<p class="lg-tag" style="margin:0">${esc(g("join_hint"))}</p>` : ""}
      ${su ? `<div class="field"><label for="lg-name">${esc(g("shop"))}</label><input id="lg-name" value="${esc(form.name)}" autocomplete="organization" autocapitalize="characters" placeholder="${esc(lang() === "fr" ? "BOUTIQUE DE VICTOR" : "VICTOR'S DRYCLEANER")}" style="text-transform:uppercase"></div>` : ""}
      ${su ? `<div class="field"><label for="lg-biz">${esc(g("biz_l"))}</label><select id="lg-biz">${["shop","electronics","pharmacy","food","beauty","health","school","repair","travel","services","rent","hotel"].map(k => `<option value="${k}" ${form.biz === k ? "selected" : ""}>${esc(g("biz_" + k))}</option>`).join("")}</select></div>` : ""}
      ${su ? `<div class="field"><label for="lg-ref">${esc(g("ref_l"))}</label><input id="lg-ref" value="${esc(form.ref)}" autocomplete="off" maxlength="60"><small class="lg-hint" style="opacity:.7;font-size:.8em">${esc(g("ref_h"))}</small></div>` : ""}
      <div class="field"><label for="lg-country">${esc(g("country"))}</label><select id="lg-country">${COUNTRY_OPTS()}</select></div>
      <div class="field"><label for="lg-phone">${esc(g("phone"))}</label><input id="lg-phone" value="${esc(form.phone)}" inputmode="tel" autocomplete="tel" placeholder="${esc(PH[form.country] || "")}"><small class="lg-hint" style="opacity:.7;font-size:.8em">${esc(g("hint_phone"))} ${esc(PH[form.country] || "")}</small></div>
      <div class="field"><label for="lg-pw">${esc(su || jn ? g("pw") : g("pw_login"))}</label><input id="lg-pw" type="password" autocomplete="${su || jn ? "new-password" : "current-password"}"></div>
      ${jn ? `<div class="field"><label for="lg-code">${esc(g("code"))}</label><input id="lg-code" value="${esc(form.code)}" autocomplete="off" autocapitalize="characters" style="text-transform:uppercase"></div>` : ""}
      ${su ? `<p class="lg-tag" style="margin:0;font-size:.8em;opacity:.75">${esc(g("terms_a"))} <a href="terms.html" target="_blank" rel="noopener">${esc(g("terms_b"))}</a> ${esc(g("terms_d"))} <a href="privacy.html" target="_blank" rel="noopener">${esc(g("terms_e"))}</a>${esc(g("terms_c"))}</p>` : ""}
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
      ${!pend && !member ? `<button class="btn primary" data-lg="pay">${esc(g("pay_btn"))}</button>` : ""}
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
  gate.innerHTML = `<div class="lg-wrap">${h}${gateKind === "loading" ? "" : (gateKind === "auth" ? about() : "") + foot()}</div>`;
  gate.hidden = false;
}
window.__authed = () => gateKind === "none";
function showGate(kind) { gateKind = kind; drawGate(); }
function hideGate() { gate.hidden = true; gate.innerHTML = ""; gateKind = "none"; }

gate.addEventListener("click", async e => {
  const b = e.target.closest("[data-lg]"); if (!b) return;
  const act = b.dataset.lg;
  if (act === "lang") { langTouched = true; S.shop.lang = lang() === "fr" ? "en" : "fr"; try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (x) {} drawGate(); }
  else if (act === "mode") { grab(); mode = mode === "login" ? "signup" : "login"; authErrText = ""; drawGate(); }
  else if (act === "tojoin") { grab(); mode = "join"; authErrText = ""; gateKind = "auth"; drawGate(); }
  else if (act === "forcelogout") forceLogout();
  else if (act === "showpw") { const p = gate.querySelector("#lg-pw"); if (p) p.type = b.checked ? "text" : "password"; }
  else if (act === "submit") submitAuth();
  else if (act === "forgot") { grab(); let id = ""; try { id = form.phone ? canon(form.country, form.phone) : ""; } catch (x) {} window.open(waLink(g("wa_pw", id ? "+" + id : "")), "_blank"); }
  else if (act === "install") { if (isIOS()) { iosHelp = !iosHelp; drawGate(); } else if (canInst()) { const d = deferredInstall; deferredInstall = null; try { d.prompt(); d.userChoice.then(() => drawGate(), () => drawGate()); } catch (x) { drawGate(); } } }
  else if (act === "pay") openPay();
  else if (act === "check") enter();
  else if (act === "backup") { try { await backupNow(); } catch (x) {} }
  else if (act === "logout") logout(true);
});
gate.addEventListener("change", e => { if (e.target.id === "lg-country") { grab(); if (mode === "signup" && !langTouched) S.shop.lang = cLang(form.country); drawGate(); } });
gate.addEventListener("keydown", e => { if (e.key === "Enter" && gateKind === "auth" && e.target.tagName === "INPUT" && e.target.type !== "checkbox") submitAuth(); });
function grab() {
  const v = id => { const el = gate.querySelector(id); return el ? el.value : null; };
  const c = v("#lg-country"), p = v("#lg-phone"), n = v("#lg-name"), cd = v("#lg-code"), rf = v("#lg-ref"), bz = v("#lg-biz");
  if (c) form.country = c; if (p !== null) form.phone = p; if (n !== null) form.name = n; if (rf !== null) form.ref = rf; if (bz) form.biz = bz; if (cd !== null) form.code = cd.toUpperCase().replace(/[^A-Z0-9]/g, "");
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
  else if (pw.length < (su || jn ? 8 : 1) || ((su || jn) && pwProblem(pw, id))) authErrText = g("e_weak");
  else if (jn && form.code.length < 6) authErrText = g("e_invite");
  if (authErrText) { drawGate(); return; }
  busyAuth = true; drawGate();
  try {
    let r;
    if (su) r = await http("/auth/v1/signup", { method: "POST", body: { email: emailOf(id), password: pw, data: { name: form.name.trim().toUpperCase(), phone: id, country: form.country, ref: form.ref.trim().slice(0, 60), biz: form.biz || "shop" } } });
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
      if (su) { try { if (!S.shop.name || S.shop.name === "Ma Boutique") S.shop.name = form.name.trim().toUpperCase(); S.shop.country = form.country; if (!langTouched) S.shop.lang = cLang(form.country); S.shop.phone = id; try { lsSet("ecrici-biz", form.biz || "shop"); } catch (e) {} S.shop.biz = form.biz || "shop"; if (form.biz && form.biz !== "shop") { S.shop.biz = form.biz; S.customers = S.customers.filter(c => !c.example); S.txs = S.txs.filter(x => !x.example); S.products = S.products.filter(x => !x.example); if (!S.txs.length) S.counter = 0; } } catch (e) {} }
      if (su) { try { lsSet("ecrici-ref", ""); form.ref = ""; } catch (e) {} }
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
  const sh = (r.json && r.json[0]) || null;
  window.__mkt = !sh || sh.market_ok !== false; /* false = public page still waiting for approval */
  return sh;
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
  const keepLang = lang(); S = blank(); S.shop.name = shop.name || S.shop.name; S.shop.phone = shop.phone || ""; S.shop.country = shop.country || "BJ"; S.shop.lang = keepLang; try { const bz = localStorage.getItem("ecrici-biz"); if (bz) S.shop.biz = bz; } catch (e) {}
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
  m.jobs = unionById(loc.jobs, rem.jobs, (x, y) => ((y.u || 0) > (x.u || 0) ? y : x));
  m.appts = unionById(loc.appts, rem.appts, (x, y) => (y.gone && !x.gone ? y : y.done && !x.done ? y : y.reminded && !x.reminded ? y : x));
  m.expRules = unionById(loc.expRules, rem.expRules, (x, y) => (String(x.next) >= String(y.next) ? x : y));
  m.products = unionById(loc.products, rem.products, (x, y) => {
    const b0 = base[x.id], z = Object.assign({}, x);
    if (typeof b0 === "number") z.qty = Math.round((x.qty + y.qty - b0) * 1000) / 1000;
    if (Array.isArray(x.bs) || Array.isArray(y.bs)) {
      z.bs = (x.bs || y.bs).map(b => Object.assign({}, b));
      let diff = Math.round((z.qty - z.bs.reduce((a, b) => a + b.q, 0)) * 1000) / 1000;
      if (diff > 0) z.bs.push({ n: "", e: "", q: diff });
      else if (diff < 0) { z.bs.sort((a, b) => (a.e || "9999").localeCompare(b.e || "9999")); for (const b of z.bs) { if (diff >= 0) break; const t = Math.min(b.q, -diff); b.q = Math.round((b.q - t) * 1000) / 1000; diff += t; } z.bs = z.bs.filter(b => b.q > 0); }
    }
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
/* tell the admin which kind of business this is (best effort, never blocks saving) */
async function syncBiz() {
  try {
    const b = S && S.shop && S.shop.biz; if (!b || member || !shopId || lid !== shopId) return;
    const key = shopId + ":" + b; if (lsGet("ecrici-biz-sync") === key) return;
    const r = await api("/rest/v1/rpc/set_biz", { method: "POST", body: { p_biz: b } });
    if (r && r.ok) lsSet("ecrici-biz-sync", key);
  } catch (e) {}
}
/* ---------- public catalog (one read-only row per shop) ---------- */
async function catPublish(force) {
  if (!active || !sess || member || !window.__catData) return { skip: true };
  const c = S && S.shop && S.shop.cat, id = lid || shopId; if (!c || !c.slug || !id) return { skip: true };
  const d = window.__catData(), sig = JSON.stringify([id, c.slug, !!c.on, !!c.listed, c.city || "", d]);
  if (!c.on && !lsGet("ecrici-cat-pub")) return { ok: true };
  if (!force && lsGet("ecrici-cat-pub") === sig) return { ok: true, same: true };
  try {
    const body = { slug: c.slug, data: d, active: !!c.on, updated_at: new Date().toISOString() };
    const mk = !!c.listed || lsGet("ecrici-mk") === "1";
    if (mk) { body.listed = !!(c.on && c.listed); body.country = String((S.shop && S.shop.country) || "").toUpperCase() || null; body.city = String(c.city || "").trim().slice(0, 40) || null; }
    let r = await api("/rest/v1/catalogs?shop_id=eq." + id, { method: "PATCH", headers: { Prefer: "return=representation" }, body });
    if (r.ok && Array.isArray(r.json) && !r.json.length) r = await api("/rest/v1/catalogs", { method: "POST", headers: { Prefer: "return=minimal" }, body: Object.assign({ shop_id: id }, body) });
    if (!r.ok) return { ok: false, taken: r.status === 409, reserved: r.status === 400 && /reserved_name/.test(JSON.stringify(r.json || "")), status: r.status };
    lsSet("ecrici-cat-pub", sig); if (c.listed) lsSet("ecrici-mk", "1");
    if (c.on && window.__mkt === false && lsGet("ecrici-mkt-ask") !== String(sess.uid)) { api("/rest/v1/rpc/request_market", { method: "POST", body: {} }).then(q => { if (q && q.ok) lsSet("ecrici-mkt-ask", String(sess.uid)); }).catch(() => {}); }
    return { ok: true };
  } catch (e) { return { ok: false, offline: !!e.offline }; }
}
window.__catPub = catPublish;
window.__waAdmin = txt => waLink(txt);
window.__catInfo = async function () { if (!active || !sess || member) return null; const id = lid || shopId; if (!id) return null; try { const r = await api("/rest/v1/catalogs?shop_id=eq." + id + "&select=updated_at"); return r.ok && Array.isArray(r.json) ? (r.json[0] || null) : null; } catch (e) { return null; } };
/* product photos: small public JPEGs in the "catalog" bucket, one folder per shop */
/* a small thumbnail (about 400 px) is saved next to every product photo so pages load fast on slow phones */
function catThumb(blob) {
  return new Promise(res => {
    try {
      const u = URL.createObjectURL(blob), im = new Image();
      im.onload = () => {
        try {
          const k = Math.min(1, 400 / Math.max(im.width, im.height)), c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
          c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(u);
          c.toBlob(b => res(b && b.size < 120000 ? b : null), "image/jpeg", 0.72);
        } catch (e) { res(null); }
      };
      im.onerror = () => { URL.revokeObjectURL(u); res(null); };
      im.src = u;
    } catch (e) { res(null); }
  });
}
async function catImg(blob, pid, oldUrl) {
  if (!active || !sess || member || !blob) return null;
  const id = lid || shopId; if (!id) return null;
  try {
    const tk = await token(), kind = String(pid).replace(/[^a-z0-9_-]/gi, ""), small = kind === "logo" || kind === "cover";
    const stem = id + "/" + kind + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const put = (path, b) => fetch(BASE + "/storage/v1/object/catalog/" + path, { method: "POST", headers: { apikey: CFG.key, Authorization: "Bearer " + tk, "Content-Type": "image/jpeg", "Cache-Control": "max-age=31536000" }, body: b });
    let path = stem + ".jpg";
    if (!small) {
      const t = await catThumb(blob);
      if (t) { const rt = await put(stem + "-t.jpg", t); if (rt.ok) path = stem + "-f.jpg"; }
    }
    const r = await put(path, blob);
    if (!r.ok) { if (/-f\.jpg$/.test(path)) catImgDel(BASE + "/storage/v1/object/public/catalog/" + stem + "-f.jpg"); return null; }
    if (oldUrl) catImgDel(oldUrl);
    return BASE + "/storage/v1/object/public/catalog/" + path;
  } catch (e) { return null; }
}
async function catImgDel(url) {
  try {
    const m = String(url).split("/storage/v1/object/public/catalog/")[1]; if (!m || !active || !sess || member) return;
    const tk = await token(), del = p => fetch(BASE + "/storage/v1/object/catalog/" + p, { method: "DELETE", headers: { apikey: CFG.key, Authorization: "Bearer " + tk } });
    await del(m); if (/-f\.jpg$/.test(m)) await del(m.replace(/-f\.jpg$/, "-t.jpg"));
  } catch (e) {}
}
/* before an account is erased, remove every photo file of its shops (thumbnails included) */
async function catWipeAll() {
  try {
    const tk = await token(), ids = [shopId, lid].concat((branches || []).map(b => b.id)).filter((x, i, a) => x && a.indexOf(x) === i);
    for (const id of ids) {
      for (let n = 0; n < 5; n++) {
        const r = await fetch(BASE + "/storage/v1/object/list/catalog", { method: "POST", headers: { apikey: CFG.key, Authorization: "Bearer " + tk, "Content-Type": "application/json" }, body: JSON.stringify({ prefix: id, limit: 100, offset: 0 }) });
        if (!r.ok) break; const l = await r.json(); if (!Array.isArray(l) || !l.length) break;
        const d = await fetch(BASE + "/storage/v1/object/catalog", { method: "DELETE", headers: { apikey: CFG.key, Authorization: "Bearer " + tk, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: l.map(x => id + "/" + x.name) }) });
        if (!d.ok) break;
      }
    }
  } catch (e) {}
}
window.__catImg = catImg; window.__catImgDel = catImgDel;
window.pushCloud = async function () {
  if (!active || !sess) return;
  if (busyPush) { dirtyPush = true; return; }
  busyPush = true;
  try { await doPush(); syncBiz(); catPublish().catch(() => {}); }
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
  if (pwProblem(a.value, "")) { toast(g("chpw_weak")); return; }
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

function referSection() {
  if (member || !active) return "";
  const a = shopRow(), ph = String(a.phone || "").replace(/\D/g, ""); if (!ph) return "";
  const cc = curCountry(), link = location.origin + "/?ref=" + ph, amt = fmtMoney(Math.round(priceOf(cc).base * 0.6), cc, lang());
  const wa = "https://wa.me/?text=" + encodeURIComponent(g("rf_msg", link));
  return `<section class="sec"><h2>${esc(g("rf_t"))}</h2><div class="card form"><p class="note" style="margin:0">${esc(g("rf_p", amt))}</p>
    <div class="note" style="margin:0;word-break:break-all">${esc(link)}</div>
    <button class="btn" data-lg-act="tm-copy" data-link="${esc(link)}">${esc(g("rf_copy"))}</button>
    <a class="btn primary" href="${wa}" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">${esc(g("rf_wa"))}</a></div></section>`;
}

/* ---------- Settings: account block ---------- */
const baseSettings = window.viewSettings;
window.viewSettings = function () {
  const a = shopRow(), l = lang();
  const until = a.paid_until ? new Date(a.paid_until + "T12:00:00").toLocaleDateString(l === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
  const dirty = S.updated > lastSynced;
  const w = waLink("");
  return baseSettings() + shopsSection() + teamSection() + referSection() + `<section class="sec"><h2>${esc(g("acct"))}</h2><div class="card form">
    <div class="note" style="margin:0">${esc(a.phone ? "+" + a.phone : "")}${until ? " · " + esc(g("until", until)) : ""}<br>${esc(dirty ? g("sync_wait") : g("sync_ok"))}</div>
    ${member ? "" : `<button class="btn primary" data-lg-act="pay-open">${esc(g("pay_btn"))}</button>`}
    ${w ? `<a class="btn" href="${w}" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">${esc(g("help"))}</a>` : ""}
    <div class="field"><label for="lg-npw">${esc(g("chpw"))}</label><input id="lg-npw" type="password" autocomplete="new-password" placeholder="${esc(g("npw"))}"></div>
    <div class="field"><input id="lg-npw2" type="password" autocomplete="new-password" placeholder="${esc(g("npw2"))}" aria-label="${esc(g("npw2"))}"></div>
    <button class="btn" data-lg-act="chpw">${esc(g("chpw_go"))}</button>
    <a class="btn" href="privacy.html" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">${esc(g("f_priv"))}</a>
    <a class="btn" href="terms.html" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">${esc(g("f_terms"))}</a>
    <button class="btn danger" data-lg-act="logout">${esc(g("out"))}</button>
    ${member ? "" : `<button class="btn ghost" data-lg-act="del-open" style="color:var(--bad,#b3261e)">${esc(g("del_btn"))}</button>`}</div></section>`;
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
  else if (b.dataset.lgAct === "del-open") { dl.open = true; dl.err = ""; dl.busy = false; drawDel(); }
  else if (b.dataset.lgAct === "del-close" || (b.dataset.lgAct === "del-veil" && e.target === b)) { if (!dl.busy) { dl.open = false; drawDel(); } }
  else if (b.dataset.lgAct === "del-bk") { try { backupNow(); } catch (x) {} }
  else if (b.dataset.lgAct === "del-go") deleteAccount();
  else if (b.dataset.lgAct === "pay-open") openPay();
  else if (b.dataset.lgAct === "pay-close" || (b.dataset.lgAct === "pay-veil" && e.target === b)) { if (!py.busy) { py.open = false; drawPay(); } }
  else if (b.dataset.lgAct === "pay-m") { py.months = Number(b.dataset.m) || 1; drawPay(); }
  else if (b.dataset.lgAct === "pay-go") sendClaim();
  else if (b.dataset.lgAct === "pay-cp") { try { navigator.clipboard.writeText(payLines().join("\n")); py.copied = true; drawPay(); setTimeout(() => { py.copied = false; drawPay(); }, 1500); } catch (x) {} }
  else if (b.dataset.lgAct === "pay-chk") { py.open = false; drawPay(); enter(); }
  else if (b.dataset.lgAct === "chpw") changePassword();
  else if (b.dataset.lgAct === "tm-invite") { const n = ((document.getElementById("tm-name") || {}).value || "").trim(); if (n) { const bs = document.getElementById("tm-branch"), body = { p_name: n }; if (bs && bs.value) body.p_branch = bs.value; teamCall("team_invite", body); } }
  else if (b.dataset.lgAct === "tm-copy") copyText(b.dataset.link);
  else if (b.dataset.lgAct === "tm-cancel") teamCall("team_cancel", { p_code: b.dataset.id });
  else if (b.dataset.lgAct === "tm-remove") { if (confirm(g("tl_rm_q"))) teamCall("team_remove", { target: b.dataset.id }); }
}, true);

/* ---------- subscription payment (customer says "I have paid", admin confirms) ---------- */
const py = { open: false, months: 1, err: "", busy: false, sent: false, copied: false };
const payLines = () => { const t = CFG.payTo || {}, cc = curCountry(); const v = t[cc] || t.default || []; return (Array.isArray(v) ? v : [String(v)]).filter(Boolean); };
async function openPay() {
  if (member) return;
  py.open = true; py.err = ""; py.busy = false; py.sent = false; py.copied = false; py.months = 1; drawPay();
  try { const r = await api("/rest/v1/pay_claims?select=months&status=eq.pending&limit=1"); if (r && r.ok && Array.isArray(r.json) && r.json.length) { py.sent = true; if (py.open) drawPay(); } } catch (x) {}
}
function drawPay() {
  let el = document.getElementById("lg-pay");
  if (!py.open) { if (el) el.remove(); return; }
  const keep = el ? ((el.querySelector("#pay-ref") || {}).value || "") : "";
  if (!el) { el = document.createElement("div"); el.id = "lg-pay"; el.style.cssText = "position:relative;z-index:2147483000"; document.body.appendChild(el); }
  const cc = curCountry(), l = lang(), base = priceOf(cc).base, amt = fmtMoney(base * py.months, cc, l), lines = payLines();
  const opt = m => `<button class="btn${py.months === m ? " primary" : ""}" data-lg-act="pay-m" data-m="${m}" style="flex:1;padding:10px 4px">${esc(g("pay_m" + m))}<br><small>${esc(fmtMoney(base * m, cc, l))}</small></button>`;
  let body;
  if (py.sent) body = `<h2>${esc(g("pay_ok_t"))}</h2><p class="note" style="margin:0">${esc(g("pay_ok_p"))}</p>
    <div class="actions"><button class="btn primary" data-lg-act="pay-chk">${esc(g("pay_chk"))}</button><button class="btn" data-lg-act="pay-close">${esc(g("pay_cls"))}</button></div>`;
  else {
    const a = shopRow(), wa = waLink(g("pay_msg", a.name || "", a.phone || "", amt, py.months));
    body = `<h2>${esc(g("pay_t"))}</h2><p class="note" style="margin:0">${esc(g("pay_len"))}</p>
    <div style="display:flex;gap:8px">${opt(1)}${opt(3)}${opt(12)}</div>
    ${lines.length ? `<div class="note" style="margin:0"><b>${esc(g("pay_to", amt))}</b><br>${lines.map(x => esc(x)).join("<br>")}</div>
    <button class="btn" data-lg-act="pay-cp">${esc(py.copied ? g("pay_cpd") : g("pay_cp"))}</button>` : `<div class="note" style="margin:0">${esc(g("pay_nodet"))}</div>`}
    <div class="field"><label for="pay-ref">${esc(g("pay_ref"))}</label><input id="pay-ref" autocomplete="off" maxlength="80" value="${esc(keep)}"></div>
    ${py.err ? `<div class="err" role="alert">${esc(py.err)}</div>` : ""}
    <div class="actions"><button class="btn primary" data-lg-act="pay-go" ${py.busy ? "disabled" : ""}>${esc(py.busy ? g("wait") : g("pay_go"))}</button>
    ${wa ? `<a class="btn" href="${wa}" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">${esc(g("pay_wa"))}</a>` : ""}
    <button class="btn" data-lg-act="pay-close" ${py.busy ? "disabled" : ""}>${esc(g("pay_cls"))}</button></div>`;
  }
  el.innerHTML = `<div class="veil" data-lg-act="pay-veil"><div class="sheet" role="dialog" aria-modal="true"><div class="dlg">${body}</div></div></div>`;
}
async function sendClaim() {
  if (py.busy || member) return;
  const ref = ((document.getElementById("pay-ref") || {}).value || "").trim().slice(0, 80);
  py.busy = true; py.err = ""; drawPay();
  try {
    const r = await api("/rest/v1/pay_claims", { method: "POST", headers: { Prefer: "return=minimal" }, body: { shop_id: shopId, months: py.months, ref } });
    py.busy = false;
    if (r.ok || r.status === 409) py.sent = true; else py.err = g("pay_fail");
  } catch (x) { py.busy = false; py.err = g("pay_fail"); }
  drawPay();
}

/* ---------- delete my account ---------- */
const dl = { open: false, err: "", busy: false };
function drawDel() {
  let el = document.getElementById("lg-del");
  if (!dl.open) { if (el) el.remove(); return; }
  const keep = el ? { w: (el.querySelector("#dl-word") || {}).value || "", p: (el.querySelector("#dl-pw") || {}).value || "" } : { w: "", p: "" };
  if (!el) { el = document.createElement("div"); el.id = "lg-del"; document.body.appendChild(el); }
  el.innerHTML = `<div class="veil" data-lg-act="del-veil"><div class="sheet" role="dialog" aria-modal="true"><div class="dlg"><h2>${esc(g("del_t"))}</h2>
    <p class="note" style="margin:0">${esc(g("del_p"))}</p>
    <button class="btn" data-lg-act="del-bk">${esc(g("del_bk"))}</button>
    <div class="field"><label for="dl-pw">${esc(g("del_pw"))}</label><input id="dl-pw" type="password" autocomplete="current-password" value="${esc(keep.p)}"></div>
    <div class="field"><label for="dl-word">${esc(g("del_word"))}</label><input id="dl-word" autocomplete="off" autocapitalize="characters" value="${esc(keep.w)}"></div>
    ${dl.err ? `<div class="err" role="alert">${esc(dl.err)}</div>` : ""}
    <div class="actions"><button class="btn danger" data-lg-act="del-go" ${dl.busy ? "disabled" : ""}>${esc(dl.busy ? g("wait") : g("del_go"))}</button>
    <button class="btn" data-lg-act="del-close" ${dl.busy ? "disabled" : ""}>${esc(g("del_no"))}</button></div></div></div></div>`;
}
async function deleteAccount() {
  if (dl.busy || member) return;
  const pw = (document.getElementById("dl-pw") || {}).value || "", w = ((document.getElementById("dl-word") || {}).value || "").trim().toUpperCase();
  if (!pw || w !== g("del_key")) { dl.err = g("del_miss"); drawDel(); return; }
  dl.busy = true; dl.err = ""; drawDel();
  try {
    const a = shopRow(), who = a.phone || "";
    const v = await http("/auth/v1/token?grant_type=password", { method: "POST", body: { email: emailOf(who), password: pw } });
    if (!v.ok || !v.json || !v.json.access_token) { dl.busy = false; dl.err = v.status === 0 ? g("del_fail") : g("del_bad"); drawDel(); return; }
    await catWipeAll();
    const r = await api("/rest/v1/rpc/delete_my_account", { method: "POST", body: {} });
    if (!r.ok) { dl.busy = false; dl.err = g("del_fail"); drawDel(); return; }
  } catch (e) { dl.busy = false; dl.err = g("del_fail"); drawDel(); return; }
  [K.sess, K.acct, K.sync, K.owner, K.base, "ecrici-join"].forEach(lsDel); clearStash(); lsDel(LS_KEY);
  try { alert(g("del_ok")); } catch (e) {}
  location.reload();
}

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
const extraPrice = () => { const c = curCountry(); return "+" + fmtMoney(priceOf(c).extra, c, lang()); };
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
