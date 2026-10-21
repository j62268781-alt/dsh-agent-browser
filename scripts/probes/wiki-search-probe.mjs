#!/usr/bin/env node
/**
 * wiki-search 假完成探针：往维基搜索框输入 `Alan Turing`，在 0/150/400/800ms 各跑一次
 * `lib/extract.js` 的 EXTRACT_SCRIPT，看**搜索建议下拉**是否进候选、里面有没有
 * 纯条目「Alan Turing」（目标）与陷阱项「Alan Turing: The Enigma」（传记书）。
 *
 * 另测：suggestion 的 DOM 标签/role 是否在抽取 selector 覆盖内；填完按 Enter 去哪。
 *
 * 用法：node scripts/probes/wiki-search-probe.mjs [--session dsh-probe]
 */
import { spawnSync } from 'node:child_process'
import { EXTRACT_SCRIPT } from '../../lib/extract.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const SESSION = opt('--session', 'dsh-probe')
const URL = opt('--url', 'https://en.wikipedia.org/wiki/Main_Page')

function cli(argv, input) {
  const proc = spawnSync('agent-browser', argv, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' }
}
const strip = (text) =>
  text.replace(/^\s*---\s*(?:END_)?AGENT_BROWSER_(?:PAGE_)?CONTENT[^\n]*---\s*$/gim, '').trim()

const open = cli(['--session', SESSION, 'open', URL])
console.log(`[open] exit=${open.code}`)
if (open.code !== 0) {
  console.error(strip(open.stderr || open.stdout).slice(0, 1500))
  process.exit(open.code ?? 1)
}
cli(['--session', SESSION, 'wait', '--load', 'load'])
// 真机：刚 open 完就输入时 Vector 2022 的搜索建议 JS 还没初始化（会 0 建议、0 listbox）；
// runTask 里也有 2.5s 就绪门。这里固定留 3s 再输入，保证测的是"建议下拉本身"而不是"还没初始化"。
cli(['--session', SESSION, 'eval', 'new Promise((resolve) => setTimeout(resolve, 3000)).then(() => "settled")'])

const pageScript = `(async () => {
  const EXTRACT = ${JSON.stringify(EXTRACT_SCRIPT)};
  const input = document.querySelector('input[name=search]') || document.querySelector('#searchInput');
  if (input === null) return JSON.stringify({ error: 'no search input' });
  const selector = 'a,button,input,select,textarea,summary,label[for],[contenteditable=""],[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="tab"],[aria-checked],[aria-selected],[onclick],[tabindex]';
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'Alan Turing');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Alan Turing' }));
  const t0 = performance.now();
  const samples = [];
  const domInfo = () => {
    const boxes = [...document.querySelectorAll('[role=listbox], .suggestions, .suggestions-results')];
    const items = [...document.querySelectorAll('.suggestions-result, [role=option], .suggestions-results a')];
    return {
      listboxes: boxes.map((el) => ({ tag: el.tagName, role: el.getAttribute('role'), cls: String(el.className).slice(0, 60), visible: !!(el.offsetWidth || el.offsetHeight), text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 100) })),
      suggestionNodes: items.slice(0, 4).map((el) => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        cls: String(el.className).slice(0, 60),
        inSelector: el.matches(selector),
        text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 90),
      })),
      inputValue: (document.querySelector('input[name=search]') || {}).value,
    };
  };
  const take = (label) => {
    const parsed = JSON.parse(eval(EXTRACT));
    const hits = parsed.items.filter((it) => /Alan Turing/i.test(String(it[2])));
    samples.push({
      label,
      dt: Math.round(performance.now() - t0),
      items: parsed.items.length,
      covered: parsed.items.filter((it) => Number(it[3]) === 1).length,
      truncated: parsed.truncated === true,
      alanHits: hits.slice(0, 14).map((it) => [it[0], it[1], it[2], it[3]]),
      exactArticle: hits.some((it) => /^Alan Turing(\\s|$)|^Alan Turing\\s/.test(String(it[2]))),
      enigmaTrap: parsed.items.some((it) => /Enigma/i.test(String(it[2]))),
      dom: domInfo(),
    });
  };
  take('t0');
  for (const delay of [150, 400, 800]) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay - (performance.now() - t0))));
    take('t' + delay);
  }
  return JSON.stringify(samples);
})()`

const measured = cli(['--session', SESSION, 'eval', '--json', '--stdin'], pageScript)
if (measured.code !== 0) {
  console.error('[eval] exit', measured.code, strip(measured.stderr || measured.stdout).slice(0, 1500))
  process.exit(1)
}
const envelope = JSON.parse(strip(measured.stdout))
let samples = envelope.data?.result
if (typeof samples === 'string') samples = JSON.parse(samples)
console.log('=== 建议下拉在抽取脚本里的可见性（输入后 0/150/400/800ms） ===')
console.log(JSON.stringify(samples, null, 1))
