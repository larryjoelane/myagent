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
    // app-data location), never a value derived from untrusted input. A relative
    // path is a programming error. We pin the dir + file here; each fs op below
    // re-checks containment inline (js/path-injection barrier).
    if (!path.isAbsolute(file)) {
      throw new Error(`AppSettings: file must be an absolute path, got: ${file}`);
    }
    this.fileDir = path.resolve(path.dirname(file));
    this.file = path.resolve(this.fileDir, path.basename(file));
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
    // js/path-injection barrier (inlined at the sink): resolve + require the
    // file stays inside its pinned dir before reading.
    const file = path.resolve(this.fileDir, path.basename(this.file));
    if (!file.startsWith(this.fileDir + path.sep)) return {};
    try {
      const text = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return {};
    } catch {
      return {};
    }
  }

  _save() {
    // js/path-injection barrier (inlined at the sinks): resolve + require both
    // the target and its tmp sibling stay inside the pinned settings dir.
    const file = path.resolve(this.fileDir, path.basename(this.file));
    const tmp = file + '.tmp';
    if (!file.startsWith(this.fileDir + path.sep) || !tmp.startsWith(this.fileDir + path.sep)) {
      return;
    }
    try {
      fs.mkdirSync(this.fileDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      // Settings persistence is best-effort. A failure here means the
      // value won't survive a restart — the running app still works.
    }
  }
}

module.exports = { AppSettings };
