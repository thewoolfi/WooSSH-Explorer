/**
 * The virtual path model behind "My Computer".
 *
 * Worth testing on its own because the translation between `/C:/Users` and `C:\Users` is
 * where this feature is most likely to be quietly wrong — a wrong parent here turns into a
 * back button that goes nowhere.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeLocalPath, toNativePath, toVirtualPath } from '../../src/local/localFs.js';

const isWindows = process.platform === 'win32';

describe('local path translation', () => {
  it('keeps the drive as the first segment, with a trailing slash at its root', () => {
    if (!isWindows) {
      // Off Windows the same model degrades to plain absolute paths; there are no drives.
      assert.equal(normalizeLocalPath('/home/anna'), '/home/anna');
      assert.equal(normalizeLocalPath('/home/../etc'), '/etc');
      return;
    }
    assert.equal(normalizeLocalPath('/C:/'), '/C:/');
    assert.equal(normalizeLocalPath('/C:/Users'), '/C:/Users');
    assert.equal(normalizeLocalPath('/c:/users'), '/C:/users');
    assert.equal(normalizeLocalPath('/c:\\Users\\Admin'), '/C:/Users/Admin');
  });

  it('collapses . and .. ', () => {
    if (!isWindows) {
      assert.equal(normalizeLocalPath('/home/../etc'), '/etc');
      assert.equal(normalizeLocalPath('/home/./anna/'), '/home/anna');
      return;
    }
    assert.equal(normalizeLocalPath('/C:/Users/../Windows'), '/C:/Windows');
    assert.equal(normalizeLocalPath('/C:/./Users/'), '/C:/Users');
    // Above the root of a drive is the list of drives, which is where "up" should lead.
    assert.equal(normalizeLocalPath('/C:/..'), '/');
  });

  it('round-trips a drive path through the native form', () => {
    const samples = isWindows
      ? ['/C:/', '/C:/Users', '/C:/Program Files/WooSSH']
      : ['/', '/home', '/home/anna'];
    for (const virtual of samples) {
      const native = toNativePath(virtual);
      const back = toVirtualPath(native);
      assert.equal(normalizeLocalPath(back), virtual, `${virtual} → ${native} → ${back}`);
    }
  });

  it('leaves non-drive paths alone', () => {
    // The drive list has no native equivalent and must not be mangled by translation.
    assert.equal(toNativePath('/'), '/');
  });
});
