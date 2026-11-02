#!/usr/bin/env node
// Offline checks for repository documentation. No service, credentials or network needed.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slash = value => value.split(path.sep).join('/');
const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md', 'RELEASE.md'];
async function walk(dir) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = slash(path.join(dir, entry.name));
    if (entry.isDirectory()) await walk(rel);
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(rel);
  }
}
await walk('docs');
const errors = [];
const records = new Map();
const report = (file, line, reason) => errors.push(file + ':' + line + ': ' + reason);
function parse(file, text) {
  const lines = text.split(/\r?\n/);
  const visible = [];
  const headings = new Set();
  const counts = new Map();
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\s{0,3}(\x60{3,}|~{3,})(.*)$/);
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = null;
      visible.push('');
      continue;
    }
    if (match) {
      fence = { char: match[1][0], length: match[1].length, line: i + 1 };
      visible.push('');
      continue;
    }
    visible.push(line);
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const base = heading[1].replace(/<[^>]*>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '').replace(/ /g, '-');
      const count = counts.get(base) || 0;
      headings.add(base + (count ? '-' + count : ''));
      counts.set(base, count + 1);
    }
    for (const anchor of line.matchAll(/<(?:a|span)\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) headings.add(anchor[1]);
  }
  if (fence) report(file, fence.line, 'Unclosed code fence');
  return { lines, visible, headings };
}
for (const file of files) records.set(file, parse(file, await readFile(path.join(root, file), 'utf8')));
let checked = 0;
for (const [file, record] of records) {
  // Scan examples inside fences too. Public examples should use reserved documentation addresses.
  for (let i = 0; i < record.lines.length; i++) {
    const line = record.lines[i];
    if (/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/.test(line))
      report(file, i + 1, 'Private IPv4 address: replace deployment details with a reserved example');
    if (/[A-Za-z]:[\\/]Users[\\/](?!<|YOUR_USER|USER\b)[^\\/\s)]+/i.test(line))
      report(file, i + 1, 'Personal home-directory path');
  }
  for (let i = 0; i < record.visible.length; i++) {
    const line = record.visible[i].replace(/\x60[^\x60]*\x60/g, '');
    const targets = [...line.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g)].map(m => m[1]);
    const definition = line.match(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/);
    if (definition) targets.push(definition[1]);
    for (let target of targets) {
      target = target.replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
      const hash = target.indexOf('#');
      let fragment = hash < 0 ? '' : target.slice(hash + 1);
      let pathname = (hash < 0 ? target : target.slice(0, hash)).split('?')[0];
      try { pathname = decodeURIComponent(pathname); fragment = decodeURIComponent(fragment); }
      catch { report(file, i + 1, 'Invalid URL encoding: ' + target); continue; }
      const resolved = pathname ? path.resolve(path.dirname(path.join(root, file)), pathname) : path.join(root, file);
      const rel = slash(path.relative(root, resolved));
      if (rel.startsWith('../') || path.isAbsolute(rel)) { report(file, i + 1, 'Link leaves repository: ' + target); continue; }
      try { await stat(resolved); }
      catch { report(file, i + 1, 'Missing local target: ' + target); continue; }
      checked++;
      if (!fragment || !rel.endsWith('.md')) continue;
      let destination = records.get(rel);
      if (!destination) {
        destination = parse(rel, await readFile(resolved, 'utf8'));
        records.set(rel, destination);
      }
      if (!destination.headings.has(fragment)) report(file, i + 1, 'Missing heading anchor: ' + target);
    }
  }
}
if (errors.length) {
  for (const error of errors) console.error(error);
  console.error(errors.length + ' documentation problem(s). External URLs and command behavior were not checked.');
  process.exitCode = 1;
} else {
  console.log('Documentation checks passed: ' + files.length + ' Markdown files, ' + checked + ' local links; fences and basic private-path/address checks passed.');
  console.log('External URLs, generic hostnames, prose accuracy and platform behavior still require review.');
}
