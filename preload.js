// Preload script
// Exposes a minimal, safe API to the renderer for auth actions and log streaming.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('auth', {
  // Starts the Auth0 login flow; resolves with tokens or an error object.
  login: async () => {
    return await ipcRenderer.invoke('auth:login');
  },
  // Initiates logout from Auth0 session.
  logout: async () => {
    return await ipcRenderer.invoke('auth:logout');
  },
  // Subscribe to log messages emitted by the main process.
  onLog: (cb) => {
    const listener = (_e, line) => cb(line);
    ipcRenderer.on('auth:log', listener);
    return () => ipcRenderer.removeListener('auth:log', listener);
  }
});
