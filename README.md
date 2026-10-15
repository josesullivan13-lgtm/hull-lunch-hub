# Hull Lunch Hub | Version 13

This is the current faded-green Hull Lunch Hub working prototype with an editable kitchen menu setup, set to run locally on port 5009.

It keeps the same branding, colours, header, name/ward section, pickup slots and kitchen dashboard.

The menu now shows one main route at a time:

- Build Your Own: choose one base, one topping and one garnish, £6.
- Hot2Go: choose one complete hot meal or soup.
- Hot2Go meals are single-click choices, with no rice or side sub-selection.
- Optional drink for £1, shown with the menu choices.
- Next step button scrolls to name, ward / department and pickup time.
- Kitchen can edit up to five bases, five toppings, five garnishes and nine Hot2Go dishes.
- Kitchen Hot2Go dish numbers are clearly labelled as prices.
- Blank menu setup fields are ignored and do not show on the customer app.

## Run it on Windows

Double-click:

```text
START_HULL_LUNCH_HUB_WINDOWS.bat
```

Or in CMD from this folder:

```bash
set PORT=5009 && node server.js
```

Customer link:

```text
http://localhost:5009
```

Kitchen dashboard:

```text
http://localhost:5009/kitchen
```

Admin key:

```text
change-this-before-pilot
```

## Important

This is still a controlled prototype, not a production NHS system. Do not collect patient data, clinical data, NHS numbers, staff numbers, payment details or allergy free-text.

Before any real launch or formal pilot, add the 11:00 same-day cut-off back in.

## v18: Weekly menus (rolling Mon–Fri menu)

Kitchen dashboard → **Weekly menus** tab.

- Save a menu once for each weekday (Monday–Friday), using the same editor and dietary tags as Menu setup.
- Each morning, pick the day and tap **Make [day] live today**. That day's saved menu is copied into today's live menu.
- Changes made afterwards on the **Menu setup** tab only affect today; the saved weekday menu is not changed.
- Saved weekday menus live in `data/weekly-menus.json` (created automatically on first start, with every day copied from the current menu).
- Existing orders are never changed when a different day is made live.

## v19: Self-hosted fonts (no third-party requests)

- The Fraunces and Inter fonts are now stored in `public/fonts` instead of being loaded from Google Fonts.
- The app no longer contacts any outside service when a page is opened.
- Both fonts are free under the SIL Open Font Licence; the licence files are included in `public/fonts`.

## v20: "Clear orders" button (end of service)

- Kitchen dashboard → Orders → **Clear orders** (red button next to Export CSV).
- Permanently deletes today's orders, plus any older orders left over from a day it wasn't pressed. Orders dated for a future day are kept.
- Before deleting, it shows how many orders will go, warns if any haven't been marked Collected, and reminds the kitchen to Export CSV first if they need a record.
- This replaces double-clicking `RESET_ORDERS_WINDOWS.bat`, which won't be available once the app is hosted online. (The .bat file still works on a laptop.)
