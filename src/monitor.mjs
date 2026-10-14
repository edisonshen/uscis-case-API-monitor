import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const cwd = process.cwd();
const stateDir = path.join(cwd, "state");
const snapshotsDir = path.join(cwd, "snapshots");
const authFile = path.join(stateDir, "auth.json");
const lastFile = path.join(stateDir, "last.json");
const configFile = path.join(cwd, "config.local.json");
const exampleConfigFile = path.join(cwd, "config.example.json");

const LOGIN_EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name*="email" i]',
  'input[name*="username" i]',
  'input[id*="username" i]',
  'input[id*="email" i]',
  'input[placeholder*="email" i]',
  'input[placeholder*="username" i]',
  'input[autocomplete="username"]',
  'input[type="text"]',
];

const LOGIN_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name*="password" i]',
  'input[autocomplete="current-password"]',
];

const OTP_INPUT_SELECTORS = [
  '#secure-verification-code',
  '[data-testid="test-secure-verification-code"]',
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[inputmode="numeric"]',
  'input[type="tel"]',
];

const BUTTON_TEXTS = [/sign in/i, /log in/i, /submit/i, /continue/i, /verify/i];

function ensureDirs() {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(snapshotsDir, { recursive: true });
}

function loadConfig() {
  const source = fs.existsSync(configFile) ? configFile : exampleConfigFile;
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function loginIdentifier(config) {
  return config.uscisUsername || config.uscisEmail;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function isVerificationPageUrl(url) {
  const lower = url.toLowerCase();
  return lower.includes("verification") || lower.includes("two-factor") || lower.includes("2fa");
}

async function firstVisible(page, selectors, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        const visible = await locator.isVisible().catch(() => false);
        if (visible) {
          return locator;
        }
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function firstVisibleInPageOrFrames(page, selectors, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const fromPage = await firstVisible(page, selectors, 500);
    if (fromPage) {
      return fromPage;
    }
    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const locator = frame.locator(selector).first();
        if (await locator.count()) {
          const visible = await locator.isVisible().catch(() => false);
          if (visible) {
            return locator;
          }
        }
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function clickButton(page, regexes) {
  const preferredSelectors = [
    '[data-testid="sign-in-btn"]',
    '#sign-in-btn',
    'button[id="sign-in-btn"]',
  ];
  
  // Try preferred selectors first
  for (const selector of preferredSelectors) {
    const button = page.locator(selector).first();
    if (await button.count() && await button.isVisible().catch(() => false)) {
      console.log(`    Found button: ${selector}`);
      await button.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  
  // Try by text/role
  for (const regex of regexes) {
    const button = page.getByRole("button", { name: regex }).first();
    if (await button.count()) {
      console.log(`    Found button by role: ${regex}`);
      await button.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
    
    const input = page.locator('input[type="submit"], button').filter({ hasText: regex }).first();
    if (await input.count()) {
      console.log(`    Found submit by text: ${regex}`);
      await input.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  
  return false;
}

async function waitForPostSubmitChange(page, timeout = 5000) {
  const startUrl = page.url();
  const startHtml = await page.content().catch(() => "");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const currentUrl = page.url();
    if (currentUrl !== startUrl) {
      return true;
    }
    const currentHtml = await page.content().catch(() => "");
    if (currentHtml !== startHtml) {
      return true;
    }
  }
  return false;
}

function readOtp(otpConfig) {
  const mode = otpConfig?.mode || "imap";
  
  if (mode === "imap") {
    // Use IMAP email mode
    if (!otpConfig) {
      throw new Error("OTP config required for IMAP mode");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        "python3",
        [path.join("src", "email_otp.py"), "--config-json", JSON.stringify(otpConfig)],
        {
          cwd,
          stdio: ["ignore", "pipe", "inherit"],
        },
      );

      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error("Failed to read OTP from email"));
          return;
        }
        resolve(stdout.trim());
      });
    });
  } else if (mode === "sms-imessage") {
    // Use macOS Messages (iMessage) mode
    if (!otpConfig) {
      throw new Error("OTP config required for SMS/iMessage mode");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        "python3",
        [path.join("src", "sms_imessage.py"), "--config-json", JSON.stringify(otpConfig)],
        {
          cwd,
          stdio: ["ignore", "pipe", "inherit"],
        },
      );

      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          // Exit 3 = the Python reader hit a Full Disk Access denial on
          // chat.db (see sms_imessage.py). Tag it so the scheduler pauses OTP
          // retries instead of fast-retrying — a permission error can't be
          // fixed by retrying and each retry triggers another USCIS text.
          const err = new Error(
            code === 3
              ? "Full Disk Access denied reading Messages database"
              : "Failed to read OTP from SMS/iMessage",
          );
          if (code === 3) err.code = "OTP_PERMISSION_DENIED";
          reject(err);
          return;
        }
        resolve(stdout.trim());
      });
    });
  } else {
    throw new Error(`Unsupported OTP mode: ${mode}`);
  }
}

// Legacy function for backward compatibility
function readOtpFromEmail(otpConfig) {
  return readOtp(otpConfig);
}

function normalizeOtp(rawCode) {
  const digitsOnly = String(rawCode || "").replace(/\D+/g, "");
  if (digitsOnly.length >= 6) {
    return digitsOnly.slice(0, 6);
  }
  return String(rawCode || "").trim();
}

async function typeLikeHuman(locator, value) {
  await locator.focus().catch(() => {});
  await locator.click({ clickCount: 3 }).catch(() => {});
  await locator.press("Backspace").catch(() => {});
  for (const char of String(value)) {
    await locator.type(char, { delay: 90 + Math.floor(Math.random() * 80) }).catch(async () => {
      await locator.fill(String(value)).catch(() => {});
    });
  }

  // Some React forms only validate after input/change/blur events.
  await locator.evaluate((node) => {
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    node.dispatchEvent(new Event("blur", { bubbles: true }));
  }).catch(() => {});
}

async function waitForOtpPostSubmit(page, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const stillOnOtp = await firstVisibleInPageOrFrames(page, OTP_INPUT_SELECTORS, 300);
    if (!stillOnOtp) {
      return true;
    }
  }
  return false;
}

async function looksLoggedOut(page) {
  const url = page.url().toLowerCase();
  if (isVerificationPageUrl(url)) {
    return false;
  }
  if (url.includes("/oidc/login") || url.includes("/oauth/authorize")) {
    return true;
  }
  for (const selector of [...LOGIN_EMAIL_SELECTORS, ...LOGIN_PASSWORD_SELECTORS]) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const visible = await locator.isVisible().catch(() => false);
      if (visible) {
        return true;
      }
    }
  }
  return false;
}

async function fillFirst(page, selectors, value) {
  const input = await firstVisibleInPageOrFrames(page, selectors);
  if (!input) {
    const summary = await pageSummary(page);
    await writeDebugSnapshot(page, "missing-input");
    throw new Error(
      `Could not find input for selectors: ${selectors.join(", ")}\nURL: ${summary.url}\nTitle: ${summary.title}\nHeading: ${summary.heading}\nAlert: ${summary.alert}\nText: ${summary.text.slice(0, 300)}`,
    );
  }
  await input.fill(value);
}

async function pageSummary(page) {
  const summary = await page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1000);
    const heading = document.querySelector("h1,h2,h3")?.textContent?.trim() || "";
    const alert =
      document.querySelector('[role="alert"], .usa-alert, .alert, .error, [data-testid*="error" i]')?.textContent?.trim() || "";
    return {
      title: document.title,
      heading,
      alert,
      text,
    };
  });
  return {
    url: page.url(),
    ...summary,
  };
}

async function writeDebugSnapshot(page, label) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const base = path.join(snapshotsDir, `${stamp}-${label}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  if (html) {
    fs.writeFileSync(`${base}.html`, html, "utf8");
  }
  return base;
}

// Force-wake Messages.app HARD so iMessage Continuity flushes the relayed
// USCIS SMS into chat.db before the Python poller reads it. A backgrounded
// `open -g -a Messages` proved too weak (2026-06-05 incident: imagent
// deferred the disk write ~2.5h on an awake Mac). Instead:
//   1. osascript activate  — foreground the app so it un-naps
//   2. killall -CONT Messages imagent — resume any App-Nap-suspended process
// All steps are best-effort: errors are swallowed, the function never throws.
async function wakeMessages() {
  const spawnQuiet = (cmd, args) =>
    new Promise((resolve) => {
      try {
        const child = spawn(cmd, args, { stdio: "ignore" });
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      } catch {
        resolve();
      }
    });

  await spawnQuiet("osascript", ["-e", 'tell application "Messages" to activate']);
  // -CONT resumes any App-Nap-suspended Messages/imagent process. These exit
  // non-zero when the process is not running; stdio:"ignore" + the error
  // handler keep that quiet.
  await spawnQuiet("killall", ["-CONT", "Messages", "imagent"]);
}

async function maybeHandleOtp(page, config) {
  console.log("  Finding OTP input field...");
  const otpInput = page.locator(OTP_INPUT_SELECTORS.join(", ")).first();
  const visible = await otpInput.isVisible().catch(() => false);
  if (!visible) {
    console.log("  No OTP input field found");
    return false;
  }

  try {
    const mode = config.otp?.mode || "imap";
    const modeLabel = mode === "sms-imessage" ? "SMS/iMessage" : "email";
    console.log(`  Mode: ${modeLabel}`);
    
    // Validate OTP config exists
    if (!config.otp) {
      throw new Error("OTP configuration not found");
    }
    
    // Force-wake Messages.app so iMessage Continuity starts syncing from the
    // iPhone before the Python OTP poll opens chat.db. m.date in chat.db is
    // the SMS origin time, not the local insert time — if Messages.app is
    // suspended, the row can be missing from chat.db for hours.
    if (mode === "sms-imessage") {
      console.log("  Force-waking Messages.app (hard) for iMessage Continuity sync...");
      await wakeMessages();
      await page.waitForTimeout(2000);
    }

    console.log(`  Reading OTP code from ${modeLabel}...`);
    const rawCode = await readOtp(config.otp);
    const code = normalizeOtp(rawCode);
    console.log(`  ✓ Code retrieved: ${code.substring(0, 2)}***`);

    console.log(`  Filling code into input...`);
    await otpInput.fill(code).catch(() => {});
    await otpInput.evaluate((node) => {
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }).catch(() => {});
    
    await page.waitForTimeout(500);
    await writeDebugSnapshot(page, "otp-filled");

    // Try multiple submit methods
    console.log(`  Submitting code...`);
    
    // Method 1: Look for explicit submit button
    const submitBtn = page.locator('button, input[type="submit"]').filter({ hasText: /submit|verify|continue/i }).first();
    if (await submitBtn.count()) {
      console.log("    Clicking submit button...");
      await submitBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
      
      if (await waitForOtpPostSubmit(page, 8000)) {
        console.log("  ✓ OTP accepted");
        return true;
      }
    }

    // Method 2: Press Enter
    console.log("    Trying Enter key...");
    await otpInput.press("Enter").catch(() => {});
    await page.waitForTimeout(1000);
    
    if (await waitForOtpPostSubmit(page, 8000)) {
      console.log("  ✓ OTP accepted");
      return true;
    }

    console.log("  ✓ OTP submitted (may still be processing)");
    return true;
  } catch (error) {
    console.error(`  ✗ OTP error: ${error.message}`);
    throw error;
  }
}

async function submitLogin(page) {
  console.log("Attempting to submit login form...");
  const startUrl = page.url();

  // Try clicking login button (single click only)
  console.log("  Trying to click login button...");
  const clicked = await clickButton(page, [/(sign|log)\s*in/i, /continue/i, /next/i]);
  
  if (!clicked) {
    // Fallback: press Enter on password field
    console.log("  No button found, pressing Enter...");
    const passwordInput = await firstVisibleInPageOrFrames(page, LOGIN_PASSWORD_SELECTORS, 3000);
    if (passwordInput) {
      await passwordInput.press("Enter").catch(() => {});
    } else {
      throw new Error("Cannot find login button or password field to submit");
    }
  }

  // Wait for page navigation or OTP page (up to 15s)
  console.log("  Waiting for page response...");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    
    // Check URL changed
    if (page.url() !== startUrl) {
      console.log("  ✓ Page navigated");
      return;
    }
    
    // Check if OTP input appeared (same URL but different content)
    const otpVisible = await page.locator(OTP_INPUT_SELECTORS.join(", ")).first().isVisible().catch(() => false);
    if (otpVisible) {
      console.log("  ✓ OTP page detected");
      return;
    }
  }

  console.log("  ⚠️ No navigation detected after 15s, continuing anyway...");
}

async function browserWithState(useSavedState) {
  const storageState = useSavedState && fs.existsSync(authFile) ? authFile : undefined;
  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      // Disable detection of being automated
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  const context = await browser.newContext({
    storageState,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'light',
  });
  
  // Stealth mode: hide webdriver property
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
    // Hide chrome detection
    if (window.chrome === undefined) {
      window.chrome = {};
    }
    Object.defineProperty(window, 'chrome', {
      get: () => ({
        runtime: {}
      }),
    });
  });
  
  return { browser, context, page };
}

async function login(config) {
  const { browser, context, page } = await browserWithState(false);
  // Set true if the OTP step failed (read timeout / OTP error). Used to tag
  // the "Login did not stick" throw with code OTP_LOGIN_FAILED so the
  // scheduler can fast-retry instead of waiting 6h.
  let otpFailed = false;
  // Set true when the OTP read failed specifically because macOS denied Full
  // Disk Access to chat.db. Retrying can't fix that (and each retry triggers
  // another USCIS text), so we tag the throw OTP_PERMISSION_DENIED instead —
  // the scheduler pauses retries and notifies once rather than fast-retrying.
  let otpPermissionDenied = false;
  try {
    console.log("Starting login process...");
    console.log(`Navigating to ${config.loginUrl}`);
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000); // Allow time for JavaScript to load
    
    console.log("Filling email/username...");
    await fillFirst(page, LOGIN_EMAIL_SELECTORS, loginIdentifier(config));
    await page.waitForTimeout(500);
    
    console.log("Filling password...");
    await fillFirst(page, LOGIN_PASSWORD_SELECTORS, config.uscisPassword);
    await page.waitForTimeout(500);
    
    await writeDebugSnapshot(page, "login-form-filled");
    console.log("✓ Login form filled");

    // Wake Messages.app BEFORE submitting so iMessage Continuity is already
    // syncing by the time USCIS texts the code — shrinks the relay write lag
    // that otherwise hides the SMS from chat.db for minutes/hours.
    if ((config.otp?.mode || "imap") === "sms-imessage") {
      console.log("Pre-waking Messages.app before submit...");
      await wakeMessages();
    }

    console.log("Submitting login form...");
    await submitLogin(page);
    
    console.log("Waiting for page to load after login...");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(3000);
    await writeDebugSnapshot(page, "after-primary-submit");

    console.log("Checking for OTP requirement...");
    try {
      console.log("Looking for OTP input (checking for 12 seconds)...");
      const otpInput = await firstVisibleInPageOrFrames(page, OTP_INPUT_SELECTORS, 12000).catch(() => null);
      
      if (otpInput) {
        console.log("✓ OTP input found, proceeding with OTP handling...");
        // The OTP page appeared, so this login depends on the verification
        // code. Pre-arm the OTP-failure tag: if the login does NOT stick
        // below, treat it as an OTP failure (fast-retry) regardless of
        // whether maybeHandleOtp threw or returned true via its
        // "may still be processing" path (code read but page rejected it).
        // On a successful login no error is thrown, so the flag is moot.
        otpFailed = true;
        const handledOtp = await maybeHandleOtp(page, config);
        if (handledOtp) {
          console.log("✓ OTP submitted");
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          await page.waitForTimeout(3000);
          await writeDebugSnapshot(page, "after-otp-submit");
        }
      } else {
        console.log("No OTP input found - proceeding without OTP");
      }
    } catch (otpError) {
      // The OTP could not be read/submitted (most often: the code never
      // landed in chat.db within the poll window). otpFailed was already set
      // when the OTP page appeared; keep it set here so the "Login did not
      // stick" throw below carries OTP_LOGIN_FAILED and the scheduler
      // fast-retries with a fresh code instead of waiting 6h.
      otpFailed = true;
      if (otpError?.code === "OTP_PERMISSION_DENIED") otpPermissionDenied = true;
      console.error(`⚠️  OTP handling error (continuing): ${otpError.message}`);
      await writeDebugSnapshot(page, "otp-error");
    }

    console.log(`Waiting ${config.postLoginWaitMs ?? 5000}ms before navigating to monitor URL...`);
    await page.waitForTimeout(config.postLoginWaitMs ?? 5000);
    
    console.log(`Navigating to ${config.monitorUrl}`);
    await page.goto(config.monitorUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    
    console.log("Checking if logged in successfully...");
    // A failed/timed-out OTP can leave the browser stranded on the USCIS
    // verification page instead of the login form. looksLoggedOut() returns
    // FALSE for a verification URL (it is not the login page), so without this
    // guard we would fall through and storageState() the unauthenticated
    // verification session as if login succeeded — and never tag the OTP
    // failure, so the scheduler would skip the fast-retry. If the OTP step
    // failed and we are still sitting on a verification page, that is an OTP
    // login failure: throw it tagged so the scheduler fast-retries.
    const stuckOnVerification = otpFailed && isVerificationPageUrl(page.url());
    if ((await looksLoggedOut(page)) || stuckOnVerification) {
      const summary = await pageSummary(page);
      await writeDebugSnapshot(page, "login-failed");
      const err = new Error(
        `Login did not stick. URL: ${summary.url}\nTitle: ${summary.title}\nHeading: ${summary.heading}\nAlert: ${summary.alert}\nText: ${summary.text.slice(0, 300)}`,
      );
      // If the login failed specifically because the OTP step failed, tag it
      // so the scheduler fast-retries (15 min) instead of falling back to 6h.
      // A Full Disk Access denial gets a distinct tag so the scheduler pauses
      // (and notifies once) rather than fast-retrying an unfixable failure.
      if (otpFailed) {
        err.code = otpPermissionDenied ? "OTP_PERMISSION_DENIED" : "OTP_LOGIN_FAILED";
      }
      throw err;
    }
    
    console.log("✓ Successfully logged in!");
    await context.storageState({ path: authFile });
    console.log(`✓ Saved authenticated session to ${authFile}`);
  } finally {
    await browser.close();
  }
}

async function extractMonitoredText(page, config) {
  await page.goto(config.monitorUrl, { waitUntil: "domcontentloaded" });
  if (await looksLoggedOut(page)) {
    await writeDebugSnapshot(page, "poll-session-expired");
    throw new Error("Session expired. Run `npm run reauth`.");
  }
  if (config.monitorReadySelector) {
    await page.locator(config.monitorReadySelector).first().waitFor({ timeout: 30000 });
  }
  const contentLocator = page.locator(config.contentSelector || "body").first();
  await contentLocator.waitFor({ timeout: 30000 });
  const text = (await contentLocator.innerText()).replace(/\s+/g, " ").trim();
  const html = await contentLocator.innerHTML();
  return { text, html };
}

function requireAuthState() {
  if (!fs.existsSync(authFile)) {
    throw new Error("Missing state/auth.json. Run `npm run login` first.");
  }
}

function saveSnapshot(prefix, text, html) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const textFile = path.join(snapshotsDir, `${stamp}-${prefix}.txt`);
  const htmlFile = path.join(snapshotsDir, `${stamp}-${prefix}.html`);
  fs.writeFileSync(textFile, `${text}\n`, "utf8");
  fs.writeFileSync(htmlFile, html, "utf8");
  return { textFile, htmlFile };
}

const caseHistoryFile = path.join(stateDir, "case-history.json");

function loadCaseHistory() {
  if (!fs.existsSync(caseHistoryFile)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(caseHistoryFile, "utf8"));
  } catch (e) {
    console.warn("Could not parse case history, starting fresh");
    return {};
  }
}

function saveCaseHistory(history) {
  fs.writeFileSync(caseHistoryFile, JSON.stringify(history, null, 2) + "\n", "utf8");
}

function deepHash(obj) {
  // Create a hash of the object for change detection
  return sha256(JSON.stringify(obj || {}));
}

function detectChanges(previousData, currentData) {
  const changes = {};
  
  if (!previousData) {
    return { isChanged: true, summary: "New case" };
  }
  
  const prevData = previousData.data || {};
  const currData = currentData.data || {};
  
  // Check key fields
  if (prevData.updatedAt !== currData.updatedAt) {
    changes.updatedAt = {
      from: prevData.updatedAt,
      to: currData.updatedAt,
    };
  }
  
  // Check events
  const prevEventCount = (prevData.events || []).length;
  const currEventCount = (currData.events || []).length;
  if (prevEventCount !== currEventCount) {
    changes.events = {
      from: prevEventCount,
      to: currEventCount,
      newEvents: (currData.events || []).slice(prevEventCount),
    };
  }
  
  // Check closed status
  if (prevData.closed !== currData.closed) {
    changes.closed = {
      from: prevData.closed,
      to: currData.closed,
    };
  }
  
  // Check if any important field changed
  if (prevData.actionRequired !== currData.actionRequired) {
    changes.actionRequired = {
      from: prevData.actionRequired,
      to: currData.actionRequired,
    };
  }
  
  const isChanged = Object.keys(changes).length > 0;
  
  return { isChanged, changes, summary: isChanged ? `Updated: ${Object.keys(changes).join(", ")}` : "No changes" };
}

async function getCookies(config) {
  // Read cookies from saved auth state
  let cookies = [];
  try {
    const authState = JSON.parse(fs.readFileSync(authFile, "utf8"));
    if (authState.cookies) {
      cookies = authState.cookies;
    }
  } catch (e) {
    console.warn("⚠️  Could not read cookies from auth state, trying without cookies...");
  }
  
  // Build Cookie header
  return cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

async function fetchSingleCase(receiptNumber, config) {
  const apiUrl = `${config.apiUrl}/${receiptNumber}`;
  const cookieHeader = await getCookies(config);
  
  try {
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Cookie": cookieHeader,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": config.monitorUrl,
      },
    });
    
    // Check for auth failure: HTTP 401 OR API response with data: null + error object
    if (response.status === 401) {
      const error = new Error("SESSION_EXPIRED");
      error.code = "SESSION_EXPIRED";
      error.statusCode = 401;
      throw error;
    }
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Also check for API-level auth failure: data is null with error object
    if (data.data === null && data.error) {
      const error = new Error("SESSION_EXPIRED");
      error.code = "SESSION_EXPIRED";
      error.apiError = data.error;
      throw error;
    }
    
    return data;
  } catch (error) {
    // Don't suppress SESSION_EXPIRED errors - let them bubble up
    if (error.code === "SESSION_EXPIRED") {
      throw error;
    }
    console.error(`❌ Error fetching ${receiptNumber}: ${error.message}`);
    return null;
  }
}

async function sendDiscordWebhook(webhookUrl, payload, opts = {}) {
  // Retry transient network failures up to `attempts` times with 0/200/800 ms
  // backoff. Do NOT retry on HTTP 4xx — those mean URL/payload is bad. On final
  // failure, surface error.cause?.code and .message so we can diagnose undici
  // socket-pool issues (see DESIGN-discord-cron-otp-and-heartbeat-fix.md §2.2).
  const attempts = opts.attempts ?? 3;
  const backoffMs = [0, 200, 800];
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (backoffMs[i]) await new Promise((r) => setTimeout(r, backoffMs[i]));
    let res;
    try {
      res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: opts.keepalive ?? true,
      });
    } catch (err) {
      // Network / fetch failure — retryable.
      lastErr = err;
      continue;
    }
    // Drain the response body so undici can release the socket. Discord
    // responses are tiny; this is fire-and-forget.
    res.body?.cancel().catch(() => {});
    if (res.ok) return;
    // 4xx — bad URL or payload, not transient. Surface immediately without retrying.
    if (res.status >= 400 && res.status < 500) {
      throw new Error(`Discord webhook failed: ${res.status} ${res.statusText}`);
    }
    // 5xx — retryable.
    lastErr = new Error(`Discord webhook failed: ${res.status} ${res.statusText}`);
  }
  const cause = lastErr?.cause;
  const causeStr = cause ? ` (cause: ${cause.code ?? cause.name ?? "?"}: ${cause.message ?? ""})` : "";
  throw new Error(`Discord webhook failed after ${attempts} attempts: ${lastErr?.message ?? "?"}${causeStr}`);
}

function buildDiscordEmbed(receiptNumber, caseData, changes) {
  const data = caseData.data || {};
  const changedFields = Object.entries(changes || {});
  
  const fields = [
    { name: "Receipt Number", value: receiptNumber, inline: true },
    { name: "Applicant", value: data.applicantName || "N/A", inline: true },
    { name: "Updated At", value: data.updatedAt || "N/A", inline: true },
  ];
  
  for (const [key, detail] of changedFields) {
    if (key === "events" && detail.newEvents?.length) {
      for (const evt of detail.newEvents) {
        fields.push({
          name: `New Event`,
          value: `**${evt.actionCodeText || "Unknown"}**\n${evt.dispositionCodeText || ""}\n${evt.eventDate || ""}`,
        });
      }
    } else {
      fields.push({
        name: key,
        value: `${detail.from ?? "—"} → ${detail.to ?? "—"}`,
        inline: true,
      });
    }
  }
  
  return {
    embeds: [{
      title: `🔄 Case Update: ${data.formName || receiptNumber}`,
      color: 0xff9900,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: "USCIS Case Monitor" },
    }],
  };
}

async function triggerNotification(receiptNumber, caseData, changes, config) {
  try {
    console.log(`\n🔔 [NOTIFICATION] Case ${receiptNumber} updated:`);
    console.log(`  Changes: ${JSON.stringify(changes)}`);
    
    const webhookUrl = config?.discordWebhookUrl || process.env.PHONEMONITOR_DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      console.log("  ⚠️ No Discord webhook URL configured (set discordWebhookUrl in config or PHONEMONITOR_DISCORD_WEBHOOK_URL env var)");
      return;
    }
    
    const payload = buildDiscordEmbed(receiptNumber, caseData, changes);
    await sendDiscordWebhook(webhookUrl, payload);
    console.log("  ✓ Discord notification sent");
  } catch (error) {
    console.error(`  ✗ Discord notification failed: ${error.message}`);
  }
}

async function checkAllCases(config) {
  requireAuthState();
  
  const receiptNumbers = config.receiptNumbers || (config.receiptNumber ? [config.receiptNumber] : []);
  if (receiptNumbers.length === 0) {
    throw new Error("No receiptNumbers found in config. Please add receiptNumbers array to config.local.json");
  }
  
  let sessionExpired = false;
  let retryCount = 0;
  const maxRetries = 1;
  
  while (retryCount <= maxRetries) {
    try {
      console.log(`\n📋 Checking ${receiptNumbers.length} case(s)...\n`);
      
      const history = loadCaseHistory();
      const results = [];
      
      for (const receiptNumber of receiptNumbers) {
        try {
          console.log(`⏳ Fetching ${receiptNumber}...`);
          const caseData = await fetchSingleCase(receiptNumber, config);
          
          if (!caseData || !caseData.data) {
            console.log(`⚠️  Could not fetch ${receiptNumber} (invalid response), skipping...\n`);
            results.push({
              receiptNumber,
              isChanged: false,
              formName: null,
              updatedAt: null,
              error: "Invalid API response",
            });
            continue;
          }
          
          // Detect changes
          const previousRecord = history[receiptNumber];
          const { isChanged, changes } = detectChanges(previousRecord?.current, caseData);
          
          // Update history
          history[receiptNumber] = {
            lastFetchAt: new Date().toISOString(),
            lastHash: deepHash(caseData),
            current: caseData,
            previous: previousRecord?.current || null,
            changes: isChanged ? changes : null,
          };
          
          // Print summary
          const data = caseData.data || {};
          console.log(`✓ ${data.formName || "N/A"}`);
          console.log(`  Receipt: ${receiptNumber}`);
          console.log(`  Name: ${data.applicantName || "N/A"}`);
          console.log(`  Updated: ${data.updatedAt || "N/A"}`);
          console.log(`  Events: ${(data.events || []).length}`);
          console.log(`  Status: ${isChanged ? "🔄 CHANGED" : "✓ No changes"}`);
          
          if (isChanged) {
            console.log(`  Changes: ${Object.keys(changes).join(", ")}`);
            
            // Trigger notification
            await triggerNotification(receiptNumber, caseData, changes, config);
          }
          
          console.log();
          
          results.push({
            receiptNumber,
            isChanged,
            formName: data.formName || null,
            updatedAt: data.updatedAt || null,
          });
        } catch (error) {
          // Check if it's a session expired error
          if (error.code === "SESSION_EXPIRED") {
            console.error(`⚠️  Session expired while fetching ${receiptNumber}`);
            sessionExpired = true;
            throw error; // Bubble up to outer loop for retry
          }
          
          console.error(`❌ Error processing ${receiptNumber}: ${error.message}\n`);
          results.push({
            receiptNumber,
            isChanged: false,
            formName: null,
            updatedAt: null,
            error: error.message,
          });
        }
      }
      
      // Save updated history
      saveCaseHistory(history);
      console.log(`✓ History saved to ${caseHistoryFile}\n`);
      
      // Return summary
      const summary = {
        checkedAt: new Date().toISOString(),
        totalCases: receiptNumbers.length,
        changedCases: results.filter(r => r.isChanged && !r.error).length,
        results,
      };
      
      console.log("📊 Summary:");
      console.log(JSON.stringify(summary, null, 2));

      if (summary.changedCases === 0) {
        const webhookUrl = config?.discordWebhookUrl || process.env.PHONEMONITOR_DISCORD_WEBHOOK_URL;
        if (webhookUrl) {
          const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
          // keepalive:false isolates this from the case-API undici socket pool —
          // see DESIGN-discord-cron-otp-and-heartbeat-fix.md §2.2 for why.
          await sendDiscordWebhook(
            webhookUrl,
            { content: `✅ \`${ts} UTC\` no changes found (${summary.totalCases} case${summary.totalCases === 1 ? "" : "s"} checked)` },
            { keepalive: false },
          ).catch((err) => console.error(`  ✗ Heartbeat failed: ${err.message}`));
        }
      }

      return summary; // Success, exit loop
      
    } catch (error) {
      if (error.code === "SESSION_EXPIRED" && retryCount < maxRetries) {
        retryCount++;
        sessionExpired = true;
        // Immediately re-authenticate before next retry
        console.log("\n🔄 Session expired, re-authenticating...\n");
        await login(config);
        console.log("\n✓ Re-authentication successful, retrying case checks...\n");
        sessionExpired = false;
        // Loop will continue and try again
        continue;
      }
      
      // If we've exhausted retries or it's a different error, throw
      throw error;
    }
  }
}

// Legacy function for single case fetch (for backward compatibility)
async function fetchCaseJson(config) {
  requireAuthState();
  
  const receiptNumbers = config.receiptNumbers || (config.receiptNumber ? [config.receiptNumber] : []);
  if (receiptNumbers.length === 0) {
    throw new Error("receiptNumbers not found in config. Please add it to config.local.json");
  }
  
  const receiptNumber = receiptNumbers[0];
  const caseData = await fetchSingleCase(receiptNumber, config);
  
  if (!caseData) {
    throw new Error(`Failed to fetch case ${receiptNumber}`);
  }
  
  // Save the JSON data
  const caseFile = path.join(stateDir, "case.json");
  fs.writeFileSync(caseFile, JSON.stringify(caseData, null, 2) + "\n", "utf8");
  console.log(`\n✓ Case data saved to ${caseFile}`);
  console.log(`\n📋 Case Summary:`);
  console.log(`   Receipt #: ${caseData.data?.receiptNumber}`);
  console.log(`   Status: ${caseData.data?.formName}`);
  console.log(`   Submitted: ${caseData.data?.submissionDate}`);
  console.log(`   Updated: ${caseData.data?.updatedAt}`);
  console.log(`   Events: ${caseData.data?.events?.length || 0}`);
  
  // Also print full JSON
  console.log(`\n📄 Full JSON:`);
  console.log(JSON.stringify(caseData, null, 2));
}

async function poll(config) {
  requireAuthState();
  const { browser, page } = await browserWithState(true);
  try {
    const { text, html } = await extractMonitoredText(page, config);
    const hash = sha256(text);
    const now = new Date().toISOString();
    const previous = fs.existsSync(lastFile) ? JSON.parse(fs.readFileSync(lastFile, "utf8")) : null;
    const changed = !previous || previous.hash !== hash;
    const snapshot = saveSnapshot("monitor", text, html);
    const state = {
      checkedAt: now,
      hash,
      changed,
      textPreview: text.slice(0, 400),
      snapshot,
    };
    if (previous && previous.hash) {
      state.previousHash = previous.hash;
    }
    fs.writeFileSync(lastFile, JSON.stringify(state, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(state, null, 2));
    if (changed) {
      process.exitCode = 2;
    }
  } finally {
    await browser.close();
  }
}

// --- Scheduler ---

// Defaults for the OTP fast-retry loop. Overridable via the `otpRetry` block
// in config.local.json. See docs/DESIGN-otp-timeout-fast-retry.md.
const DEFAULT_OTP_RETRY = { maxRetries: 8, retryIntervalMinutes: 15 };

// Pure scheduler decision: given the just-finished run's outcome, decide how
// long to wait before the next run and whether this is a fast OTP retry.
//
// PURE — no timers, no Date, no I/O. The caller passes `fallbackDelayMs` (the
// result of `planRun().nextDelayMs`) so this function — and its tests — stay
// deterministic.
//
//   OTP failure, in-window, budget left, retry lands in-window -> retry in N min
//   OTP failure, budget exhausted                              -> fallback, exhausted
//   OTP failure, retry would land AFTER hours                  -> fallback, exhausted (notify)
//   OTP failure, the failed run itself was out of window       -> fallback (no retry)
//   success or non-OTP error                                   -> fallback (no retry)
//
// `withinSchedule` describes the run that just failed; `retryWithinSchedule`
// describes whether the PROJECTED retry target time (now + retry interval) is
// still inside the 9am–8pm ET window. A late-day OTP failure whose retry would
// wake after hours must NOT schedule a dead retry (it would skip the check and
// reset the burst silently — the 2026-06-05 silence bug). Instead we exhaust:
// fall back to the next slot AND fire the operator notice.
function decideNextDelay({
  error,
  retryCount,
  withinSchedule,
  retryWithinSchedule = true,
  cfg,
  fallbackDelayMs,
}) {
  const { maxRetries, retryIntervalMinutes } = { ...DEFAULT_OTP_RETRY, ...(cfg || {}) };

  // A Full Disk Access denial can't be fixed by retrying, and every retry makes
  // USCIS text another code. Never fast-retry it: fall back to the normal
  // schedule and let the caller notify the operator once.
  if (error?.code === "OTP_PERMISSION_DENIED") {
    return { delayMs: fallbackDelayMs, isRetry: false, exhausted: false, permissionDenied: true };
  }

  const isOtpFailure = error?.code === "OTP_LOGIN_FAILED";

  if (isOtpFailure && withinSchedule) {
    if (retryCount >= maxRetries) {
      return { delayMs: fallbackDelayMs, isRetry: false, exhausted: true };
    }
    if (!retryWithinSchedule) {
      // Budget remains but the retry would wake after hours — fall back and
      // notify rather than schedule a retry that silently skips the check.
      return { delayMs: fallbackDelayMs, isRetry: false, exhausted: true };
    }
    return { delayMs: retryIntervalMinutes * 60 * 1000, isRetry: true, exhausted: false };
  }
  return { delayMs: fallbackDelayMs, isRetry: false, exhausted: false };
}

// Pure: decide whether to send the Full Disk Access denial notice, and the next
// value of the "already notified" flag. Notify once per denial STREAK.
//
// A streak ends only when a check actually RAN with a non-denial outcome. An
// out-of-window run skips the check entirely (no login, no OTP read), so it is
// NOT evidence that access was restored — it must leave the flag untouched, or
// a persistent denial re-pings every time a 6h run lands after hours.
//
//   denied, not yet notified   -> notify now, mark notified
//   denied, already notified   -> stay silent, stay notified
//   non-denial, check ran      -> reset (next denial re-notifies)
//   non-denial, check skipped  -> unchanged (streak not broken by a no-op)
function nextPermissionNotifyState(decision, checkRan, alreadyNotified) {
  if (decision.permissionDenied) {
    return { notify: !alreadyNotified, notified: true };
  }
  return { notify: false, notified: checkRan ? false : alreadyNotified };
}

// ---- Schedule (ET weekdays, fixed slots) ------------------------------------
//
// Every decision below is a PURE function of one `now` Date so a single
// scheduler tick can never see two different clock readings. The 2026-10-14
// skip happened because `isWithinSchedule()` and `nextScheduledRun()` each
// read the clock: the timer woke a few ms before 9:00:00 ET (the old delay
// dropped the millisecond part), the first call said "outside", the second
// (now past 9:00) said "inside -> +6h", and the 9 AM check was lost.

const SCHEDULE_TZ = "America/New_York";
const SLOT_HOURS_ET = [9, 15];     // checks run at 9:00 and 15:00 ET on weekdays
const WINDOW_START_HOUR = 9;
const WINDOW_END_HOUR = 20;        // exclusive
// A timer that wakes this close before a slot counts as that slot (and must
// not be re-armed for the same slot). Covers timer jitter; see planRun().
const SLOT_TOLERANCE_MS = 5_000;
// After a (re)start, how long to wait before a catch-up check when the most
// recent slot was missed — lets a rebooting machine settle instead of
// launching Chrome under boot load (the 2026-10-14 "browser closed" failure).
const STARTUP_SETTLE_MS = 5 * 60 * 1000;
const MIN_DELAY_MS = 60_000;

// ET wall-clock of `now`, expressed as a Date in the process's local frame
// (so getDay/getHours read ET components). Keeps the millisecond part, which
// `toLocaleString` drops — otherwise delays computed from it are up to 999 ms
// short and the timer wakes before the slot.
function toEastern(now) {
  const et = new Date(now.toLocaleString("en-US", { timeZone: SCHEDULE_TZ }));
  et.setMilliseconds(now.getMilliseconds());
  return et;
}

function isWeekday(et) {
  const day = et.getDay();
  return day >= 1 && day <= 5;
}

function inWindow(et) {
  const hour = et.getHours();
  return isWeekday(et) && hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}

function isWithinSchedule(when = new Date()) {
  return inWindow(toEastern(when));
}

// First slot strictly after `et` (ET frame). Weekends and after-hours roll to
// the next weekday's first slot.
function nextSlotAfter(et) {
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const candidate = new Date(et);
    candidate.setDate(et.getDate() + dayOffset);
    if (!isWeekday(candidate)) continue;
    for (const hour of SLOT_HOURS_ET) {
      candidate.setHours(hour, 0, 0, 0);
      if (candidate.getTime() > et.getTime()) return new Date(candidate);
    }
  }
  throw new Error("nextSlotAfter: no slot within 7 days (unreachable)");
}

// Most recent slot at or before `et`, or null if none this week yet matters
// (we only look back 7 days).
function lastSlotAtOrBefore(et) {
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const candidate = new Date(et);
    candidate.setDate(et.getDate() - dayOffset);
    if (!isWeekday(candidate)) continue;
    for (const hour of [...SLOT_HOURS_ET].reverse()) {
      candidate.setHours(hour, 0, 0, 0);
      if (candidate.getTime() <= et.getTime()) return new Date(candidate);
    }
  }
  return null;
}

// Real instant of an ET-frame wall-clock time. The ET<->real offset can differ
// between `now` and the target (a DST switch in between), so refine once.
function etToInstant(etFrame, now) {
  const offsetAt = (instant) => instant.getTime() - toEastern(instant).getTime();
  const guess = new Date(etFrame.getTime() + offsetAt(now));
  return new Date(etFrame.getTime() + offsetAt(guess));
}

// One scheduler tick's view of the clock. `withinSchedule`: should a check
// run now? `nextDelayMs`: ms until the next slot, measured from this same
// `now`. A wake-up within SLOT_TOLERANCE_MS before a slot is treated as that
// slot: it runs now and the next delay targets the slot after it.
function planRun(now = new Date(), { toleranceMs = SLOT_TOLERANCE_MS } = {}) {
  const et = toEastern(now);
  const effective = new Date(et.getTime() + toleranceMs);
  const withinSchedule = inWindow(et) || inWindow(effective);
  const nextSlot = nextSlotAfter(effective);
  const nextDelayMs = Math.max(etToInstant(nextSlot, now).getTime() - now.getTime(), MIN_DELAY_MS);
  return { withinSchedule, nextDelayMs, nextSlotEt: nextSlot };
}

// Latest completed fetch recorded in case-history.json, or null.
function lastCheckedAtFromHistory(history) {
  let latest = null;
  for (const entry of Object.values(history || {})) {
    const t = entry?.lastFetchAt ? Date.parse(entry.lastFetchAt) : NaN;
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest === null ? null : new Date(latest);
}

// What to do when the scheduler (re)starts. Never run immediately: a launchd
// restart after reboot lands at a random time under boot load. If the most
// recent slot has no completed check after it (missed, e.g. the machine was
// down at 9:00) and we are still inside the window, catch up after a settle
// delay; otherwise sleep until the next slot.
function planStartup({ now = new Date(), lastCheckedAt = null, settleMs = STARTUP_SETTLE_MS } = {}) {
  const plan = planRun(now);
  const et = toEastern(now);
  const lastSlot = lastSlotAtOrBefore(et);
  const lastSlotMissed =
    lastSlot !== null &&
    inWindow(et) &&
    (lastCheckedAt === null || toEastern(lastCheckedAt).getTime() < lastSlot.getTime());
  if (lastSlotMissed) {
    const delayMs = Math.min(settleMs, plan.nextDelayMs);
    return { delayMs, reason: "missed-slot-catch-up", nextSlotEt: plan.nextSlotEt };
  }
  return { delayMs: plan.nextDelayMs, reason: "next-slot", nextSlotEt: plan.nextSlotEt };
}

// OTP failures have their own operator notices (fast-retry exhaustion, Full
// Disk Access denial) — posting on each of those too would spam a burst of
// retries. Everything else (expired session that re-auth couldn't fix, a
// crashed browser, network errors, ...) was previously silent and must ping.
function shouldNotifyCheckFailure(error) {
  const code = error?.code;
  return code !== "OTP_LOGIN_FAILED" && code !== "OTP_PERMISSION_DENIED";
}

async function notifyCheckFailed(config, error) {
  const webhookUrl = config?.discordWebhookUrl || process.env.PHONEMONITOR_DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  await sendDiscordWebhook(webhookUrl, {
    content: `❌ \`${ts} UTC\` Scheduled check failed: ${error.message}`,
  }).catch((err) => console.error(`  ✗ Check-failure notification failed: ${err.message}`));
}

function formatEt(et) {
  return et.toLocaleString("en-US");
}

async function scheduledCheck(config) {
  // Smart check: try API first, login only if needed
  const etStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  console.log(`\n⏰ Scheduled check at ${etStr} ET\n`);
  
  const hasAuth = fs.existsSync(authFile);
  if (!hasAuth) {
    console.log("No auth state found, performing login...");
    await login(config);
  }
  
  await checkAllCases(config);
}

async function runScheduler(config) {
  console.log("🕐 USCIS Case Monitor Scheduler started");
  console.log("   Schedule: Weekdays 9:00 and 15:00 ET (window 9am–8pm ET)");
  console.log("   Press Ctrl+C to stop\n");

  // Record our own PID so `./uscis.sh status|stop|logs` stay accurate whether
  // we were launched by uscis.sh (nohup) or directly by launchd. Remove the
  // file on clean exit so a stale PID never lingers. On SIGTERM/SIGINT (e.g.
  // `uscis.sh stop`) exit 0 — under launchd's KeepAlive{SuccessfulExit:false}
  // a deliberate stop stays stopped, while a crash (non-zero) auto-restarts.
  const pidFile = path.join(stateDir, "scheduler.pid");
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));
  } catch (e) {
    console.error(`⚠️  Could not write PID file: ${e.message}`);
  }
  const cleanupPid = () => {
    try {
      if (fs.readFileSync(pidFile, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(pidFile);
      }
    } catch {}
  };
  process.on("exit", cleanupPid);
  process.on("SIGTERM", () => { cleanupPid(); process.exit(0); });
  process.on("SIGINT", () => { cleanupPid(); process.exit(0); });

  const otpCfg = { ...DEFAULT_OTP_RETRY, ...(config.otpRetry || {}) };
  // Counts consecutive OTP-not-stick failures in the current fast-retry
  // burst. Reset to 0 on any success or on exhaustion.
  let otpRetryCount = 0;
  // True once we've sent the operator a Full Disk Access denial notice for the
  // current broken streak. Reset on any non-denial outcome so a persistent
  // denial pings once, not every 6h scheduled run.
  let notifiedPermissionDenied = false;

  const run = async () => {
    let runError = null;
    // Read the clock ONCE per tick; every decision below derives from it.
    const plan = planRun();
    const { withinSchedule } = plan;
    if (withinSchedule) {
      try {
        await scheduledCheck(config);
      } catch (error) {
        runError = error;
        console.error(`❌ Scheduled check error: ${error.message}`);
        if (shouldNotifyCheckFailure(error)) {
          await notifyCheckFailed(config, error);
        }
      }
    } else {
      const etStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
      console.log(`⏸️  Outside schedule (${etStr} ET). Skipping.`);
    }

    // otpRetryCount = number of fast-retries already SCHEDULED in this burst
    // (the initial 9:00 scheduled run is not itself a retry). Pass the
    // pre-increment count to the pure decision: retryCount<maxRetries means
    // budget remains, so the failure earns another retry; ===maxRetries means
    // all `maxRetries` retries have run -> exhausted. We bump the counter
    // below only when the decision is actually a retry.
    // Would a 15-min fast-retry still land inside the 9am–8pm ET window? If
    // the failure happens late in the day, the retry target is after hours and
    // must NOT be scheduled (it would skip the check and silently reset the
    // burst). decideNextDelay turns that into an exhaustion + operator notice.
    const retryTarget = new Date(Date.now() + otpCfg.retryIntervalMinutes * 60 * 1000);
    const retryWithinSchedule = isWithinSchedule(retryTarget);

    const decision = decideNextDelay({
      error: runError,
      retryCount: otpRetryCount,
      withinSchedule,
      retryWithinSchedule,
      cfg: otpCfg,
      fallbackDelayMs: plan.nextDelayMs,
    });

    // Notify-once bookkeeping for the FDA-denial streak. `withinSchedule` is
    // the "a check actually ran this cycle" signal — an out-of-window skip must
    // not reset the flag (see nextPermissionNotifyState).
    const notifyState = nextPermissionNotifyState(
      decision,
      withinSchedule,
      notifiedPermissionDenied,
    );
    notifiedPermissionDenied = notifyState.notified;

    if (decision.permissionDenied) {
      // Full Disk Access is denied — retrying only spams USCIS texts. Skip the
      // burst; notify the operator once per streak.
      console.error("🔒 Full Disk Access denied — can't read the OTP text. Pausing OTP retries.");
      if (notifyState.notify) {
        await notifyPermissionDenied(config);
      }
      otpRetryCount = 0;
    } else if (decision.exhausted) {
      console.error(`❌ OTP fast-retry exhausted after ${otpRetryCount} attempts`);
      await notifyOtpExhausted(config, otpRetryCount);
      otpRetryCount = 0;
    } else if (decision.isRetry) {
      // Scheduling another fast-retry — consume one budget slot.
      otpRetryCount += 1;
    } else {
      // Success or non-OTP path — clear any in-progress retry burst.
      otpRetryCount = 0;
    }

    const waitMin = Math.round(decision.delayMs / 60000);
    if (decision.isRetry) {
      console.log(`🔁 OTP fast-retry ${otpRetryCount}/${otpCfg.maxRetries} — next attempt in ${waitMin} minutes\n`);
    } else {
      console.log(`⏳ Next check in ${waitMin} minutes (${formatEt(plan.nextSlotEt)} ET)\n`);
    }
    setTimeout(run, decision.delayMs);
  };

  // Never run immediately on start — align to the slot grid (catching up a
  // missed slot after a settle delay). See planStartup().
  const startup = planStartup({ lastCheckedAt: lastCheckedAtFromHistory(loadCaseHistory()) });
  const startMin = Math.round(startup.delayMs / 60000);
  if (startup.reason === "missed-slot-catch-up") {
    console.log(`🕘 Last slot has no completed check — catch-up in ${startMin} minutes\n`);
  } else {
    console.log(`⏳ First check in ${startMin} minutes (${formatEt(startup.nextSlotEt)} ET)\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, startup.delayMs));
  await run();
}

// Send a single Discord notice when the OTP fast-retry loop gives up, so the
// operator sees the failure instead of silence (the 2026-06-05 failure mode).
async function notifyOtpExhausted(config, attempts) {
  const webhookUrl = config?.discordWebhookUrl || process.env.PHONEMONITOR_DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  // `attempts` is the number of fast-retries fired (0 when a late-day failure
  // exhausts immediately because the retry would land after hours). Clamp to
  // >=1 so the message never reads "after 0 tries".
  const n = Math.max(attempts, 1);
  await sendDiscordWebhook(webhookUrl, {
    content: `❌ \`${ts} UTC\` couldn't read OTP after ${n} ${n === 1 ? "try" : "tries"} — falling back to the 6h schedule.`,
  }).catch((err) => console.error(`  ✗ OTP-exhaustion notification failed: ${err.message}`));
}

// Send a single Discord notice when the OTP read fails because macOS denied
// Full Disk Access to chat.db. This is an operator-actionable config problem,
// not a transient miss — so we surface the fix instead of silently retrying.
async function notifyPermissionDenied(config) {
  const webhookUrl = config?.discordWebhookUrl || process.env.PHONEMONITOR_DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  await sendDiscordWebhook(webhookUrl, {
    content: `🔒 \`${ts} UTC\` Can't read the OTP text — macOS Full Disk Access is denied for the monitor. Grant it to the node binary (System Settings → Privacy & Security → Full Disk Access) and restart the scheduler. Pausing OTP retries until then.`,
  }).catch((err) => console.error(`  ✗ Permission-denied notification failed: ${err.message}`));
}

async function smsTest() {
  const dbPath = path.join(process.env.HOME, "Library", "Messages", "chat.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`❌ Messages DB not found at ${dbPath}`);
    process.exit(1);
  }

  const query = `
    SELECT
      COALESCE(h.id, '?') AS sender,
      COALESCE(m.service, '?') AS service,
      datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS dt,
      substr(COALESCE(m.text, ''), 1, 80) AS preview
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.date >= (strftime('%s','now') - 86400 - 978307200) * 1000000000
    ORDER BY m.date DESC
    LIMIT 20;
  `;

  const result = await new Promise((resolve, reject) => {
    const child = spawn("sqlite3", ["-separator", "\t", dbPath, query], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || `sqlite3 exited ${code}`))));
  }).catch((err) => {
    console.error(`❌ Failed to read Messages DB: ${err.message}`);
    console.error("   Grant Full Disk Access to your terminal: System Settings → Privacy & Security → Full Disk Access");
    process.exit(1);
  });

  const rows = result.split("\n").filter(Boolean).map((line) => {
    const [sender, service, dt, preview] = line.split("\t");
    return { sender, service, dt, preview };
  });

  if (rows.length === 0) {
    console.log("⚠️  No messages in the last 24h.");
    console.log("   If you have iMessages on your phone but none here, check that Messages.app on this Mac is signed in.");
    console.log("   If you receive SMS on your phone but none here, enable Text Message Forwarding:");
    console.log("     iPhone → Settings → Apps → Messages → Text Message Forwarding → toggle this Mac ON");
    return;
  }

  const smsCount = rows.filter((r) => r.service === "SMS").length;
  const iMessageCount = rows.filter((r) => r.service === "iMessage").length;
  const uscisRows = rows.filter((r) => /uscis|85728|verification|secure/i.test(`${r.sender} ${r.preview}`));

  console.log(`📬 Last 24h: ${rows.length} message(s) — ${smsCount} SMS, ${iMessageCount} iMessage\n`);
  console.log("Recent messages:");
  for (const r of rows.slice(0, 10)) {
    console.log(`  [${r.service.padEnd(8)}] ${r.dt}  ${r.sender}`);
    console.log(`             ${r.preview}`);
  }

  console.log();
  if (smsCount === 0) {
    console.log("❌ Zero SMS messages forwarded in last 24h.");
    console.log("   USCIS sends from short code 85728 via SMS (not iMessage).");
    console.log("   Enable forwarding: iPhone → Settings → Apps → Messages → Text Message Forwarding → toggle this Mac ON");
    process.exit(2);
  } else if (uscisRows.length === 0) {
    console.log("✓ SMS forwarding is working (you have SMS in the DB).");
    console.log("⚠️  But no USCIS / 85728 messages in the last 24h. Trigger a login and run this again to confirm.");
  } else {
    console.log(`✓ SMS forwarding works AND found ${uscisRows.length} USCIS-related message(s). Auto-OTP should work.`);
  }
}

async function main() {
  ensureDirs();
  const config = loadConfig();
  const command = process.argv[2] || "poll";
  if (command === "login" || command === "reauth") {
    await login(config);
    return;
  }
  if (command === "check-all-cases") {
    await checkAllCases(config);
    return;
  }
  if (command === "scheduled-check") {
    await scheduledCheck(config);
    return;
  }
  if (command === "scheduler") {
    await runScheduler(config);
    return;
  }
  if (command === "fetch-case-json") {
    await fetchCaseJson(config);
    return;
  }
  if (command === "otp-test") {
    const code = await readOtpFromEmail(config.otp);
    console.log(code);
    return;
  }
  if (command === "sms-test") {
    await smsTest();
    return;
  }
  if (command === "webhook-test") {
    // Hidden: post 5 heartbeats sequentially to exercise the retry path.
    const webhookUrl = config?.discordWebhookUrl || process.env.PHONEMONITOR_DISCORD_WEBHOOK_URL;
    if (!webhookUrl) throw new Error("No Discord webhook URL configured");
    for (let i = 1; i <= 5; i++) {
      const ts = new Date().toISOString();
      try {
        await sendDiscordWebhook(webhookUrl, { content: `🧪 webhook-test ${i}/5 \`${ts}\`` }, { keepalive: false });
        console.log(`  ✓ ${i}/5 sent`);
      } catch (err) {
        console.error(`  ✗ ${i}/5 failed: ${err.message}`);
      }
    }
    return;
  }
  if (command === "poll") {
    await poll(config);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

// Exported for unit tests (tests/monitor.test.mjs). All pure.
export {
  decideNextDelay,
  nextPermissionNotifyState,
  DEFAULT_OTP_RETRY,
  isVerificationPageUrl,
  isWithinSchedule,
  planRun,
  planStartup,
  lastCheckedAtFromHistory,
  shouldNotifyCheckFailure,
  SLOT_TOLERANCE_MS,
  STARTUP_SETTLE_MS,
};

// Only run the CLI when invoked directly (`node src/monitor.mjs ...`), not
// when imported by the test runner. import.meta.url vs argv[1] is the
// standard ESM "is this the entry module" check.
const isEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
  } catch {
    return false;
  }
})();

if (isEntry) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
