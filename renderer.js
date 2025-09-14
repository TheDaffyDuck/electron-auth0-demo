// Renderer logic for the demo UI: handles button clicks, displays token and logs.
window.addEventListener("DOMContentLoaded", () => {
  const loginBtn = document.getElementById("login");
  const copyBtn = document.getElementById("copyOutput");
  const logoutBtn = document.getElementById("logout");
  const output = document.getElementById("output");
  const status = document.getElementById("status");
  const logEl = document.getElementById("log");

  // Simple copy-to-clipboard helper for the Bearer token
  copyBtn.addEventListener('click', () => {
    const text = output.textContent.trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      const original = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = original, 1500);
    });
  });

  const appendLog = (line) => {
    const ts = new Date().toISOString();
    logEl.textContent += `[${ts}] ${line}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  };

  // Subscribe to logs from main process
  try {
    window.auth.onLog((line) => appendLog(line));
  } catch {}

  // Login button handler
  loginBtn.addEventListener("click", async () => {
    output.textContent = "";
    status.textContent = "Opening Auth0...";
    appendLog('Login button clicked');
    try {
      const res = await window.auth.login();
      appendLog('Login result received');

      if (res.tokens && res.tokens.access_token) {
        const bearerToken = `Bearer ${res.tokens.access_token}`;
        status.textContent = "Signed in successfully. Token:";
        output.textContent = bearerToken;
        appendLog('Access token displayed in Bearer format');
      } else if (res.error) {
        status.innerHTML = `<span class="error">Error: ${res.error}</span>` + (res.error_description ? ` - ${res.error_description}` : "");
        if (res.details) {
          output.textContent = JSON.stringify(res.details, null, 2);
        }
        appendLog('Error result: ' + JSON.stringify(res));
      } else {
        status.textContent = "Unknown result.";
        appendLog('Unknown result structure');
      }
    } catch (e) {
      status.innerHTML = `<span class="error">Exception: ${String(e)}</span>`;
      appendLog('Exception thrown: ' + String(e));
    }
  });

  // Logout handler
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      appendLog('Logout button clicked');
      status.textContent = 'Signing out...';
      try {
        const res = await window.auth.logout();
        if (res && res.ok) {
          status.textContent = 'You have signed out.';
          output.textContent = '';
          appendLog('Logout success');
        } else if (res && res.error) {
          status.innerHTML = `<span class="error">Logout error: ${res.error}</span>` + (res.error_description ? ` - ${res.error_description}` : '');
          appendLog('Logout error: ' + JSON.stringify(res));
        } else {
          status.textContent = 'Sign-out finished (session may not be fully cleared).';
          appendLog('Logout result (unknown structure)');
        }
      } catch (e) {
        status.innerHTML = `<span class="error">Exception during logout: ${String(e)}</span>`;
        appendLog('Logout exception: ' + String(e));
      }
    });
  }
});
