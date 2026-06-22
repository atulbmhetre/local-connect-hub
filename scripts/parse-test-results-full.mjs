import fs from 'fs';

const text = fs.readFileSync(new URL('../test-results-full.txt', import.meta.url), 'utf8');

const summary = {};
const patterns = {
  total: /Running\s+(\d+)\s+tests/,
  passed: /\n\s*(\d+)\s+passed\b/g,
  failed: /\n\s*(\d+)\s+failed\b/g,
  skipped: /\n\s*(\d+)\s+skipped\b/g,
  didNotRun: /\n\s*(\d+)\s+did\s+not\s+run\b/g,
  flaky: /\n\s*(\d+)\s+flaky\b/g,
};

summary.total = Number(text.match(patterns.total)?.[1] ?? 0);
for (const key of ['passed', 'failed', 'skipped', 'didNotRun', 'flaky']) {
  const re = patterns[key];
  let m;
  let last;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text))) last = m;
  if (last) summary[key] = Number(last[1]);
}

const stripAnsi = (s) =>
  s
    // color codes
    .replace(/\x1b\[[0-9;]*m/g, '')
    // cursor movement / erase / etc (CSI)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    // leftover ESC
    .replace(/\x1b/g, '');
const lines = text.split(/\r?\n/);

const failures = [];
for (let i = 0; i < lines.length; i++) {
  const header = stripAnsi(lines[i]);
  const m = header.match(/^\s*(\d+)\)\s+(tests[\\/].+?)\s+.*?(?:›|ΓÇ║)\s*(.+)$/);
  if (!m) continue;

  const testPath = m[2].trim();
  const testName = m[3].trim();

  let errorText = null;
  for (let j = i + 1; j < Math.min(i + 160, lines.length); j++) {
    const l = stripAnsi(lines[j]).trim();
    if (!l.startsWith('Error:')) continue;

    const extra = [];
    for (let k = j + 1; k < Math.min(j + 30, lines.length); k++) {
      const t = stripAnsi(lines[k]).trim();
      if (/^(Received:|Expected:|Locator:|Timeout:|\{|code:|message:)/.test(t)) extra.push(t);
      else if (extra.length) break;
    }

    errorText = [l, ...extra].join('\n');
    break;
  }

  failures.push({
    test: `${testPath} › ${testName}`,
    error: errorText ?? '(no Error: line found)',
  });
}

// de-dupe (original + retry blocks)
const seen = new Set();
const uniqueFailures = failures.filter((f) => {
  if (seen.has(f.test)) return false;
  seen.add(f.test);
  return true;
});

console.log(JSON.stringify({ summary, failedTests: uniqueFailures }, null, 2));

