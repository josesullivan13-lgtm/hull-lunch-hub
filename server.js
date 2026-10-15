/*
  Hull Lunch Hub | Staff Dining Pre-Order
  -------------------------------------------------
  No-npm / no-dependencies server version.

  This version uses only built-in Node.js modules, so it does NOT need:
  - npm install
  - express
  - any external packages

  Run with:
    set PORT=5009 && node server.js
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

loadDotEnvIfPresent();

const PORT = Number(process.env.PORT || 5009);
const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const MENU_SETUP_FILE = path.join(DATA_DIR, 'menu-setup.json');
// v18: one saved menu per weekday. menu-setup.json stays the LIVE menu;
// "making a day live" copies that day's saved setup into menu-setup.json.
const WEEKLY_MENUS_FILE = path.join(DATA_DIR, 'weekly-menus.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const CONFIG = {
  siteName: process.env.SITE_NAME || 'Hull Lunch Hub',
  orderStartTime: process.env.ORDER_START_TIME || '11:30',
  orderEndTime: process.env.ORDER_END_TIME || '13:30',
  slotIntervalMinutes: Number(process.env.SLOT_INTERVAL_MINUTES || 5),
  slotCapacity: Number(process.env.SLOT_CAPACITY || 3),
  // Cut-off disabled for development testing. Add back before live pilot.
  orderCutoffTime: process.env.ORDER_CUTOFF_TIME || '',
  adminKey: process.env.ADMIN_KEY || 'change-this-before-pilot',
};

const VALID_DIET_CODES = ['V', 'VG', 'GF', 'DF'];

const DEFAULT_MENU_SETUP = {
  buildYourOwn: {
    price: 6,
    bases: [
      { name: 'Jacket Potato', diet: ['V', 'VG', 'GF', 'DF'] },
      { name: 'Potato Wedges', diet: ['V', 'VG', 'GF', 'DF'] },
      { name: '', diet: [] },
      { name: '', diet: [] },
      { name: '', diet: [] },
    ],
    toppings: [
      { name: 'Baked Beans', diet: ['V', 'VG', 'GF', 'DF'] },
      { name: 'Bean Chilli', diet: ['V', 'VG', 'GF', 'DF'] },
      { name: 'Tuna Mayo', diet: ['GF'] },
      { name: '', diet: [] },
      { name: '', diet: [] },
    ],
    garnishes: [
      { name: 'Cheddar Cheese', diet: ['V', 'GF'] },
      { name: 'Chilies', diet: ['V', 'VG', 'GF', 'DF'] },
      { name: '', diet: [] },
      { name: '', diet: [] },
      { name: '', diet: [] },
    ],
  },
  hot2go: {
    dishes: [
      { name: 'Vegetarian Tikka Masala with White Rice', price: 5, diet: ['V', 'GF'] },
      { name: 'Vegan Thai Red Curry with White Rice', price: 5, diet: ['VG', 'GF', 'DF'] },
      { name: 'Orange & Ginger Chicken with White Rice', price: 5, diet: [] },
      { name: 'Carrot & Coriander Soup', price: 3, diet: ['VG', 'GF', 'DF'] },
      { name: '', price: 5, diet: [] },
      { name: '', price: 5, diet: [] },
      { name: '', price: 5, diet: [] },
      { name: '', price: 5, diet: [] },
      { name: '', price: 5, diet: [] },
    ],
  },
};

const STATUSES = ['New', 'Preparing', 'Ready', 'Collected', 'Cancelled'];

// v18 weekly rolling menu: Monday to Friday only.
const WEEKDAYS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
];
const WEEKDAY_KEYS = WEEKDAYS.map(d => d.key);

ensureDataFile();
ensureWeeklyMenusFile();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (req.method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true, service: 'Hull Lunch Hub', site: CONFIG.siteName });
    if (req.method === 'GET' && pathname === '/api/config') return sendJson(res, 200, publicConfig());
    if (req.method === 'GET' && pathname === '/api/menu') return handleGetMenu(req, res, requestUrl);
    if (req.method === 'GET' && pathname === '/api/menu-setup') return handleGetMenuSetup(req, res, requestUrl);
    if (req.method === 'POST' && pathname === '/api/menu-setup') return handleSaveMenuSetup(req, res, requestUrl);
    if (req.method === 'GET' && pathname === '/api/slots') return handleGetSlots(req, res, requestUrl);
    if (req.method === 'POST' && pathname === '/api/orders') return handleCreateOrder(req, res);
    if (req.method === 'GET' && pathname === '/api/orders') return handleGetOrders(req, res, requestUrl);
    if (req.method === 'POST' && pathname === '/api/orders/clear') return handleClearOrders(req, res, requestUrl);
    if (req.method === 'GET' && pathname === '/api/export.csv') return handleExportCsv(req, res, requestUrl);
    if (req.method === 'GET' && pathname === '/api/summary') return handleSummary(req, res, requestUrl);
    if (req.method === 'GET' && pathname === '/api/weekly-menus') return handleGetWeeklyMenus(req, res, requestUrl);

    const weeklyMatch = pathname.match(/^\/api\/weekly-menus\/([^/]+)(\/activate)?$/);
    if (req.method === 'POST' && weeklyMatch) {
      return weeklyMatch[2]
        ? handleActivateWeeklyMenu(req, res, requestUrl, weeklyMatch[1])
        : handleSaveWeeklyMenu(req, res, requestUrl, weeklyMatch[1]);
    }

    const statusMatch = pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
    if (req.method === 'PATCH' && statusMatch) return handleUpdateStatus(req, res, requestUrl, statusMatch[1]);

    if (req.method === 'GET') return serveStaticOrIndex(req, res, pathname);

    return sendJson(res, 405, { ok: false, message: 'Method not allowed.' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { ok: false, message: 'Server error.' });
  }
});

server.listen(PORT, () => {
  console.log(`Hull Lunch Hub running at http://localhost:${PORT}`);
  console.log(`Kitchen dashboard: http://localhost:${PORT}/kitchen`);
  console.log(`Admin key: ${CONFIG.adminKey}`);
  console.log('No npm install required in this version. Keep this CMD window open while testing.');
});

function handleGetMenu(req, res, requestUrl) {
  const date = sanitizeDate(requestUrl.searchParams.get('date')) || todayIso();
  const orders = readOrders();
  const menu = buildMenuFromSetup(readMenuSetup());
  const menuWithRemaining = menu.map(item => {
    const sold = orders.filter(o => o.date === date && o.dishId === item.id && o.status !== 'Cancelled').length;
    return { ...item, sold, remaining: Math.max(0, item.dailyStock - sold) };
  });
  return sendJson(res, 200, { menu: menuWithRemaining });
}

function handleGetMenuSetup(req, res, requestUrl) {
  if (!isAdmin(requestUrl, req)) return sendJson(res, 401, { ok: false, message: 'Admin key required.' });
  return sendJson(res, 200, { ok: true, date: todayIso(), setup: readMenuSetup() });
}

async function handleSaveMenuSetup(req, res, requestUrl) {
  if (!isAdmin(requestUrl, req)) return sendJson(res, 401, { ok: false, message: 'Admin key required.' });
  const body = await readJsonBody(req);
  const setup = normalizeMenuSetup(body && body.setup ? body.setup : body || {});
  const preview = buildMenuFromSetup(setup);
  if (!preview.length) {
    return sendJson(res, 400, { ok: false, message: 'Please enter at least one menu option before saving.' });
  }
  writeMenuSetup(setup);
  markLiveMenuEdited();
  return sendJson(res, 200, { ok: true, date: todayIso(), setup, menu: preview });
}

function handleGetSlots(req, res, requestUrl) {
  const date = sanitizeDate(requestUrl.searchParams.get('date')) || todayIso();
  return sendJson(res, 200, { date, slots: buildSlotsForDate(date) });
}

async function handleCreateOrder(req, res) {
  const body = await readJsonBody(req);
  const result = createOrder(body || {});
  if (!result.ok) return sendJson(res, result.status || 400, { ok: false, message: result.message });
  return sendJson(res, 201, { ok: true, order: publicOrder(result.order) });
}

function handleGetOrders(req, res, requestUrl) {
  if (!isAdmin(requestUrl, req)) return sendJson(res, 401, { ok: false, message: 'Admin key required.' });
  const date = sanitizeDate(requestUrl.searchParams.get('date')) || todayIso();
  const orders = readOrders().filter(order => order.date === date).sort(orderSort);
  return sendJson(res, 200, { ok: true, date, orders: orders.map(publicOrder) });
}

// v20: kitchen "Clear orders" button. Permanently deletes today's orders plus any
// older ones left over (e.g. a day the button wasn't pressed). Future-dated orders are kept.
// Replaces double-clicking RESET_ORDERS_WINDOWS.bat, which won't exist once hosted.
function handleClearOrders(req, res, requestUrl) {
  if (!isAdmin(requestUrl, req)) return sendJson(res, 401, { ok: false, message: 'Admin key required.' });
  const today = todayIso();
  const orders = readOrders();
  const kept = orders.filter(o => typeof o.date === 'string' && o.date > today);
  const removed = orders.length - kept.length;
  writeOrders(kept);
  console.log(`[${new Date().toISOString()}] Kitchen cleared ${removed} order(s) dated ${today} or earlier.`);
  return sendJson(res, 200, { ok: true, removed, date: today });
}

async function handleUpdateStatus(req, res, requestUrl, id) {
  if (!isAdmin(requestUrl, req)) return sendJson(res, 401, { ok: false, message: 'Admin key required.' });
  const body = await readJsonBody(req);
  const status = String((body && body.status) || '').trim();
  if (!STATUSES.includes(status)) return sendJson(res, 400, { ok: false, message: 'Invalid status.' });

  const orders = readOrders();
  const index = orders.findIndex(o => o.id === id);
  if (index === -1) return sendJson(res, 404, { ok: false, message: 'Order not found.' });

  orders[index].status = status;
  orders[index].updatedAt = new Date().toISOString();
  writeOrders(orders);
  return sendJson(res, 200, { ok: true, order: publicOrder(orders[index]) });
}

function handleExportCsv(req, res, requestUrl) {
  if (!isAdmin(requestUrl, req)) return sendText(res, 401, 'Admin key required.', 'text/plain');
  const date = sanitizeDate(requestUrl.searchParams.get('date')) || todayIso();
  const rows = readOrders().filter(order => order.date === date).sort(orderSort);
  const csv = toCsv(rows);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="hull-lunch-hub-orders-${date}.csv"`,
  });
  return res.end(csv);
}

function handleSummary(req, res, requestUrl) {
  if (!isAdmin(requestUrl, req)) return sendJson(res, 401, { ok: false, message: 'Admin key required.' });
  const date = sanitizeDate(requestUrl.searchParams.get('date')) || todayIso();
  const orders = readOrders().filter(order => order.date === date && order.status !== 'Cancelled');
  const byDish = {};
  const bySlot = {};
  for (const order of orders) {
    byDish[order.dishName] = (byDish[order.dishName] || 0) + 1;
    bySlot[order.pickupTime] = (bySlot[order.pickupTime] || 0) + 1;
  }
  return sendJson(res, 200, { ok: true, date, total: orders.length, byDish, bySlot });
}

/* ---------- v18 WEEKLY ROLLING MENU ----------
   weekly-menus.json holds one saved setup per weekday (same shape as menu-setup.json).
   The live customer menu is still menu-setup.json. Activating a day COPIES that
   day's setup into menu-setup.json, so the ordering, validation and diet code
   are unchanged, and same-day edits on the Menu setup tab don't alter the template. */

function handleGetWeeklyMenus(req, res, requestUrl) {
  if (!isAdmin(requestUrl, req)) return sendJson(res, 401, { ok: false, message: 'Admin key required.' });
  const weekly = readWeeklyMenus();
  const date = todayIso();
  const ordersToday = readOrders().filter(o => o.date === date && o.status !== 'Cancelled').length;
  return sendJson(res, 200, {
    ok: true,
    date,
    todayKey: weekdayKeyForDate(new Date()),
    weekdays: WEEKDAYS,
    live: weekly.live,
    ordersToday,
    days: weekly.days,
  });
}

async function handleSaveWeeklyMenu(req, res, requestUrl, dayKey) {
  if (!isAdmin(requestUrl, req)) return sendJson(res, 401, { ok: false, message: 'Admin key required.' });
  if (!WEEKDAY_KEYS.includes(dayKey)) return sendJson(res, 400, { ok: false, message: 'Unknown weekday.' });
  const body = await readJsonBody(req);
  const setup = normalizeMenuSetup(body && body.setup ? body.setup : body || {});
  // A weekday may be saved part-finished; the "at least one option" rule is enforced on activate.
  const weekly = readWeeklyMenus();
  weekly.days[dayKey] = setup;
  writeWeeklyMenus(weekly);
  const optionCount = buildMenuFromSetup(setup).length;
  return sendJson(res, 200, { ok: true, day: dayKey, setup, optionCount });
}

function handleActivateWeeklyMenu(req, res, requestUrl, dayKey) {
  if (!isAdmin(requestUrl, req)) return sendJson(res, 401, { ok: false, message: 'Admin key required.' });
  if (!WEEKDAY_KEYS.includes(dayKey)) return sendJson(res, 400, { ok: false, message: 'Unknown weekday.' });
  const weekly = readWeeklyMenus();
  const setup = normalizeMenuSetup(weekly.days[dayKey]);
  const preview = buildMenuFromSetup(setup);
  const label = weekdayLabel(dayKey);
  if (!preview.length) {
    return sendJson(res, 400, { ok: false, message: `${label}'s menu has no options yet. Add at least one dish and save it first.` });
  }
  writeMenuSetup(setup);
  weekly.live = { day: dayKey, appliedAt: new Date().toISOString(), appliedDate: todayIso(), editedSince: false };
  writeWeeklyMenus(weekly);
  return sendJson(res, 200, { ok: true, day: dayKey, live: weekly.live, setup, menu: preview });
}

function weekdayKeyForDate(date) {
  // getDay(): 0 = Sunday ... 6 = Saturday. Weekends return '' (no weekday menu).
  return ['', 'mon', 'tue', 'wed', 'thu', 'fri', ''][date.getDay()];
}

function weekdayLabel(key) {
  const found = WEEKDAYS.find(d => d.key === key);
  return found ? found.label : key;
}

function normalizeWeeklyMenus(raw, fallbackSetup) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const daysIn = source.days && typeof source.days === 'object' ? source.days : {};
  const days = {};
  for (const key of WEEKDAY_KEYS) {
    // Same normalizer as the live menu: same shapes, same diet validation, same string/object tolerance.
    days[key] = normalizeMenuSetup(daysIn[key] || fallbackSetup);
  }
  const liveIn = source.live && typeof source.live === 'object' ? source.live : {};
  const live = {
    day: WEEKDAY_KEYS.includes(liveIn.day) ? liveIn.day : '',
    appliedAt: typeof liveIn.appliedAt === 'string' ? liveIn.appliedAt.slice(0, 40) : '',
    appliedDate: sanitizeDate(liveIn.appliedDate),
    editedSince: liveIn.editedSince === true,
  };
  return { live, days };
}

function readWeeklyMenus() {
  ensureWeeklyMenusFile();
  const fallback = readMenuSetup();
  try {
    return normalizeWeeklyMenus(JSON.parse(fs.readFileSync(WEEKLY_MENUS_FILE, 'utf8')), fallback);
  } catch {
    return normalizeWeeklyMenus({}, fallback);
  }
}

function writeWeeklyMenus(weekly) {
  ensureDataFile();
  const normalized = normalizeWeeklyMenus(weekly, readMenuSetup());
  fs.writeFileSync(WEEKLY_MENUS_FILE, JSON.stringify(normalized, null, 2));
}

function ensureWeeklyMenusFile() {
  ensureDataFile();
  if (fs.existsSync(WEEKLY_MENUS_FILE)) return;
  // First run: seed every weekday with a copy of the current live menu so nothing starts empty.
  const seed = normalizeWeeklyMenus({}, readMenuSetup());
  fs.writeFileSync(WEEKLY_MENUS_FILE, JSON.stringify(seed, null, 2));
}

function markLiveMenuEdited() {
  // Called when the live menu is edited directly on the Menu setup tab.
  try {
    const weekly = readWeeklyMenus();
    if (!weekly.live.day || weekly.live.editedSince) return;
    weekly.live.editedSince = true;
    writeWeeklyMenus(weekly);
  } catch (err) {
    console.error('Could not update weekly menu status:', err.message);
  }
}

function serveStaticOrIndex(req, res, pathname) {
  let filePath = pathname === '/' || pathname === '/kitchen' || pathname === '/notes' || pathname === '/about'
    ? path.join(PUBLIC_DIR, 'index.html')
    : path.join(PUBLIC_DIR, pathname.replace(/^\//, ''));

  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) return sendText(res, 403, 'Forbidden', 'text/plain');

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = mimeType(ext);
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(filePath).pipe(res);
}

function publicConfig() {
  return {
    siteName: CONFIG.siteName,
    orderStartTime: CONFIG.orderStartTime,
    orderEndTime: CONFIG.orderEndTime,
    slotIntervalMinutes: CONFIG.slotIntervalMinutes,
    slotCapacity: CONFIG.slotCapacity,
    orderCutoffTime: CONFIG.orderCutoffTime,
    date: todayIso(),
    statuses: STATUSES,
  };
}

function createOrder(body) {
  const date = sanitizeDate(body.date) || todayIso();
  const name = sanitizeText(body.name, 80);
  const department = sanitizeText(body.department || '', 80);
  const menuItemId = sanitizeText(body.menuItemId || body.dishId, 80);
  const pickupTime = sanitizeTime(body.pickupTime);
  const selections = sanitizeSelections(body.selections || {});
  const addDrink = body.addDrink === true;

  if (!name || name.length < 2) return { ok: false, status: 400, message: 'Please enter a name.' };
  if (!department || department.length < 2) return { ok: false, status: 400, message: 'Please enter a ward or department.' };
  if (!pickupTime) return { ok: false, status: 400, message: 'Please choose a valid pickup time.' };
  if (!isPickupTimeAllowed(pickupTime)) return { ok: false, status: 400, message: 'That pickup time is outside today’s collection window.' };
  // Development testing mode: no same-day order cut-off enforced.
  // Before a real pilot, re-enable an 11:00 cut-off here.

  const dish = buildMenuFromSetup(readMenuSetup()).find(item => item.id === menuItemId);
  if (!dish) return { ok: false, status: 400, message: 'Please choose a valid menu option.' };

  const validation = validateSelections(dish, selections);
  if (!validation.ok) return { ok: false, status: 400, message: validation.message };

  const orders = readOrders();
  const activeForSlot = orders.filter(o => o.date === date && o.pickupTime === pickupTime && o.status !== 'Cancelled');
  if (activeForSlot.length >= CONFIG.slotCapacity) return { ok: false, status: 409, message: `${pickupTime} is now full. Please choose another time.` };

  const soldForDish = orders.filter(o => o.date === date && o.dishId === dish.id && o.status !== 'Cancelled').length;
  if (soldForDish >= dish.dailyStock) return { ok: false, status: 409, message: `${dish.name} is now sold out. Please choose another dish.` };

  const sequence = activeForSlot.length + 1;
  const orderNumber = buildOrderNumber(date, pickupTime, sequence);
  const totalPrice = dish.price + (addDrink ? dish.drinkAddOn.price : 0);
  const selectionSummary = buildSelectionSummary(dish, selections, addDrink);
  const dishName = buildDishName(dish, selections, addDrink);
  const dishDiet = computeOrderDiet(dish, selections);
  const order = {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    orderNumber,
    date,
    siteName: CONFIG.siteName,
    name,
    department,
    dishId: dish.id,
    dishName,
    dishFormat: dish.format,
    dishProtein: '',
    dishSku: '',
    menuItemName: dish.name,
    dishDiet: dishDiet,
    selections,
    selectionSummary,
    addDrink,
    totalPrice,
    pickupTime,
    status: 'New',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  orders.push(order);
  writeOrders(orders);
  return { ok: true, order };
}

function sanitizeSelections(raw) {
  const selections = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return selections;
  for (const [key, value] of Object.entries(raw)) {
    selections[sanitizeText(key, 40)] = sanitizeText(value, 100);
  }
  return selections;
}

function validateSelections(dish, selections) {
  for (const step of dish.steps || []) {
    const value = selections[step.id];
    if (step.required && !value) {
      return { ok: false, message: `Please choose ${step.label.toLowerCase()}.` };
    }
    if (value && !step.options.includes(value)) {
      return { ok: false, message: `Please choose a valid option for ${step.label.toLowerCase()}.` };
    }
  }
  return { ok: true };
}

function buildSelectionSummary(dish, selections, addDrink) {
  const parts = [];
  for (const step of dish.steps || []) {
    if (selections[step.id]) parts.push(`${step.label}: ${selections[step.id]}`);
  }
  parts.push(addDrink ? 'Drink: Added' : 'Drink: No drink');
  return parts.join(' | ');
}

function buildDishName(dish, selections, addDrink) {
  if (dish.id === 'build-your-own') {
    return `Build Your Own: ${selections.base}, ${selections.topping}, ${selections.garnish}${addDrink ? ' + drink' : ''}`;
  }
  return `${dish.name}${addDrink ? ' + drink' : ''}`;
}

function computeOrderDiet(dish, selections) {
  // Hot2Go: the dish carries its own diet tags.
  if (dish.id !== 'build-your-own') return Array.isArray(dish.diet) ? dish.diet : [];
  // Build Your Own: only tags shared by ALL chosen ingredients apply (intersection).
  const chosenLists = [];
  for (const step of dish.steps || []) {
    const chosenName = selections[step.id];
    const opt = (step.optionsData || []).find(o => o.name === chosenName);
    chosenLists.push(opt ? (opt.diet || []) : []);
  }
  return intersectDiet(chosenLists);
}

function buildMenuFromSetup(setup) {
  const normalized = normalizeMenuSetup(setup || readMenuSetup());
  const menu = [];
  const bases = normalized.buildYourOwn.bases.filter(i => i.name);
  const toppings = normalized.buildYourOwn.toppings.filter(i => i.name);
  const garnishes = normalized.buildYourOwn.garnishes.filter(i => i.name);

  if (bases.length && toppings.length && garnishes.length) {
    const toStep = (id, label, items) => ({
      id,
      label,
      required: true,
      options: items.map(i => i.name),
      optionsData: items.map(i => ({ name: i.name, diet: i.diet || [] })),
    });
    menu.push({
      id: 'build-your-own',
      name: 'Build Your Own',
      category: 'Build Your Own',
      format: 'Base + topping + garnish',
      price: normalized.buildYourOwn.price,
      description: '',
      tags: [formatPrice(normalized.buildYourOwn.price)],
      diet: [],
      dailyStock: 120,
      steps: [
        toStep('base', 'Add a base', bases),
        toStep('topping', 'Add a topping', toppings),
        toStep('garnish', 'Add a garnish', garnishes),
      ],
      drinkAddOn: { id: 'drink', label: 'Add a drink', price: 1 },
    });
  }

  normalized.hot2go.dishes
    .filter(dish => dish.name)
    .forEach((dish, index) => {
      menu.push({
        id: `hot2go-${index + 1}-${slugify(dish.name)}`,
        name: dish.name,
        category: 'Hot2Go',
        format: 'Hot2Go',
        price: dish.price,
        description: '',
        tags: [formatPrice(dish.price)],
        diet: dish.diet || [],
        dailyStock: 120,
        steps: [],
        drinkAddOn: { id: 'drink', label: 'Add a drink', price: 1 },
      });
    });

  return menu;
}

function normalizeMenuSetup(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const build = source.buildYourOwn && typeof source.buildYourOwn === 'object' ? source.buildYourOwn : {};
  const hot = source.hot2go && typeof source.hot2go === 'object' ? source.hot2go : {};

  return {
    buildYourOwn: {
      price: sanitizePrice(build.price, DEFAULT_MENU_SETUP.buildYourOwn.price),
      bases: normalizeIngredientList(build.bases, DEFAULT_MENU_SETUP.buildYourOwn.bases, 5),
      toppings: normalizeIngredientList(build.toppings, DEFAULT_MENU_SETUP.buildYourOwn.toppings, 5),
      garnishes: normalizeIngredientList(build.garnishes, DEFAULT_MENU_SETUP.buildYourOwn.garnishes, 5),
    },
    hot2go: {
      dishes: normalizeHotDishes(hot.dishes, DEFAULT_MENU_SETUP.hot2go.dishes, 9),
    },
  };
}

function normalizeTextList(raw, fallback, max) {
  const list = Array.isArray(raw) ? raw : fallback;
  const cleaned = list.slice(0, max).map(value => sanitizeText(value, 100));
  while (cleaned.length < max) cleaned.push('');
  return cleaned;
}

function normalizeIngredientList(raw, fallback, max) {
  const list = Array.isArray(raw) ? raw : fallback;
  const cleaned = list.slice(0, max).map(entry => {
    // Backward compatible: accept a plain string or a { name, diet } object.
    if (entry && typeof entry === 'object') {
      return { name: sanitizeText(entry.name, 100), diet: sanitizeDiet(entry.diet) };
    }
    return { name: sanitizeText(entry, 100), diet: [] };
  });
  while (cleaned.length < max) cleaned.push({ name: '', diet: [] });
  return cleaned;
}

// Intersection of diet tags: a built meal only qualifies if every part qualifies.
function intersectDiet(dietLists) {
  const lists = dietLists.filter(Array.isArray);
  if (!lists.length) return [];
  return VALID_DIET_CODES.filter(code => lists.every(list => list.includes(code)));
}

function normalizeHotDishes(raw, fallback, max) {
  const list = Array.isArray(raw) ? raw : fallback;
  const cleaned = list.slice(0, max).map((dish, index) => {
    const item = dish && typeof dish === 'object' ? dish : { name: dish };
    const fallbackPrice = fallback[index] ? fallback[index].price : 5;
    return {
      name: sanitizeText(item.name, 120),
      price: sanitizePrice(item.price, fallbackPrice || 5),
      diet: sanitizeDiet(item.diet),
    };
  });
  while (cleaned.length < max) cleaned.push({ name: '', price: 5, diet: [] });
  return cleaned;
}

function sanitizePrice(value, fallback) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 50) return Number(fallback || 0);
  return Math.round(price * 100) / 100;
}

function sanitizeDiet(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const code of value) {
    const c = String(code || '').trim().toUpperCase();
    if (VALID_DIET_CODES.includes(c) && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  // keep a consistent display order
  return VALID_DIET_CODES.filter(c => out.includes(c));
}

function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug || 'item';
}

function buildSlotsForDate(date) {
  const orders = readOrders();
  const slots = generateTimeSlots(CONFIG.orderStartTime, CONFIG.orderEndTime, CONFIG.slotIntervalMinutes);
  return slots.map(time => {
    const used = orders.filter(o => o.date === date && o.pickupTime === time && o.status !== 'Cancelled').length;
    const remaining = Math.max(0, CONFIG.slotCapacity - used);
    return { time, capacity: CONFIG.slotCapacity, used, remaining, available: remaining > 0 };
  });
}

function generateTimeSlots(start, end, interval) {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  const times = [];
  for (let minutes = startMinutes; minutes <= endMinutes; minutes += interval) times.push(minutesToTime(minutes));
  return times;
}

function isPickupTimeAllowed(time) {
  return generateTimeSlots(CONFIG.orderStartTime, CONFIG.orderEndTime, CONFIG.slotIntervalMinutes).includes(time);
}

function buildOrderNumber(date, pickupTime, sequence) {
  const yyMMdd = date.replace(/-/g, '').slice(2);
  return `HSD-${yyMMdd}-${pickupTime.replace(':', '')}-${String(sequence).padStart(2, '0')}`;
}

function publicOrder(order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    date: order.date,
    siteName: order.siteName,
    name: order.name,
    department: order.department,
    dishId: order.dishId,
    dishName: order.dishName,
    dishFormat: order.dishFormat,
    dishProtein: order.dishProtein,
    dishSku: order.dishSku,
    menuItemName: order.menuItemName || order.dishName,
    dishDiet: Array.isArray(order.dishDiet) ? order.dishDiet : [],
    selections: order.selections || {},
    selectionSummary: order.selectionSummary || '',
    addDrink: Boolean(order.addDrink),
    totalPrice: Number(order.totalPrice || 0),
    pickupTime: order.pickupTime,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function orderSort(a, b) {
  if (a.pickupTime !== b.pickupTime) return a.pickupTime.localeCompare(b.pickupTime);
  return a.createdAt.localeCompare(b.createdAt);
}

function readOrders() {
  ensureDataFile();
  const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  ensureDataFile();
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function readMenuSetup() {
  ensureDataFile();
  const raw = fs.readFileSync(MENU_SETUP_FILE, 'utf8');
  try {
    return normalizeMenuSetup(JSON.parse(raw));
  } catch {
    return normalizeMenuSetup(DEFAULT_MENU_SETUP);
  }
}

function writeMenuSetup(setup) {
  ensureDataFile();
  fs.writeFileSync(MENU_SETUP_FILE, JSON.stringify(normalizeMenuSetup(setup), null, 2));
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
  if (!fs.existsSync(MENU_SETUP_FILE)) fs.writeFileSync(MENU_SETUP_FILE, JSON.stringify(normalizeMenuSetup(DEFAULT_MENU_SETUP), null, 2));
}

function toCsv(rows) {
  const headers = ['Order number', 'Date', 'Pickup time', 'Name', 'Department/ward', 'Menu item', 'Choices', 'Drink', 'Total price', 'Status', 'Created at'];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push([
      row.orderNumber,
      row.date,
      row.pickupTime,
      row.name,
      row.department,
      row.menuItemName || row.dishName,
      row.selectionSummary || row.dishName,
      row.addDrink ? 'Yes' : 'No',
      formatPrice(row.totalPrice || 0),
      row.status,
      row.createdAt,
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

function formatPrice(value) {
  return `£${Number(value || 0).toFixed(2)}`;
}

function csvCell(value) {
  const text = String(value || '');
  return `"${text.replace(/"/g, '""')}"`;
}

function isAdmin(requestUrl, req) {
  if (!CONFIG.adminKey) return true;
  const provided = requestUrl.searchParams.get('adminKey') || req.headers['x-admin-key'];
  return provided === CONFIG.adminKey;
}

function sanitizeText(value, maxLength) {
  return String(value || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function sanitizeDate(value) {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

function sanitizeTime(value) {
  const time = String(value || '').trim();
  return /^\d{2}:\d{2}$/.test(time) ? time : '';
}

function timeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function todayIso() {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function loadDotEnvIfPresent() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

async function readJsonBody(req) {
  const raw = await readRawBody(req, 250000);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > limit) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const text = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  return res.end(text);
}

function sendText(res, status, text, type) {
  res.writeHead(status, { 'Content-Type': `${type || 'text/plain'}; charset=utf-8` });
  return res.end(text);
}

function mimeType(ext) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.txt': 'text/plain; charset=utf-8',
  }[ext] || 'application/octet-stream';
}
