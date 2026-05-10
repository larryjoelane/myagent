// Editor BrowserWindow entry point. Loaded by renderer/editor.html
// (a second Vite entry — see vite.config.js). Hosts the file-tabs +
// file-editor components and listens for editor:load-file pushes
// from main via window.transport.editor.onLoadFile.

import './components/file-tabs.js';
import './components/file-editor.js';
