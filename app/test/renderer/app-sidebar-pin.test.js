'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
test('the App test pin does not change the shared rail store', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.jsx'), 'utf8');
  const assignment = app.slice(app.indexOf('window.__setSidebarModelForTest ='), app.indexOf('window.__setTranscriptForTest ='));
  let appModel = null; let sharedModel = { projects: ['real rail'] };
  const context = { window: {}, pinnedTestModelRef: { current: false }, setAppTestModel: (value) => { appModel = value; }, sidebarStore: () => ({ setTestModel: (value) => { sharedModel = value; } }) };
  vm.runInNewContext(assignment, context);
  const pinned = { projects: ['stage fixture'] }; context.window.__setSidebarModelForTest(pinned);
  assert.equal(appModel, pinned); assert.deepEqual(sharedModel, { projects: ['real rail'] });
  context.window.__setSidebarModelForTest(null); assert.equal(appModel, null);
  assert.match(app, /const sidebarModel = appTestModel \|\| sidebarState.model/);
});
