// Electron Auth0 Demo
// Purpose: Emulate the Auth0 login flow used by your React Native app to quickly obtain a Bearer token for API testing.
// Open-source readiness: secrets are provided via OS environment variables or external config.json. .env files are not used.

const { app, BrowserWindow, session, ipcMain } = require("electron");
const path = require("path");
const crypto = require("crypto");


// Simple, secure config loader: OS env > external config.json > nothing
const fs = require('fs');
function loadExternalConfig() {
  try {
    const candidates = [];
    // 1) next to the unpacked app (dev) or asar root
    candidates.push(path.join(app.getAppPath(), 'config.json'));
    // 2) resources path (next to app.asar)
    try { candidates.push(path.join(process.resourcesPath || '', 'config.json')); } catch {}
    // 3) userData directory (recommended for per-user config)
    try { candidates.push(path.join(app.getPath('userData'), 'config.json')); } catch {}

    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf-8');
          const parsed = JSON.parse(raw);
          return parsed || {};
        }
      } catch {}
    }
  } catch {}
  return {};
}

// Simple logger helper
function log(...args) {
  console.log(`[AUTH]`, ...args);
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auth:log', args.map(String).join(' ')); } catch {}
}

// Settings — use the same values as in your React Native app
// Provide these via OS environment variables or an external config.json:
// AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_AUDIENCE, AUTH0_SCOPE, AUTH0_REDIRECT_URI
const externalConfig = loadExternalConfig();
const AUTH0_DOMAIN =  externalConfig.AUTH0_DOMAIN;
const CLIENT_ID =  externalConfig.AUTH0_CLIENT_ID;
const AUDIENCE =  externalConfig.AUTH0_AUDIENCE;
const SCOPE = externalConfig.AUTH0_SCOPE;
const REDIRECT_URI = externalConfig.AUTH0_REDIRECT_URI;

let mainWindow;

// --- PKCE helpers ---
function base64URLEncode(str) {
  return str.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("index.html");
  log('App ready. Config:', JSON.stringify({
    AUTH0_DOMAIN,
    CLIENT_ID: CLIENT_ID ? CLIENT_ID.slice(0,4)+"…" : undefined,
    AUDIENCE,
    SCOPE,
    REDIRECT_URI
  }));
  if (!AUTH0_DOMAIN || !CLIENT_ID || !REDIRECT_URI) {
    log('Missing required configuration. Provide AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_REDIRECT_URI via OS env or config.json');
  }
}

// Utility: build login params per request
function buildLoginParams() {
  // Generate verifier/challenge pair for each login attempt
  const verifier = base64URLEncode(crypto.randomBytes(32));
  const challenge = base64URLEncode(sha256(Buffer.from(verifier)));
  const state = base64URLEncode(crypto.randomBytes(16));
  log('PKCE/State generated', { state, challenge: challenge.slice(0,8)+'…', verifier: verifier.slice(0,6)+'…' });
  return { verifier, challenge, state };
}

// Login: open Auth0 authorize URL
ipcMain.handle("auth:login", async () => {
  const { verifier, challenge, state } = buildLoginParams();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  if (AUDIENCE && AUDIENCE !== "YOUR_API_AUDIENCE") params.append("audience", AUDIENCE);

  const authUrl = `https://${AUTH0_DOMAIN}/authorize?${params.toString()}`;
  log('Opening Auth0 authorize URL:', authUrl.replace(/(code_challenge=[^&]+)/, 'code_challenge=***'));

  const authWindow = new BrowserWindow({
    width: 500,
    height: 700,
    webPreferences: { nodeIntegration: false }
  });

  return new Promise((resolve) => {
    let loginFinished = false; // guard to prevent false user_cancelled

    const safeResolve = (payload) => {
      if (loginFinished) return;
      loginFinished = true;
      resolve(payload);
    };

    const cleanup = () => {
      try {
        authWindow.webContents.removeListener('will-redirect', willRedirect);
        authWindow.webContents.removeListener('will-navigate', willNavigate);
        authWindow.webContents.removeListener('did-redirect-navigation', didRedirectNav);
        authWindow.webContents.removeListener('did-navigate', didNavigate);
        authWindow.webContents.removeListener('did-fail-load', didFailLoad);
      } catch {}
    };

    const handleUrl = async (url) => {
      log('Nav/Redirect detected:', url);
      try {
        if (!url.startsWith(REDIRECT_URI)) {
          const hash = new URL(url).hash;
          if (hash && url.startsWith(`https://${AUTH0_DOMAIN}`)) {
            log('Hash fragment returned (implicit flow?) ->', hash);
          }
          return;
        }

        const urlObj = new URL(url);
        const code = urlObj.searchParams.get("code");
        const returnedState = urlObj.searchParams.get("state");
        const error = urlObj.searchParams.get("error");
        const error_description = urlObj.searchParams.get("error_description");
        log('Parsed callback params', { hasCode: !!code, stateOk: returnedState === state, error, error_description });

        // Stop listening; we'll manage the window ourselves
        cleanup();

        if (error) {
          log('Error from Auth0 callback:', error, error_description || '');
          safeResolve({ error, error_description });
          if (!authWindow.isDestroyed()) authWindow.close();
          return;
        }
        if (!code || returnedState !== state) {
          const msg = !code ? 'Missing code' : 'State mismatch';
          log('Invalid response:', msg, { returnedState, expectedState: state });
          safeResolve({ error: "invalid_response", error_description: "Missing code or state mismatch", details: { returnedState, expectedState: state } });
          if (!authWindow.isDestroyed()) authWindow.close();
          return;
        }

        log('Exchanging code for tokens...');
        const tokenRes = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code_verifier: verifier,
            code,
            redirect_uri: REDIRECT_URI,
          }),
        });

        const text = await tokenRes.text();
        let tokenData;
        try { tokenData = JSON.parse(text); } catch { tokenData = { raw: text }; }
        log('Token response status:', tokenRes.status, tokenRes.statusText);
        if (!tokenRes.ok) {
          log('Token exchange failed:', tokenData);
          safeResolve({ error: "token_error", error_description: tokenData.error_description || tokenRes.statusText, details: tokenData });
          if (!authWindow.isDestroyed()) authWindow.close();
          return;
        }
        log('Token exchange success. Received keys:', Object.keys(tokenData));
        // Mark finished before closing window to avoid race with 'closed'
        loginFinished = true;
        const payload = { tokens: tokenData };
        if (!authWindow.isDestroyed()) authWindow.close();
        resolve(payload);
      } catch (e) {
        log('Unexpected error handling URL:', e);
        safeResolve({ error: "unexpected_error", error_description: String(e) });
        if (!authWindow.isDestroyed()) authWindow.close();
      }
    };

    const willRedirect = (_e, url) => handleUrl(url);
    const willNavigate = (_e, url) => handleUrl(url);
    const didRedirectNav = (_e, url) => handleUrl(url);
    const didNavigate = (_e, url) => handleUrl(url);
    const didFailLoad = (_e, code, desc, url) => log('did-fail-load', code, desc, url || '');

    authWindow.webContents.on('will-redirect', willRedirect);
    authWindow.webContents.on('will-navigate', willNavigate);
    authWindow.webContents.on('did-redirect-navigation', didRedirectNav);
    authWindow.webContents.on('did-navigate', didNavigate);
    authWindow.webContents.on('did-fail-load', didFailLoad);

    authWindow.on("closed", () => {
      // If the user closed the window, remove listeners and report cancellation
      cleanup();
      log('Auth window closed by user.');
      if (!loginFinished) {
        resolve({ error: "user_cancelled" });
      }
    });

    authWindow.loadURL(authUrl);
  });
});

ipcMain.handle('auth:logout', async () => {
  try {
    const logoutParams = new URLSearchParams({ client_id: CLIENT_ID });
    // Optionally provide a returnTo that is allowed in your Auth0 dashboard
    // For desktop we can use about:blank
    logoutParams.append('returnTo', 'about:blank');
    const logoutUrl = `https://${AUTH0_DOMAIN}/v2/logout?${logoutParams.toString()}`;
    log('Starting logout flow:', logoutUrl);

    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false } });

    await new Promise((resolve) => {
      const done = () => { try { if (!win.isDestroyed()) win.destroy(); } catch {} ; resolve(); };
      win.webContents.once('did-finish-load', () => {
        log('Logout page loaded');
        setTimeout(done, 200); // small delay to ensure cookie ops
      });
      win.webContents.once('did-fail-load', (_e, code, desc) => {
        log('Logout page failed to load:', code, desc);
        done();
      });
      try { win.loadURL(logoutUrl); } catch { done(); }
    });

    // Best-effort: clear cookies for Auth0 domain in this Electron session
    try {
      const url = `https://${AUTH0_DOMAIN}`;
      const cookies = await session.defaultSession.cookies.get({ url });
      for (const c of cookies) {
        try {
          await session.defaultSession.cookies.remove(url, c.name);
        } catch (e) { log('Cookie remove failed:', c.name, e.message || e); }
      }
      log('Auth0 cookies cleared:', cookies.map(c => c.name));
    } catch (e) {
      log('Cookie clear step failed:', e.message || e);
    }

    return { ok: true };
  } catch (e) {
    log('Logout exception:', e);
    return { error: 'logout_failed', error_description: String(e) };
  }
});

// --- Deep link / custom protocol handling (Windows) ---
// Register custom URI scheme so Windows doesn't prompt to find an app for custom-scheme:// links.
// We keep Auth0 files untouched; we just register the scheme declared in config.json (AUTH0_REDIRECT_URI).
function registerProtocol() {
  try {
    const uri = REDIRECT_URI || '';
    const proto = uri.split('://')[0];
    if (!proto) { log('No protocol to register (REDIRECT_URI missing or invalid)'); return; }

    if (process.platform === 'win32') {
      // On Windows, registration may require being run as installed app. For dev, this still helps.
      const ok = app.setAsDefaultProtocolClient(proto);
      log('Protocol registration (win32):', proto, ok ? 'OK' : 'FAILED');
    } else if (process.platform === 'darwin') {
      app.setAsDefaultProtocolClient(proto);
      log('Protocol registration (darwin):', proto);
    } else {
      // Linux desktop environments vary. Attempt registration.
      const ok = app.setAsDefaultProtocolClient(proto);
      log('Protocol registration (linux):', proto, ok ? 'OK' : 'FAILED');
    }
  } catch (e) {
    log('Protocol registration error:', e.message || e);
  }
}

// Ensure single instance so deep links are delivered via second-instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv/*, workingDirectory*/) => {
    try {
      // On Windows, deep link URL comes in argv array
      const uri = (argv || []).find(a => typeof a === 'string' && a.includes('://'));
      if (uri) {
        log('Second-instance deep link:', uri);
        // Forward to renderer so it can handle if needed
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auth:log', `Deep link received: ${uri}`); } catch {}
      }
      if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
    } catch {}
  });
}

app.whenReady().then(() => { registerProtocol(); createWindow(); });

// macOS deep link handler
app.on('open-url', (event, url) => {
  event.preventDefault();
  log('open-url deep link:', url);
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auth:log', `Deep link received: ${url}`); } catch {}
});
