// DebitRadar demo: a single-file, client-side simulation. All data is fictional; nothing is sent anywhere or stored.
// Demo state:
//   s = demo step (-1 onboarding, 0 AutoPay list, 1 bank alert, 2 cancel guide, 3 payment stopped, 4 payment kept)
//   c = onboarding screen (0 number, 1 OTP, 2 banks, 3 consent)

const $ = q => document.querySelector(q);
const fmt = n => Math.round(n).toLocaleString("en-IN");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COL = {
    "Netflix": "#b4232c",
    "Hotstar": "#1d3a8a",
    "Spotify": "#1f8a4c",
    "ChatGPT Plus": "#2f7f6f",
    "Google One": "#3b6fd4",
    "Amazon Prime": "#1c5f8a"
};

// Mock 6-month bank statement, the kind of data Account Aggregator would return (made up).
const TX = [];
[
    ["Netflix", 199, 28, [5, 6, 7, 8, 9]],
    ["Hotstar", 299, 14, [5, 8]],
    ["Spotify", 119, 3, [5, 6, 7, 8, 9, 10]],
    ["ChatGPT Plus", 1770, 15, [5, 6, 7, 8, 9, 10]],
    ["Google One", 130, 9, [5, 6, 7, 8, 9, 10]],
    ["Amazon Prime", 299, 12, [5, 6, 7, 8, 9, 10]]
].forEach(([m, a, d, ms]) =>
    ms.forEach(k => TX.push({ m, a, d: `2026-${String(k).padStart(2, "0")}-${String(d).padStart(2, "0")}` }))
);

// Irregular one-off spends mixed in. The detector must ignore these.
[
    ["Swiggy", 412, "2026-06-03"],
    ["Swiggy", 288, "2026-07-19"],
    ["Swiggy", 530, "2026-09-02"],
    ["Uber", 186, "2026-08-11"]
].forEach(([m, a, d]) => TX.push({ m, a, d }));

const pd = t => {
    const [y, m, d] = t.split("-");
    return new Date(y, m - 1, d);
};

// Detector: group by merchant, look at gaps between debits. ~30 days = monthly, ~91 days = quarterly, anything else is ignored.
function detect(tx) {
    const g = {};
    tx.forEach(t => (g[t.m] = g[t.m] || []).push(t));

    return Object.entries(g).map(([m, a]) => {
        a.sort((x, y) => x.d < y.d ? -1 : 1);
        const gp = a.slice(1).map((t, i) => Math.round((pd(t.d) - pd(a[i].d)) / 864e5));
        const ok = (lo, hi) => gp.length && gp.every(x => x >= lo && x <= hi);
        const cy = ok(28, 32) ? 1 : ok(88, 94) ? 3 : 0;

        if (!cy) return 0;
        const l = a[a.length - 1];
        const n = pd(l.d);
        n.setMonth(n.getMonth() + cy);
        return [m, l.a, cy, n.getDate() + " " + MON[n.getMonth()], COL[m] || "#555"];
    }).filter(Boolean);
}

const S = detect(TX);

// Pre-debit notice from the bank; compared with the last detected amount to find increases.
let NOTICE = { m: "Netflix", a: 249 };
let HK = S.find(x => x[0] == NOTICE.m);
let NEW = NOTICE.a;
let OLD = HK ? HK[1] : 0;
let PCT = OLD ? ((NEW - OLD) / OLD * 100).toFixed(1) : "0.0";
let isHike = NEW > OLD;
let s = -1;

let cap = [];
function updateCaptions() {
    cap = [
        `DebitRadar analysed ${TX.length} transactions from the last 6 months and found ${S.length} recurring auto-debits from intervals. One-off spends (Swiggy, Uber) were ignored. Press "Send pre-debit notice" to simulate bank's 24h notification.`,
        isHike
            ? `The bank announced that ${NOTICE.m} will debit ₹${NEW} tomorrow. DebitRadar compared it with the last payment (₹${OLD}) and flagged a ${PCT}% price hike! You can choose to stop or keep the mandate.`
            : `The bank announced that ${NOTICE.m} will debit ₹${NEW} tomorrow. DebitRadar verified it against the baseline (₹${OLD}): no price change. Payment is auto-approved without annoying you!`,
        `DebitRadar never cancels anything itself. It guides you to cancel the mandate inside your own UPI app (GPay/PhonePe), keeping you 100% in control.`,
        `Mandate cancelled: the ₹${NEW} charge is prevented and ${NOTICE.m} drops out of your yearly budget. Warn before the debit and protect your balance!`,
        `Payment kept: ₹${NEW} becomes the new baseline. DebitRadar will warn again only on future price increases.`
    ];
}
updateCaptions();

const capO = [
    "Sign in with the 10-digit mobile number registered with your bank. Any 10-digit number works in this demo; anything else shows an error. Tap Send OTP on the phone.",
    "Enter the one-time password sent to that number. The demo code 123456 is pre-filled. Tap Verify on the phone.",
    "Choose which bank accounts DebitRadar may read, via India's Account Aggregator framework (simulated). Tap Continue on the phone.",
    "Review the consent request: what data is read, why, and for how long. Access is read-only and can be revoked at any time. Tap Approve to continue."
];

const BK = [
    "HDFC Bank",
    "State Bank of India",
    "ICICI Bank",
    "Axis Bank",
    "Kotak Mahindra Bank",
    "IDFC FIRST Bank",
    "Federal Bank",
    "IndusInd Bank"
];

// Onboarding state: screen index, entered number, OTP, selected banks, error text.
let c = 0;
let idv = "";
let otpv = "123456";
let sel = [1, 1, 0, 0, 0, 0, 0, 0];
let err = "";

// Scenario switcher for judges / demo evaluation
function setScenario(merchant, newAmount) {
    NOTICE = { m: merchant, a: newAmount };
    HK = S.find(x => x[0] == NOTICE.m);
    NEW = NOTICE.a;
    OLD = HK ? HK[1] : 0;
    PCT = OLD ? ((NEW - OLD) / OLD * 100).toFixed(1) : "0.0";
    isHike = NEW > OLD;

    document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
    const targetPill = document.getElementById("pill-" + merchant.toLowerCase());
    if (targetPill) targetPill.classList.add("active");

    const desc = document.getElementById("scen-desc");
    if (desc) {
        desc.textContent = isHike ? `${merchant} +${PCT}% hike` : `${merchant} normal debit (verified)`;
    }

    updateCaptions();

    if (s >= 0) {
        s = 1; // instantly show this scenario
        draw();
    }
}

// Escape text before inserting it into HTML (prevents injection).
const esc = t => String(t).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[m]));

// Mask the entered mobile number for display (only the last 3 digits are shown).
const mk = () => "+91 " + "\u2022".repeat(7) + idv.slice(-3);
const hd = (t, sub) => `<div class="sumc"><b style="font-weight:600;font-size:17px">${t}</b><br><span class="mut" style="font-size:13px">${sub}</span></div>`;

// Validate the mobile number (exactly 10 digits) before moving to the OTP screen.
const sn = () => {
    if (/^[0-9]{10}$/.test(idv)) {
        err = "";
        c = 1;
    } else {
        err = idv ? "Mobile number must be exactly 10 digits (" + idv.length + " entered)." : "Please enter your 10-digit mobile number.";
    }
    draw();
};

// Verify the OTP: any 6-digit code is accepted in this demo.
const vf = () => {
    if (/^\d{6}$/.test(otpv)) {
        err = "";
        c = 2;
    } else {
        err = "Enter the 6-digit code.";
    }
    draw();
};

// Timer id used to auto-hide the popup and push notification.
let nt;

// Notification channels the user can toggle: p = popup, u = push, e = email.
let ch = { p: 1, u: 1, e: 1 };
const CH = () => `<div class="chs"><span class="mut">Notify me via</span>${[["p", "Popup"], ["u", "Push"], ["e", "Email"]].map(x => `<label><input type="checkbox" ${ch[x[0]] ? "checked" : ""} onchange="ch.${x[0]}^=1;draw()">${x[1]}</label>`).join("")}</div>`;

// Onboarding wizard: returns the HTML for the current screen (0 number, 1 OTP, 2 banks, 3 consent).
function onb() {
    if (c == 0) {
        return hd("Find your auto-debits", "Enter the mobile number registered with your bank.")
            + `<input class="in mono" type="tel" maxlength="10" inputmode="numeric" placeholder="10-digit mobile number" style="${err ? "border-color:var(--warn)" : ""}" value="${esc(idv)}" oninput="idv=this.value=this.value.replace(/[^0-9]/g,'')" onkeydown="if(event.key==='Enter')sn()">${err ? `<p class="warn" style="font-size:13px;margin:-8px 0 10px">${err}</p>` : ""}<button class="main" onclick="sn()">Send OTP</button><p class="mut" style="font-size:12px">Demo: enter any 10-digit number. No SMS is sent.</p>`;
    }
    if (c == 1) {
        return hd("Enter OTP", "Sent to " + esc(mk()) + " by your bank.")
            + `<input class="in mono" maxlength="6" inputmode="numeric" value="${esc(otpv)}" oninput="otpv=this.value">${err ? `<p class="warn" style="font-size:13px;margin:-8px 0 10px">${err}</p>` : ""}<button class="main" onclick="vf()">Verify</button><p class="mut" style="font-size:12px">Demo OTP: 123456</p>`;
    }
    if (c == 2) {
        return hd("Choose your banks", "Banks where " + esc(mk()) + " is registered.")
            + BK.map((b, i) => `<div class="it" onclick="sel[${i}]^=1;draw()"><div class="av" style="background:#555">${b[0]}</div><div class="m"><b>${b}</b><span>Savings \u00b7\u00b7\u00b7\u00b7${(1234 + i * 1111) % 10000}</span></div><div class="a ${sel[i] ? "ok" : "mut"}"><i data-lucide="${sel[i] ? "check" : "circle"}"></i></div></div>`).join("")
            + `<button class="main" style="margin-top:14px"${sel.some(x => x) ? "" : " disabled"} onclick="c=3;draw()">Continue (${sel.filter(x => x).length} selected)</button>`;
    }
    return hd("Review consent", "DebitRadar asks to read data from your selected accounts.")
        + [["Data", "Transactions"], ["Period", "Last 6 months"], ["Why", "Find recurring payments and warn before price rises"], ["Valid for", "12 months, stop any time"], ["Accounts", sel.filter(x => x).length + " selected"]].map(r => `<div class="kv2"><span class="mut">${r[0]}</span><span>${r[1]}</span></div>`).join("")
        + `<button class="main" style="margin-top:14px" onclick="s=0;draw()">Approve</button><button class="stop" style="background:none;color:var(--ink);border:1px solid var(--ink);width:100%;padding:11px;margin:0 0 12px" onclick="c=2;draw()">Go back</button><p class="mut" style="font-size:12px">Through Account Aggregator (simulated). You can revoke this consent later.</p>`;
}

// One AutoPay list row. Only the mandate named in NOTICE changes during the demo.
function row(x, i) {
    const n = x[0] == NOTICE.m;
    const hike = n && s == 1 && isHike;
    const normal = n && s == 1 && !isHike;
    const done = n && s == 3;
    const kept = n && s == 4;

    return `<div class="it"><div class="av" style="background:${x[4]}">${x[0][0]}</div><div class="m"><b>${x[0]}</b><span>${x[2] == 3 ? "every 3 months" : "every month"} · next ${x[3]}</span>${hike ? `<div class="fl"><i data-lucide="trending-up"></i> Price increase to ₹${NEW} (+${PCT}%)</div><button class="stop" onclick="s=2;draw()">Stop this payment</button> <button class="keep" onclick="s=4;draw()">Keep it</button>${ch.e ? `<div class="em"><b>Email</b> (simulated)<br>Subject: ${NOTICE.m} price change<br>${NOTICE.m} will debit ₹${NEW} tomorrow, up from ₹${OLD}.</div>` : ""}` : ""}${normal ? `<div class="ok" style="font-size:13px;margin-top:4px"><i data-lucide="check-circle-2"></i> Price verified: ₹${NEW} matches baseline. No hike.</div>` : ""}${done ? '<div class="ok" style="font-size:13px;margin-top:4px"><i data-lucide="check"></i> Stopped. You saved ₹' + NEW + '</div>' : ""}${kept ? '<div style="font-size:13px;margin-top:4px">Kept. ₹' + NEW + ' will be debited tomorrow. This is now the usual price.</div>' : ""}</div><div class="a mono">${hike || kept ? "<s class='mut'>₹" + OLD + "</s><br><b>₹" + NEW + "</b>" : done ? "<s class='mut'>₹" + OLD + "</s>" : "₹" + fmt(x[1])}</div></div>`;
}

// Redraw the whole screen from the current state (s, c, ch).
function draw() {
    const act = S.filter(x => !(s == 3 && x[0] == NOTICE.m));
    const tot = act.reduce((t, x) => t + (s == 4 && x[0] == NOTICE.m ? NEW : x[1]) * 12 / x[2], 0);

    $("#step").textContent = (s < 0 ? "Step " + (c + 1) : "Step " + Math.min(s + 5, 8)) + " of 8";
    $("#cap").textContent = s < 0 ? capO[c] : cap[s];
    $("#btns").style.display = s < 0 ? "none" : "flex";
    $("#sim-bar").style.display = s < 0 ? "none" : "block";
    $("#alert").textContent = s == 0 ? "Send pre-debit notice" : "Send notice again";
    $("#scr").innerHTML = (s < 0 ? onb() : `<div class="sumc"><span class="mut" style="font-size:12px">${s == 3 ? act.length + " active auto-debits" : S.length + " auto-debits found in " + TX.length + " transactions"}</span><br><b>₹${fmt(tot)}</b> <span class="mut">a year</span>${s == 3 ? `<div class="ok" style="font-size:13px;margin-top:4px">Saved ₹${NEW} so far</div>` : ""}</div>` + CH() + S.map(row).join(""));

    clearTimeout(nt);
    document.querySelectorAll(".ban,.push,.sheet").forEach(e => e.remove());
    const p = document.querySelector(".phone");

    if (s == 1 && ch.p) {
        const banHtml = isHike
            ? `<div class="ban"><b>DebitRadar</b> · alert<br>${NOTICE.m} price hike: ₹${OLD} → ₹${NEW} (+${PCT}%). Debits tomorrow, 10:00.</div>`
            : `<div class="ban" style="background:#18794e"><b>DebitRadar</b> · verified<br>${NOTICE.m} normal debit: ₹${NEW} matches baseline. No action needed.</div>`;
        p.insertAdjacentHTML("beforeend", banHtml);
    }
    if (s == 1 && ch.u) {
        const pushHtml = isHike
            ? `<div class="push" style="top:${ch.p ? 96 : 10}px"><b>DebitRadar</b> · push notification<br>${NOTICE.m} going up to ₹${NEW} (+${PCT}%). Tap to stop.</div>`
            : `<div class="push" style="top:${ch.p ? 96 : 10}px"><b>DebitRadar</b> · push notification<br>${NOTICE.m} ₹${NEW} scheduled tomorrow. Verified ok.</div>`;
        p.insertAdjacentHTML("beforeend", pushHtml);
    }

    // Alerts behave like real notifications: they disappear on their own after 6 seconds.
    if (s == 1) {
        nt = setTimeout(() => document.querySelectorAll(".ban,.push").forEach(e => e.remove()), 6000);
    }
    if (s == 2) {
        p.insertAdjacentHTML("beforeend", `<div class="sheet"><h3>Stop ${NOTICE.m}</h3><ol><li>Open your UPI app (GPay/PhonePe/Paytm)</li><li>Go to Mandates / AutoPay section</li><li>Select ${NOTICE.m}</li><li>Cancel mandate &amp; enter UPI PIN to confirm</li></ol><button class="main" onclick="s=3;draw()">Done, I stopped it</button></div>`);
    }

    if (window.lucide) {
        lucide.createIcons();
    }
}

// Replay the bank alert without signing out.
$("#alert").onclick = () => {
    s = 1;
    draw();
};

// Log out: return to sign-in and clear all demo state.
$("#out").onclick = () => {
    s = -1;
    c = 0;
    idv = "";
    otpv = "123456";
    sel = [1, 1, 0, 0, 0, 0, 0, 0];
    ch = { p: 1, u: 1, e: 1 };
    err = "";
    draw();
};

draw();

