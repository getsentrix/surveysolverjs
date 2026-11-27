# Universal Survey Solver (Gemini)

A Tampermonkey userscript that fills out web surveys using Google's Gemini API. It adds a small floating control bar to survey pages and includes an optional Auto-Farm mode that solves and clicks Next across pages.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Install the script from [Greasy Fork](https://greasyfork.org/en/scripts/607189-universal-survey-solver-gemini).
3. On first install, the setup page opens automatically so you can save your API key. Future updates from Greasy Fork happen automatically and keep your saved key intact.

## Setup

### 1. Get a free Google AI Studio API key
1. Go to [aistudio.google.com/api-keys](https://aistudio.google.com/api-keys) and sign in with a Google account.
2. Click **Create API key** and copy it. No credit card is required.
3. Paste the key into the setup page that opens after install, or click the Tampermonkey icon on any tab → **Universal Survey Solver (Gemini)** → **Set Gemini API Key**.

*(Saving the key through the setup page or Tampermonkey menu stores it in Tampermonkey's local storage so Greasy Fork updates won't overwrite it.)*

### 2. Start on a survey site
If you need a good place to start, try [gain.gg/surveys](https://gain.gg/surveys). Open any survey, wait for the page to load, and use the bottom-right control bar or shortcuts below.

## Controls & Shortcuts

| Shortcut | HUD Button | What it does |
| :--- | :--- | :--- |
| `Alt + A` | **Solve** | Solves all unanswered questions on the page (or just what you highlighted). |
| `Alt + S` | **Next** | Clicks Next / Continue / Submit while ignoring Back, Cancel, and Exit. |
| `Alt + F` | **Auto** | Toggles Auto-Farm on/off for the current tab. |
| `Alt + X` | **Stop** | Stops everything immediately (cancels active requests, typing, and Auto-Farm). |

You can drag the pill anywhere on the screen using the left handle, or click `−` to collapse it down to a dot.

## What It Handles

- Radio buttons, checkboxes, and custom clickable card options (including button-style cards like CloudResearch Sentry)
- Matrix / Likert grids (batched into a single API call per table)
- Multi-question pages (batches up to 8 choice/dropdown questions per request)
- Native `<select>` dropdowns and custom ARIA / Select2 / Choices dropdowns
- Numeric inputs, constant-sum allocation tables (e.g. rows that must total 100%), range sliders, dates, and emails
- Open-ended text boxes with character/word limit detection and simulated typing
- "Other (please specify)" companion boxes and common attention checks
- Ignores list search/filter boxes, corner language switchers, and embedded iframes

## Auto-Farm Behavior

Auto-Farm (`Alt + F`) loops through `Solve → pause → Next` and stays active across page reloads inside the same tab (it does not run in other tabs).

Built-in safety stops:
- **CAPTCHAs:** Pauses on active CAPTCHA challenges and visible checkboxes, while ignoring passive reCAPTCHA v3 badges in the corner.
- **Stuck pages:** Stops after two failed attempts on the same page so it doesn't loop and burn API quota.
- **End screens:** Turns itself off on completion, screen-out, or quota-full pages.
- **Pacing:** Uses randomized delays plus occasional 2–3 second waits to avoid speeder flags.

## Model & Speed Settings

By default, the script uses **`gemma-4-26b-a4b-it`** (30 RPM / 14,400 requests/day on the free tier) and automatically falls back to `gemma-4-31b-it` and `gemini-3.5-flash-lite` if a model times out or hits a limit.

You can tweak pacing at the top of the script:

```js
const SPEED_MODE = 'fast'; // 'fast', 'balanced', or 'human'
```

## Hosting the Setup Page (`index.html`)

This repo includes `index.html` for the first-install setup page:
1. Enable **GitHub Pages** in your repo settings (**Settings → Pages → Deploy from branch → `main` / `(root)`**).
2. Set `WELCOME_PAGE_URL` near the top of the userscript to your GitHub Pages URL.

## Privacy

Your API key is stored locally in Tampermonkey (`GM_setValue`). The script only talks to:
- `generativelanguage.googleapis.com` (to answer survey prompts)
- `update.greasyfork.org` (to check for script updates once per day)

## License

MIT — see [LICENSE](./LICENSE).