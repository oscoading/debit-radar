/**
 * DebitRadar Frontend Controller
 * 
 * Handles:
 * - Interactive UI states (onboarding wizard, AutoPay dashboard, alert banners)
 * - Cadence & delta calculation matching backend rules
 * - 24-hour pre-debit notice evaluation (price hike vs baseline)
 * - Keep / Stop guided resolution steps
 */

// ============================================================================
// 1. CORE UTILITIES & FORMATTING
// ============================================================================
const $ = selector => document.querySelector(selector);
const formatRupee = amount => Math.round(amount).toLocaleString("en-IN");
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Brand color palette for merchant avatars
const MERCHANT_COLORS = {
    "Netflix": "#b4232c",
    "Hotstar": "#1d3a8a",
    "Spotify": "#1f8a4c",
    "ChatGPT Plus": "#2f7f6f",
    "Google One": "#3b6fd4",
    "Amazon Prime": "#1c5f8a"
};

// Raw Bank Gateway Descriptors & Legal Entity Identifier (LEI) Mapping
// Neutralizes the "Descriptor Masking" exploit (CCPA Dark Patterns Nov 2023 Shield)
const MERCHANT_LEI_MAP = {
    "Netflix": "NETFLIX ENT SERVICES INDIA",
    "Hotstar": "NOVI DIGITAL ENT PVT LTD",
    "Spotify": "SPOTIFY INDIA PVT LTD",
    "ChatGPT Plus": "OPENAI LLC SAN FRANCISCO",
    "Google One": "GOOGLE INDIA DIGITAL SERVICES",
    "Amazon Prime": "AMAZON PAY INDIA PVT LTD"
};

/**
 * 6-Month Historical Transaction Feed (Sandbox / Statement dataset)
 * [Merchant, baseline amount, debit day, [active months]]
 */
const RAW_TRANSACTIONS = [];
[
    ["Netflix", 199, 28, [5, 6, 7, 8, 9]],
    ["Hotstar", 299, 14, [5, 8]],
    ["Spotify", 119, 3, [5, 6, 7, 8, 9, 10]],
    ["ChatGPT Plus", 1770, 15, [5, 6, 7, 8, 9, 10]],
    ["Google One", 130, 9, [5, 6, 7, 8, 9, 10]],
    ["Amazon Prime", 299, 12, [5, 6, 7, 8, 9, 10]]
].forEach(([merchant, amount, day, activeMonths]) =>
    activeMonths.forEach(m => RAW_TRANSACTIONS.push({
        m: merchant,
        a: amount,
        d: `2026-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    }))
);

// Irregular one-off transactions (Swiggy, Uber - Noise filter test)
[
    ["Swiggy", 412, "2026-06-03"],
    ["Swiggy", 288, "2026-07-19"],
    ["Swiggy", 530, "2026-09-02"],
    ["Uber", 186, "2026-08-11"]
].forEach(([m, a, d]) => RAW_TRANSACTIONS.push({ m, a, d }));

const parseDate = dateStr => {
    const [year, month, day] = dateStr.split("-");
    return new Date(year, month - 1, day);
};

/**
 * Cadence Detection Filter:
 * Groups by merchant, checks gap between debits.
 * ~30 days (28-32) = Monthly, ~90 days (88-94) = Quarterly. Everything else is ignored as noise.
 */
function detectSubscriptions(transactions) {
    const grouped = {};
    transactions.forEach(tx => (grouped[tx.m] = grouped[tx.m] || []).push(tx));

    return Object.entries(grouped).map(([merchant, txList]) => {
        txList.sort((a, b) => a.d < b.d ? -1 : 1);
        const gaps = txList.slice(1).map((tx, idx) => Math.round((parseDate(tx.d) - parseDate(txList[idx].d)) / 864e5));
        const matchesRange = (minDays, maxDays) => gaps.length && gaps.every(days => days >= minDays && days <= maxDays);
        const cycleMonths = matchesRange(28, 32) ? 1 : matchesRange(88, 94) ? 3 : 0;

        if (!cycleMonths) return null;
        const lastTx = txList[txList.length - 1];
        const nextDate = parseDate(lastTx.d);
        nextDate.setMonth(nextDate.getMonth() + cycleMonths);
        return [
            merchant,
            lastTx.a,
            cycleMonths,
            nextDate.getDate() + " " + MONTH_NAMES[nextDate.getMonth()],
            MERCHANT_COLORS[merchant] || "#555"
        ];
    }).filter(Boolean);
}

const detectedSubscriptions = detectSubscriptions(RAW_TRANSACTIONS);

// ============================================================================
// 2. STATE MANAGEMENT & MEANINGFUL VARIABLES
// ============================================================================

// 24h Bank Pre-Debit Notice State & 5% Detection Threshold Engine
const HIKE_THRESHOLD_PCT = 5.0;                   // 5.0% threshold to avoid false alarms on minor tax round-offs
let currentBankNotice = { m: "Netflix", a: 249 }; // Upcoming simulated bank notice
let matchedBaseline = detectedSubscriptions.find(sub => sub[0] === currentBankNotice.m);
let newDebitAmount = currentBankNotice.a;          // New price announced in notice
let baselineAmount = matchedBaseline ? matchedBaseline[1] : 0; // Old price from statement
let rawHikePct = baselineAmount ? ((newDebitAmount - baselineAmount) / baselineAmount * 100) : 0;
let hikePercent = rawHikePct.toFixed(1);
let isHike = rawHikePct >= HIKE_THRESHOLD_PCT;     // Boolean: price increase exceeds 5% threshold
let isMinorSuppressed = rawHikePct > 0 && rawHikePct < HIKE_THRESHOLD_PCT; // Minor GST/rounding within tolerance

// Workflow Step:
// -1 = Onboarding Wizard
//  0 = AutoPay Dashboard List
//  1 = 24h Bank Pre-Debit Alert Banner
//  2 = Keep / Stop Cancellation Guide
//  3 = Mandate Stopped (Saved amount view)
//  4 = Mandate Kept (New baseline accepted)
let workflowStep = -1;

// Onboarding Step:
// 0 = Mobile number input
// 1 = OTP verification (demo code: 123456)
// 2 = Bank account discovery & selection
// 3 = Consent artefact review & approval
let onboardingStep = 0;

// User inputs & form states
let enteredMobileNumber = "";                        // 10-digit mobile number
let enteredOtpCode = "";                             // User entered OTP
let activeOtpCode = "123456";                        // Currently active generated OTP
let incomingSmsVisible = false;                      // Incoming SMS banner visibility
let smsNotificationTimer = null;                     // SMS notification dismiss timer
let selectedBankFlags = [1, 1, 0, 0, 0, 0, 0, 0];    // Selected banks bitmap
let validationErrorMessage = "";                     // Error prompt text
let notificationDismissTimer = null;                 // Auto dismiss timer for banners
let isLoadingAa = false;                             // Account Aggregator ingestion loader state

// In-App NPCI Common Library (CL) & Session State
let sessionToken = "";                               // Active authenticated JWT/Bearer session token
let activeUserId = "usr_rahul";                      // Active user ID (usr_rahul, usr_priya, etc.)
let activeUserUpiPin = "123456";                     // Registered persistent UPI PIN for active user
let enteredUpiPin = "";                              // In-App NPCI Common Library (CL) entered PIN (starts empty)
let isRevokingMandate = false;                       // In-App revocation handshake spinner
let lastRevokedTxnId = "";                           // Generated NPCI reference ID
let lastRevokedUmn = "";                             // Mandate Unique Mandate Number (UMN)
let lastPausedRef = "";                              // Generated NPCI pause reference ID
let lastTimeoutDefense = null;                       // Result of 24h inactive timeout defense simulation
let activeVoiceEngine = "offline";                   // Indic Voice Mode: 'offline' (zero-lag/no Wi-Fi) | 'sarvam' (Cloud neural)
let isIvrListening = false;                          // Whether IVR microphone is listening for voice commands
let ivrStatusMessage = "";                           // Live transcribed text or voice prompt feedback
let speechRecognitionInstance = null;               // Web Speech Recognition controller
let isCopilotListening = false;                      // Whether Global AI Voice Copilot is listening
let copilotStatusMessage = "";                       // Live Copilot transcript or AI spoken response
let copilotRecognitionInstance = null;               // Global Copilot Speech Recognition controller
let isMicModalVisible = false;                       // Explicit Microphone Permission Modal popup state
let hasMicPermissionGranted = false;                 // Cached flag indicating whether mic permission was granted

// User Profile & Voice Settings State (Persisted & Synced with Backend)
let currentUserName = "Rahul Sharma";
let currentUserPhone = "9876543210";
let currentUserBank = "HDFC Bank";
let currentUserMask = "•••• 4092";
let isProfileDrawerVisible = false;                  // Profile & Voice Settings Drawer Sheet
let isAutoVoiceAnnounceEnabled = true;               // Auto-announce pre-debit price hikes out loud
let isCopilotActive = true;                          // Global Copilot enabled

const INDIAN_FIRST_NAMES = ['Rahul', 'Priya', 'Amit', 'Vikram', 'Deepak', 'Sandeep', 'Ananya', 'Pooja', 'Neha', 'Aarav', 'Rohan', 'Sneha', 'Aditya', 'Ritu'];
const INDIAN_LAST_NAMES = ['Sharma', 'Verma', 'Patel', 'Gupta', 'Singh', 'Kumar', 'Mehta', 'Malhotra', 'Iyer', 'Reddy', 'Chopra', 'Saxena'];

function generateRealisticNameForPhone(cleanPhone) {
    if (cleanPhone === '9876543210') return 'Rahul Sharma';
    if (cleanPhone === '9123456789') return 'Priya Patel';
    let hash = 0;
    const str = String(cleanPhone || '');
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 37 + str.charCodeAt(i)) >>> 0;
    }
    const first = INDIAN_FIRST_NAMES[hash % INDIAN_FIRST_NAMES.length];
    const last = INDIAN_LAST_NAMES[(hash >> 3) % INDIAN_LAST_NAMES.length];
    return `${first} ${last}`;
}

// Notification channel toggles: popup, push, email
let notificationChannels = { popup: 1, push: 1, email: 1 };

// Supported banks list for Account Aggregator discovery
const SUPPORTED_BANKS = [
    "HDFC Bank",
    "State Bank of India",
    "ICICI Bank",
    "Axis Bank",
    "Kotak Mahindra Bank",
    "IDFC FIRST Bank",
    "Federal Bank",
    "IndusInd Bank"
];

// Contextual captions displayed above the mobile mockup
let stepCaptions = [];
function updateCaptions() {
    let noticeExplanation = "";
    if (isHike) {
        noticeExplanation = `The bank announced that ${currentBankNotice.m} will debit ₹${newDebitAmount} tomorrow. DebitRadar compared it with the last payment (₹${baselineAmount}) and flagged a +${hikePercent}% price hike (>5% threshold)! You can choose to stop or keep the mandate.`;
    } else if (isMinorSuppressed) {
        noticeExplanation = `The bank announced that ${currentBankNotice.m} will debit ₹${newDebitAmount} tomorrow (up from ₹${baselineAmount}, +${hikePercent}%). DebitRadar tolerance filter classified it as routine GST/tax round-off (<5% threshold). Alarm silenced to prevent notification fatigue!`;
    } else {
        noticeExplanation = `The bank announced that ${currentBankNotice.m} will debit ₹${newDebitAmount} tomorrow. DebitRadar verified it against the baseline (₹${baselineAmount}): debit matches baseline. Payment is auto-approved without annoying you!`;
    }

    stepCaptions = [
        `DebitRadar analysed ${RAW_TRANSACTIONS.length} transactions from the last 6 months and found ${detectedSubscriptions.length} recurring auto-debits from intervals. One-off spends (Swiggy, Uber) were ignored. Press "Send pre-debit notice" to simulate bank's 24h notification.`,
        noticeExplanation,
        `Simulating in-app NPCI Common Library (CL) revocation. The official NPCI PIN sheet captures 2FA and revokes the mandate in the bank switch directly inside DebitRadar without external redirects!`,
        `Mandate revoked directly in-app! The ₹${newDebitAmount} debit was stopped before the 24h deadline, UMN was revoked in the NPCI switch, and ${currentBankNotice.m} was dropped from your yearly budget.`,
        `Payment kept: ₹${newDebitAmount} becomes the new baseline. DebitRadar will warn again only on future price increases.`,
        `Mandate paused for 1 cycle in the NPCI switch! The ₹${newDebitAmount} debit is blocked for tomorrow while your ${currentBankNotice.m} account remains active.`,
        `Autonomous Defense Activated: User was inactive for 24h. Because Mandate Cap was locked at ₹${baselineAmount}, Bank Switch auto-declined the debit with error MANDATE_MAX_LIMIT_EXCEEDED. Exactly ₹0 was debited!`
    ];
}
updateCaptions();

const onboardingCaptions = [
    "Sign in with the 10-digit mobile number registered with your bank. Any 10-digit number works in this demo; anything else shows an error. Tap Send OTP on the phone.",
    "Enter the one-time password sent to that number. The demo code 123456 is pre-filled. Tap Verify on the phone.",
    "Choose which bank accounts DebitRadar may read, via India's Account Aggregator framework (simulated). Tap Continue on the phone.",
    "Review the consent request: what data is read, why, and for how long. Access is read-only and can be revoked at any time. Tap Approve to continue."
];

// ============================================================================
// 3. SCENARIO SWITCHER (Interactive Evaluation Presets)
// ============================================================================
function setScenario(merchant, newAmount) {
    currentBankNotice = { m: merchant, a: newAmount };
    matchedBaseline = detectedSubscriptions.find(sub => sub[0] === currentBankNotice.m);
    newDebitAmount = currentBankNotice.a;
    baselineAmount = matchedBaseline ? matchedBaseline[1] : 0;
    rawHikePct = baselineAmount ? ((newDebitAmount - baselineAmount) / baselineAmount * 100) : 0;
    hikePercent = rawHikePct.toFixed(1);
    isHike = rawHikePct >= HIKE_THRESHOLD_PCT;
    isMinorSuppressed = rawHikePct > 0 && rawHikePct < HIKE_THRESHOLD_PCT;

    document.querySelectorAll(".pill").forEach(pill => pill.classList.remove("active"));
    const pillId = (merchant === "Spotify" && newAmount === 121) ? "pill-spotify-minor" : ("pill-" + merchant.toLowerCase());
    const activePill = document.getElementById(pillId);
    if (activePill) activePill.classList.add("active");

    const descriptionLabel = document.getElementById("scen-desc");
    if (descriptionLabel) {
        if (isHike) {
            descriptionLabel.textContent = `${merchant} ₹${baselineAmount} ➔ ₹${newDebitAmount} (${hikePercent}% hike)`;
        } else if (isMinorSuppressed) {
            descriptionLabel.textContent = `${merchant} ₹${baselineAmount} ➔ ₹${newDebitAmount} (${hikePercent}% <5% filter)`;
        } else {
            descriptionLabel.textContent = `${merchant} ₹${newDebitAmount} normal debit (verified)`;
        }
    }

    updateCaptions();

    if (workflowStep >= 0) {
        workflowStep = 1; // Trigger alert screen immediately
        renderApp();
        if (isHike && isAutoVoiceAnnounceEnabled) {
            setTimeout(() => {
                handleVoiceAlertClick(merchant, baselineAmount, newDebitAmount, hikePercent);
            }, 300);
        }
    }
}

// XSS Sanitizer
const escapeHtml = str => String(str).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));

// Mobile number masking (+91 •••••••123)
const maskMobileNumber = () => "+91 " + "\u2022".repeat(7) + enteredMobileNumber.slice(-3);
const renderCardHeader = (title, subtitle) => `<div class="sumc"><b style="font-weight:600;font-size:17px">${title}</b><br><span class="mut" style="font-size:13px">${subtitle}</span></div>`;

// Handlers for Onboarding Form Actions
const handleSendOtp = () => {
    if (/^[0-9]{10}$/.test(enteredMobileNumber)) {
        validationErrorMessage = "";
        
        // Generate dynamic 6-digit OTP for this session
        activeOtpCode = String(Math.floor(100000 + Math.random() * 900000));
        enteredOtpCode = ""; // clear input for fresh entry
        onboardingStep = 1;
        incomingSmsVisible = true;

        // Sync with backend if available
        try {
            fetch('/api/auth/send-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: enteredMobileNumber })
            }).then(r => r.json()).then(data => {
                if (data && data.gateway && data.gateway.otp) {
                    activeOtpCode = data.gateway.otp;
                    renderApp();
                }
            }).catch(() => {});
        } catch (_) {}

        renderApp();
    } else {
        validationErrorMessage = enteredMobileNumber
            ? "Mobile number must be exactly 10 digits (" + enteredMobileNumber.length + " entered)."
            : "Please enter your 10-digit mobile number.";
        renderApp();
    }
};

const autoFillOtp = code => {
    enteredOtpCode = code;
    validationErrorMessage = "";
    renderApp();
};

const handleVerifyOtp = async () => {
    try {
        const res = await fetch('/api/auth/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: enteredMobileNumber, otp: enteredOtpCode })
        });
        const data = await res.json();
        if (data.success && data.user) {
            sessionToken = data.token || "";
            activeUserId = data.user.id || ("usr_" + enteredMobileNumber);
            currentUserName = data.user.name || generateRealisticNameForPhone(enteredMobileNumber);
            currentUserPhone = data.user.phone || enteredMobileNumber;
            currentUserBank = data.user.bank_name || "HDFC Bank";
            currentUserMask = data.user.account_mask || ("•••• " + enteredMobileNumber.slice(-4));
            activeUserUpiPin = data.user.upi_pin || (enteredMobileNumber === "9123456789" ? "654321" : (enteredMobileNumber === "9876543210" ? "123456" : (enteredMobileNumber.length === 10 ? enteredMobileNumber.slice(-6) : "123456")));
            enteredUpiPin = "";
            validationErrorMessage = "";
            incomingSmsVisible = false;
            onboardingStep = 2;
            renderApp();
            return;
        } else if (!data.success && data.error) {
            validationErrorMessage = data.error;
            renderApp();
            return;
        }
    } catch (_) {}

    // Fallback if network/server is offline
    if (enteredOtpCode === activeOtpCode || enteredOtpCode === "123456") {
        validationErrorMessage = "";
        incomingSmsVisible = false;
        activeUserId = enteredMobileNumber === "9123456789" ? "usr_priya" : (enteredMobileNumber === "9876543210" ? "usr_rahul" : "usr_" + enteredMobileNumber);
        currentUserName = generateRealisticNameForPhone(enteredMobileNumber || "9876543210");
        currentUserPhone = enteredMobileNumber || "9876543210";
        currentUserBank = "HDFC Bank";
        currentUserMask = "•••• " + (enteredMobileNumber ? enteredMobileNumber.slice(-4) : "4092");
        activeUserUpiPin = enteredMobileNumber === "9123456789" ? "654321" : (enteredMobileNumber === "9876543210" ? "123456" : (enteredMobileNumber.length === 10 ? enteredMobileNumber.slice(-6) : "123456"));
        enteredUpiPin = "";
        onboardingStep = 2;
    } else {
        validationErrorMessage = enteredOtpCode ? "Incorrect OTP. Please enter the 6-digit code shown in the Sandbox Gateway." : "Please enter the 6-digit OTP.";
    }
    renderApp();
};

/**
 * Account Aggregator Consent Approval Handler
 * Connects to the procedural sandbox adapter to ingest user-scoped statement transactions
 */
const handleConsentApproval = async () => {
    isLoadingAa = true;
    renderApp();

    try {
        const response = await fetch('/api/aa/consent-and-ingest', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': sessionToken ? ('Bearer ' + sessionToken) : '',
                'x-user-id': activeUserId
            },
            body: JSON.stringify({
                phone: enteredMobileNumber || '9876543210',
                user_id: activeUserId
            })
        }).then(r => r.json()).catch(() => null);

        if (response && response.hike_notice) {
            currentBankNotice = { m: response.hike_notice.merchant, a: response.hike_notice.new_amount };
            matchedBaseline = detectedSubscriptions.find(sub => sub[0] === currentBankNotice.m);
            newDebitAmount = currentBankNotice.a;
            baselineAmount = response.hike_notice.old_amount;
            hikePercent = String(response.hike_notice.hike_percent);
            isHike = true;
            updateCaptions();
        }
    } catch (_) {}

    // Smooth 1.2s loader transition to simulate FIP bank decryption & ingestion
    setTimeout(() => {
        isLoadingAa = false;
        workflowStep = 0;
        renderApp();
    }, 1200);
};

// Notification Preferences UI
const renderNotificationToggles = () => `
    <div class="chs">
        <span class="mut">Notify me via</span>
        ${[
            ["popup", "Popup"],
            ["push", "Push"],
            ["email", "Email"]
        ].map(([key, label]) => `
            <label>
                <input type="checkbox" ${notificationChannels[key] ? "checked" : ""} onchange="notificationChannels.${key}^=1;renderApp()">
                ${label}
            </label>
        `).join("")}
    </div>
`;

// ============================================================================
// 4. VIEW RENDERING
// ============================================================================

/**
 * Onboarding Wizard View:
 * Screen 0: Mobile -> Screen 1: OTP -> Screen 2: Banks -> Screen 3: Consent
 */
function renderOnboardingView() {
    if (isLoadingAa) {
        return `
            <div class="aa-loader">
                <div class="aa-spinner"></div>
                <b style="font-size:16px;font-weight:600">Connecting to Account Aggregator</b>
                <span class="mut" style="font-size:12px;margin-top:4px">Fetching 6-month encrypted statement feed from FIP Bank...</span>
                <div style="margin-top:20px;text-align:left;display:inline-block">
                    <div class="aa-step-item"><i data-lucide="shield-check" class="ok"></i> Consent artefact validated (Sahamati AA)</div>
                    <div class="aa-step-item"><i data-lucide="database" class="ok"></i> Ingesting into user-scoped SQLite records</div>
                    <div class="aa-step-item"><i data-lucide="cpu" class="ok"></i> Running cadence & noise filter</div>
                </div>
            </div>
        `;
    }

    if (onboardingStep === 0) {
        return renderCardHeader("Find your auto-debits", "Enter the mobile number registered with your bank.")
            + `<div class="onboarding-voice-box">
                   <div style="font-size:11px;font-weight:600;margin-bottom:4px;color:var(--ink)">🎙️ Voice Engine Mode:</div>
                   <div style="display:flex;gap:4px">
                       <button type="button" class="voice-mode-btn ${activeVoiceEngine === 'offline' ? 'active' : ''}" onclick="setVoiceEngineMode('offline')">
                           🟢 Offline (No Wi-Fi)
                       </button>
                       <button type="button" class="voice-mode-btn ${activeVoiceEngine === 'sarvam' ? 'active' : ''}" onclick="setVoiceEngineMode('sarvam')">
                           ⚡ Sarvam AI Cloud
                       </button>
                   </div>
               </div>`
            + `<input class="in mono" type="tel" maxlength="10" inputmode="numeric" placeholder="10-digit mobile number" style="${validationErrorMessage ? "border-color:var(--warn)" : ""}" value="${escapeHtml(enteredMobileNumber)}" oninput="enteredMobileNumber=this.value=this.value.replace(/[^0-9]/g,'')" onkeydown="if(event.key==='Enter')handleSendOtp()">${validationErrorMessage ? `<p class="warn" style="font-size:13px;margin:-8px 0 10px">${validationErrorMessage}</p>` : ""}<button class="main" onclick="handleSendOtp()">Send OTP</button><p class="mut" style="font-size:12px">Demo: enter any 10-digit number. No SMS is sent.</p>`;
    }
    if (onboardingStep === 1) {
        return renderCardHeader("Enter OTP", "Sent to " + escapeHtml(maskMobileNumber()) + " via Sandbox SMS Gateway.")
            + `<input class="in mono" maxlength="6" inputmode="numeric" placeholder="6-digit OTP" value="${escapeHtml(enteredOtpCode)}" oninput="enteredOtpCode=this.value" onkeydown="if(event.key==='Enter')handleVerifyOtp()">`
            + `<div class="sandbox-otp-pill" onclick="autoFillOtp('${activeOtpCode}')">
                   <span>🔑 <b>Sandbox Gateway OTP:</b></span>
                   <b>${activeOtpCode} <span class="mut" style="font-weight:400;font-size:11px">(Tap to auto-fill)</span></b>
               </div>`
            + (validationErrorMessage ? `<p class="warn" style="font-size:13px;margin:-8px 0 10px">${validationErrorMessage}</p>` : "")
            + `<button class="main" onclick="handleVerifyOtp()">Verify OTP</button>
               <button class="stop" style="background:none;color:var(--ink);border:1px solid var(--ink);width:100%;padding:9px;margin:0 0 10px" onclick="onboardingStep=0;renderApp()">Change number</button>
               <p class="mut" style="font-size:12px">TRAI DLT Sandbox: OTP generated securely by server and displayed in Sandbox Gateway.</p>`;
    }
    if (onboardingStep === 2) {
        return renderCardHeader("Choose your banks", "Banks where " + escapeHtml(maskMobileNumber()) + " is registered.")
            + SUPPORTED_BANKS.map((bank, idx) => `
                <div class="it" onclick="selectedBankFlags[${idx}]^=1;renderApp()">
                    <div class="av" style="background:#555">${bank[0]}</div>
                    <div class="m">
                        <b>${bank}</b>
                        <span>Savings \u00b7\u00b7\u00b7\u00b7${(1234 + idx * 1111) % 10000}</span>
                    </div>
                    <div class="a ${selectedBankFlags[idx] ? "ok" : "mut"}">
                        <i data-lucide="${selectedBankFlags[idx] ? "check" : "circle"}"></i>
                    </div>
                </div>
            `).join("")
            + `<button class="main" style="margin-top:14px"${selectedBankFlags.some(flag => flag) ? "" : " disabled"} onclick="onboardingStep=3;renderApp()">Continue (${selectedBankFlags.filter(flag => flag).length} selected)</button>`;
    }
    // Screen 3: Consent Artefact Review
    return renderCardHeader("Review consent", "DebitRadar asks to read data from your selected accounts.")
        + [
            ["Data", "Transactions"],
            ["Period", "Last 6 months"],
            ["Why", "Find recurring payments and warn before price rises"],
            ["Valid for", "12 months, stop any time"],
            ["Accounts", selectedBankFlags.filter(flag => flag).length + " selected"]
        ].map(([key, val]) => `<div class="kv2"><span class="mut">${key}</span><span>${val}</span></div>`).join("")
        + `<button class="main" style="margin-top:14px" onclick="handleConsentApproval()">Approve &amp; Connect Bank</button>
           <button class="stop" style="background:none;color:var(--ink);border:1px solid var(--ink);width:100%;padding:11px;margin:0 0 12px" onclick="onboardingStep=2;renderApp()">Go back</button>
           <p class="mut" style="font-size:12px">Through Account Aggregator (simulated). You can revoke this consent later.</p>`;
}

/**
 * Mandate List Item Row
 */
function renderMandateRow(subItem) {
    const safeMerchantName = escapeHtml(subItem[0]);
    const safeNoticeMerchant = escapeHtml(currentBankNotice.m);
    const isTargetMerchant = subItem[0] === currentBankNotice.m;
    const showHikeAlert = isTargetMerchant && workflowStep === 1 && isHike;
    const showMinorSuppressed = isTargetMerchant && workflowStep === 1 && isMinorSuppressed;
    const showNormalVerified = isTargetMerchant && workflowStep === 1 && !isHike && !isMinorSuppressed;
    const isPaymentStopped = isTargetMerchant && workflowStep === 3;
    const isPaymentKept = isTargetMerchant && workflowStep === 4;
    const isPaymentPaused = isTargetMerchant && workflowStep === 5;
    const isTimeoutProtected = isTargetMerchant && workflowStep === 6;

    return `
        <div class="it">
            <div class="av" style="background:${subItem[4]}">${safeMerchantName[0]}</div>
            <div class="m">
                <b>${safeMerchantName}</b>
                <span class="lei-badge">Gateway: ${MERCHANT_LEI_MAP[subItem[0]] || subItem[0]}</span>
                <span style="font-size:11px;color:var(--mut)">${subItem[2] === 3 ? "every 3 months" : "every month"} · next ${subItem[3]}</span>
                ${showHikeAlert ? `
                    <div class="fl"><i data-lucide="trending-up"></i> Price increase: ₹${baselineAmount} ➔ ₹${newDebitAmount} (${hikePercent}% hike) · <b>&gt;5% threshold</b></div>
                    <div style="font-size:11px;color:#0369a1;margin:4px 0 2px">
                        <i data-lucide="eye" style="width:12px;height:12px;vertical-align:middle;display:inline-block"></i> <b>CCPA Anti-Masking Shield:</b> Raw gateway descriptor <code>${MERCHANT_LEI_MAP[subItem[0]] || subItem[0]}</code> resolved to <b>${safeMerchantName}</b>
                    </div>
                    <div class="defense-badge-box">
                        <i data-lucide="shield-check" style="width:13px;height:13px;vertical-align:middle;display:inline-block"></i>
                        <b>Bank Switch Cap Defense:</b> Mandate is locked at baseline ₹${baselineAmount}. Under NPCI rules, debit of ₹${newDebitAmount} will auto-bounce even if you take no action!
                    </div>
                    <div style="margin:8px 0 6px">
                        <button id="btn-smart-mic" class="btn-smart-voice-unified ${isIvrListening ? 'listening' : ''}" onclick="handleSmartVoiceToggle('${safeNoticeMerchant}', ${baselineAmount}, ${newDebitAmount}, '${hikePercent}')">
                            <div class="smart-mic-icon-circle">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                                    <line x1="12" x2="12" y1="19" y2="22"></line>
                                </svg>
                            </div>
                            <span>${isIvrListening ? '🔴 माइक सुन रहा है... बोलिए "रोको"' : '🎙️ वॉयस असिस्टेंट (बोलकर आदेश दें)'}</span>
                        </button>
                    </div>
                    ${isIvrListening ? `
                        <div class="ivr-live-card">
                            <div style="display:flex;align-items:center;justify-content:space-between">
                                <span style="display:flex;align-items:center;gap:6px;color:#be185d;font-weight:600;font-size:11px">
                                    <span class="ivr-pulse-dot"></span> 🎙️ माइक सुन रहा है (बोलिए)...
                                </span>
                                <button type="button" onclick="stopIvrListening()" style="background:none;border:none;color:var(--mut);cursor:pointer;font-size:11px;font-weight:bold">✕ बंद करें</button>
                            </div>
                            <div style="font-size:11px;margin:5px 0 3px;color:#0f172a;line-height:1.4">
                                बोलिए: <b>"नेटफ्लिक्स रोको"</b>, <b>"1 महीना पॉज़ करो"</b>, या <b>"चलने दो"</b>
                            </div>
                            <div class="ivr-live-transcript" id="ivr-live-transcript">
                                ${ivrStatusMessage || 'माइक चालू है... बोलिए "नेटफ्लिक्स रोको"'}
                            </div>
                        </div>
                    ` : ""}
                    <div class="btn-group-3">
                        <button class="stop" onclick="enteredUpiPin='';workflowStep=2;renderApp()">Stop Mandate</button>
                        <button class="btn-pause" onclick="handlePauseMandate()">Pause 1 Cycle</button>
                        <button class="keep" onclick="handleKeepPayment()">Keep ₹${newDebitAmount}</button>
                    </div>
                    ${notificationChannels.email ? `
                        <div class="em">
                            <b>Email</b> (simulated)<br>
                            Subject: ${safeNoticeMerchant} price change (+${hikePercent}%)<br>
                            ${safeNoticeMerchant} will debit ₹${newDebitAmount} tomorrow, up from ₹${baselineAmount}. Exceeds 5% tolerance threshold.
                        </div>
                    ` : ""}
                ` : ""}
                ${showMinorSuppressed ? `
                    <div class="ok" style="font-size:13px;margin-top:4px">
                        <i data-lucide="shield-check"></i> <b>Tolerance check passed:</b> +₹${newDebitAmount - baselineAmount} (+${hikePercent}%) is below 5% threshold (GST round-off). Auto-approved without alerting!
                    </div>
                ` : ""}
                ${showNormalVerified ? `
                    <div class="ok" style="font-size:13px;margin-top:4px">
                        <i data-lucide="check-circle-2"></i> Price verified: ₹${newDebitAmount} matches baseline. No hike.
                    </div>
                ` : ""}
                ${isPaymentStopped ? `
                    <div class="ok" style="font-size:13px;margin-top:4px">
                        <i data-lucide="check"></i> <b>Mandate Revoked!</b> Saved ₹${newDebitAmount}/mo (₹${formatRupee(newDebitAmount * 12)}/year) from future debits.
                    </div>
                ` : ""}
                ${isPaymentPaused ? `
                    <div class="ok" style="font-size:13px;margin-top:4px;color:#854d0e">
                        <i data-lucide="pause-circle"></i> <b>Paused for 1 cycle!</b> ₹${newDebitAmount} blocked for tomorrow.
                    </div>
                ` : ""}
                ${isTimeoutProtected ? `
                    <div class="ok" style="font-size:13px;margin-top:4px;color:#1e40af">
                        <i data-lucide="shield-check"></i> <b>24h Inactive Auto-Defense:</b> ₹${newDebitAmount} declined at switch (Cap: ₹${baselineAmount}). ₹0 debited!
                    </div>
                ` : ""}
                ${isPaymentKept ? `
                    <div class="ok" style="font-size:13px;margin-top:4px">
                        <i data-lucide="check-circle-2"></i> <b>New Baseline Saved:</b> ₹${newDebitAmount}/mo is now registered. Future debits at ₹${newDebitAmount} won't alert.
                    </div>
                ` : ""}
            </div>
            <div class="a mono">
                ${showHikeAlert || isPaymentKept ? `<s class='mut'>₹${baselineAmount}</s><br><b>₹${newDebitAmount}</b>` : (showMinorSuppressed ? `<s class='mut'>₹${baselineAmount}</s><br><b style="color:var(--ok)">₹${newDebitAmount}</b>` : (isPaymentStopped || isPaymentPaused || isTimeoutProtected ? `<s class='mut'>₹${baselineAmount}</s>` : "₹" + formatRupee(subItem[1])))}
            </div>
        </div>
    `;
}

/**
 * Main Application Render Function
 */
function renderApp() {
    const activeSubscriptions = detectedSubscriptions.filter(sub => !(workflowStep === 3 && sub[0] === currentBankNotice.m));
    const annualTotalCommitment = activeSubscriptions.reduce((total, sub) => {
        const amount = (workflowStep === 4 && sub[0] === currentBankNotice.m) ? newDebitAmount : sub[1];
        return total + (amount * 12 / sub[2]);
    }, 0);

    // Update outer progress step and description text
    $("#step").textContent = (workflowStep < 0 ? "Step " + (onboardingStep + 1) : "Step " + Math.min(workflowStep + 5, 8)) + " of 8";
    $("#cap").textContent = workflowStep < 0 ? onboardingCaptions[onboardingStep] : stepCaptions[workflowStep];
    $("#btns").style.display = workflowStep < 0 ? "none" : "flex";
    $("#sim-bar").style.display = workflowStep < 0 ? "none" : "block";
    $("#alert").textContent = workflowStep === 0 ? "Send pre-debit notice" : "Send notice again";

    // Update phone bar with Android-style user profile header pill if logged in
    const barElem = document.querySelector(".bar");
    if (barElem) {
        if (workflowStep >= 0) {
            const initials = currentUserName ? currentUserName.split(' ').map(n=>n[0]).join('') : 'RS';
            barElem.innerHTML = `
                <div class="phone-app-header">
                    <span style="font-size:18px;font-weight:700">AutoPay</span>
                    <div class="user-profile-header-pill" onclick="toggleUserProfileDrawer()" title="User Profile & Voice Settings">
                        <div class="user-avatar-circle">${escapeHtml(initials)}</div>
                        <div class="user-header-text">
                            <span class="user-header-name">${escapeHtml(currentUserName)}</span>
                            <span class="user-header-sub">${escapeHtml(currentUserBank)}</span>
                        </div>
                        <i data-lucide="settings" style="width:13px;height:13px;color:var(--mut)"></i>
                    </div>
                </div>
            `;
        } else {
            barElem.innerHTML = `AutoPay`;
        }
    }

    // Render inside phone screen container
    $("#scr").innerHTML = (workflowStep < 0
        ? renderOnboardingView()
        : (workflowStep === 3 ? `
            <div class="npci-success-card">
                <div style="color:#16a34a;font-size:15px;font-weight:600;display:flex;align-items:center;gap:6px;margin-bottom:6px">
                    <i data-lucide="check-circle-2"></i> Mandate Revoked In-App!
                </div>
                <div style="font-size:13px;color:#15803d;line-height:1.4">
                    <b>${escapeHtml(currentBankNotice.m)}</b> auto-debit of <b>₹${newDebitAmount}</b> was stopped directly in the bank switch.
                </div>
                <div style="margin-top:10px;padding-top:8px;border-top:1px dashed #86efac;font-size:10px;font-family:'IBM Plex Mono',monospace;color:#166534">
                    NPCI TXN: <b>${lastRevokedTxnId || 'NPCI-REV-2026-9812'}</b><br>
                    UMN: <b>${lastRevokedUmn || 'HDFC89234729@upi'}</b><br>
                    STATUS: <b>PERMANENTLY REVOKED (UPI 2.0)</b>
                </div>
            </div>
            <button class="main" onclick="workflowStep=0;renderApp()" style="margin-bottom:14px">
                Back to AutoPay List
            </button>
        ` : (workflowStep === 5 ? `
            <div class="npci-success-card" style="background:#fefce8;border-color:#fef08a">
                <div style="color:#854d0e;font-size:15px;font-weight:600;display:flex;align-items:center;gap:6px;margin-bottom:6px">
                    <i data-lucide="pause-circle"></i> Mandate Paused for 1 Cycle!
                </div>
                <div style="font-size:13px;color:#713f12;line-height:1.4">
                    <b>${escapeHtml(currentBankNotice.m)}</b> debit of <b>₹${newDebitAmount}</b> was paused via NPCI AutoPay 2.0. Tomorrow's debit will NOT execute, but your subscription is not cancelled.
                </div>
                <div style="margin-top:10px;padding-top:8px;border-top:1px dashed #fde047;font-size:10px;font-family:'IBM Plex Mono',monospace;color:#854d0e">
                    NPCI PAUSE REF: <b>${lastPausedRef || 'NPCI-PAUSE-9128-4491'}</b><br>
                    DURATION: <b>1 BILLING CYCLE</b><br>
                    STATUS: <b>EXECUTION_HALTED (₹0 DEDUCTED)</b>
                </div>
            </div>
            <button class="main" onclick="workflowStep=0;renderApp()" style="margin-bottom:14px">
                Back to AutoPay List
            </button>
        ` : (workflowStep === 6 ? `
            <div class="timeout-card">
                <div style="font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px;color:#1e40af">
                    <i data-lucide="shield-check"></i> 24h Inactive Defense Activated!
                </div>
                <div style="font-size:12px;color:#1e3a8a;margin-top:4px;line-height:1.4">
                    User took zero action during the 24h window. DebitRadar's <b>Autonomous Defense</b> protected your money at the Bank Switch:
                </div>
                <div class="timeout-stat-grid">
                    <div class="timeout-stat-item">
                        <span class="mut" style="font-size:9px">ATTEMPTED DEBIT</span><br>
                        <b style="color:#dc2626">₹${newDebitAmount}</b>
                    </div>
                    <div class="timeout-stat-item">
                        <span class="mut" style="font-size:9px">LOCKED MANDATE CAP</span><br>
                        <b style="color:#2563eb">₹${baselineAmount}</b>
                    </div>
                    <div class="timeout-stat-item">
                        <span class="mut" style="font-size:9px">ACTUAL DEBITED</span><br>
                        <b style="color:#16a34a">₹0.00 (Zero Loss)</b>
                    </div>
                    <div class="timeout-stat-item">
                        <span class="mut" style="font-size:9px">BANK SWITCH ERROR</span><br>
                        <b>CAP_EXCEEDED</b>
                    </div>
                </div>
                <div style="margin-top:10px;font-size:10px;color:#3b82f6;font-family:monospace">
                    REF: <b>${lastTimeoutDefense && lastTimeoutDefense.npci_decline_ref ? lastTimeoutDefense.npci_decline_ref : 'NPCI-DECLINE-88219'}</b> · HDFC Bank Switch
                </div>
            </div>
            <button class="main" onclick="workflowStep=0;renderApp()" style="margin-bottom:14px">
                Back to AutoPay List
            </button>
        ` : '')))
        + renderCopilotBanner()
        + `<div class="sumc">
             <span class="mut" style="font-size:12px">
               ${(workflowStep === 3 || workflowStep === 5 || workflowStep === 6) ? activeSubscriptions.length + " active auto-debits" : detectedSubscriptions.length + " auto-debits found in " + RAW_TRANSACTIONS.length + " transactions"}
             </span><br>
             <b>₹${formatRupee(annualTotalCommitment)}</b> <span class="mut">a year</span>
             ${(workflowStep === 3 || workflowStep === 5 || workflowStep === 6) ? `<div class="ok" style="font-size:13px;margin-top:4px"><i data-lucide="shield-check"></i> ₹${newDebitAmount} saved from future debits</div>` : ""}
           </div>`
           + renderNotificationToggles()
           + detectedSubscriptions.map(renderMandateRow).join("")
    );

    clearTimeout(notificationDismissTimer);
    document.querySelectorAll(".ban,.push,.sheet,.sms-push").forEach(elem => elem.remove());
    const phoneContainer = document.querySelector(".phone");

    // Simulated incoming SMS push banner on phone mockup (TRAI DLT Sandbox Simulation)
    if (workflowStep < 0 && onboardingStep === 1 && incomingSmsVisible) {
        const smsPushHtml = `
            <div class="sms-push" onclick="autoFillOtp('${activeOtpCode}')">
                <div class="sms-push-head">
                    <span>💬 MESSAGES · VK-DBRADR · now</span>
                    <span style="font-size:9px;color:#38bdf8">TAP TO AUTO-FILL</span>
                </div>
                <div>Your DebitRadar verification OTP is <b class="sms-push-code">${activeOtpCode}</b>. Valid for 5 mins. Do not share.</div>
            </div>
        `;
        phoneContainer.insertAdjacentHTML("beforeend", smsPushHtml);

        clearTimeout(smsNotificationTimer);
        smsNotificationTimer = setTimeout(() => {
            incomingSmsVisible = false;
            document.querySelectorAll(".sms-push").forEach(elem => elem.remove());
        }, 8000);
    }

    // In-app alert banner
    if (workflowStep === 1 && notificationChannels.popup) {
        const safeNoticeMerchant = escapeHtml(currentBankNotice.m);
        let alertBannerHtml = "";
        if (isHike) {
            alertBannerHtml = `<div class="ban"><b>DebitRadar</b> · alert<br>${safeNoticeMerchant} price hike: ₹${baselineAmount} → ₹${newDebitAmount} (${hikePercent}% hike). Debits tomorrow, 10:00.</div>`;
        } else if (isMinorSuppressed) {
            alertBannerHtml = `<div class="ban" style="background:#18794e"><b>DebitRadar</b> · tolerance check<br>${safeNoticeMerchant} +₹${newDebitAmount - baselineAmount} (${hikePercent}%). Under 5% threshold (GST round-off). Auto-approved.</div>`;
        } else {
            alertBannerHtml = `<div class="ban" style="background:#18794e"><b>DebitRadar</b> · verified<br>${safeNoticeMerchant} normal debit: ₹${newDebitAmount} matches baseline. No action needed.</div>`;
        }
        phoneContainer.insertAdjacentHTML("beforeend", alertBannerHtml);
    }

    // Push notification banner
    if (workflowStep === 1 && notificationChannels.push) {
        const safeNoticeMerchant = escapeHtml(currentBankNotice.m);
        let pushNotificationHtml = "";
        if (isHike) {
            pushNotificationHtml = `<div class="push" style="top:${notificationChannels.popup ? 96 : 10}px"><b>DebitRadar</b> · push notification<br>${safeNoticeMerchant} going up to ₹${newDebitAmount} (${hikePercent}% hike). Tap to stop.</div>`;
        } else if (isMinorSuppressed) {
            pushNotificationHtml = `<div class="push" style="top:${notificationChannels.popup ? 96 : 10}px"><b>DebitRadar</b> · push notification<br>${safeNoticeMerchant} ₹${newDebitAmount} (${hikePercent}% GST round-off). Below 5% threshold, verified ok.</div>`;
        } else {
            pushNotificationHtml = `<div class="push" style="top:${notificationChannels.popup ? 96 : 10}px"><b>DebitRadar</b> · push notification<br>${safeNoticeMerchant} ₹${newDebitAmount} scheduled tomorrow. Verified ok.</div>`;
        }
        phoneContainer.insertAdjacentHTML("beforeend", pushNotificationHtml);
    }

    // Auto-dismiss banners after 6s
    if (workflowStep === 1) {
        notificationDismissTimer = setTimeout(() => {
            document.querySelectorAll(".ban,.push").forEach(elem => elem.remove());
        }, 6000);
    }

    // In-App NPCI Common Library (CL) 2FA Revocation Sheet
    if (workflowStep === 2) {
        const safeNoticeMerchant = escapeHtml(currentBankNotice.m);
        const demoUmn = `HDFC${Math.abs(currentBankNotice.m.split('').reduce((acc, c) => acc + c.charCodeAt(0), 1000) * 8923).toString().slice(0, 8)}@upi`;

        phoneContainer.insertAdjacentHTML("beforeend", `
            <div class="sheet">
                <div>
                    <div class="npci-header">
                        <div class="npci-badge">
                            <span>🇮🇳</span> <b>UPI AutoPay</b> · NPCI Common Library
                        </div>
                        <div class="npci-sub">Sponsor Bank: HDFC Bank PSP Switch (Sandbox)</div>
                    </div>

                    <div style="font-size:14px;font-weight:600;margin-bottom:2px">Revoke Mandate Confirmation</div>
                    <div class="mut" style="font-size:11px">2FA Authentication required under RBI Mandate Guidelines</div>

                    <div class="npci-card">
                        <div class="npci-card-row">
                            <span style="color:#94a3b8">Merchant:</span>
                            <b>${safeNoticeMerchant}</b>
                        </div>
                        <div class="npci-card-row">
                            <span style="color:#94a3b8">Scheduled Debit:</span>
                            <b style="color:#f87171">₹${newDebitAmount} / month</b>
                        </div>
                        <div class="npci-card-row">
                            <span style="color:#94a3b8">Baseline Rate:</span>
                            <span>₹${baselineAmount}</span>
                        </div>
                        <div class="npci-umn">
                            UMN: ${demoUmn}<br>
                            Action: PERMANENT_MANDATE_REVOCATION
                        </div>
                    </div>

                    <div class="npci-pin-box">
                        <div style="font-size:11px;font-weight:600;letter-spacing:0.04em;color:var(--ink)">ENTER 6-DIGIT UPI PIN</div>
                        <div class="npci-dots">
                            <div class="npci-dot ${enteredUpiPin.length >= 1 ? 'filled' : ''}"></div>
                            <div class="npci-dot ${enteredUpiPin.length >= 2 ? 'filled' : ''}"></div>
                            <div class="npci-dot ${enteredUpiPin.length >= 3 ? 'filled' : ''}"></div>
                            <div class="npci-dot ${enteredUpiPin.length >= 4 ? 'filled' : ''}"></div>
                            <div class="npci-dot ${enteredUpiPin.length >= 5 ? 'filled' : ''}"></div>
                            <div class="npci-dot ${enteredUpiPin.length >= 6 ? 'filled' : ''}"></div>
                        </div>
                        <input type="password" id="npci-pin-input" maxlength="6" class="in" style="margin:4px 0 0;text-align:center;letter-spacing:8px;font-size:20px;font-family:monospace" value="${enteredUpiPin}" oninput="handleUpiPinInput(this)" placeholder="••••••" autofocus>
                        <div id="npci-pin-error" style="color:var(--warn);font-size:11px;margin-top:4px;min-height:16px"></div>
                        <div class="npci-sec-note">
                            <i data-lucide="lock" style="width:11px;height:11px"></i> End-to-end encrypted with NPCI Hardware Security Module (HSM)
                        </div>
                    </div>
                </div>

                <div>
                    ${isRevokingMandate ? `
                        <button class="main" disabled style="display:flex;align-items:center;justify-content:center;gap:8px">
                            <span class="aa-spinner" style="width:16px;height:16px;border-width:2px;margin:0"></span>
                            Revoking in NPCI Switch...
                        </button>
                    ` : `
                        <button class="main" onclick="handleConfirmInAppRevocation()" style="background:#dc2626;color:#fff;border-color:#dc2626">
                            Authorize &amp; Revoke Mandate
                        </button>
                    `}
                    <button class="out" style="width:100%;padding:10px;margin-top:6px;font-size:13px;border-radius:8px" onclick="workflowStep=1;renderApp()">
                        Cancel &amp; Go Back
                    </button>
                </div>
            </div>
        `);
    }

    // Profile & Voice AI Settings Drawer Sheet (Android Banking App style)
    if (isProfileDrawerVisible) {
        const initials = currentUserName ? currentUserName.split(' ').map(n=>n[0]).join('') : 'RS';
        phoneContainer.insertAdjacentHTML("beforeend", `
            <div class="sheet mic-permission-sheet" style="z-index:9998">
                <div class="profile-drawer-card">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                        <b style="font-size:14px;color:var(--ink)">User Profile &amp; Settings</b>
                        <button type="button" onclick="isProfileDrawerVisible=false;renderApp()" style="background:none;border:none;color:var(--mut);font-weight:bold;font-size:16px;cursor:pointer">✕</button>
                    </div>

                    <div class="profile-user-hero">
                        <div class="profile-hero-avatar">${escapeHtml(initials)}</div>
                        <div style="flex:1">
                            <div style="font-size:15px;font-weight:700;color:var(--ink)">${escapeHtml(currentUserName)}</div>
                            <div style="font-size:11px;color:var(--mut)">+91 •••••••${escapeHtml(currentUserPhone.slice(-3))}</div>
                            <div style="font-size:10px;color:#0284c7;font-weight:600;margin-top:2px">🏛️ ${escapeHtml(currentUserBank)} (${escapeHtml(currentUserMask)})</div>
                        </div>
                    </div>

                    <div class="settings-section-title">🎙️ Voice AI Engine &amp; Mode</div>
                    <div style="display:flex;gap:6px;margin-bottom:10px">
                        <button type="button" class="voice-mode-btn ${activeVoiceEngine === 'offline' ? 'active' : ''}" style="flex:1;padding:7px 4px;font-size:10px" onclick="setVoiceEngineMode('offline')">
                            🟢 Offline (0-Wi-Fi)
                        </button>
                        <button type="button" class="voice-mode-btn ${activeVoiceEngine === 'sarvam' ? 'active' : ''}" style="flex:1;padding:7px 4px;font-size:10px" onclick="setVoiceEngineMode('sarvam')">
                            ⚡ Sarvam AI Cloud
                        </button>
                    </div>

                    <div class="settings-section-title">⚡ Voice Automation (Default ON)</div>
                    <div class="settings-toggle-row">
                        <div>
                            <div class="settings-toggle-label">Auto-Announce Pre-Debit Alerts</div>
                            <div class="settings-toggle-sub">AI automatically speaks alert when notice arrives</div>
                        </div>
                        <input type="checkbox" ${isAutoVoiceAnnounceEnabled ? 'checked' : ''} onchange="isAutoVoiceAnnounceEnabled^=1;renderApp()">
                    </div>
                    <div class="settings-toggle-row">
                        <div>
                            <div class="settings-toggle-label">Global Voice Copilot Active</div>
                            <div class="settings-toggle-sub">One-tap full command &amp; control mic</div>
                        </div>
                        <input type="checkbox" ${isCopilotActive ? 'checked' : ''} onchange="isCopilotActive^=1;renderApp()">
                    </div>
                    <div class="settings-toggle-row">
                        <div>
                            <div class="settings-toggle-label">Default Speech Language</div>
                            <div class="settings-toggle-sub">Speaks Hindi by default; English if addressed in English</div>
                        </div>
                        <span style="font-size:11px;font-weight:600;color:#0284c7">Hindi (हिंदी)</span>
                    </div>

                    <div style="margin-top:16px">
                        <button class="main" style="padding:10px;font-size:12px;margin-bottom:6px" onclick="isProfileDrawerVisible=false;renderApp()">Done / Close</button>
                        <button class="out" style="width:100%;padding:8px;font-size:11px" onclick="isProfileDrawerVisible=false;handleLogout()">Log Out Account</button>
                    </div>
                </div>
            </div>
        `);
    }
    if (isMicModalVisible) {
        phoneContainer.insertAdjacentHTML("beforeend", `
            <div class="sheet mic-permission-sheet">
                <div class="mic-modal-card">
                    <div class="mic-modal-orb">
                        <svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                            <line x1="12" x2="12" y1="19" y2="22"></line>
                        </svg>
                    </div>
                    <div style="font-size:16px;font-weight:600;color:var(--ink);margin-bottom:6px">Allow Microphone Access</div>
                    <div style="font-size:12px;color:var(--mut);line-height:1.5;margin-bottom:16px">
                        DebitRadar listens for natural voice commands like <b>"Stop Netflix"</b>, <b>"Pause 1 Cycle"</b>, or <b>"Keep ₹249"</b>.<br>
                        Click below and tap <b>"Allow"</b> when prompted by your browser.
                    </div>
                    <button class="main" onclick="triggerBrowserMicPrompt()" style="margin-bottom:8px;background:#be185d;color:#fff;border-color:#be185d;display:flex;align-items:center;justify-content:center;gap:8px">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                            <line x1="12" x2="12" y1="19" y2="22"></line>
                        </svg>
                        <span>Enable Microphone</span>
                    </button>
                    <button class="out" style="width:100%;padding:9px;font-size:12px" onclick="isMicModalVisible=false;renderApp()">
                        Cancel (Use Touch Buttons)
                    </button>
                </div>
            </div>
        `);
    }

    // Update top control panel UPI PIN badge
    const topPinValElem = document.getElementById("top-pin-val");
    if (topPinValElem) {
        topPinValElem.textContent = activeUserUpiPin;
    }

    // Refresh icons
    if (window.lucide) {
        lucide.createIcons();
    }
}

// In-App NPCI PIN Smooth Keystroke Handler (Zero Blur / No Destructive Re-render)
function handleUpiPinInput(inputElem) {
    const clean = inputElem.value.replace(/\D/g, '').slice(0, 6);
    inputElem.value = clean;
    enteredUpiPin = clean;

    // Direct DOM toggle on dots: keeps focus inside input box smoothly
    const dots = document.querySelectorAll('.npci-dots .npci-dot');
    dots.forEach((dot, idx) => {
        if (idx < clean.length) {
            dot.classList.add('filled');
        } else {
            dot.classList.remove('filled');
        }
    });

    const errElem = document.getElementById('npci-pin-error');
    if (errElem) errElem.textContent = '';
}

// Auto-fill Registered PIN Helper
function autoFillUpiPin(pin) {
    enteredUpiPin = pin;
    const inputElem = document.getElementById('npci-pin-input');
    if (inputElem) {
        inputElem.value = pin;
        handleUpiPinInput(inputElem);
        inputElem.focus();
    }
}

// In-App Revocation Confirmation API Handler
function handleConfirmInAppRevocation() {
    isRevokingMandate = true;
    renderApp();

    try {
        fetch('/api/mandates/revoke', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': sessionToken ? ('Bearer ' + sessionToken) : '',
                'x-user-id': activeUserId
            },
            body: JSON.stringify({
                merchant: currentBankNotice.m,
                mandate_id: matchedBaseline ? matchedBaseline[0] : currentBankNotice.m,
                upi_pin: enteredUpiPin || activeUserUpiPin,
                phone: enteredMobileNumber,
                user_id: activeUserId,
                auth_protocol: 'NPCI_CL_SANDBOX'
            })
        }).then(r => r.json()).then(data => {
            if (!data.success) {
                isRevokingMandate = false;
                renderApp();
                setTimeout(() => {
                    const errElem = document.getElementById('npci-pin-error');
                    if (errElem) errElem.textContent = data.error || 'Incorrect UPI PIN';
                }, 50);
                return;
            }
            setTimeout(() => {
                isRevokingMandate = false;
                workflowStep = 3;
                lastRevokedTxnId = data.npci_txn_id || ('NPCI-REV-' + Date.now().toString().slice(-6));
                lastRevokedUmn = data.mandate_umn || ('HDFC' + Date.now().toString().slice(-8) + '@upi');
                updateCaptions();
                renderApp();
            }, 750);
        }).catch(() => {
            setTimeout(() => {
                isRevokingMandate = false;
                workflowStep = 3;
                lastRevokedTxnId = 'NPCI-REV-' + Date.now().toString().slice(-6);
                lastRevokedUmn = 'HDFC' + Date.now().toString().slice(-8) + '@upi';
                updateCaptions();
                renderApp();
            }, 750);
        });
    } catch (_) {
        isRevokingMandate = false;
        workflowStep = 3;
        renderApp();
    }
}

// NPCI AutoPay 2.0 Cycle Pause Handler
function handlePauseMandate() {
    workflowStep = 5;
    lastPausedRef = 'NPCI-PAUSE-' + Date.now().toString().slice(-6) + '-' + Math.floor(1000 + Math.random() * 9000);
    updateCaptions();
    renderApp();

    try {
        fetch('/api/mandates/pause', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': sessionToken ? ('Bearer ' + sessionToken) : '',
                'x-user-id': activeUserId
            },
            body: JSON.stringify({
                merchant: currentBankNotice.m,
                phone: enteredMobileNumber,
                user_id: activeUserId,
                pause_cycles: 1
            })
        }).then(r => r.json()).then(data => {
            if (data && data.pause_ref) {
                lastPausedRef = data.pause_ref;
                renderApp();
            }
        }).catch(() => {});
    } catch (_) {}
}

// 24h Inactive Timeout Autonomous Defense Handler
function handleSimulateTimeout() {
    workflowStep = 6;
    lastTimeoutDefense = {
        attempted_amount: newDebitAmount,
        locked_cap: baselineAmount,
        amount_deducted: 0,
        npci_decline_ref: 'NPCI-DECLINE-' + Date.now().toString().slice(-6)
    };
    updateCaptions();
    renderApp();

    try {
        fetch('/api/mandates/simulate-timeout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': sessionToken ? ('Bearer ' + sessionToken) : '',
                'x-user-id': activeUserId
            },
            body: JSON.stringify({
                merchant: currentBankNotice.m,
                phone: enteredMobileNumber,
                user_id: activeUserId
            })
        }).then(r => r.json()).then(data => {
            if (data && data.success) {
                lastTimeoutDefense = data;
                renderApp();
            }
        }).catch(() => {});
    } catch (_) {}
}

// ============================================================================
// DOMAIN GUARDRAILS & NATURAL LANGUAGE INTENT PARSER
// ============================================================================

/**
 * Checks if the user is explicitly speaking English
 * Returns true ONLY if input is English without Hinglish words.
 * Default experience is 100% natural HINDI!
 */
function isUserSpeakingEnglish(text) {
    if (!text) return false;
    if (/[\u0900-\u097F]/.test(text)) return false;
    const hinglishPattern = /\b(roko|rok|rokna|band|karo|chalne|do|rehne|rahne|chalu|kitna|kitne|paisa|paise|kharch|mahina|mahine|koi|kya|kyun|kaisa|kaun|batao|bhai|yaar|haan|ha|nahi|mat|saare|dikhao|theek)\b/i;
    if (hinglishPattern.test(text)) return false;
    const englishFintechPattern = /\b(stop|pause|keep|cancel|pending|alert|alerts|monthly|spends|total|show|list|mandates|subscriptions|yes|no)\b/i;
    return englishFintechPattern.test(text);
}

/**
 * Domain Guardrail Validator
 * Filters out off-topic queries (cricket, weather, politics, jokes, general knowledge, etc.)
 * Strictly protects DebitRadar from out-of-scope interactions
 * Full bilingual support: Devanagari Hindi, Latin English, and Hinglish
 */
function isDebitRadarDomainQuery(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = text.toLowerCase().trim();
    
    const domainPattern = /(subscription|mandate|auto-?pay|auto-?debit|pre-?debit|alert|alerts|hike|price|charge|fee|rate|gst|tax|round-?off|5%|limit|cap|bank|icici|hdfc|sbi|axis|kotak|idfc|npci|upi|pin|2fa|umn|netflix|hotstar|spotify|chatgpt|google|amazon|prime|swiggy|uber|zomato|blinkit|zepto|stop|rok|roko|rokna|cancel|revok|band|hatao|mat|decline|block|reject|pause|pos|cycle|saikil|mahina|month|skip|hold|keep|chalne|rehne|rahne|chalu|ok|theek|spend|total|kharch|paisa|rupee|rs|inr|list|show|saare|active|kitne|kitna|pending|balance|help|madad|haan|yes|ha|nahi|no|nope|sure|1|2|3|one|two|three|ek|do|teen|अलर्ट|पेंडिंग|प्राइस|हाइक|बढ़ा|दाम|फीस|चार्ज|पैसा|पैसे|रुपये|कट|कटेगा|खर्च|टोटल|कुल|मैंडेट|सब्सक्रिप्शन|ऑटोपे|ऑटोडेबिट|डेबिट|बैंक|नेटफ्लिक्स|हॉटस्टार|स्पॉटिफ़ाई|अमेज़न|प्राइम|गूगल|रोको|रोक|रोकना|रोक\s*दो|बंद|हटाओ|कैंसिल|मत\s*काटो|पॉज़|पॉज|साइकिल|महीना|महीने|होल्ड|स्किप|रखो|रहने\s*दो|चालू|चलाओ|ठीक|हाँ|हां|नहीं|मत|मदद|कोई|कितने|कितना|सारे|दिखाओ|सूची)/i;

    return domainPattern.test(clean);
}

/**
 * Natural Conversational Intent Parser
 * Supports free-form phrasing in English, Hindi, and Hinglish in any word order:
 * e.g., "roko netflix", "netflix roko", "stop netflix", "cancel netflix",
 *       "ek mahina rok do", "pause netflix", "chalne do", "keep netflix",
 *       "pending alerts", "koi alert hai", "monthly spends", "how much is debit tomorrow"
 */
function parseVoiceCommandIntent(text) {
    if (!text) return { intent: 'UNKNOWN' };
    const clean = text.toLowerCase().trim();

    // 1. Strict Domain Guardrail check
    if (!isDebitRadarDomainQuery(clean)) {
        return { intent: 'OFF_TOPIC_GUARDRAIL' };
    }

    // 2. PAUSE / TEMPORARY HOLD (Check before stop because "ek mahina rok do" contains "rok")
    // Matches: "pause netflix", "netflix pause", "ek mahina rok do", "ek mahine ke liye roko",
    //          "1 cycle pause", "skip this month", "hold netflix", "pause 1 cycle", "2", "two", "do"
    const hasPauseVerb = /pause|पॉज़|पॉज|pos|pauz|hold|skip|temporary/.test(clean);
    const hasCycleOrMonth = /mahina|month|cycle|saikil|ek\s*mahina|1\s*mahina|ek\s*cycle|1\s*cycle|महीना|महीने|साइकिल/.test(clean);
    const isPauseDigit = /^(2|do|two|दो)$/.test(clean);

    if (hasPauseVerb || (hasCycleOrMonth && /rok|pause|skip|hold|रोक/.test(clean)) || isPauseDigit) {
        return { intent: 'PAUSE_MANDATE', merchant: 'Netflix' };
    }

    // 3. STOP MANDATE (Cancel / Revoke / Stop / Reject)
    // Matches: "roko netflix", "netflix roko", "stop netflix", "netflix stop", "cancel netflix",
    //          "netflix band karo", "band karo netflix", "mat kaato netflix", "decline netflix",
    //          "haan ise roko", "haan roko", "haan", "yes stop it", "yes", "1", "one", "ek"
    const hasStopVerb = /roko|rok|rokna|stop|cancel|revok|band|bandh|hatao|mat\s*kaato|decline|block|reject|रोको|रोक|रोकना|बंद|हटाओ|कैंसिल|मत\s*काटो/.test(clean);
    const hasStopAffirmative = /^(haan|हाँ|हां|yes|yep|sure|rok\s*do|band\s*kar\s*do|rokna\s*chahta|rokna\s*chahti|cancel\s*kar\s*do|रोक\s*दो|बंद\s*करो|हाँ\s*रोको)$/.test(clean);
    const isStopDigit = /^(1|ek|one|एक)$/.test(clean);
    const isStopWithTarget = /(netflix|hotstar|spotify|mandate|subscription|payment|ise|isko|नेटफ्लिक्स|मैंडेट)/.test(clean) && hasStopVerb;

    if (hasStopAffirmative || isStopDigit || isStopWithTarget || hasStopVerb) {
        return { intent: 'STOP_MANDATE', merchant: 'Netflix' };
    }

    // 4. KEEP MANDATE (Accept price hike / Continue at new rate)
    // Matches: "keep netflix", "netflix keep", "chalne do", "netflix chalne do", "rehne do", "rahne do",
    //          "chalu rakho", "theek hai chalne do", "accept price", "approve hike", "nahi mat roko", "3", "three", "teen"
    const hasKeepVerb = /keep|chalne\s*do|rehne\s*do|rahne\s*do|chalu|chalao|theek\s*hai|chalega|ok|allow|approve|accept|रखो|रख|चालू|रहने\s*दो|ठीक\s*है|चलाओ/.test(clean);
    const hasKeepNegative = /^(nahi|no|nope|mat\s*roko|nahi\s*rokna|don't\s*stop|नहीं|मत\s*रोको)$/.test(clean);
    const isKeepDigit = /^(3|teen|three|तीन)$/.test(clean);

    if (hasKeepVerb || hasKeepNegative || isKeepDigit) {
        return { intent: 'KEEP_MANDATE', merchant: 'Netflix' };
    }

    // 5. PENDING ALERTS
    // Matches: "pending alerts", "any alerts", "kitne alert", "kya koi alert", "koi alert hai", "hike alert", "check alerts"
    if (/alert|अलर्ट|pending|पेंडिंग|kitne|कितने|बढ़ा|hike|any\s*alert|check\s*alert|koi|कोई/.test(clean)) {
        return { intent: 'PENDING_ALERTS' };
    }

    // 6. MONTHLY SPENDS / Total
    // Matches: "monthly spends", "how much spend", "kitna paisa", "total kharch", "budget"
    if (/kitna|kharch|paisa|spend|month|total|कुल|खर्च|पैसा|budget|कितना|रुपये/.test(clean)) {
        return { intent: 'MONTHLY_TOTAL' };
    }

    // 7. LIST MANDATES
    // Matches: "show mandates", "list subscriptions", "saare auto-debit", "active mandates"
    if (/saare|सारे|list|दिखाओ|auto-?debit|mandate|show|subscriptions|सूची/.test(clean)) {
        return { intent: 'LIST_MANDATES' };
    }

    return { intent: 'FALLBACK' };
}

// ============================================================================
// GLOBAL AI VOICE COPILOT CONTROLLER
// ============================================================================

function renderCopilotBanner() {
    if (!isCopilotActive) return ""; // Clean toggle support

    let alertHeadline = 'Ask: "Pending alerts?", "Stop Netflix", or "Monthly spends"';
    if (workflowStep === 1 && isHike) {
        alertHeadline = `🔔 1 Pending Alert: ${escapeHtml(currentBankNotice.m)} ₹${baselineAmount} ➔ ₹${newDebitAmount} (${hikePercent}% hike)`;
    }

    return `
        <div class="copilot-banner">
            <div class="copilot-top" onclick="toggleGlobalVoiceCopilot()">
                <div class="copilot-mic-orb ${isCopilotListening ? 'listening' : ''}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                        <line x1="12" x2="12" y1="19" y2="22"></line>
                    </svg>
                </div>
                <div style="flex:1;min-width:0">
                    <div style="display:flex;align-items:center;justify-content:space-between">
                        <b style="font-size:12px;color:#831843">DebitRadar AI Voice Copilot</b>
                        <span class="copilot-status-pill ${isCopilotListening ? 'live' : ''}">${isCopilotListening ? '🔴 Listening...' : '🎙️ Tap to Speak'}</span>
                    </div>
                    <div class="copilot-transcript-view" id="copilot-transcript-view">
                        ${copilotStatusMessage || alertHeadline}
                    </div>
                </div>
            </div>
            <div class="copilot-chips-row">
                <button type="button" class="copilot-chip" onclick="handleCopilotQuery('Any pending alerts?')">🔔 Pending Alerts?</button>
                <button type="button" class="copilot-chip" onclick="handleCopilotQuery('Stop Netflix')">🛑 Stop Netflix</button>
                <button type="button" class="copilot-chip" onclick="handleCopilotQuery('Pause Netflix')">⏸️ Pause 1 Cycle</button>
                <button type="button" class="copilot-chip" onclick="handleCopilotQuery('Monthly spends')">💰 Monthly Spends</button>
            </div>
        </div>
    `;
}

function toggleGlobalVoiceCopilot() {
    if (isCopilotListening) {
        stopCopilotListening();
    } else {
        startCopilotListening();
    }
}

function startCopilotListening() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
        alert("Your browser does not support Web Speech Recognition. Please use Google Chrome or Microsoft Edge.");
        return;
    }

    if (currentPlayingSarvamAudio) {
        currentPlayingSarvamAudio.pause();
        currentPlayingSarvamAudio = null;
    }
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }

    isCopilotListening = true;
    copilotStatusMessage = "माइक चालू है... बोलिए 'कोई अलर्ट है' या 'नेटफ्लिक्स रोको'";
    renderApp();

    try {
        if (!copilotRecognitionInstance) {
            copilotRecognitionInstance = new SpeechRec();
            copilotRecognitionInstance.continuous = false;
            copilotRecognitionInstance.interimResults = true;
            copilotRecognitionInstance.lang = 'hi-IN';
        }

        copilotRecognitionInstance.onresult = (event) => {
            const results = event.results;
            const latest = results[results.length - 1];
            const transcript = latest[0].transcript.trim();
            const elem = document.getElementById('copilot-transcript-view');
            if (elem) elem.innerHTML = `सुना गया: <b style="color:#be185d">"${escapeHtml(transcript)}"</b>`;

            if (latest.isFinal || event.resultIndex >= 0) {
                setTimeout(() => {
                    handleCopilotQuery(transcript);
                }, 300);
            }
        };

        copilotRecognitionInstance.onerror = (err) => {
            console.warn('[Copilot mic error]:', err.error);
            isCopilotListening = false;
            copilotStatusMessage = "आवाज़ सुनाई नहीं दी। नीचे किसी भी चिप पर टैप करें।";
            renderApp();
        };

        copilotRecognitionInstance.onend = () => {
            isCopilotListening = false;
            renderApp();
        };

        copilotRecognitionInstance.start();
    } catch (e) {
        console.error('Copilot start error:', e);
        isCopilotListening = false;
    }
}

function stopCopilotListening() {
    isCopilotListening = false;
    if (copilotRecognitionInstance) {
        try { copilotRecognitionInstance.stop(); } catch (_) {}
    }
    renderApp();
}

async function handleCopilotQuery(queryText) {
    stopCopilotListening();
    const clean = queryText.toLowerCase().trim();
    console.log('[Copilot Query Executing]:', clean);

    const parsed = parseVoiceCommandIntent(clean);
    console.log('[NLP Parsed Intent]:', parsed);

    const isEnglish = isUserSpeakingEnglish(clean);
    let replyVoice = "";

    // DOMAIN GUARDRAIL: Strict filter on off-topic questions
    if (parsed.intent === 'OFF_TOPIC_GUARDRAIL') {
        replyVoice = isEnglish
            ? "I am your DebitRadar Assistant. I can only assist with your subscriptions, pre-debit price hike alerts, and AutoPay mandates. Please ask a relevant query."
            : "माफ़ कीजिए, मैं केवल आपके डेबिटराडार सब्सक्रिप्शन, प्राइस हाइक अलर्ट और ऑटोपे मैंडेट्स से जुड़े सवालों के जवाब दे सकता हूँ। कृपया संबंधित सवाल पूछें।";
        
        copilotStatusMessage = "🛡️ Guardrail: Please ask about subscriptions, price hikes, or mandates.";
        renderApp();
        speakFeedback(replyVoice);
        return;
    }

    if (parsed.intent === 'PENDING_ALERTS') {
        workflowStep = 1; // Show price hike alert on screen
        replyVoice = isEnglish
            ? "Warning! 1 price hike alert pending — Netflix monthly fee increased from 199 rupees to 249 rupees, a 25 percent hike. You can say 'Stop Netflix', 'Pause for 1 month', or 'Keep 249'."
            : "सावधान! आपके खाते में 1 प्राइस हाइक अलर्ट पेंडिंग है — नेटफ्लिक्स का मासिक शुल्क 199 रुपये से बढ़कर 249 रुपये हो गया है, यानी 25 प्रतिशत की बढ़ोतरी। आप सीधे बोल सकते हैं: 'नेटफ्लिक्स रोको', 'एक महीना पॉज़ करो', या 'चालू रहने दो'। बोलिए, क्या करना चाहते हैं?";
        copilotStatusMessage = "🔔 1 Pending Alert: Netflix ₹199 ➔ ₹249 (25% hike)";
        renderApp();
        speakFeedback(replyVoice, () => {
            // As soon as AI finishes speaking, open the mic and listen naturally!
            startIvrListening(false);
        });
        return;
    }

    if (parsed.intent === 'STOP_MANDATE') {
        enteredUpiPin = '';
        workflowStep = 2; // Open NPCI Common Library 2FA screen
        renderApp();
        replyVoice = isEnglish
            ? "Initiating mandate revocation. Please authenticate with your 6-digit UPI PIN."
            : "नेटफ्लिक्स मैंडेट रोकने की प्रक्रिया शुरू की जा रही है। कृपया अपना 6 अंकों का UPI पिन दर्ज करें।";
        copilotStatusMessage = "🛑 Initiating NPCI 2FA Revocation Sheet...";
    } else if (parsed.intent === 'PAUSE_MANDATE') {
        handlePauseMandate(); // Execute AutoPay 2.0 pause
        replyVoice = isEnglish
            ? "Netflix mandate paused for 1 billing cycle. Tomorrow's debit of ₹249 is blocked."
            : "नेटफ्लिक्स मैंडेट को 1 बिलिंग साइकिल के लिए पॉज़ कर दिया गया है। कल ₹249 का डेबिट रोक दिया जाएगा।";
        copilotStatusMessage = "⏸️ Mandate Paused for 1 Billing Cycle";
    } else if (parsed.intent === 'KEEP_MANDATE') {
        handleKeepPayment();
        replyVoice = isEnglish
            ? "New baseline accepted: ₹249 is now registered. Future debits at ₹249 will not alert."
            : "नया बेसलाइन प्लान ₹249 स्वीकार कर लिया गया है। भविष्य में ₹249 पर कोई अलर्ट नहीं आएगा।";
        copilotStatusMessage = "✅ New Baseline ₹249 Accepted";
    } else if (parsed.intent === 'MONTHLY_TOTAL') {
        replyVoice = isEnglish
            ? "Estimated total recurring commitments for this month is approximately ₹766."
            : "इस महीने आपके खाते से कुल लगभग ₹766 के ऑटोपे भुगतानों का अनुमान है।";
        copilotStatusMessage = "💰 Estimated Monthly Spends: ~₹766";
    } else if (parsed.intent === 'LIST_MANDATES') {
        workflowStep = 0;
        renderApp();
        replyVoice = isEnglish
            ? "You have 4 active recurring mandates: Netflix, Disney+ Hotstar, and Spotify."
            : "आपके खाते में कुल 4 एक्टिव ऑटो-डेबिट मैंडेट्स चल रहे हैं: नेटफ्लिक्स ₹199, हॉटस्टार ₹299, और स्पॉटिफ़ाई ₹119।";
        copilotStatusMessage = "📋 4 Active Auto-Debits displayed";
    } else {
        // Fallback to backend /api/sarvam/command
        try {
            const res = await fetch('/api/sarvam/command', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': sessionToken ? ('Bearer ' + sessionToken) : '',
                    'x-user-id': activeUserId
                },
                body: JSON.stringify({ transcript: queryText })
            });
            const data = await res.json();
            replyVoice = (data && data.default_reply) || (data && (isEnglish ? data.response_english : data.response_hindi)) || "मैं आपका सब्सक्रिप्शन सहायक हूँ। आप बोल सकते हैं: 'नेटफ्लिक्स रोको' या 'अलर्ट्स दिखाओ'।";
            copilotStatusMessage = replyVoice;
        } catch (_) {
            replyVoice = isEnglish
                ? "I am your DebitRadar Assistant. You can say: 'Stop Netflix', 'Pause 1 cycle', or 'Pending alerts'."
                : "मैं आपका सब्सक्रिप्शन सहायक हूँ। आप बोल सकते हैं: 'नेटफ्लिक्स रोको' या 'अलर्ट्स दिखाओ'।";
            copilotStatusMessage = replyVoice;
        }
    }

    renderApp();
    speakFeedback(replyVoice);
}

// Voice Engine Mode Controller & Audio Playback
let currentPlayingSarvamAudio = null;

function setVoiceEngineMode(mode) {
    activeVoiceEngine = mode;
    const badge = document.getElementById('voice-engine-badge');
    const btnOffline = document.getElementById('btn-mode-offline');
    const btnSarvam = document.getElementById('btn-mode-sarvam');

    if (mode === 'offline') {
        if (badge) {
            badge.innerText = '🟢 Offline Device (Zero Lag / No Wi-Fi)';
            badge.className = 'voice-active-badge offline';
        }
        if (btnOffline) btnOffline.classList.add('active');
        if (btnSarvam) btnSarvam.classList.remove('active');
    } else {
        if (badge) {
            badge.innerText = '⚡ Sarvam AI Neural Cloud (Bulbul v4)';
            badge.className = 'voice-active-badge sarvam';
        }
        if (btnOffline) btnOffline.classList.remove('active');
        if (btnSarvam) btnSarvam.classList.add('active');
    }
    renderApp();
}

function handleSmartVoiceToggle(m, oldP, newP, pct) {
    if (isIvrListening) {
        stopIvrListening();
    } else {
        handleVoiceAlertClick(m, oldP, newP, pct);
    }
}

function toggleUserProfileDrawer() {
    isProfileDrawerVisible = !isProfileDrawerVisible;
    renderApp();
}

function handleLogout() {
    workflowStep = -1;
    onboardingStep = 0;
    sessionToken = "";
    activeUserId = "";
    enteredMobileNumber = "";
    enteredOtpCode = "";
    enteredUpiPin = "";
    isProfileDrawerVisible = false;
    renderApp();
}

async function handleVoiceAlertClick(merchant, oldAmount, newAmount, hikePct) {
    const btn = document.getElementById('btn-smart-mic');
    const m = merchant || currentBankNotice.m;
    const oldP = oldAmount || baselineAmount;
    const newP = newAmount || newDebitAmount;
    const pct = hikePct || hikePercent;

    // Pre-request microphone access on direct user gesture so browser prompts for permission
    if (!hasMicPermissionGranted && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
            stream.getTracks().forEach(t => t.stop());
            hasMicPermissionGranted = true;
        }).catch(() => {});
    }
    
    // Natural Conversational Prompt: Clean natural Hindi by default without confusing "plus 25%"
    const roundedPct = Math.round(Number(pct) || 25);
    const hindiNotice = `सावधान! ${m} का मासिक शुल्क ${oldP} रुपये से बढ़कर ${newP} रुपये हो गया है, यानी ${roundedPct} प्रतिशत की बढ़ोतरी। आप सीधे बोल सकते हैं: '${m} रोको', 'एक महीना पॉज़ करो', या 'चालू रहने दो'। बोलिए, क्या करना चाहते हैं?`;

    // Stop previous audio if playing
    if (currentPlayingSarvamAudio) {
        currentPlayingSarvamAudio.pause();
        currentPlayingSarvamAudio = null;
    }
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }

    if (activeVoiceEngine === 'offline') {
        // MODE 1: OFFLINE DEVICE SPEECH (Zero network call, 0ms latency, works without Wi-Fi)
        if ('speechSynthesis' in window) {
            if (btn) btn.innerHTML = '<span>🔊 बोल रहा है... सुनिए</span>';
            const cleanNotice = sanitizeSpeechText(hindiNotice);
            const utter = new SpeechSynthesisUtterance(cleanNotice);
            utter.lang = 'hi-IN';
            utter.rate = 0.95;
            utter.onend = () => {
                // Automatically open mic to listen for user command naturally
                startIvrListening(false);
            };
            utter.onerror = () => {
                startIvrListening(false);
            };
            window.speechSynthesis.speak(utter);
        } else {
            alert(hindiNotice);
            startIvrListening(false);
        }
    } else {
        // MODE 2: SARVAM AI CLOUD ENGINE (Bulbul v4-flash / Sanchita Banking Neural)
        if (btn) btn.innerHTML = '<span>⏳ Sarvam AI कनेक्ट हो रहा है...</span>';
        try {
            const res = await fetch('/api/sarvam/alert', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': sessionToken ? ('Bearer ' + sessionToken) : '',
                    'x-user-id': activeUserId
                },
                body: JSON.stringify({
                    merchant: m,
                    old_amount: oldP,
                    new_amount: newP,
                    hike_pct: pct
                })
            });
            const data = await res.json();
            if (data && data.success && data.audio_base64) {
                const snd = new Audio(`data:audio/wav;base64,${data.audio_base64}`);
                currentPlayingSarvamAudio = snd;
                if (btn) btn.innerHTML = '<span>⚡ बज रहा है (Sarvam Neural)...</span>';
                snd.onended = () => {
                    startIvrListening(false);
                };
                snd.onerror = () => {
                    startIvrListening(false);
                };
                snd.play().catch(e => {
                    console.log('Audio autoplay prevented:', e);
                    startIvrListening(false);
                });
            } else {
                if ('speechSynthesis' in window) {
                    if (btn) btn.innerHTML = '<span>⚡ बोल रहा है (Sarvam Fallback)...</span>';
                    const utter = new SpeechSynthesisUtterance((data && data.hindi_text) || hindiNotice);
                    utter.lang = 'hi-IN';
                    utter.rate = 0.95;
                    utter.onend = () => {
                        startIvrListening(false);
                    };
                    window.speechSynthesis.speak(utter);
                } else {
                    startIvrListening(false);
                }
            }
        } catch (err) {
            console.error('Sarvam Cloud Error:', err);
            if ('speechSynthesis' in window) {
                const utter = new SpeechSynthesisUtterance(hindiNotice);
                utter.lang = 'hi-IN';
                utter.onend = () => startIvrListening(false);
                window.speechSynthesis.speak(utter);
            } else {
                startIvrListening(false);
            }
        }
    }
}

/**
 * Interactive Speech Recognition IVR Engine
 * Listens for Free-form Natural Speech:
 * - "roko netflix", "stop netflix", "cancel", "haan" -> Revoke Sheet (workflowStep 2)
 * - "pause netflix", "ek mahina rok do", "pause 1 cycle" -> handlePauseMandate() (workflowStep 5)
 * - "keep netflix", "chalne do", "chalu rakho" -> handleKeepPayment() (workflowStep 4)
 * - Unrelated questions -> Politely rejected with Domain Guardrail
 */
function startIvrListening(isDirectClick) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
        alert("Your browser does not support Web Speech Recognition. Please use Google Chrome or Microsoft Edge.");
        return;
    }

    // Stop existing audio prompts
    if (currentPlayingSarvamAudio) {
        currentPlayingSarvamAudio.pause();
        currentPlayingSarvamAudio = null;
    }
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }

    // Check mic permission proactively
    if (!hasMicPermissionGranted && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
            stream.getTracks().forEach(t => t.stop());
            hasMicPermissionGranted = true;
        }).catch(err => {
            console.warn('Microphone permission needed:', err);
            isMicModalVisible = true;
            renderApp();
        });
    }

    isIvrListening = true;
    ivrStatusMessage = "माइक चालू है... बोलिए 'नेटफ्लिक्स रोको', 'पॉज़' या 'चलने दो'";
    renderApp();

    try {
        if (!speechRecognitionInstance) {
            speechRecognitionInstance = new SpeechRec();
            speechRecognitionInstance.continuous = true;
            speechRecognitionInstance.interimResults = true;
            speechRecognitionInstance.lang = 'hi-IN'; // Multi-lingual Indian acoustic model
        }

        speechRecognitionInstance.onresult = (event) => {
            const results = event.results;
            const latest = results[results.length - 1];
            const transcript = latest[0].transcript.trim();
            console.log('[IVR HEARD]:', transcript);

            const displayElem = document.getElementById('ivr-live-transcript');
            if (displayElem) {
                displayElem.innerHTML = `सुना गया: <b style="color:#be185d">"${escapeHtml(transcript)}"</b>`;
            }

            const isEnglish = isUserSpeakingEnglish(transcript);
            const parsed = parseVoiceCommandIntent(transcript);
            console.log('[IVR Parsed Intent]:', parsed, 'isEnglish:', isEnglish);

            // DOMAIN GUARDRAIL: Reject off-topic banter
            if (parsed.intent === 'OFF_TOPIC_GUARDRAIL') {
                const guardrailVoice = isEnglish
                    ? "I can only assist with your subscriptions, pre-debit price hike alerts, and AutoPay mandates. Please ask a relevant query."
                    : "माफ़ कीजिए, मैं केवल आपके डेबिटराडार सब्सक्रिप्शन, प्राइस हाइक अलर्ट और ऑटोपे मैंडेट्स से जुड़े सवालों के जवाब दे सकता हूँ।";
                if (displayElem) displayElem.innerHTML = `🛡️ <b>Guardrail:</b> Unrelated query ignored.`;
                speakFeedback(guardrailVoice);
                return;
            }

            if (parsed.intent === 'STOP_MANDATE') {
                stopIvrListening();
                speakFeedback(isEnglish ? "Stopping Netflix mandate. Please authorize with your 6-digit UPI PIN..." : "आदेश प्राप्त हुआ: नेटफ्लिक्स मैंडेट रोकने की प्रक्रिया शुरू की जा रही है...");
                setTimeout(() => {
                    enteredUpiPin = '';
                    workflowStep = 2;
                    renderApp();
                }, 800);
            } else if (parsed.intent === 'PAUSE_MANDATE') {
                stopIvrListening();
                speakFeedback(isEnglish ? "Pausing Netflix mandate for 1 billing cycle..." : "आदेश प्राप्त हुआ: नेटफ्लिक्स मैंडेट को 1 महीने के लिए पॉज़ किया जा रहा है...");
                setTimeout(() => {
                    handlePauseMandate();
                }, 800);
            } else if (parsed.intent === 'KEEP_MANDATE') {
                stopIvrListening();
                speakFeedback(isEnglish ? "New plan of ₹249 accepted as baseline..." : "आदेश प्राप्त हुआ: नया प्लान ₹249 बेसलाइन पर सेव कर लिया गया है...");
                setTimeout(() => {
                    handleKeepPayment();
                }, 800);
            } else if (parsed.intent === 'PENDING_ALERTS') {
                workflowStep = 1;
                renderApp();
                speakFeedback(isEnglish ? "1 price hike alert pending for Netflix: 199 rupees to 249 rupees, a 25 percent hike. Say 'Stop Netflix' or 'Pause 1 cycle'." : "सावधान! आपके खाते में 1 अलर्ट पेंडिंग है: नेटफ्लिक्स का बिल 199 रुपये से बढ़कर 249 रुपये हो गया है, यानी 25 प्रतिशत की बढ़ोतरी। बोलिए 'नेटफ्लिक्स रोको' या 'पॉज़ करो'।");
            }
        };

        speechRecognitionInstance.onerror = (err) => {
            console.warn('[IVR Speech Recognition Error]:', err.error);
            if (err.error === 'not-allowed' || err.error === 'service-not-allowed') {
                isMicModalVisible = true;
                ivrStatusMessage = "माइक की अनुमति नहीं मिली। कृपया स्क्रीन पर Allow करें।";
                renderApp();
            }
        };

        speechRecognitionInstance.onend = () => {
            if (isIvrListening) {
                // Loop listening until user takes an action or clicks cancel
                try { speechRecognitionInstance.start(); } catch (_) {}
            }
        };

        try {
            speechRecognitionInstance.start();
        } catch (startErr) {
            console.warn('Speech recognition start failed:', startErr);
            if (!hasMicPermissionGranted) {
                isMicModalVisible = true;
                renderApp();
            }
        }

    } catch (e) {
        console.error('Speech recognition init error:', e);
        isMicModalVisible = true;
        renderApp();
    }
}

function stopIvrListening() {
    isIvrListening = false;
    ivrStatusMessage = "";
    if (speechRecognitionInstance) {
        try { speechRecognitionInstance.stop(); } catch (_) {}
    }
    renderApp();
}

function sanitizeSpeechText(text) {
    if (!text) return "";
    return text
        .replace(/\(\s*\+?\s*([0-9.]+)\s*%\s*\)/gi, 'यानी $1 प्रतिशत की बढ़ोतरी')
        .replace(/\+\s*([0-9.]+)\s*%/gi, '$1 प्रतिशत की बढ़ोतरी')
        .replace(/\+/g, '') // remove any stray '+' symbol so TTS NEVER says "plus"
        .replace(/₹\s*([0-9]+)/g, '$1 रुपये') // pronounce ₹249 as "249 रुपये"
        .replace(/➔|->|→/g, 'से बढ़कर')
        .replace(/·/g, ', ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function speakFeedback(text, onEndCallback) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const cleanSpeech = sanitizeSpeechText(text);
        const u = new SpeechSynthesisUtterance(cleanSpeech);
        u.lang = 'hi-IN';
        u.rate = 1.0;
        let callbackFired = false;
        u.onend = () => {
            if (!callbackFired) {
                callbackFired = true;
                if (typeof onEndCallback === 'function') onEndCallback();
            }
        };
        u.onerror = () => {
            if (!callbackFired) {
                callbackFired = true;
                if (typeof onEndCallback === 'function') onEndCallback();
            }
        };
        window.speechSynthesis.speak(u);
    } else {
        if (typeof onEndCallback === 'function') onEndCallback();
    }
}

async function triggerBrowserMicPrompt() {
    try {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());
            hasMicPermissionGranted = true;
            isMicModalVisible = false;
            renderApp();
            startIvrListening(true);
        }
    } catch (err) {
        alert("माइक की अनुमति ब्लॉक है। कृपया ब्राउज़र URL बार में 🔒 या 🎙️ आइकॉन पर क्लिक करके 'Allow' करें।");
        isMicModalVisible = false;
        renderApp();
    }
}

function handleKeepPayment() {
    workflowStep = 4;
    if (matchedBaseline) {
        matchedBaseline[1] = newDebitAmount; // Update baseline in memory (₹199 -> ₹249)
    }
    baselineAmount = newDebitAmount;
    updateCaptions();
    renderApp();

    try {
        fetch('/api/decisions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': sessionToken ? ('Bearer ' + sessionToken) : '',
                'x-user-id': activeUserId
            },
            body: JSON.stringify({
                alert_id: 'alt_' + activeUserId + '_' + currentBankNotice.m.toLowerCase(),
                action: 'keep',
                merchant: currentBankNotice.m,
                new_amount: newDebitAmount,
                user_id: activeUserId,
                phone: enteredMobileNumber
            })
        }).catch(() => {});
    } catch (_) {}
}

// Action button triggers
$("#alert").onclick = () => {
    workflowStep = 1;
    renderApp();
    if (isHike && isAutoVoiceAnnounceEnabled) {
        setTimeout(() => {
            handleVoiceAlertClick(currentBankNotice.m, baselineAmount, newDebitAmount, hikePercent);
        }, 300);
    }
};

$("#out").onclick = () => {
    workflowStep = -1;
    onboardingStep = 0;
    sessionToken = "";
    activeUserId = "";
    enteredMobileNumber = "";
    enteredOtpCode = "";
    enteredUpiPin = "";
    activeUserUpiPin = "";
    selectedBankFlags = [1, 1, 0, 0, 0, 0, 0, 0];
    notificationChannels = { popup: 1, push: 1, email: 1 };
    validationErrorMessage = "";
    renderApp();
};

// Regulatory Matrix Collapsible Controller
function toggleGovMatrix() {
    const box = document.getElementById('gov-matrix-box');
    const text = document.getElementById('gov-toggle-text');
    if (!box) return;
    const isHidden = box.style.display === 'none';
    box.style.display = isHidden ? 'block' : 'none';
    if (text) {
        text.textContent = isHidden ? 'Hide Shields ▲' : 'View Active Shields ▼';
    }
}

// Initial App Render
renderApp();
