'use strict';
/**
 * Preload — the only bridge between the renderer and the main process.
 *
 * The renderer runs sandboxed with context isolation on, so it has no Node,
 * no filesystem and no child processes. It gets exactly the calls listed here
 * and nothing else.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Wrap a push channel so the renderer receives only the payload, never the
// Electron event object (which would leak the sender).
const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);   // unsubscribe
};

contextBridge.exposeInMainWorld('scale', {
  start:   () => ipcRenderer.invoke('scale:start'),

  /**
   * Take one measurement.
   * @param {{age:number, heightCm:number, sex:'male'|'female'}} profile
   *        The only three facts this app supplies. Everything else comes back.
   */
  measure: (profile) => ipcRenderer.invoke('scale:measure', profile),

  /**
   * Take a reading before the profile is known. The radio window is short; the
   * user's age can wait. Pass `result.measured` to compute() afterwards.
   */
  measureWithoutProfile: (options) => ipcRenderer.invoke('scale:measureWithoutProfile', options),

  /**
   * Interpret a reading taken earlier. Identical to a live measurement with the
   * same profile, and it touches no hardware.
   */
  compute: (measured, profile, context) => ipcRenderer.invoke('scale:compute', measured, profile, context),

  cancel:  () => ipcRenderer.invoke('scale:cancel'),
  status:  () => ipcRenderer.invoke('scale:status'),
  forget:  () => ipcRenderer.invoke('scale:forget'),
  /**
   * Open the settings page that can actually fix this failure.
   * @param {'PERMISSION_DENIED'|'BLUETOOTH_UNAVAILABLE'} code
   */
  openBluetoothSettings: (code) => ipcRenderer.invoke('scale:openBluetoothSettings', code),

  onProgress: on('scale:progress'),
  onLog:      on('scale:log'),
  onError:    on('scale:error'),
  onClosed:   on('scale:closed'),
});
