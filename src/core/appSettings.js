// AppSettings — small JSON-backed key/value store for persisted UI
// preferences (last-used cwd, future: theme, default permission mode,
// etc.). Synchronous on read, async-write on update.
//
// Design choices:
//   - Synchronous reads. Settings are tiny; blocking briefly on
//     startup is fine and avoids a Promise wrapper everywhere.
//   - Async writes via writeFileSync after each set(). Atomic via
//     rename of a tmp file so a crash mid-write can't corrupt the
//     existing settings.
//   - Garbage-on-disk = empty, non-fatal. We never want a corrupted
//     settings file to break app startup.

const fs = require('fs');
const path = require('path');

class AppSettings {
  constructor({ file }) {
    if (!file) throw new Error('AppSettings: file is required');
    // The settings file must be an absolute, caller-controlled path (an
    // app-data location), never a value derived from untrusted input. Pin it to
    // an absolute resolved path so every fs op below operates on a fixed target
    // and CodeQL (js/path-injection) sees a single non-tainted sink. A relative
    // path here is a programming error.
    if (!path.isAbsolute(file)) {
      throw new Error(`AppSettings: file must be an absolute path, got: ${file}`);
    }
    this.file = path.resolve(file);
    this.values = this._load();
  }

  get(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(this.values, key)) return this.values[key];
    return fallback;
  }

  set(key, value) {
    this.values[key] = value;
    this._save();
  }

  all() {
    // Return a shallow copy so callers can't mutate our internal state.
    return { ...this.values };
  }

  _load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return {};
    } catch {
      return {};
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      // Settings persistence is best-effort. A failure here means the
      // value won't survive a restart — the running app still works.
    }
  }
}

module.exports = { AppSettings };
