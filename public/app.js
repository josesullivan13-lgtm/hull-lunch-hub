let CONFIG = null;
let MENU = [];
let SLOTS = [];
let selectedMenuItemId = '';
let selectedMenuCategory = 'build-your-own';
let selectedPickupTime = '';
let selectedMenuItem = null;
let selectedSelections = {};
let selectedAddDrink = false;
let currentMenuSetup = null;
let kitchenKey = '';
let kitchenSignedIn = false;
let autoRefreshTimer = null;
let lastOrdersSignature = '';
// v18 weekly rolling menu state
let weeklyData = null;        // response from GET /api/weekly-menus
let weeklySelectedDay = '';   // 'mon'..'fri'
let weeklyDirty = false;      // unsaved edits in the weekly editor

const $ = (id) => document.getElementById(id);

init();

async function init() {
  setupTabs();
  setupActions();
  await loadConfig();
  await Promise.all([loadMenu(), loadSlots()]);
  await loadHealth();
  renderHeaderStats();
  renderMenu();
  renderSlots();
  updateSelectedSummary();
  updateOrderButton();
}

function setupTabs() {
  const path = window.location.pathname.toLowerCase();
  const showView = (id) => {
    document.querySelectorAll('.app-view').forEach(panel => panel.classList.remove('active'));
    const panel = document.getElementById(id);
    if (panel) panel.classList.add('active');
  };

  if (path.includes('/kitchen')) {
    showView('kitchenTab');
  } else {
    showView('orderTab');
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.app-view').forEach(panel => panel.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.tab).classList.add('active');
    });
  });
}

function setupActions() {
  $('customerName').addEventListener('input', updateOrderButton);
  $('department').addEventListener('input', updateOrderButton);
  $('placeOrderBtn').addEventListener('click', placeOrder);
  $('exportCsvBtn').addEventListener('click', exportCsv);
  if ($('clearOrdersBtn')) $('clearOrdersBtn').addEventListener('click', clearOrders);
  $('loadMenuSetupBtn').addEventListener('click', loadMenuSetup);
  $('saveMenuSetupBtn').addEventListener('click', saveMenuSetup);

  // Diet tag toggles inside the menu editor (delegated so it survives re-renders)
  const menuForm = $('menuSetupForm');
  if (menuForm) {
    menuForm.addEventListener('click', (e) => {
      const btn = e.target.closest('.diet-toggle');
      if (!btn) return;
      const on = btn.classList.toggle('on');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // v18 Weekly menus: same delegated diet toggles, plus "unsaved changes" tracking
  const weeklyForm = $('weeklyForm');
  if (weeklyForm) {
    weeklyForm.addEventListener('click', (e) => {
      const btn = e.target.closest('.diet-toggle');
      if (!btn) return;
      const on = btn.classList.toggle('on');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      setWeeklyDirty(true);
    });
    weeklyForm.addEventListener('input', () => setWeeklyDirty(true));
  }
  const weekdayPicker = $('weekdayPicker');
  if (weekdayPicker) {
    weekdayPicker.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-weekday]');
      if (btn) selectWeeklyDay(btn.dataset.weekday);
    });
  }
  if ($('saveWeeklyBtn')) $('saveWeeklyBtn').addEventListener('click', () => saveWeeklyMenu());
  if ($('activateWeeklyBtn')) $('activateWeeklyBtn').addEventListener('click', activateWeeklyMenu);
  if ($('copyLiveToWeeklyBtn')) $('copyLiveToWeeklyBtn').addEventListener('click', copyLiveToWeekly);

  // Kitchen: sign in / out
  const signInBtn = $('kitchenSignInBtn');
  if (signInBtn) signInBtn.addEventListener('click', kitchenSignIn);
  const adminKeyInput = $('adminKey');
  if (adminKeyInput) {
    adminKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') kitchenSignIn(); });
  }
  const signOutBtn = $('kitchenSignOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', kitchenSignOut);

  // Kitchen: sub-tab switching (Orders / Menu setup)
  document.querySelectorAll('[data-kitchen-view]').forEach(btn => {
    btn.addEventListener('click', () => switchKitchenView(btn.dataset.kitchenView));
  });

  // Kitchen: manual refresh + auto-refresh toggle
  const refreshBtn = $('refreshOrdersBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadKitchenOrders({ quiet: false }));
  const autoToggle = $('autoRefreshToggle');
  if (autoToggle) autoToggle.addEventListener('change', () => {
    if (autoToggle.checked) startAutoRefresh();
    else stopAutoRefresh();
  });
}

async function kitchenSignIn() {
  const key = ($('adminKey').value || '').trim();
  if (!key) {
    setLoginNotice('error', 'Please enter the kitchen password.');
    return;
  }
  setLoginNotice('', 'Signing in…');
  try {
    // Verify the password by attempting an authenticated request.
    await api(`/api/summary?date=${encodeURIComponent(CONFIG.date)}&adminKey=${encodeURIComponent(key)}`);
    kitchenKey = key;
    kitchenSignedIn = true;
    $('kitchenLogin').hidden = true;
    $('kitchenApp').hidden = false;
    switchKitchenView('ordersView');
    await loadKitchenOrders({ quiet: false });
    startAutoRefresh();
  } catch (err) {
    setLoginNotice('error', 'That password was not recognised. Please try again.');
  }
}

function kitchenSignOut() {
  stopAutoRefresh();
  kitchenKey = '';
  kitchenSignedIn = false;
  lastOrdersSignature = '';
  weeklyData = null;
  weeklyDirty = false;
  $('adminKey').value = '';
  $('kitchenApp').hidden = true;
  $('kitchenLogin').hidden = false;
  setLoginNotice('', 'Ask your manager for the kitchen password if you don’t have it.');
}

function setLoginNotice(kind, message) {
  const el = $('loginNotice');
  if (!el) return;
  el.className = `notice${kind ? ' ' + kind : ''}`;
  el.textContent = message;
}

function switchKitchenView(viewId) {
  // v18: don't silently lose unsaved weekly edits when leaving the tab
  const leavingWeekly = $('weeklyView') && $('weeklyView').classList.contains('active') && viewId !== 'weeklyView';
  if (leavingWeekly && weeklyDirty && !confirm(`You have unsaved changes to ${weekdayName(weeklySelectedDay)}'s menu. Leave without saving?`)) return;
  if (leavingWeekly && weeklyDirty) { weeklyDirty = false; renderWeeklyEditor(); }
  document.querySelectorAll('.kitchen-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('[data-kitchen-view]').forEach(b => b.classList.remove('active'));
  const view = $(viewId);
  if (view) view.classList.add('active');
  const btn = document.querySelector(`[data-kitchen-view="${viewId}"]`);
  if (btn) btn.classList.add('active');
  // Auto-load the menu editor the first time it is opened.
  if (viewId === 'menuView' && !currentMenuSetup) loadMenuSetup();
  if (viewId === 'weeklyView' && !weeklyData) loadWeeklyMenus();
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => {
    if (kitchenSignedIn && $('ordersView').classList.contains('active')) {
      loadKitchenOrders({ quiet: true });
    }
  }, 15000);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = typeof data === 'object' && data.message ? data.message : `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return data;
}

async function loadConfig() {
  CONFIG = await api('/api/config');
  const capacityText = $('capacityText');
  if (capacityText) capacityText.textContent = `${CONFIG.slotCapacity} per slot`;
  $('customerNotice').innerHTML = `Lunch collection is available between <strong>${CONFIG.orderStartTime}</strong> and <strong>${CONFIG.orderEndTime}</strong>. Build your lunch, add your details and select a collection time.`;
}

async function loadMenu() {
  const data = await api(`/api/menu?date=${encodeURIComponent(CONFIG.date)}`);
  MENU = orderMenu(data.menu || []);

  if (!MENU.length) {
    selectedMenuItemId = '';
    selectedMenuItem = null;
    selectedSelections = {};
    selectedAddDrink = false;
    return;
  }

  const existingSelection = selectedMenuItemId ? MENU.find(item => item.id === selectedMenuItemId) : null;
  if (!existingSelection) {
    setSelectedMenuItem(MENU[0], { resetDrink: true });
  } else {
    selectedMenuItem = existingSelection;
  }
}

async function loadSlots() {
  const data = await api(`/api/slots?date=${encodeURIComponent(CONFIG.date)}`);
  SLOTS = data.slots || [];
}

async function loadHealth() {
  try {
    const health = await api('/api/health');
    const block = $('healthBlock');
    if (block) block.textContent = JSON.stringify(health, null, 2);
  } catch (err) {
    const block = $('healthBlock');
    if (block) block.textContent = err.message;
  }
}

function renderHeaderStats() {
  return;
}

function renderMenu() {
  const container = $('menuContainer');
  if (!MENU.length) {
    container.innerHTML = '<div class="notice">Today’s menu is not available yet.</div>';
    return;
  }

  if (!selectedMenuItem) setSelectedMenuItem(MENU[0], { resetDrink: true });
  const categories = [];
  if (MENU.some(item => menuCategoryFor(item) === 'build-your-own')) categories.push(['build-your-own', 'Build Your Own']);
  if (MENU.some(item => menuCategoryFor(item) === 'hot2go')) categories.push(['hot2go', 'Hot2Go']);
  if (!categories.some(([category]) => category === selectedMenuCategory)) {
    selectedMenuCategory = categories[0][0];
    const firstInCategory = MENU.find(item => menuCategoryFor(item) === selectedMenuCategory);
    if (firstInCategory) setSelectedMenuItem(firstInCategory, { resetDrink: true });
  }

  container.innerHTML = `
    <div class="menu-choice-tabs" aria-label="Choose lunch type">
      ${categories.map(([category, label]) => renderMenuCategoryButton(category, label)).join('')}
    </div>
    <div class="focused-builder-card">
      ${renderFocusedBuilder(selectedMenuItem)}
    </div>
  `;

  container.querySelectorAll('[data-menu-category]').forEach(button => {
    button.addEventListener('click', () => {
      selectMenuCategory(button.dataset.menuCategory);
    });
  });

  container.querySelectorAll('[data-hot-item]').forEach(button => {
    button.addEventListener('click', () => {
      const item = MENU.find(entry => entry.id === button.dataset.hotItem);
      if (!item || item.remaining <= 0) return;
      selectMenuItem(item);
    });
  });

  container.querySelectorAll('[data-step-id]').forEach(button => {
    button.addEventListener('click', () => {
      selectedSelections[button.dataset.stepId] = button.dataset.optionValue;
      renderMenu();
      updateSelectedSummary();
      updateOrderButton();
    });
  });

  container.querySelectorAll('[data-drink-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      if (!selectedMenuItem || !selectedMenuItem.drinkAddOn) return;
      selectedAddDrink = !selectedAddDrink;
      renderMenu();
      updateSelectedSummary();
      updateOrderButton();
    });
  });

  container.querySelectorAll('[data-next-step]').forEach(button => {
    button.addEventListener('click', () => {
      if (getMissingSteps().length) return;
      const composer = $('orderComposer');
      if (composer) composer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  updateDrinkToggle();
}

function selectMenuItem(item) {
  setSelectedMenuItem(item, { resetDrink: true });
  renderMenu();
  updateSelectedSummary();
  updateOrderButton();
}

function setSelectedMenuItem(item, options = {}) {
  selectedMenuItemId = item.id;
  selectedMenuItem = item;
  selectedMenuCategory = menuCategoryFor(item);
  selectedSelections = {};
  if (options.resetDrink) selectedAddDrink = false;

  (item.steps || []).forEach(step => {
    if (step.options.length === 1) selectedSelections[step.id] = step.options[0];
  });
}

function orderMenu(items) {
  const preferred = ['build-your-own'];
  return [...items].sort((a, b) => {
    const aIndex = preferred.indexOf(a.id);
    const bIndex = preferred.indexOf(b.id);
    const categorySort = (menuCategoryFor(a) === 'build-your-own' ? 0 : 1) - (menuCategoryFor(b) === 'build-your-own' ? 0 : 1);
    if (categorySort !== 0) return categorySort;
    return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
  });
}

function menuCategoryFor(item) {
  return item && item.id === 'build-your-own' ? 'build-your-own' : 'hot2go';
}

function selectMenuCategory(category) {
  selectedMenuCategory = category;
  const item = MENU.find(entry => menuCategoryFor(entry) === category);
  if (item && menuCategoryFor(selectedMenuItem) !== category) {
    setSelectedMenuItem(item, { resetDrink: true });
  }
  renderMenu();
  updateSelectedSummary();
  updateOrderButton();
}

function renderMenuCategoryButton(category, label) {
  const selected = selectedMenuCategory === category;
  const items = MENU.filter(item => menuCategoryFor(item) === category);
  const prices = items.map(item => Number(item.price || 0)).filter(price => price > 0);
  const priceLabel = prices.length ? `From ${formatPrice(Math.min(...prices))}` : '';
  return `
    <button
      class="menu-choice-btn ${selected ? 'active' : ''}"
      type="button"
      data-menu-category="${escapeHtml(category)}"
    >
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(priceLabel)}</strong>
    </button>
  `;
}

function renderDietBadges(diet, extraClass) {
  const list = Array.isArray(diet) ? diet : [];
  if (!list.length) return '';
  const titles = { V: 'Vegetarian', VG: 'Vegan', GF: 'Gluten Free', DF: 'Dairy Free' };
  return `<div class="diet-badges ${extraClass || ''}">
    ${list.map(code => `<span class="diet-badge diet-${escapeHtml(code)}" title="${escapeHtml(titles[code] || code)}">${escapeHtml(code)}</span>`).join('')}
  </div>`;
}

const ALL_DIET_CODES = ['V', 'VG', 'GF', 'DF'];

// For Build Your Own: the meal qualifies only for tags shared by every chosen ingredient.
function computeLiveBuildDiet(item) {
  if (!item || !Array.isArray(item.steps) || !item.steps.length) return { diet: [], complete: false };
  const lists = [];
  let complete = true;
  for (const step of item.steps) {
    const chosen = selectedSelections[step.id];
    if (!chosen) { complete = false; continue; }
    const opt = (step.optionsData || []).find(o => o.name === chosen);
    lists.push(opt ? (opt.diet || []) : []);
  }
  if (!lists.length) return { diet: [], complete: false };
  const diet = ALL_DIET_CODES.filter(code => lists.every(l => l.includes(code)));
  return { diet, complete };
}

function renderFocusedBuilder(item) {
  if (!item) return '';
  const missing = getMissingSteps();
  const ready = !missing.length;
  const isHotToGo = selectedMenuCategory === 'hot2go';
  const hasSteps = Boolean((item.steps || []).length);

  // Hot2Go shows the dish's own tags; Build Your Own shows the live intersection of chosen ingredients.
  let headerDiet = item.diet || [];
  let buildNote = '';
  if (!isHotToGo && hasSteps) {
    const live = computeLiveBuildDiet(item);
    headerDiet = live.diet;
    if (!live.complete) {
      buildNote = 'Pick a base, topping and garnish to see dietary tags for your meal.';
    } else if (!live.diet.length) {
      buildNote = 'This combination has no shared dietary tags.';
    }
  }
  const showGuidance = (isHotToGo && headerDiet.length) || (!isHotToGo && hasSteps);

  return `
    ${isHotToGo ? renderHotToGoChooser() : ''}
    <div class="focused-builder-head">
      <div>
        <span class="dish-format">${escapeHtml(item.format || 'Lunch')}</span>
        <h3>${escapeHtml(item.name)}</h3>
        ${renderDietBadges(headerDiet, 'head-badges')}
        ${buildNote ? `<p class="build-diet-note">${escapeHtml(buildNote)}</p>` : ''}
        ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
      </div>
      <div class="focused-price">
        <span>${isHotToGo ? 'Price' : 'From'}</span>
        <strong>${formatPrice(item.price)}</strong>
      </div>
    </div>
    ${showGuidance ? `<p class="diet-guidance">V Vegetarian · VG Vegan · GF Gluten Free · DF Dairy Free. A guide only — please ask the kitchen team about specific allergens.</p>` : ''}
    ${hasSteps ? `<div class="builder-options focused-options">${renderBuilderSteps(item)}</div>` : ''}
    ${renderDrinkAddOn(item)}
    <div class="selection-state ${ready ? 'ready' : ''}">
      ${ready ? 'Lunch choice complete.' : `Next: ${escapeHtml(missing[0])}`}
    </div>
    <div class="next-step-row">
      <button class="primary-btn next-step-btn" type="button" data-next-step="true" ${ready ? '' : 'disabled'}>
        Next step
      </button>
      <span>Then add your name, ward / department and collection time.</span>
    </div>
  `;
}

function renderHotToGoChooser() {
  const items = MENU.filter(item => menuCategoryFor(item) === 'hot2go');
  return `
    <div class="hot-item-strip">
      <div>
        <strong>Hot2Go</strong>
      </div>
      <div class="hot-item-buttons">
        ${items.map(item => `
          <button
            class="hot-item-btn ${item.id === selectedMenuItemId ? 'selected' : ''}"
            type="button"
            data-hot-item="${escapeHtml(item.id)}"
          >
            <span>${escapeHtml(item.name)}</span>
            ${renderDietBadges(item.diet, 'inline-badges')}
            <strong>${formatPrice(item.price)}</strong>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderBuilderSteps(item) {
  return (item.steps || []).map(step => `
    <div class="builder-step">
      <div class="builder-step-title">${escapeHtml(step.label)}</div>
      <div class="option-grid">
        ${step.options.map(option => {
          const optData = (step.optionsData || []).find(o => o.name === option);
          const optDiet = optData ? optData.diet : [];
          return `
          <button
            class="option-btn ${selectedSelections[step.id] === option ? 'selected' : ''}"
            type="button"
            data-step-id="${escapeHtml(step.id)}"
            data-option-value="${escapeHtml(option)}"
          ><span class="option-name">${escapeHtml(option)}</span>${renderDietBadges(optDiet, 'option-badges')}</button>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

function renderDrinkAddOn(item) {
  if (!item || !item.drinkAddOn) return '';
  return `
    <div class="single-add-on menu-add-on">
      <button class="drink-toggle global-drink-toggle ${selectedAddDrink ? 'selected' : ''}" type="button" data-drink-toggle="true">
        <span>${selectedAddDrink ? 'Drink added' : 'Add a drink'}</span>
        <strong>+${formatPrice(item.drinkAddOn.price)}</strong>
      </button>
    </div>
  `;
}

function renderSlots() {
  const grid = $('slotGrid');
  grid.innerHTML = '';

  SLOTS.forEach(slot => {
    const button = document.createElement('button');
    button.className = `slot-btn ${slot.time === selectedPickupTime ? 'selected' : ''} ${slot.available ? '' : 'full'}`;
    button.disabled = !slot.available;
    button.innerHTML = `${escapeHtml(slot.time)}<small>${slot.available ? `${slot.remaining} left` : 'Full'}</small>`;
    button.addEventListener('click', () => {
      if (!slot.available) return;
      selectedPickupTime = slot.time;
      $('selectedSlotText').textContent = slot.time;
      renderSlots();
      updateOrderButton();
    });
    grid.appendChild(button);
  });
}

function updateSelectedSummary() {
  if (!selectedMenuItem) {
    $('selectedDishText').textContent = 'Not selected yet';
    const totalText = $('totalText');
    if (totalText) totalText.textContent = '£0';
    updateDrinkToggle();
    return;
  }

  const missing = getMissingSteps();
  const choices = (selectedMenuItem.steps || [])
    .map(step => selectedSelections[step.id])
    .filter(Boolean)
    .join(', ');
  const drink = selectedAddDrink ? ' + drink' : '';
  const total = calculateTotal();
  const selectedText = choices || selectedMenuItem.name;
  const status = missing.length ? `Choose: ${missing.join(', ')}` : `${selectedText}${drink}`;
  $('selectedDishText').textContent = choices || missing.length
    ? `${selectedMenuItem.name} - ${status} (${formatPrice(total)})`
    : `${status} (${formatPrice(total)})`;
  const totalText = $('totalText');
  if (totalText) totalText.textContent = formatPrice(total);
  updateDrinkToggle();
}

function updateOrderButton() {
  const name = $('customerName').value.trim();
  const department = $('department').value.trim();
  $('placeOrderBtn').disabled = !(name.length >= 2 && department.length >= 2 && selectedMenuItemId && !getMissingSteps().length && selectedPickupTime);
}

function getMissingSteps() {
  if (!selectedMenuItem) return ['lunch'];
  return (selectedMenuItem.steps || [])
    .filter(step => step.required && !selectedSelections[step.id])
    .map(step => step.label.toLowerCase());
}

function calculateTotal() {
  if (!selectedMenuItem) return 0;
  return Number(selectedMenuItem.price || 0) + (selectedAddDrink && selectedMenuItem.drinkAddOn ? Number(selectedMenuItem.drinkAddOn.price || 0) : 0);
}

function updateDrinkToggle() {
  const drinkButton = document.querySelector('[data-drink-toggle]');
  if (!drinkButton) return;
  const hasDrinkAddOn = Boolean(selectedMenuItem && selectedMenuItem.drinkAddOn);
  drinkButton.disabled = !hasDrinkAddOn;
  drinkButton.classList.toggle('selected', selectedAddDrink);
  if (!hasDrinkAddOn) {
    drinkButton.innerHTML = '<span>Add a drink</span><strong>+£1</strong>';
    return;
  }
  const price = selectedMenuItem.drinkAddOn.price || 1;
  drinkButton.innerHTML = `
    <span>${selectedAddDrink ? 'Drink added' : 'Add a drink'}</span>
    <strong>+${formatPrice(price)}</strong>
  `;
}

async function placeOrder() {
  const payload = {
    date: CONFIG.date,
    name: $('customerName').value.trim(),
    department: $('department').value.trim(),
    menuItemId: selectedMenuItemId,
    selections: selectedSelections,
    addDrink: selectedAddDrink,
    pickupTime: selectedPickupTime,
  };

  $('placeOrderBtn').disabled = true;
  $('confirmationBox').innerHTML = `<div class="notice">Submitting order...</div>`;

  try {
    const data = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const order = data.order;
    $('confirmationBox').innerHTML = `
      <div class="notice success">
        <strong>Order confirmed.</strong><br />
        Order number: <strong>${escapeHtml(order.orderNumber)}</strong><br />
        Pickup: <strong>${escapeHtml(order.pickupTime)}</strong><br />
        Lunch: <strong>${escapeHtml(order.dishName)}</strong><br />
        Total: <strong>${formatPrice(order.totalPrice)}</strong>
      </div>
    `;

    $('customerName').value = '';
    $('department').value = '';
    selectedMenuItemId = '';
    selectedMenuItem = null;
    selectedSelections = {};
    selectedAddDrink = false;
    selectedPickupTime = '';
    $('selectedDishText').textContent = 'Not selected yet';
    const totalText = $('totalText');
    if (totalText) totalText.textContent = '£0';
    $('selectedSlotText').textContent = 'Not selected yet';

    await Promise.all([loadMenu(), loadSlots()]);
    renderMenu();
    renderSlots();
    updateSelectedSummary();
  } catch (err) {
    $('confirmationBox').innerHTML = `<div class="notice error"><strong>Order not placed.</strong><br />${escapeHtml(err.message)}</div>`;
  } finally {
    updateOrderButton();
  }
}

async function loadMenuSetup() {
  const adminKey = kitchenKey;
  $('menuSetupNotice').className = 'notice';
  $('menuSetupNotice').textContent = 'Loading menu setup...';

  try {
    const data = await api(`/api/menu-setup?adminKey=${encodeURIComponent(adminKey)}`);
    currentMenuSetup = data.setup;
    renderMenuSetup(currentMenuSetup);
    $('menuSetupNotice').className = 'notice success';
    $('menuSetupNotice').textContent = 'Menu setup loaded. Blank fields will stay hidden from the customer app.';
  } catch (err) {
    $('menuSetupNotice').className = 'notice error';
    $('menuSetupNotice').textContent = err.message;
  }
}

async function saveMenuSetup() {
  const adminKey = kitchenKey;
  const setup = collectMenuSetup();
  $('menuSetupNotice').className = 'notice';
  $('menuSetupNotice').textContent = 'Saving today’s menu...';

  try {
    const data = await api(`/api/menu-setup?adminKey=${encodeURIComponent(adminKey)}`, {
      method: 'POST',
      body: JSON.stringify({ setup }),
    });
    currentMenuSetup = data.setup;
    renderMenuSetup(currentMenuSetup);
    await loadMenu();
    renderMenu();
    updateSelectedSummary();
    updateOrderButton();
    $('menuSetupNotice').className = 'notice success';
    $('menuSetupNotice').textContent = `Menu saved. ${data.menu.length} customer menu option${data.menu.length === 1 ? '' : 's'} available.`;
  } catch (err) {
    $('menuSetupNotice').className = 'notice error';
    $('menuSetupNotice').textContent = err.message;
  }
}

// v18: the editor can render into any container. `prefix` keeps element ids unique when
// two editors exist on the page (Menu setup + Weekly menus). Defaults = original behaviour.
function renderMenuSetup(setup, opts = {}) {
  const container = opts.container || $('menuSetupForm');
  const p = opts.prefix || '';
  const blankIng = () => ({ name: '', diet: [] });
  const safeSetup = setup || {
    buildYourOwn: {
      price: 6,
      bases: Array.from({ length: 5 }, blankIng),
      toppings: Array.from({ length: 5 }, blankIng),
      garnishes: Array.from({ length: 5 }, blankIng),
    },
    hot2go: { dishes: Array.from({ length: 9 }, () => ({ name: '', price: 5, diet: [] })) },
  };

  container.innerHTML = `
    <div class="menu-setup-section">
      <div class="menu-setup-title">
        <h4>Build Your Own</h4>
        <span>Up to five per group. Tag each ingredient — the customer’s meal shows only the tags shared by all three choices.</span>
      </div>
      <div class="menu-setup-price">
        <label for="${p}buildPrice">Price</label>
        <input id="${p}buildPrice" data-build-price type="number" min="0" step="0.5" value="${escapeHtml(safeSetup.buildYourOwn.price || 6)}" />
      </div>
      <div class="menu-setup-columns">
        ${renderIngredientList('Bases', 'base', safeSetup.buildYourOwn.bases, p)}
        ${renderIngredientList('Toppings', 'topping', safeSetup.buildYourOwn.toppings, p)}
        ${renderIngredientList('Garnishes', 'garnish', safeSetup.buildYourOwn.garnishes, p)}
      </div>
    </div>

    <div class="menu-setup-section">
      <div class="menu-setup-title">
        <h4>Hot2Go</h4>
        <span>Up to nine dishes. Blank names will not show. Tap the dietary tags that apply.</span>
      </div>
      <div class="hot-setup-grid">
        ${safeSetup.hot2go.dishes.slice(0, 9).map((dish, index) => `
          <div class="hot-setup-card">
            <div class="hot-setup-top">
              <label for="${p}hotDish${index}">Dish ${index + 1}</label>
              <input id="${p}hotDish${index}" data-hot-name="${index}" value="${escapeHtml(dish.name || '')}" placeholder="e.g. Chicken Curry with Rice" />
              <div class="hot-setup-price">
                <span>£</span>
                <input id="${p}hotPrice${index}" data-hot-price="${index}" type="number" min="0" step="0.5" value="${escapeHtml(dish.price || 5)}" aria-label="Dish ${index + 1} price" title="Price" />
              </div>
            </div>
            <div class="diet-setup-row">
              <span class="diet-setup-label">Dietary tags</span>
              ${renderDietToggles(`${p}hot${index}`, dish.diet || [])}
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <p class="diet-help">V = Vegetarian · VG = Vegan · GF = Gluten Free · DF = Dairy Free. Shown on the customer app as a guide.</p>
  `;
}

const DIET_CODES = [
  { code: 'V', label: 'Vegetarian' },
  { code: 'VG', label: 'Vegan' },
  { code: 'GF', label: 'Gluten Free' },
  { code: 'DF', label: 'Dairy Free' },
];

function renderDietToggles(group, selected) {
  const chosen = Array.isArray(selected) ? selected : [];
  return `<div class="diet-toggle-set" data-diet-group="${escapeHtml(group)}">
    ${DIET_CODES.map(d => `
      <button type="button"
              class="diet-toggle ${chosen.includes(d.code) ? 'on' : ''}"
              data-diet-code="${d.code}"
              aria-pressed="${chosen.includes(d.code) ? 'true' : 'false'}"
              title="${d.label}">${d.code}</button>
    `).join('')}
  </div>`;
}

function readDietToggles(group, root = document) {
  const set = root.querySelector(`[data-diet-group="${group}"]`);
  if (!set) return [];
  return Array.from(set.querySelectorAll('.diet-toggle.on')).map(b => b.dataset.dietCode);
}

// Each ingredient: a name input plus its own dietary toggle row.
function renderIngredientList(title, group, items, p = '') {
  const padded = [...(items || [])].slice(0, 5).map(i => (i && typeof i === 'object') ? i : { name: i || '', diet: [] });
  while (padded.length < 5) padded.push({ name: '', diet: [] });
  const singulars = { Bases: 'Base', Toppings: 'Topping', Garnishes: 'Garnish' };
  const singular = singulars[title] || title;
  return `
    <div class="menu-setup-list ingredient-list">
      <h5>${escapeHtml(title)}</h5>
      ${padded.map((ing, index) => `
        <div class="ingredient-row">
          <input id="${p}${group}Option${index}" data-ingredient-group="${group}" data-ingredient-index="${index}"
                 value="${escapeHtml(ing.name || '')}" placeholder="${escapeHtml(singular)} ${index + 1}" />
          ${renderDietToggles(`${p}ing-${group}-${index}`, ing.diet || [])}
        </div>
      `).join('')}
    </div>
  `;
}

function readIngredientList(group, root = document, p = '') {
  const out = [];
  for (let index = 0; index < 5; index++) {
    const input = root.querySelector(`[data-ingredient-group="${group}"][data-ingredient-index="${index}"]`);
    const name = input ? input.value.trim() : '';
    out.push({ name, diet: readDietToggles(`${p}ing-${group}-${index}`, root) });
  }
  return out;
}

function collectMenuSetup(opts = {}) {
  const root = opts.container || $('menuSetupForm');
  const p = opts.prefix || '';
  const field = (sel) => root.querySelector(sel) || {};
  const dishes = Array.from({ length: 9 }, (_, index) => ({
    name: (field(`[data-hot-name="${index}"]`).value || '').trim(),
    price: Number(field(`[data-hot-price="${index}"]`).value || 5),
    diet: readDietToggles(`${p}hot${index}`, root),
  }));

  return {
    buildYourOwn: {
      price: Number(field('[data-build-price]').value || 6),
      bases: readIngredientList('base', root, p),
      toppings: readIngredientList('topping', root, p),
      garnishes: readIngredientList('garnish', root, p),
    },
    hot2go: { dishes },
  };
}

/* =====================================================================
   v18 WEEKLY ROLLING MENU
   Five saved menus (Mon–Fri). "Make live today" copies the chosen day into
   today's live menu on the server. Reuses the Menu setup editor, prefixed "wk-".
   ===================================================================== */
const WEEKLY_PREFIX = 'wk-';

function weekdayName(key) {
  const list = (weeklyData && weeklyData.weekdays) || [];
  const found = list.find(d => d.key === key);
  return found ? found.label : key;
}

function setWeeklyNotice(kind, message) {
  const el = $('weeklyNotice');
  if (!el) return;
  el.className = `notice${kind ? ' ' + kind : ''}`;
  el.textContent = message;
}

function setWeeklyDirty(dirty) {
  weeklyDirty = dirty;
  const btn = $('saveWeeklyBtn');
  if (btn) btn.classList.toggle('has-changes', dirty);
  if (dirty) setWeeklyNotice('warning', `Unsaved changes to ${weekdayName(weeklySelectedDay)}'s menu.`);
}

async function loadWeeklyMenus() {
  setWeeklyNotice('', 'Loading weekly menus…');
  try {
    weeklyData = await api(`/api/weekly-menus?adminKey=${encodeURIComponent(kitchenKey)}`);
    if (!weeklySelectedDay) weeklySelectedDay = weeklyData.todayKey || 'mon';
    weeklyDirty = false;
    renderWeeklyView();
    setWeeklyNotice('', `Showing ${weekdayName(weeklySelectedDay)}'s saved menu. Edit it and tap “Save changes”, or tap “Make live today”.`);
  } catch (err) {
    setWeeklyNotice('error', err.message);
  }
}

function renderWeeklyView() {
  renderWeeklyLiveStatus();
  renderWeekdayPicker();
  renderWeeklyEditor();
}

function renderWeeklyEditor() {
  if (!weeklyData) return;
  renderMenuSetup(weeklyData.days[weeklySelectedDay], { container: $('weeklyForm'), prefix: WEEKLY_PREFIX });
  const name = weekdayName(weeklySelectedDay);
  $('activateWeeklyBtn').textContent = `Make ${name} live today`;
  $('saveWeeklyBtn').textContent = `Save ${name}’s menu`;
  setWeeklyDirty(false);
}

function liveIsToday() {
  return Boolean(weeklyData && weeklyData.live.day && weeklyData.live.appliedDate === weeklyData.date);
}

function renderWeekdayPicker() {
  const todayKey = weeklyData.todayKey;
  $('weekdayPicker').innerHTML = weeklyData.weekdays.map(d => {
    const isLive = liveIsToday() && weeklyData.live.day === d.key;
    return `
      <button type="button" class="weekday-btn ${d.key === weeklySelectedDay ? 'active' : ''}" data-weekday="${d.key}"
              aria-pressed="${d.key === weeklySelectedDay ? 'true' : 'false'}">
        <span class="weekday-short">${escapeHtml(d.label.slice(0, 3))}</span>
        <span class="weekday-long">${escapeHtml(d.label)}</span>
        ${isLive ? '<span class="weekday-tag live">Live</span>' : (d.key === todayKey ? '<span class="weekday-tag">Today</span>' : '')}
      </button>`;
  }).join('');
}

function renderWeeklyLiveStatus() {
  const el = $('weeklyLiveStatus');
  const live = weeklyData.live || {};
  const time = live.appliedAt ? new Date(live.appliedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  el.className = 'weekly-live-status';
  if (liveIsToday()) {
    el.classList.add('ok');
    el.innerHTML = `<strong>Live now: ${escapeHtml(weekdayName(live.day))}’s menu</strong> <span>made live today at ${escapeHtml(time)}${live.editedSince ? ' · changed since on the Menu setup tab' : ''}</span>`;
  } else if (live.day) {
    el.classList.add('warn');
    const when = live.appliedDate ? new Date(live.appliedDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
    el.innerHTML = `<strong>No menu made live yet today.</strong> <span>Customers still see ${escapeHtml(weekdayName(live.day))}’s menu from ${escapeHtml(when)}${live.editedSince ? ' (with later edits)' : ''}.</span>`;
  } else {
    el.classList.add('warn');
    el.innerHTML = `<strong>No weekly menu made live yet.</strong> <span>Customers see whatever is on the Menu setup tab.</span>`;
  }
}

function selectWeeklyDay(key) {
  if (!weeklyData || key === weeklySelectedDay) return;
  if (weeklyDirty && !confirm(`You have unsaved changes to ${weekdayName(weeklySelectedDay)}'s menu. Discard them?`)) return;
  weeklySelectedDay = key;
  renderWeekdayPicker();
  renderWeeklyEditor();
  setWeeklyNotice('', `Showing ${weekdayName(key)}'s saved menu.`);
}

async function saveWeeklyMenu(options = {}) {
  const day = weeklySelectedDay;
  const setup = collectMenuSetup({ container: $('weeklyForm'), prefix: WEEKLY_PREFIX });
  if (!options.quiet) setWeeklyNotice('', `Saving ${weekdayName(day)}'s menu…`);
  try {
    const data = await api(`/api/weekly-menus/${day}?adminKey=${encodeURIComponent(kitchenKey)}`, {
      method: 'POST',
      body: JSON.stringify({ setup }),
    });
    weeklyData.days[day] = data.setup;
    renderWeeklyEditor();
    if (!options.quiet) {
      const n = data.optionCount;
      setWeeklyNotice(n ? 'success' : 'warning', n
        ? `${weekdayName(day)}'s menu saved (${n} customer option${n === 1 ? '' : 's'}). It is not live until you tap “Make ${weekdayName(day)} live today”.`
        : `${weekdayName(day)}'s menu saved, but it has no complete options yet, so it can't be made live.`);
    }
    return true;
  } catch (err) {
    setWeeklyNotice('error', err.message);
    return false;
  }
}

async function activateWeeklyMenu() {
  if (!weeklyData) return;
  const day = weeklySelectedDay;
  const name = weekdayName(day);

  // Refresh today's order count so the warning is accurate.
  try {
    const fresh = await api(`/api/weekly-menus?adminKey=${encodeURIComponent(kitchenKey)}`);
    weeklyData.ordersToday = fresh.ordersToday;
    weeklyData.live = fresh.live;
    weeklyData.todayKey = fresh.todayKey;
  } catch (err) { /* fall back to what we have */ }

  const warnings = [];
  if (weeklyData.todayKey && weeklyData.todayKey !== day) warnings.push(`Today is ${weekdayName(weeklyData.todayKey)}, not ${name}.`);
  if (weeklyData.ordersToday > 0) warnings.push(`There ${weeklyData.ordersToday === 1 ? 'is already 1 order' : `are already ${weeklyData.ordersToday} orders`} today. Those orders won't change.`);
  if (weeklyDirty) warnings.push(`Your unsaved changes to ${name} will be saved first.`);
  if (warnings.length && !confirm(`${warnings.join('\n')}\n\nMake ${name}'s menu live for customers now?`)) return;

  if (weeklyDirty) {
    const saved = await saveWeeklyMenu({ quiet: true });
    if (!saved) return;
  }

  setWeeklyNotice('', `Making ${name}'s menu live…`);
  try {
    const data = await api(`/api/weekly-menus/${day}/activate?adminKey=${encodeURIComponent(kitchenKey)}`, { method: 'POST' });
    weeklyData.live = data.live;
    renderWeeklyLiveStatus();
    renderWeekdayPicker();
    // Keep the Menu setup tab in step so it can't save an out-of-date menu over the new one.
    currentMenuSetup = data.setup;
    renderMenuSetup(currentMenuSetup);
    // Refresh the customer menu on this page too.
    await loadMenu();
    renderMenu();
    updateSelectedSummary();
    updateOrderButton();
    setWeeklyNotice('success', `${name}'s menu is now live. Customers will see ${data.menu.length} option${data.menu.length === 1 ? '' : 's'}.`);
  } catch (err) {
    setWeeklyNotice('error', err.message);
  }
}

async function copyLiveToWeekly() {
  const name = weekdayName(weeklySelectedDay);
  if (!confirm(`Replace what's in the ${name} editor with today's live menu? Nothing is saved until you tap Save.`)) return;
  try {
    const data = await api(`/api/menu-setup?adminKey=${encodeURIComponent(kitchenKey)}`);
    renderMenuSetup(data.setup, { container: $('weeklyForm'), prefix: WEEKLY_PREFIX });
    setWeeklyDirty(true);
    setWeeklyNotice('warning', `Copied today's live menu into ${name}. Tap “Save ${name}’s menu” to keep it.`);
  } catch (err) {
    setWeeklyNotice('error', err.message);
  }
}

async function loadKitchenOrders(options = {}) {
  const quiet = options.quiet === true;
  const adminKey = kitchenKey;
  if (!adminKey) return;

  if (!quiet) setOrdersStatus('Loading today’s orders…');

  try {
    const [ordersData, summaryData] = await Promise.all([
      api(`/api/orders?date=${encodeURIComponent(CONFIG.date)}&adminKey=${encodeURIComponent(adminKey)}`),
      api(`/api/summary?date=${encodeURIComponent(CONFIG.date)}&adminKey=${encodeURIComponent(adminKey)}`),
    ]);
    const orders = ordersData.orders || [];

    // Detect newly arrived orders for a gentle nudge.
    const signature = orders.map(o => o.id).join(',');
    const hadOrdersBefore = lastOrdersSignature !== '';
    const isNew = hadOrdersBefore && signature !== lastOrdersSignature && orders.length > countSignature(lastOrdersSignature);
    lastOrdersSignature = signature;

    renderKitchenOrders(orders);
    renderSummary(summaryData);
    hideKitchenNotice();
    setOrdersStatus(`${orders.length} order${orders.length === 1 ? '' : 's'} today · updated ${nowTimeLabel()}`);
    if (isNew) flashNewOrder();
  } catch (err) {
    showKitchenNotice('error', err.message);
    setOrdersStatus('Could not refresh. Check the connection and try Refresh now.');
  }
}

function countSignature(sig) {
  return sig ? sig.split(',').filter(Boolean).length : 0;
}

function setOrdersStatus(text) {
  const el = $('ordersStatusLine');
  if (el) el.textContent = text;
}

function nowTimeLabel() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function flashNewOrder() {
  const el = $('ordersStatusLine');
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function showKitchenNotice(kind, message) {
  const el = $('kitchenNotice');
  if (!el) return;
  el.hidden = false;
  el.className = `notice${kind ? ' ' + kind : ''}`;
  el.textContent = message;
}

function hideKitchenNotice() {
  const el = $('kitchenNotice');
  if (el) el.hidden = true;
}

function renderKitchenOrders(orders) {
  const list = $('ordersList');
  if (!list) return;

  if (!orders.length) {
    list.innerHTML = `
      <div class="orders-empty">
        <strong>No orders yet</strong>
        <span>Orders will appear here automatically as staff place them.</span>
      </div>`;
    return;
  }

  // Group orders by pickup time so the kitchen works to collection times.
  const groups = {};
  orders.forEach(order => {
    (groups[order.pickupTime] = groups[order.pickupTime] || []).push(order);
  });
  const times = Object.keys(groups).sort();

  list.innerHTML = times.map(time => {
    const groupOrders = groups[time];
    return `
      <div class="order-group">
        <div class="order-group-head">
          <span class="order-group-time">${escapeHtml(time)}</span>
          <span class="order-group-count">${groupOrders.length} order${groupOrders.length === 1 ? '' : 's'}</span>
        </div>
        <div class="order-cards">
          ${groupOrders.map(renderOrderCard).join('')}
        </div>
      </div>`;
  }).join('');

  wireOrderButtons();
}

function renderOrderCard(order) {
  const status = order.status;
  const isDone = status === 'Collected' || status === 'Cancelled';
  // Next-step quick actions for one-tap progression.
  const actions = [];
  if (status === 'New') actions.push(['Preparing', 'Start preparing']);
  if (status === 'Preparing') actions.push(['Ready', 'Mark ready']);
  if (status === 'Ready') actions.push(['Collected', 'Mark collected']);

  return `
    <div class="order-card status-border-${escapeHtml(status)} ${isDone ? 'is-done' : ''}">
      <div class="order-card-top">
        <div class="order-card-who">
          <strong>${escapeHtml(order.name)}</strong>
          <span>${escapeHtml(order.department || 'No ward / department')}</span>
        </div>
        <span class="status-pill status-${escapeHtml(status)}">${escapeHtml(status)}</span>
      </div>

      <div class="order-card-dish">${escapeHtml(order.menuItemName || order.dishName)}</div>
      ${order.dishDiet && order.dishDiet.length ? renderDietBadges(order.dishDiet, 'order-badges') : ''}
      ${order.selectionSummary ? `<div class="order-card-detail">${escapeHtml(order.selectionSummary)}</div>` : ''}

      <div class="order-card-meta">
        <span>${escapeHtml(order.orderNumber)}</span>
        <span>${formatPrice(order.totalPrice)}</span>
      </div>

      <div class="order-card-actions">
        ${actions.map(([next, label]) => `
          <button class="status-action go-${escapeHtml(next)}" type="button" data-advance="${escapeHtml(order.id)}" data-next="${escapeHtml(next)}">${escapeHtml(label)}</button>
        `).join('')}
        <details class="status-more">
          <summary>Change</summary>
          <div class="status-more-menu">
            ${CONFIG.statuses.map(s => `
              <button class="status-more-btn ${s === status ? 'current' : ''}" type="button" data-set-status="${escapeHtml(order.id)}" data-status="${escapeHtml(s)}">${escapeHtml(s)}</button>
            `).join('')}
          </div>
        </details>
      </div>
    </div>`;
}

function wireOrderButtons() {
  document.querySelectorAll('[data-advance]').forEach(btn => {
    btn.addEventListener('click', () => changeStatus(btn.dataset.advance, btn.dataset.next));
  });
  document.querySelectorAll('[data-set-status]').forEach(btn => {
    btn.addEventListener('click', () => changeStatus(btn.dataset.setStatus, btn.dataset.status));
  });
}

function renderSummary(summary) {
  const dishes = Object.entries(summary.byDish || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => `${escapeHtml(name)}: ${count}`)
    .join('<br />') || 'No dish data yet';

  const busiestSlot = Object.entries(summary.bySlot || {})
    .sort((a, b) => b[1] - a[1])[0];

  $('summaryGrid').innerHTML = `
    <div class="compact-card"><b>${summary.total || 0}</b><span>Active orders today</span></div>
    <div class="compact-card"><b>${busiestSlot ? escapeHtml(busiestSlot[0]) : '-'}</b><span>Busiest slot${busiestSlot ? `, ${busiestSlot[1]} orders` : ''}</span></div>
    <div class="compact-card"><b>Top dishes</b><span>${dishes}</span></div>
  `;
}

async function changeStatus(id, status) {
  const adminKey = kitchenKey;
  try {
    await api(`/api/orders/${encodeURIComponent(id)}/status?adminKey=${encodeURIComponent(adminKey)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await loadKitchenOrders({ quiet: true });
    await loadSlots();
    renderSlots();
  } catch (err) {
    showKitchenNotice('error', err.message);
  }
}

// v20: end-of-service clear. Deletes today's orders (and any older leftovers) after a clear warning.
async function clearOrders() {
  const adminKey = kitchenKey;
  if (!adminKey) return;
  let orders = [];
  try {
    const data = await api(`/api/orders?date=${encodeURIComponent(CONFIG.date)}&adminKey=${encodeURIComponent(adminKey)}`);
    orders = data.orders || [];
  } catch (err) {
    showKitchenNotice('error', err.message);
    return;
  }
  const open = orders.filter(o => o.status !== 'Collected' && o.status !== 'Cancelled').length;
  const lines = [
    orders.length
      ? `This will permanently delete today's ${orders.length} order${orders.length === 1 ? '' : 's'}, plus any older orders left over.`
      : `There are no orders today. This will delete any older orders left over.`,
  ];
  if (open) lines.push(`\n⚠ ${open} order${open === 1 ? " hasn't" : " haven't"} been marked Collected yet.`);
  lines.push(`\nIf you need a record, tap “Export CSV” first.`);
  lines.push(`\nThis can't be undone. Clear orders now?`);
  if (!confirm(lines.join('\n'))) return;

  try {
    const result = await api(`/api/orders/clear?adminKey=${encodeURIComponent(adminKey)}`, { method: 'POST' });
    lastOrdersSignature = '';
    await loadKitchenOrders({ quiet: false });
    await loadSlots();
    renderSlots();
    showKitchenNotice('success', result.removed
      ? `Cleared ${result.removed} order${result.removed === 1 ? '' : 's'}.`
      : 'There were no orders to clear.');
  } catch (err) {
    showKitchenNotice('error', err.message);
  }
}

function exportCsv() {
  const adminKey = kitchenKey;
  window.open(`/api/export.csv?date=${encodeURIComponent(CONFIG.date)}&adminKey=${encodeURIComponent(adminKey)}`, '_blank');
}

function formatPrice(value) {
  return `£${Number(value || 0).toFixed(2).replace('.00', '')}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
