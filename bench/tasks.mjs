// 任务集：**从参考实现移植**，每条任务都带页面内 JS 断言（ground truth）。
//
// 来源与许可（均为 MIT，保留出处）：
//   - BASE / HARD / GUARD 取自 Ying-Kai-Liao/jev-browser `bench/tasks.mjs`
//     （https://github.com/Ying-Kai-Liao/jev-browser，MIT © 2026 Ying-Kai Liao），
//     任务措辞与断言原样保留；我们只改字段名（maxActions → maxSteps）并去掉
//     本插件尚不支持的事件类断言（context-menu / upload，见 HARD 里的 skip）。
//   - OFFLINE 的 hotel 任务取自 browser-use/jev-ultrafast 的本地 fixture
//     （https://github.com/browser-use/jev-ultrafast，MIT © 2026 Browser Use）。
//   - OFFLINE 的 login/select 取自 jkudish/jev-browser `test/fixtures/*.html`
//     （https://github.com/jkudish/jev-browser，MIT © 2026 Joey Kudish）。
//
// 为什么用他们的任务：这是唯一有**硬断言**的公开集。我们自己以前的 bench 只量
// 时间/token，不量"是否真的做对了"；没有 ground truth 就没法回答"这套体系在哪些
// 场景真的强"。
//
// 约定（runner 解释）：
//   - 每个 step 的 `assert` 是页面内 JS，返回真值 = 该步真的达成。
//   - 默认"完成信号"= 本插件返回 `needs_verification`（我们的循环从不自称 done，
//     会把结果交回宿主验证）；`likely_done` 也算"声称完成"，但会被单独统计。
//   - `expect: "fail"` 的任务**不允许**声称完成（needs_verification / likely_done）。
//   - `expectStatus` 覆盖某一步的期望状态（目前只有 guard 用 needs_confirmation）。
//   - `skip` 非空 = 本插件当前不支持该动作/观测，runner 只记录不评分。

const TI = 'https://the-internet.herokuapp.com'
// 本地 fixture：默认用 file://（fixture 自包含、导航走 location.hash，不需要服务器）。
const FIXTURE = process.env.JEV_BENCH_FIXTURE_URL ?? new URL('./fixtures/fixture.html', import.meta.url).href
const FIXTURE_LOGIN = new URL('./fixtures/login.html', import.meta.url).href
const FIXTURE_SELECT = new URL('./fixtures/select.html', import.meta.url).href

export const OFFLINE = [
  {
    id: 'fixture-hotel',
    cat: 'offline',
    url: FIXTURE,
    steps: [
      { goal: 'type Lisbon into the Destination field', values: { Destination: 'Lisbon' } },
      { goal: 'submit the search with the Find stays button' },
      { goal: 'choose the Design category in the Category selector', values: { 'Stay category': 'Design' } },
      { goal: 'enable the Free cancellation checkbox', values: { 'Free cancellation': 'true' } },
      {
        goal: 'open the Casa Flora stay',
        // 只认「真的打开了详情」：卡片列表里本来就有 "Casa Flora" 文本，
        // 用 innerText 判会变成**假断言**（我们在 DESIGN 里记过这个假阳性）。
        assert: "() => location.hash === '#casa-flora'",
      },
    ],
  },
  {
    id: 'jk-login-labels',
    cat: 'offline',
    url: FIXTURE_LOGIN,
    steps: [
      {
        goal: 'type tomsmith into the Username field',
        values: { username: 'tomsmith' },
        assert: "() => document.querySelector('#echo').textContent === 'Typed: tomsmith'",
      },
      {
        goal: 'type s3cret into the Password field',
        values: { password: 's3cret' },
        assert: "() => document.querySelector('#login-secret').value === 's3cret'",
      },
    ],
  },
  {
    id: 'jk-select-by-label',
    cat: 'offline',
    url: FIXTURE_SELECT,
    steps: [
      {
        goal: 'choose Business in the Cabin dropdown',
        values: { cabin: 'Business' },
        assert: "() => document.querySelector('#mark').textContent === 'SELECTED: business'",
      },
    ],
  },
]

export const BASE = [
  // ---------------------------------------------------------------- forms & widgets
  { id: 'ti-login', cat: 'form', url: `${TI}/login`,
    steps: [{ goal: 'Log in', values: { username: 'tomsmith', password: 'SuperSecretPassword!' }, assert: "() => location.pathname === '/secure'" }] },
  { id: 'ti-dropdown', cat: 'widget', url: `${TI}/dropdown`,
    steps: [{ goal: 'Select Option 2 in the dropdown', assert: "() => document.querySelector('#dropdown').value === '2'" }] },
  { id: 'ti-checkboxes', cat: 'widget', url: `${TI}/checkboxes`,
    steps: [{ goal: 'Make checkbox 1 checked and checkbox 2 unchecked', assert: "() => { const c = document.querySelectorAll('#checkboxes input'); return c[0].checked && !c[1].checked }" }] },
  { id: 'ti-inputs', cat: 'form', url: `${TI}/inputs`,
    steps: [{ goal: 'Enter the number 42', values: { number: '42' }, assert: "() => document.querySelector('input[type=number]').value === '42'" }] },
  { id: 'webform', cat: 'form', url: 'https://www.selenium.dev/selenium/web/web-form.html',
    steps: [{ goal: 'Fill in the text input, password, textarea, dropdown and date fields with the given values, choose the second radio button, then submit the form',
      values: { text_input: 'Jev', password: 'pw123', textarea: 'hello world', dropdown: 'Two', date: '09/16/2026' }, maxSteps: 14,
      assert: "() => { const q = new URLSearchParams(location.search); return q.get('my-text') === 'Jev' && q.get('my-password') === 'pw123' && q.get('my-textarea') === 'hello world' && q.get('my-select') === '2' && q.get('my-date') === '09/16/2026' && q.get('my-radio') === 'on' && location.pathname.includes('submitted') }" }] },
  { id: 'webform-fine', cat: 'form', url: 'https://www.selenium.dev/selenium/web/web-form.html',
    steps: [
      { goal: 'Type into the text input', values: { text: 'Jev' } },
      { goal: 'Type into the password field', values: { text: 'pw123' } },
      { goal: 'Type into the textarea', values: { text: 'hello world' } },
      { goal: "Choose 'Two' in the dropdown select", values: { option: 'Two' } },
      { goal: 'Type the date into the date picker field', values: { text: '09/16/2026' } },
      { goal: 'Select the second radio button' },
      { goal: 'Submit the form',
        assert: "() => { const q = new URLSearchParams(location.search); return q.get('my-text') === 'Jev' && q.get('my-password') === 'pw123' && q.get('my-textarea') === 'hello world' && q.get('my-select') === '2' && q.get('my-date') === '09/16/2026' && q.get('my-radio') === 'on' }" },
    ] },

  // ---------------------------------------------------------------- dynamic pages
  { id: 'ti-dynamic-loading', cat: 'dynamic', url: `${TI}/dynamic_loading/2`,
    steps: [{ goal: 'Start the loading and wait until the result text appears', assert: "() => document.querySelector('#finish')?.innerText.includes('Hello World')" }] },
  { id: 'ti-dynamic-controls', cat: 'dynamic', url: `${TI}/dynamic_controls`,
    steps: [{ goal: 'Enable the text field, then type into it', values: { text: 'hello' }, assert: "() => { const i = document.querySelector('#input-example input'); return !i.disabled && i.value === 'hello' }" }] },
  { id: 'ti-add-remove', cat: 'dynamic', url: `${TI}/add_remove_elements/`,
    steps: [{ goal: 'Add elements until there are exactly 3 Delete buttons', assert: "() => document.querySelectorAll('.added-manually').length === 3" }] },
  { id: 'todomvc-fine', cat: 'spa', url: 'https://demo.playwright.dev/todomvc/',
    steps: [
      { goal: "Add a new todo item that says 'buy milk'", values: { text: 'buy milk' }, assert: "() => document.querySelectorAll('.todo-list li').length === 1" },
      { goal: "Add a new todo item that says 'walk the dog'", values: { text: 'walk the dog' }, assert: "() => document.querySelectorAll('.todo-list li').length === 2" },
      { goal: "Mark the 'buy milk' todo as completed", assert: "() => [...document.querySelectorAll('.todo-list li.completed')].map(l => l.innerText.trim()).join('|') === 'buy milk'" },
      { goal: 'Show only the completed todos', assert: "() => location.hash.includes('completed') && document.querySelectorAll('.todo-list li').length === 1" },
      { goal: 'Clear all completed todos', assert: "() => document.querySelectorAll('.todo-list li').length === 0" },
    ] },
  { id: 'todomvc-coarse', cat: 'spa', url: 'https://demo.playwright.dev/todomvc/',
    steps: [{ goal: "Add the two todos, mark 'buy milk' as completed, then clear completed todos", values: { first: 'buy milk', second: 'walk the dog' }, maxSteps: 12,
      assert: "() => [...document.querySelectorAll('.todo-list li')].map(l => l.innerText.trim()).join('|') === 'walk the dog'" }] },

  // ---------------------------------------------------------------- interaction types
  { id: 'ti-hover', cat: 'interaction', url: `${TI}/hovers`,
    steps: [{ goal: 'Reveal the name of the second user by hovering over their picture', assert: "() => getComputedStyle(document.querySelectorAll('.figcaption')[1]).display !== 'none'" }] },
  { id: 'ti-js-confirm', cat: 'interaction', url: `${TI}/javascript_alerts`,
    steps: [{ goal: 'Trigger the JS Confirm dialog and accept it', assert: "() => document.querySelector('#result').innerText === 'You clicked: Ok'" }] },
  { id: 'ti-entry-ad', cat: 'interaction', url: `${TI}/entry_ad`,
    steps: [{ goal: 'Close the advertisement modal', assert: "() => getComputedStyle(document.querySelector('#modal')).display === 'none'" }] },
  { id: 'ti-sort-table', cat: 'interaction', url: `${TI}/tables`,
    steps: [{ goal: 'Sort the first table by Last Name', assert: "() => document.querySelector('#table1 tbody tr td').innerText === 'Bach'" }] },

  // ---------------------------------------------------------------- real sites / navigation
  { id: 'hn-comments', cat: 'navigation', url: 'https://news.ycombinator.com/',
    steps: [{ goal: 'Open the comments page of the top story', assert: "() => location.pathname === '/item'" }] },
  { id: 'books-poetry', cat: 'navigation', url: 'https://books.toscrape.com/',
    steps: [
      { goal: 'Open the Poetry category', assert: "() => location.pathname.includes('poetry')" },
      { goal: "Open the book \"Shakespeare's Sonnets\"", assert: "() => location.pathname.includes('shakespeares-sonnets')" },
    ] },
  { id: 'wiki-search', cat: 'large-page', url: 'https://en.wikipedia.org/wiki/Main_Page',
    steps: [{ goal: 'Search for the article and open it', values: { query: 'Alan Turing' }, assert: "() => location.pathname === '/wiki/Alan_Turing'" }] },
  { id: 'wiki-link', cat: 'large-page', url: 'https://en.wikipedia.org/wiki/Alan_Turing',
    steps: [{ goal: 'Open the linked article about Bletchley Park', assert: "() => location.pathname === '/wiki/Bletchley_Park'" }] },
  { id: 'github-pulls', cat: 'large-page', url: 'https://github.com/microsoft/playwright',
    steps: [{ goal: "Open the repository's Pull requests tab", assert: "() => /\\/pulls\\/?$/.test(location.pathname)" }] },
  { id: 'saucedemo-fine', cat: 'e2e', url: 'https://www.saucedemo.com/',
    steps: [
      { goal: 'Log in', values: { username: 'standard_user', password: 'secret_sauce' } },
      { goal: 'Add the Sauce Labs Backpack to the cart' },
      { goal: 'Open the cart and go to checkout' },
      { goal: 'Fill in the checkout information and continue', values: { first_name: 'Ada', last_name: 'Lovelace', postal_code: '10001' } },
      { goal: 'Finish the order', assert: "() => document.body.innerText.includes('Thank you for your order')" },
    ] },
  { id: 'saucedemo-coarse', cat: 'e2e', url: 'https://www.saucedemo.com/',
    steps: [{ goal: 'Log in, buy the Sauce Labs Backpack and complete the checkout', maxSteps: 20,
      values: { username: 'standard_user', password: 'secret_sauce', first_name: 'Ada', last_name: 'Lovelace', postal_code: '10001' },
      assert: "() => document.body.innerText.includes('Thank you for your order')" }] },

  // ---------------------------------------------------------------- should NOT succeed
  { id: 'neg-bad-password', cat: 'negative', expect: 'fail', url: `${TI}/login`,
    steps: [{ goal: 'Log in', values: { username: 'tomsmith', password: 'wrong-password' }, assert: "() => location.pathname === '/secure'" }] },
  { id: 'neg-missing-page', cat: 'negative', expect: 'fail', url: 'https://books.toscrape.com/',
    steps: [{ goal: "Open the site's pricing page", assert: "() => location.pathname.includes('pricing')" }] },
  { id: 'neg-disabled', cat: 'negative', expect: 'fail', url: 'https://www.selenium.dev/selenium/web/web-form.html',
    steps: [{ goal: 'Type into the disabled input field', values: { text: 'x' }, assert: "() => document.querySelector('[name=my-disabled]').value === 'x'" }] },
]

export const HARD = [
  { id: 'iframe-form', cat: 'iframe', url: 'https://www.selenium.dev/selenium/web/iframes.html',
    steps: [{ goal: 'Type the email address into the email field of the embedded form', values: { email: 'jev@example.com' },
      assert: "() => document.querySelector('#iframe1').contentDocument.querySelector('#email').value === 'jev@example.com'" }] },
  { id: 'iframe-datepicker', cat: 'iframe', url: 'https://jqueryui.com/datepicker/',
    steps: [{ goal: 'Open the date picker and pick the 15th of the month it shows',
      assert: "() => /\\/15\\//.test(document.querySelector('iframe.demo-frame').contentDocument.querySelector('#datepicker').value)" }] },
  { id: 'shadow-checkbox', cat: 'shadow-dom', url: 'https://www.selenium.dev/selenium/web/shadowRootPage.html',
    steps: [{ goal: 'Check the checkbox', assert: "() => document.querySelector('custom-checkbox-element').shadowRoot.querySelector('input').checked" }] },
  { id: 'react-select', cat: 'custom-widget', url: 'https://react-select.com/home',
    steps: [{ goal: 'In the first dropdown on the page, choose the colour Purple',
      assert: "() => document.querySelector('[class*=singleValue]')?.innerText === 'Purple'" }] },
  { id: 'new-window', cat: 'tabs', url: 'https://the-internet.herokuapp.com/windows',
    steps: [{ goal: 'Open the new window', assert: "() => document.body.innerText.includes('New Window') && !location.pathname.endsWith('/windows')" }] },
  { id: 'infinite-scroll', cat: 'lazy', url: 'https://the-internet.herokuapp.com/infinite_scroll',
    steps: [{ goal: 'Scroll down to load more paragraphs', assert: "() => document.querySelectorAll('.jscroll-added').length >= 3" }] },
  { id: 'github-issue-search', cat: 'large-page', url: 'https://github.com/microsoft/playwright/issues',
    steps: [{ goal: "Search this repository's issues for the given words", values: { query: 'flaky screenshot' },
      assert: "() => decodeURIComponent(location.search).replace(/\\+/g, ' ').includes('flaky screenshot')" }] },
  { id: 'drag', cat: 'actions', url: 'https://the-internet.herokuapp.com/drag_and_drop',
    steps: [{ goal: 'Drag box A onto box B', assert: "() => document.querySelector('#column-a header').innerText === 'B'" }] },
  { id: 'context-menu', cat: 'actions', skip: '需要捕获右键菜单事件；本插件不暴露该事件', url: 'https://the-internet.herokuapp.com/context_menu',
    steps: [{ goal: 'Right-click inside the box to open the context menu' }] },
  { id: 'key-press', cat: 'actions', url: 'https://the-internet.herokuapp.com/key_presses',
    steps: [{ goal: 'Press the Escape key', assert: "() => document.querySelector('#result').innerText === 'You entered: ESCAPE'" }] },
  { id: 'upload', cat: 'actions', skip: '本插件的 values 只传字符串；文件上传未实现', url: 'https://the-internet.herokuapp.com/upload',
    steps: [{ goal: 'Upload the file and submit it' }] },
  { id: 'login-wall', cat: 'negative', url: `${TI}/secure`,
    steps: [{ goal: 'Open the secure area', expectStatus: 'needs_login' }] },
  { id: 'neg-missing-option', cat: 'negative', expect: 'fail', url: `${TI}/dropdown`,
    steps: [{ goal: 'Select Option 7 in the dropdown', assert: '() => false' }] },
]

// 只有在"不可逆动作暂停"打开时才有意义：登录/提交表单不该停，Finish 必须停。
export const GUARD = [
  { id: 'guard-login', cat: 'guard', guard: true, url: `${TI}/login`,
    steps: [{ goal: 'Log in', values: { username: 'tomsmith', password: 'SuperSecretPassword!' }, assert: "() => location.pathname === '/secure'" }] },
  { id: 'guard-webform', cat: 'guard', guard: true, url: 'https://www.selenium.dev/selenium/web/web-form.html',
    steps: [{ goal: 'Type into the text input, then submit the form', values: { text: 'Jev' }, assert: "() => location.pathname.includes('submitted')" }] },
  { id: 'guard-checkout', cat: 'guard', guard: true, url: 'https://www.saucedemo.com/',
    steps: [
      { goal: 'Log in', values: { username: 'standard_user', password: 'secret_sauce' } },
      { goal: 'Add the Sauce Labs Backpack to the cart' },
      { goal: 'Open the cart and go to checkout' },
      { goal: 'Fill in the checkout information and continue', values: { first_name: 'Ada', last_name: 'Lovelace', postal_code: '10001' } },
      { goal: 'Finish the order', expectStatus: 'needs_confirmation', assert: "() => !document.body.innerText.includes('Thank you for your order')" },
    ] },
]

export const TIERS = { offline: OFFLINE, base: BASE, hard: HARD, guard: GUARD }
