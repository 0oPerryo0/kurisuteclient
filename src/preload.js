const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('client', {
  command: (name, value) => ipcRenderer.invoke('client:command', name, value),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('client:state', listener);
    return () => ipcRenderer.removeListener('client:state', listener);
  },
});
