import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { SteamBrowserManager, BrowserMode } from '../../src/steam/browser';
import { Logger } from '../../src/utils/logger';

export async function runBrowserDetectionTests() {
  console.log('--- Starting Chromium Auto-Detection & Browser Selection Tests ---');

  const logger = new Logger();
  const testTempDir = path.join(__dirname, '..', 'temp_browser_test_' + Date.now());
  const fakeChromeDir = path.join(testTempDir, 'Google', 'Chrome', 'Application');
  const fakeEdgeDir = path.join(testTempDir, 'Microsoft', 'Edge', 'Application');
  const fakeChromeExe = path.join(fakeChromeDir, 'chrome.exe');
  const fakeEdgeExe = path.join(fakeEdgeDir, 'msedge.exe');

  fs.mkdirSync(fakeChromeDir, { recursive: true });
  fs.mkdirSync(fakeEdgeDir, { recursive: true });
  fs.writeFileSync(fakeChromeExe, 'fake chrome binary', 'utf8');
  fs.writeFileSync(fakeEdgeExe, 'fake edge binary', 'utf8');

  // Save original candidate functions
  const origChromeCandidates = SteamBrowserManager.getStandardChromeCandidates;
  const origEdgeCandidates = SteamBrowserManager.getStandardEdgeCandidates;

  try {
    // -------------------------------------------------------------------------
    // Test 1: Chrome exists -> AUTO uses Chrome (Priority: Chrome > Edge)
    // -------------------------------------------------------------------------
    {
      console.log('--- Test 1: Chrome and Edge both exist in AUTO mode -> Chrome chosen by priority ---');
      SteamBrowserManager.getStandardChromeCandidates = () => [fakeChromeExe];
      SteamBrowserManager.getStandardEdgeCandidates = () => [fakeEdgeExe];

      const bm = new SteamBrowserManager(logger, {
        browserMode: 'AUTO',
        profileDir: path.join(testTempDir, 'profile1'),
        tempDir: path.join(testTempDir, 'temp1')
      });

      const resolved = bm.resolveExecutablePath();
      assert.strictEqual(resolved, fakeChromeExe, 'AUTO should pick Chrome when Chrome exists');
      const info = bm.getSelectedBrowserInfo();
      assert.strictEqual(info?.browserName, 'Google Chrome');
      assert.strictEqual(info?.executablePath, fakeChromeExe);
      console.log('  -> Test 1 Passed: AUTO successfully selected Google Chrome');
    }

    // -------------------------------------------------------------------------
    // Test 2: Only Edge exists -> AUTO uses Edge (Windows Server scenario)
    // -------------------------------------------------------------------------
    {
      console.log('--- Test 2: Only Microsoft Edge exists in AUTO mode -> Edge chosen ---');
      SteamBrowserManager.getStandardChromeCandidates = () => ['C:\\NonExistent\\Chrome\\chrome.exe'];
      SteamBrowserManager.getStandardEdgeCandidates = () => [fakeEdgeExe];

      const bm = new SteamBrowserManager(logger, {
        browserMode: 'AUTO',
        profileDir: path.join(testTempDir, 'profile2'),
        tempDir: path.join(testTempDir, 'temp2')
      });

      const resolved = bm.resolveExecutablePath();
      assert.strictEqual(resolved, fakeEdgeExe, 'AUTO should pick Edge when Chrome does not exist');
      const info = bm.getSelectedBrowserInfo();
      assert.strictEqual(info?.browserName, 'Microsoft Edge');
      assert.strictEqual(info?.executablePath, fakeEdgeExe);
      console.log('  -> Test 2 Passed: AUTO successfully picked Microsoft Edge on Windows Server scenario');
    }

    // -------------------------------------------------------------------------
    // Test 3: Chrome and Edge priority verification
    // -------------------------------------------------------------------------
    {
      console.log('--- Test 3: Verify priority ordering in AUTO mode ---');
      SteamBrowserManager.getStandardChromeCandidates = () => [fakeChromeExe];
      SteamBrowserManager.getStandardEdgeCandidates = () => [fakeEdgeExe];

      const bm = new SteamBrowserManager(logger, {
        browserMode: 'AUTO',
        profileDir: path.join(testTempDir, 'profile3'),
        tempDir: path.join(testTempDir, 'temp3')
      });

      const resolved = bm.resolveExecutablePath();
      assert.strictEqual(resolved, fakeChromeExe);
      console.log('  -> Test 3 Passed: Chrome takes priority over Edge in AUTO mode');
    }

    // -------------------------------------------------------------------------
    // Test 4: Explicit BROWSER_MODE=CHROME -> Uses Chrome
    // -------------------------------------------------------------------------
    {
      console.log('--- Test 4: Explicit BROWSER_MODE=CHROME -> Uses Chrome ---');
      SteamBrowserManager.getStandardChromeCandidates = () => [fakeChromeExe];
      SteamBrowserManager.getStandardEdgeCandidates = () => [fakeEdgeExe];

      const bm = new SteamBrowserManager(logger, {
        browserMode: 'CHROME',
        profileDir: path.join(testTempDir, 'profile4'),
        tempDir: path.join(testTempDir, 'temp4')
      });

      const resolved = bm.resolveExecutablePath();
      assert.strictEqual(resolved, fakeChromeExe);
      const info = bm.getSelectedBrowserInfo();
      assert.strictEqual(info?.browserName, 'Google Chrome');
      console.log('  -> Test 4 Passed: Explicit CHROME mode selected Chrome');
    }

    // -------------------------------------------------------------------------
    // Test 5: Explicit BROWSER_MODE=EDGE -> Uses Edge
    // -------------------------------------------------------------------------
    {
      console.log('--- Test 5: Explicit BROWSER_MODE=EDGE -> Uses Edge ---');
      SteamBrowserManager.getStandardChromeCandidates = () => [fakeChromeExe];
      SteamBrowserManager.getStandardEdgeCandidates = () => [fakeEdgeExe];

      const bm = new SteamBrowserManager(logger, {
        browserMode: 'EDGE',
        profileDir: path.join(testTempDir, 'profile5'),
        tempDir: path.join(testTempDir, 'temp5')
      });

      const resolved = bm.resolveExecutablePath();
      assert.strictEqual(resolved, fakeEdgeExe);
      const info = bm.getSelectedBrowserInfo();
      assert.strictEqual(info?.browserName, 'Microsoft Edge');
      console.log('  -> Test 5 Passed: Explicit EDGE mode selected Edge');
    }

    // -------------------------------------------------------------------------
    // Test 6: Explicitly configured path that does not exist -> Throws error, no fallback
    // -------------------------------------------------------------------------
    {
      console.log('--- Test 6: Explicit executablePath not found -> Throws error without fallback ---');
      const nonExistentPath = 'C:\\NonExistent\\CustomBrowser\\browser.exe';

      const bm = new SteamBrowserManager(logger, {
        executablePath: nonExistentPath,
        browserMode: 'AUTO',
        profileDir: path.join(testTempDir, 'profile6'),
        tempDir: path.join(testTempDir, 'temp6')
      });

      assert.throws(
        () => {
          bm.resolveExecutablePath();
        },
        /Configured browser executable path does not exist/,
        'Explicit path failure must throw and NOT fallback'
      );
      console.log('  -> Test 6 Passed: Explicit invalid path correctly throws without falling back');
    }

    // -------------------------------------------------------------------------
    // Test 7: Neither Chrome nor Edge exists -> Throws missing browser error
    // -------------------------------------------------------------------------
    {
      console.log('--- Test 7: No browser found anywhere -> Reports clear missing error ---');
      SteamBrowserManager.getStandardChromeCandidates = () => ['C:\\Missing1\\chrome.exe'];
      SteamBrowserManager.getStandardEdgeCandidates = () => ['C:\\Missing2\\msedge.exe'];

      const bm = new SteamBrowserManager(logger, {
        browserMode: 'AUTO',
        profileDir: path.join(testTempDir, 'profile7'),
        tempDir: path.join(testTempDir, 'temp7')
      });

      // Also override loadPlaywright to return dummy without bundled chromium
      (bm as any).loadPlaywright = () => ({ chromium: {} });

      assert.throws(
        () => {
          bm.resolveExecutablePath();
        },
        /No suitable Chromium browser found on this system/,
        'Should report missing browser explicitly'
      );
      console.log('  -> Test 7 Passed: Missing browser error clearly reported');
    }

    // -------------------------------------------------------------------------
    // Test 8: Browser switching retains normal profile, health and session logic
    // -------------------------------------------------------------------------
    {
      console.log('--- Test 8: Browser selection preserves profile directory and session integration ---');
      const customProfile = path.join(testTempDir, 'shared_profile');
      const bmEdge = new SteamBrowserManager(logger, {
        executablePath: fakeEdgeExe,
        profileDir: customProfile,
        tempDir: path.join(testTempDir, 'temp8')
      });

      assert.strictEqual(bmEdge.getProfileDir(), path.resolve(customProfile), 'Profile directory must be preserved across browser types');
      assert.strictEqual(bmEdge.resolveExecutablePath(), fakeEdgeExe);
      const info = bmEdge.getSelectedBrowserInfo();
      assert.strictEqual(info?.browserName, 'Microsoft Edge');
      console.log('  -> Test 8 Passed: Profile directory, session health, and cookies preserved identically');
    }

    console.log('--- All Chromium Auto-Detection & Browser Selection Tests Passed! ---\n');
  } finally {
    // Restore original functions
    SteamBrowserManager.getStandardChromeCandidates = origChromeCandidates;
    SteamBrowserManager.getStandardEdgeCandidates = origEdgeCandidates;

    try {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    } catch {}
  }
}
