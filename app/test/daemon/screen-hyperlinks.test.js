'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScreenModel } = require('../../src/daemon/screen.js');

for (const cols of [24, 80]) {
  for (const terminator of ['\x07', '\x1b\\']) {
    test(`OSC 8 leaves multiline question text and cursor intact at ${cols} columns with ${terminator === '\x07' ? 'BEL' : 'ST'}`, async () => {
      const url = 'https://example.invalid/diagnostics?view=full';
      const prefix = 'Run this command:\r\n\r\nprintf diagnostic\r\nThen review ';
      const suffix = '?\r\n\r\n> Draft';
      const plain = new ScreenModel({ cols, rows: 16 });
      const linked = new ScreenModel({ cols, rows: 16 });
      try {
        await plain.write(prefix + url + suffix);
        await linked.write(prefix + `\x1b]8;;${url}${terminator}${url}\x1b]8;;${terminator}` + suffix);
        const expected = await plain.read();
        assert.match(expected.visible, /Run this command:/);
        assert.match(expected.visible, /> Draft/);
        assert.deepEqual(await linked.read(), expected);
      } finally {
        plain.terminal.dispose();
        linked.terminal.dispose();
      }
    });
  }
}

// Claude CLI 2.1.302 makes a URL that wraps one link across all its rows
// (before, only the first row was clickable). The CLI writes a link as
// ESC ] 8 ; ; <url> BEL <text> ESC ] 8 ; ; BEL with no id (read in the 2.1.303
// binary), and its renderer breaks the rows itself, so a wrapped URL arrives as
// one such piece per row. The headless screen must read exactly the plain text.
async function sameAsPlain(cols, plainText, linkedText) {
  const plain = new ScreenModel({ cols, rows: 12 });
  const linked = new ScreenModel({ cols, rows: 12 });
  try {
    await plain.write(plainText);
    await linked.write(linkedText);
    const expected = await plain.read();
    const actual = await linked.read();
    assert.ok(!/\x1b|\]8;/.test(actual.visible), 'no escape bytes leak into the linked screen');
    assert.deepEqual(actual, expected);
    return expected;
  } finally {
    plain.terminal.dispose();
    linked.terminal.dispose();
  }
}

for (const terminator of ['\x07', '\x1b\\']) {
  const name = terminator === '\x07' ? 'BEL' : 'ST';
  const link = (url, text) => `\x1b]8;;${url}${terminator}${text}\x1b]8;;${terminator}`;

  test(`a URL wrapped by the CLI as one link piece per row reads as its plain text (${name})`, async () => {
    const cols = 24;
    const url = 'https://example.invalid/a/very/long/path/that/wraps?x=1';
    const rows = [];
    for (let rest = `  see ${url}`; rest.length; rest = rest.slice(cols)) rows.push(rest.slice(0, cols));
    const linked = rows.map((row, i) => (i === 0 ? `  see ${link(url, row.slice(6))}` : link(url, row))).join('\r\n');
    const expected = await sameAsPlain(cols, `${rows.join('\r\n')}\r\n> Draft`, `${linked}\r\n> Draft`);
    assert.match(expected.visible, /> Draft/);
  });

  // 2.1.302 also fixed an emoji that a link starts inside wrapping one column
  // too wide. A wide emoji that no longer fits the row wraps whole; the link
  // around it must not move it or anything after it.
  test(`a link that starts with an emoji at the row edge reads as its plain text (${name})`, async () => {
    const cols = 24;
    const url = 'https://example.invalid/doc';
    const text = `\u{1F4CE} attached doc`;
    const head = 'x'.repeat(cols - 1);
    const expected = await sameAsPlain(cols, `${head}${text}\r\n> Draft`, `${head}${link(url, text)}\r\n> Draft`);
    assert.match(expected.visible, /attached doc/);
  });
}
