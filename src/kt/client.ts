/**
 * Client for the private JSON API behind www.kaloricketabulky.cz.
 *
 * The site is a Spring MVC app where any route accepts `?format=json` and
 * replies with a `{code, data, message}` envelope (`code: 0` means success).
 * Auth is a JSESSIONID cookie obtained by posting an md5 of the password.
 *
 * None of this is documented or guaranteed by Dine4Fit. Every call that
 * deviates from the shape we expect throws rather than guessing, so a
 * frontend change surfaces as a loud error instead of a wrong calorie count.
 */

import { createHash } from 'node:crypto';

const BASE = 'https://www.kaloricketabulky.cz';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** unitGuid for plain grams — accepted by every solid food. */
export const GRAM_UNIT = '0000000000000001';

/**
 * Pseudo-unit meaning "one portion of this recipe", offered only by the
 * meal-add form (alongside `0000000000000003` for percent).
 */
export const PORTION_UNIT = '0000000000000004';

/** Diary time slots, keyed by the `diaryTimeGuid` the site expects. */
export const MEALS = {
  '1': 'Snídaně',
  '2': 'Dopolední svačina',
  '3': 'Oběd',
  '4': 'Odpolední svačina',
  '5': 'Večeře',
  '6': 'Druhá večeře',
} as const;

export type MealId = keyof typeof MEALS;

export interface FoodHit {
  id: string;
  title: string;
  /** Energy per 100 g / 100 ml, as the site reports it in search results. */
  energyPer100: number | null;
  energyUnit: string;
  baseUnit: string;
  brand: string | null;
}

export interface UnitOption {
  id: string;
  title: string;
  /** Grams (or ml) that one of this unit corresponds to. */
  grams: number;
}

export interface FoodDetail {
  id: string;
  title: string;
  units: UnitOption[];
  /** The site's own default portion for this food. */
  defaultUnitId: string;
  defaultAmount: number;
}

export interface Nutrition {
  title: string;
  energy: number | null;
  energyUnit: string;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  sugar: number | null;
  fibre: number | null;
  saturatedFat: number | null;
  salt: number | null;
}

export interface MealSummary {
  id: string;
  title: string;
  /** Energy for the whole recipe, not per portion. */
  energy: number | null;
  energyUnit: string;
  portions: number;
}

export interface ActivityHit {
  id: string;
  title: string;
  /** The site's category, e.g. "Chůze". */
  category: string | null;
}

export interface DiaryActivity {
  id: string;
  title: string;
  /** Duration as the site displays it, e.g. "30 min". */
  duration: string;
  energy: number | null;
  energyUnit: string;
}

export interface DiaryFood {
  id: string;
  title: string;
  /** Amount as the site displays it, e.g. "kus (40 g)" or "120 x 1 g". */
  amount: string;
  energy: number | null;
  energyUnit: string;
  meal: MealId;
  isRecipe: boolean;
  /** The database food this entry was logged from; null for recipes and own foods. */
  foodId: string | null;
  /** Whether the site lets the amount be changed (false for own foods and recipes). */
  editable: boolean;
}

export interface DiaryNote {
  id: string;
  text: string;
  /** The meal slot the note is attached to, or null for a note on the whole day. */
  meal: MealId | null;
}

export interface DayEntries {
  foods: DiaryFood[];
  activities: DiaryActivity[];
  notes: DiaryNote[];
}

export interface DayTotals {
  date: string;
  energy: number | null;
  energyTarget: number | null;
  energyBurned: number | null;
  energyUnit: string;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  /** Litres drunk, which the site counts from logged drinks on its own. */
  drinkLitres: number | null;
  drinkTargetLitres: number | null;
  weightKg: number | null;
  weightTargetKg: number | null;
  /**
   * Every nutrient the user tracks on the site, with its daily goal. The
   * first four (protein, carbs, fat, fibre) are always there; the rest are
   * whatever the user picked in the site's settings.
   */
  nutrients: NutrientProgress[];
}

export interface NutrientProgress {
  /** The site's key, e.g. "protein", "carbohydrate", "sugar", "calcium". */
  code: string;
  title: string;
  unit: string;
  actual: number | null;
  goal: number | null;
  /** goal − actual; negative once the goal is exceeded. */
  remaining: number | null;
  /** The site's own percentage of the goal reached. */
  percent: number | null;
}

export interface NamedItem {
  id: string;
  title: string;
}

/** Nutrition for an own food. Energy is in kcal; the rest are grams. */
export interface OwnFoodValues {
  energyKcal: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  sugar?: number;
  fibre?: number;
  saturatedFat?: number;
  salt?: number;
}

export class KtError extends Error {}

/**
 * A food's base unit — the one whose multiplier is 1 (the site sends `null`
 * for it). Grams for solids, millilitres for liquids, and a liquid's unit list
 * does not contain the gram unit at all, so this must be read per food rather
 * than assumed.
 */
export function baseUnitOf(units: UnitOption[]): string {
  return units.find(u => u.grams === 0 || u.grams === 1)?.id ?? GRAM_UNIT;
}

/**
 * Czech number formatting: decimal comma, thin/regular space as the thousands
 * separator ("1 043", "20,43"). Returns null for absent or unparseable values
 * rather than a misleading 0.
 */
export function parseCzechNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalised = value.replace(/[\s  ]/g, '').replace(',', '.');
  if (normalised === '') return null;
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

/**
 * Parses the diary page's summary panel (`/user/diary/summary/{date}/get`).
 * Every row in `items` and `itemsDynamic` pairs a display `actual` with a
 * `goal`, both Czech-formatted strings. Nutrient rows also carry the exact
 * `actualValue`, but on the energy row it is always 0, so energy comes from
 * `foodstuffEnergyTotal` instead.
 */
export function parseDiarySummary(day: string, data: unknown): DayTotals {
  const s = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const balance = (s['balance'] ?? {}) as Record<string, unknown>;
  const items = Array.isArray(s['items']) ? (s['items'] as Record<string, unknown>[]) : [];
  const dynamic = (Array.isArray(s['itemsDynamic']) ? (s['itemsDynamic'] as unknown[]) : [])
    .flatMap(group => (Array.isArray(group) ? (group as Record<string, unknown>[]) : []));

  const nutrients: NutrientProgress[] = dynamic
    .filter(row => typeof row['code'] === 'string')
    .map(row => {
      const actual = round1(parseCzechNumber(row['actualValue']) ?? parseCzechNumber(row['actual']));
      const goal = parseCzechNumber(row['goal']);
      return {
        code: row['code'] as string,
        title: String(row['title'] ?? row['titleShort'] ?? row['code']),
        unit: typeof row['unit'] === 'string' ? row['unit'] : '',
        actual,
        goal,
        remaining: actual === null || goal === null ? null : round1(goal - actual),
        percent: typeof row['percent'] === 'number' ? row['percent'] : null,
      };
    });
  const nutrient = (code: string) => nutrients.find(n => n.code === code)?.actual ?? null;

  const energyItem = items.find(i => i['code'] === 'total');
  // Drinks and weight have no code; the unit is the stable way to tell them apart.
  const drinkItem = items.find(i => i['unit'] === 'l');
  const weightItem = items.find(i => i['unit'] === 'kg');
  return {
    date: day,
    energy: parseCzechNumber(s['foodstuffEnergyTotal']),
    energyTarget: parseCzechNumber(balance['target']) ?? parseCzechNumber(energyItem?.['goal']),
    energyBurned: parseCzechNumber(s['activityEnergyTotal']),
    energyUnit: typeof energyItem?.['unit'] === 'string' ? energyItem['unit'] : 'kcal',
    protein: nutrient('protein'),
    carbs: nutrient('carbohydrate'),
    fat: nutrient('fat'),
    drinkLitres: parseCzechNumber(drinkItem?.['actual']),
    drinkTargetLitres: parseCzechNumber(drinkItem?.['goal']),
    weightKg: parseCzechNumber(weightItem?.['actual']),
    // An unset weight goal comes back as null or "0".
    weightTargetKg: parseCzechNumber(weightItem?.['goal']) || null,
    nutrients,
  };
}

/** The inverse of parseCzechNumber: 97.3 → "97,3". */
export function formatCzechDecimal(value: number): string {
  return String(value).replace('.', ',');
}

/** The site formats dates as dd.MM.yyyy everywhere. */
export function formatCzechDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${date.getFullYear()}`;
}

export function todayCzech(): string {
  // The diary runs on Czech wall-clock time; the server usually doesn't
  // (containers default to UTC, which would flip the date around midnight).
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}`;
}

/**
 * Dates come from the model, and one of them ends up in a URL path, so accept
 * nothing but the site's own dd.MM.yyyy shape.
 */
/**
 * Every id we put into a URL path is one of the site's hex guids (or a short
 * numeric id like a meal slot). Anything else, including a comma-separated
 * list that some routes would happily accept, is refused.
 */
export function assertGuid(id: string, what: string): string {
  if (!/^[0-9a-f]{1,32}$/i.test(id)) throw new KtError(`invalid ${what} id "${id}"`);
  return id;
}

/** Adds days to a dd.MM.yyyy date, in calendar terms (no DST surprises). */
export function shiftCzechDate(date: string, days: number): string {
  const [d, m, y] = assertCzechDate(date).split('.').map(Number) as [number, number, number];
  return formatCzechDate(new Date(y, m - 1, d + days));
}

export function assertCzechDate(date: string): string {
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(date)) {
    throw new Error(`Invalid date "${date}" — expected dd.MM.yyyy, e.g. ${todayCzech()}`);
  }
  return date;
}

export interface KtCredentials {
  email: string;
  password: string;
}

export class KtClient {
  private cookie: string | null = null;
  private loginInFlight: Promise<void> | null = null;

  constructor(private readonly credentials: KtCredentials) {}

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; redirectedToLogin: boolean; text: string }> {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/json',
    };
    if (this.cookie) headers['Cookie'] = this.cookie;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(BASE + path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    });

    // Capture a rotated session cookie whenever the site issues one.
    const setCookie = response.headers.getSetCookie?.() ?? [];
    const jsession = setCookie.find(c => c.startsWith('JSESSIONID='));
    if (jsession) this.cookie = jsession.split(';')[0] ?? null;

    // Spring Security answers unauthenticated /user/** with a 302 to /login.
    const location = response.headers.get('location') ?? '';
    const redirectedToLogin = response.status >= 300 && response.status < 400 && location.includes('/login');

    return { status: response.status, redirectedToLogin, text: await response.text() };
  }

  private parseEnvelope(text: string, context: string): unknown {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new KtError(`${context}: expected JSON, got ${text.slice(0, 120)}`);
    }
    // Two envelope shapes exist: most routes send {code, message, data}, but
    // some list endpoints send {requestId, count, data} with no code at all.
    // Unwrap `data` whenever it is present, and only enforce `code` when it is.
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const envelope = body as { code?: number; message?: string; data?: unknown };
      if (typeof envelope.code === 'number' && envelope.code !== 0) {
        throw new KtError(`${context}: ${envelope.message ?? `code ${envelope.code}`}`);
      }
      if ('data' in envelope && envelope.data !== null) return envelope.data;
    }
    return body;
  }

  /** Logs in, reusing an in-flight attempt so concurrent tool calls don't stampede. */
  private async login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      this.cookie = null;
      const passwordHash = createHash('md5').update(this.credentials.password).digest('hex');
      const { text } = await this.request('/login/create?format=json', {
        method: 'POST',
        body: { email: this.credentials.email, password: passwordHash },
      });
      this.parseEnvelope(text, 'login');
      if (!this.cookie) throw new KtError('login succeeded but no session cookie was issued');
    })().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /** Runs an authenticated call, logging in on first use and once on session expiry. */
  private async authed(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    if (!this.cookie) await this.login();
    let result = await this.request(path, init);
    if (result.redirectedToLogin) {
      await this.login();
      result = await this.request(path, init);
      if (result.redirectedToLogin) throw new KtError(`${path}: still unauthenticated after re-login`);
    }
    return this.parseEnvelope(result.text, path);
  }

  /**
   * The site's combined autocomplete, which returns foods, activities and
   * recipes in one list tagged by `clazz`. Works anonymously.
   */
  private async autocomplete(query: string, clazz: string): Promise<Record<string, unknown>[]> {
    const { text } = await this.request(
      `/autocomplete/foodstuff-activity-meal?format=json&query=${encodeURIComponent(query)}`,
    );
    const data = this.parseEnvelope(text, 'search');
    if (!Array.isArray(data)) throw new KtError('search: expected an array of results');
    return data.filter(
      (row): row is Record<string, unknown> => !!row && typeof row === 'object' && (row as Record<string, unknown>)['clazz'] === clazz,
    );
  }

  /**
   * Full-text or EAN search. Works anonymously, so no login is forced here.
   * A 13-digit barcode resolves to the matching product.
   */
  async search(query: string, limit = 10): Promise<FoodHit[]> {
    return (await this.autocomplete(query, 'foodstuff')).slice(0, limit).map(row => ({
      id: String(row['id']),
      title: String(row['title']),
      energyPer100: parseCzechNumber(row['value']),
      energyUnit: typeof row['energyUnit'] === 'string' ? row['energyUnit'] : 'kcal',
      baseUnit: typeof row['unit'] === 'string' ? row['unit'] : 'g',
      brand: typeof row['brandName'] === 'string' ? row['brandName'] : null,
    }));
  }

  /**
   * Activity search. The result's `value` is deliberately not exposed: it is
   * an intensity factor whose scaling does not match what the site actually
   * logs (it came out about a quarter lower in testing), and the site
   * computes the real figure from the user's weight when the entry is added.
   */
  async searchActivities(query: string, limit = 10): Promise<ActivityHit[]> {
    return (await this.autocomplete(query, 'activity')).slice(0, limit).map(row => ({
      id: String(row['id']),
      title: String(row['title']),
      category: typeof row['type'] === 'string' ? row['type'] : null,
    }));
  }

  /**
   * The site's own add-entry form for a food. This is the source of truth for
   * which portion units exist ("kus (55 g)"), so "3 eggs" maps onto the site's
   * model instead of us guessing gram weights.
   */
  async getFoodDetail(foodId: string): Promise<FoodDetail> {
    const { text } = await this.request(
      `/foodstuff/detail/form/${encodeURIComponent(foodId)}?format=json&default=true`,
    );
    const form = this.parseEnvelope(text, 'food detail') as Record<string, unknown>;
    if (typeof form['guid'] !== 'string') throw new KtError(`food detail: unknown food id ${foodId}`);

    const rawUnits = Array.isArray(form['unitOptions']) ? form['unitOptions'] : [];
    const units: UnitOption[] = rawUnits
      .filter((u): u is Record<string, unknown> => !!u && typeof u === 'object')
      .map(u => ({
        id: String(u['id']),
        title: String(u['title']),
        grams: parseCzechNumber(u['multiplier']) ?? 0,
      }));
    // The site echoes back whatever guid is requested, even for foods that do
    // not exist, so the guid check above no longer catches bad ids. A real
    // food always offers at least its base unit; an empty list means the id
    // is unknown.
    if (units.length === 0) throw new KtError(`food detail: unknown food id ${foodId}`);

    return {
      id: form['guid'],
      title: String(form['title'] ?? ''),
      units,
      defaultUnitId: typeof form['unitGuid'] === 'string' ? form['unitGuid'] : GRAM_UNIT,
      defaultAmount: parseCzechNumber(form['multiplier']) ?? 100,
    };
  }

  /** Nutrition for a given quantity, scaled server-side by the site itself. */
  async getNutrition(foodId: string, amount: number, unitId: string): Promise<Nutrition> {
    const { text } = await this.request(
      `/foodstuff/detail/${encodeURIComponent(foodId)}/${amount}/${encodeURIComponent(unitId)}?format=json`,
    );
    const data = this.parseEnvelope(text, 'nutrition') as Record<string, unknown>;
    const food = data['foodstuff'];
    if (!food || typeof food !== 'object') throw new KtError('nutrition: response had no foodstuff block');
    const f = food as Record<string, unknown>;

    return {
      title: String(f['title'] ?? ''),
      energy: parseCzechNumber(f['energy']),
      energyUnit: typeof data['energyUnit'] === 'string' ? data['energyUnit'] : 'kcal',
      protein: parseCzechNumber(f['protein']),
      carbs: parseCzechNumber(f['carbohydrate']),
      fat: parseCzechNumber(f['fat']),
      sugar: parseCzechNumber(f['sugar']),
      fibre: parseCzechNumber(f['fiber']),
      saturatedFat: parseCzechNumber(f['saturatedFattyAcid']),
      salt: parseCzechNumber(f['salt']),
    };
  }

  /**
   * Creates a diary entry. We fetch the site's own form first and override only
   * the four fields that describe this portion, so any field we don't know
   * about keeps whatever value the site considers correct.
   *
   * The trailing `&=` is the site's (empty) CSRF token pair — its own frontend
   * appends it the same way.
   */
  async logFood(args: {
    foodId: string;
    amount: number;
    unitId?: string;
    meal: MealId;
    date?: string;
  }): Promise<void> {
    // Fetch the form with a session established, exactly as the site's own
    // frontend does: it carries user-specific fields (favourite, preferred
    // unit) that we must post back unchanged.
    const form = (await this.authed(
      `/foodstuff/detail/form/${encodeURIComponent(args.foodId)}?format=json&default=true`,
    )) as Record<string, unknown>;
    if (typeof form['guid'] !== 'string') throw new KtError(`log food: unknown food id ${args.foodId}`);

    // The site's own frontend posts the fetched form back whole, option
    // arrays included — deviate from that and the server may reject the write
    // ("Potravinu se nepodařilo zapsat do deníku").
    const payload: Record<string, unknown> = { ...form };
    payload['multiplier'] = args.amount;
    payload['unitGuid'] = args.unitId ?? form['unitGuid'] ?? GRAM_UNIT;
    payload['diaryTimeGuid'] = args.meal;
    payload['date'] = args.date === undefined ? todayCzech() : assertCzechDate(args.date);

    await this.authed('/user/foodstuff/add?format=json&=', { method: 'POST', body: payload });
  }

  /** Raw daily summary. Shape is not fully documented, so it is passed through. */
  async getDaySummary(date?: string): Promise<unknown> {
    return this.authed(`/statistic/summary/${date === undefined ? todayCzech() : assertCzechDate(date)}/get?format=json`);
  }

  // ---------------------------------------------------------------------
  // Activity and weight
  // ---------------------------------------------------------------------

  /**
   * Logs an activity for a duration. As with food, the site's own form is
   * fetched and posted back whole with only duration and date overridden;
   * the site then computes the energy from the user's current weight.
   *
   * `activityId` "0" is the site's custom activity, which needs a title and
   * a total energy instead of relying on the database.
   */
  private async addActivity(args: {
    activityId: string;
    minutes: number;
    date?: string;
    custom?: { title: string; energyKcal: number };
  }): Promise<void> {
    const form = (await this.authed(
      `/user/activity/add/form/${encodeURIComponent(args.activityId)}?format=json`,
    )) as Record<string, unknown>;
    // Like the food form, this echoes any guid back; a real activity always
    // carries its title, so a missing one means the id is unknown.
    if (!args.custom && typeof form['title'] !== 'string') {
      throw new KtError(`log activity: unknown activity id ${args.activityId}`);
    }

    const payload: Record<string, unknown> = { ...form };
    payload['time'] = args.minutes;
    payload['timeUnit'] = 'min';
    payload['date'] = args.date === undefined ? todayCzech() : assertCzechDate(args.date);
    if (args.custom) {
      payload['title'] = args.custom.title;
      // The form carries the user's preferred energy unit; the tool always
      // speaks kcal, so convert for users who switched the site to kJ.
      payload['energy'] =
        form['energyUnit'] === 'kj' ? Math.round(args.custom.energyKcal * 4.184) : args.custom.energyKcal;
    }

    await this.authed('/user/activity/add?format=json&=', { method: 'POST', body: payload });
  }

  async logActivity(args: { activityId: string; minutes: number; date?: string }): Promise<void> {
    if (args.activityId === '0') throw new KtError('log activity: use a custom activity for id 0');
    await this.addActivity(args);
  }

  /** An activity not in the database, e.g. a workout whose calories came from a watch. */
  async logCustomActivity(args: { title: string; energyKcal: number; minutes: number; date?: string }): Promise<void> {
    await this.addActivity({
      activityId: '0',
      minutes: args.minutes,
      date: args.date,
      custom: { title: args.title, energyKcal: args.energyKcal },
    });
  }

  /**
   * Every entry in one day's diary, food and activity alike, with the entry
   * ids the delete calls need. Food comes grouped by meal slot (`times`),
   * activities as a flat list.
   */
  async getDayEntries(date?: string): Promise<DayEntries> {
    const day = date === undefined ? todayCzech() : assertCzechDate(date);
    const diary = (await this.authed(`/user/diary/${day}/get?format=json`)) as Record<string, unknown>;
    const times = diary['times'];
    const activities = diary['activities'];
    if (!Array.isArray(times) || !Array.isArray(activities)) {
      throw new KtError('diary: response had no times or activities list');
    }

    const foods: DiaryFood[] = [];
    for (const slot of times) {
      if (!slot || typeof slot !== 'object') continue;
      const s = slot as Record<string, unknown>;
      const meal = String(s['id']);
      if (!(meal in MEALS) || !Array.isArray(s['foodstuff'])) continue;
      for (const f of s['foodstuff']) {
        if (!f || typeof f !== 'object') continue;
        const e = f as Record<string, unknown>;
        foods.push({
          id: String(e['id']),
          title: String(e['title'] ?? ''),
          amount: String(e['unit'] ?? ''),
          energy: parseCzechNumber(e['energy']),
          energyUnit: typeof e['energyUnit'] === 'string' ? e['energyUnit'] : 'kcal',
          meal: meal as MealId,
          isRecipe: e['isRecipe'] === true,
          foodId: typeof e['guidType'] === 'string' ? e['guidType'] : null,
          editable: e['editableUnit'] === true,
        });
      }
    }

    // Notes come back with the author's full user record attached, password
    // hash included, so only the id and text are ever read out of them.
    const notes: DiaryNote[] = [];
    const readNotes = (list: unknown, meal: MealId | null) => {
      if (!Array.isArray(list)) return;
      for (const n of list) {
        if (!n || typeof n !== 'object') continue;
        const note = n as Record<string, unknown>;
        notes.push({ id: String(note['id']), text: String(note['text'] ?? ''), meal });
      }
    };
    readNotes(diary['notes'], null);
    for (const slot of times) {
      if (!slot || typeof slot !== 'object') continue;
      const s = slot as Record<string, unknown>;
      const meal = String(s['id']);
      if (meal in MEALS) readNotes(s['notes'], meal as MealId);
    }

    return {
      foods,
      notes,
      activities: activities
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .map(a => ({
          id: String(a['id']),
          title: String(a['title'] ?? ''),
          duration: String(a['unit'] ?? ''),
          energy: parseCzechNumber(a['energy']),
          energyUnit: typeof a['energyUnit'] === 'string' ? a['energyUnit'] : 'kcal',
        })),
    };
  }

  /** The activities logged on one day, with the energy the site computed. */
  async getDayActivities(date?: string): Promise<DiaryActivity[]> {
    return (await this.getDayEntries(date)).activities;
  }

  /**
   * Deletes one diary entry. The site's delete routes take a comma-separated
   * id list in the path, so the id is checked to be a single bare hex guid:
   * a model-supplied "a,b,c" must not turn one delete into several.
   */
  private async deleteEntry(kind: 'foodstuff' | 'activity' | 'note', entryId: string): Promise<void> {
    if (!/^[0-9a-f]{16,32}$/i.test(entryId)) throw new KtError(`invalid diary entry id "${entryId}"`);
    await this.authed(`/user/diary/${kind}/delete/${entryId}?format=json`);
  }

  /** Removes a food, recipe or own-food entry from the diary. */
  async deleteFoodEntry(entryId: string): Promise<void> {
    await this.deleteEntry('foodstuff', entryId);
  }

  async deleteActivityEntry(entryId: string): Promise<void> {
    await this.deleteEntry('activity', entryId);
  }

  async deleteNote(noteId: string): Promise<void> {
    await this.deleteEntry('note', noteId);
  }

  // ---------------------------------------------------------------------
  // Editing and copying diary entries
  // ---------------------------------------------------------------------

  /**
   * Changes the amount of a logged food. The site's edit form carries the
   * entry's unit list; only the count and unit are overridden. Own foods and
   * recipes have no such form (the site answers 500), so callers check
   * `editable` first. Either value may be omitted to keep the current one.
   */
  async editFoodAmount(entryId: string, amount?: number, unitId?: string): Promise<void> {
    const form = (await this.authed(
      `/user/diary/foodstuff/unit/form/${assertGuid(entryId, 'diary entry')}?format=json`,
    )) as Record<string, unknown>;
    const options = Array.isArray(form['unitOptions']) ? (form['unitOptions'] as Record<string, unknown>[]) : [];
    const unit = unitId ?? String(form['unitGuid']);
    if (!options.some(o => o['id'] === unit)) {
      throw new KtError(
        `unit ${unit} is not valid for this entry. Available: ` + options.map(o => `${o['title']} (${o['id']})`).join(', '),
      );
    }
    await this.authed('/user/diary/foodstuff/unit/edit?format=json&=', {
      method: 'POST',
      body: { ...form, diaryGuid: form['diaryGuid'] ?? entryId, multiplier: amount ?? form['multiplier'], unitGuid: unit },
    });
  }

  /** Changes the duration of a logged activity; the site recomputes its energy. */
  async editActivityDuration(entryId: string, minutes: number): Promise<void> {
    const form = (await this.authed(
      `/user/diary/activity/unit/form/${assertGuid(entryId, 'diary entry')}?format=json`,
    )) as Record<string, unknown>;
    await this.authed('/user/diary/activity/unit/edit?format=json&=', {
      method: 'POST',
      body: { ...form, diaryGuid: form['diaryGuid'] ?? entryId, multiplier: minutes, unit: 'min' },
    });
  }

  /**
   * Copies the food in one meal slot to another day and/or slot, through the
   * site's own "copy meal" form. `foodIds`, when given, limits the copy to
   * entries of those database foods. Returns the titles that were copied.
   *
   * The form lists the slot's food in its own order, not the diary's, so
   * items are matched by food id (and, for `onlyEntry`, also by amount and
   * unit), never by position.
   */
  async copyMealSlot(args: {
    fromDate: string;
    fromMeal: MealId;
    toDate: string;
    toMeal: MealId;
    foodIds?: string[];
    onlyEntry?: { foodId: string; amount: number; unitId: string };
  }): Promise<string[]> {
    const form = (await this.authed(
      `/user/diary-time/create/form/${assertCzechDate(args.fromDate)}/${args.fromMeal}?format=json`,
    )) as Record<string, unknown>;
    const items = Array.isArray(form['foodstuff']) ? (form['foodstuff'] as Record<string, unknown>[]) : [];
    if (items.length === 0) throw new KtError(`${MEALS[args.fromMeal]} on ${args.fromDate} has no food to copy`);

    let picked = false;
    for (const item of items) {
      let select = true;
      if (args.onlyEntry) {
        const e = args.onlyEntry;
        select = !picked && item['foodstuffGuid'] === e.foodId && Number(item['count']) === e.amount && item['selectedUnitGuid'] === e.unitId;
      } else if (args.foodIds) {
        select = args.foodIds.includes(String(item['foodstuffGuid']));
      }
      item['selected'] = select;
      if (select) picked = true;
    }
    if (!picked) throw new KtError('none of the requested food is in that meal');

    await this.authed('/user/diary-time/copy?format=json&=', {
      method: 'POST',
      body: { ...form, date: assertCzechDate(args.toDate), diaryTimeGuid: args.toMeal },
    });
    return items.filter(i => i['selected']).map(i => String(i['title'] ?? ''));
  }

  /**
   * Moves one database-food entry to another meal slot on the same day:
   * copy it with the site's own form, then delete the original. The copy
   * goes first, so a failure part-way leaves a duplicate, never a loss.
   */
  async moveFoodEntry(entryId: string, date: string, toMeal: MealId): Promise<void> {
    const entries = await this.getDayEntries(date);
    const entry = entries.foods.find(f => f.id === entryId);
    if (!entry) throw new KtError(`no food entry ${entryId} on ${date}`);
    if (!entry.foodId || !entry.editable) {
      throw new KtError(`${entry.title} is a recipe or own food, which the site cannot move; delete it and log it again instead`);
    }
    if (entry.meal === toMeal) return;
    const form = (await this.authed(
      `/user/diary/foodstuff/unit/form/${assertGuid(entryId, 'diary entry')}?format=json`,
    )) as Record<string, unknown>;
    await this.copyMealSlot({
      fromDate: date,
      fromMeal: entry.meal,
      toDate: date,
      toMeal,
      onlyEntry: { foodId: entry.foodId, amount: Number(form['multiplier']), unitId: String(form['unitGuid']) },
    });
    await this.deleteFoodEntry(entryId);
  }

  // ---------------------------------------------------------------------
  // Own foods, notes, favourites
  // ---------------------------------------------------------------------

  /**
   * Logs a food that is not in the database, with nutrition the caller
   * supplies (typically read off a label). This is the site's "own food"
   * form (id 0): a one-off diary entry, not a new database food.
   */
  async logOwnFood(args: { title: string; values: OwnFoodValues; meal: MealId; date?: string }): Promise<void> {
    const form = (await this.authed('/user/foodstuff/add/form/0?format=json')) as Record<string, unknown>;
    const v = args.values;
    const payload: Record<string, unknown> = { ...form };
    payload['title'] = args.title;
    // As with custom activities, the form carries the user's energy unit.
    payload['energy'] = form['energyUnit'] === 'kj' ? Math.round(v.energyKcal * 4.184) : v.energyKcal;
    payload['protein'] = v.protein ?? null;
    payload['carbohydrate'] = v.carbs ?? null;
    payload['fat'] = v.fat ?? null;
    payload['sugar'] = v.sugar ?? null;
    payload['fiber'] = v.fibre ?? null;
    payload['saturatedFattyAcid'] = v.saturatedFat ?? null;
    payload['salt'] = v.salt ?? null;
    payload['diaryTimeGuid'] = args.meal;
    payload['date'] = args.date === undefined ? todayCzech() : assertCzechDate(args.date);
    await this.authed('/user/foodstuff/add?format=json&=', { method: 'POST', body: payload });
  }

  /** Adds a note to a day, or to one meal slot of it. */
  async addNote(args: { text: string; meal?: MealId; date?: string }): Promise<void> {
    await this.authed('/user/diary/note/add?format=json&=', {
      method: 'POST',
      body: {
        date: args.date === undefined ? todayCzech() : assertCzechDate(args.date),
        note: args.text,
        time: args.meal === undefined ? 0 : Number(args.meal),
      },
    });
  }

  private async namedList(path: string): Promise<NamedItem[]> {
    const data = await this.authed(path);
    if (!Array.isArray(data)) throw new KtError(`${path}: expected a list`);
    return data
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map(x => ({ id: String(x['id']), title: String(x['title'] ?? '') }));
  }

  /**
   * The user's favourites and the site's own "most used" lists. Ids are the
   * same database ids search returns, so they feed straight into logging.
   */
  async getUsualItems(): Promise<{
    favouriteFoods: NamedItem[];
    commonFoods: NamedItem[];
    favouriteActivities: NamedItem[];
    commonActivities: NamedItem[];
  }> {
    return {
      favouriteFoods: await this.namedList('/user/settings/favorite/foodstuff?format=json'),
      commonFoods: await this.namedList('/user/settings/common/foodstuff?format=json'),
      favouriteActivities: await this.namedList('/user/settings/favorite/activity?format=json'),
      commonActivities: await this.namedList('/user/settings/common/activity?format=json'),
    };
  }

  async setFavourite(kind: 'food' | 'activity', id: string, favourite: boolean): Promise<void> {
    const type = kind === 'food' ? 'foodstuff' : 'activity';
    await this.authed(
      `/user/settings/favorite/${type}/${favourite ? 'add' : 'remove'}/${assertGuid(id, kind)}?format=json`,
    );
  }

  // ---------------------------------------------------------------------
  // Overviews and templates
  // ---------------------------------------------------------------------

  /**
   * Totals for one day: eaten, target, burned, macros and drinks. These come
   * from the diary page's summary panel; the diary itself carries total
   * fields too, but they are always 0.
   */
  async getDayTotals(date: string): Promise<DayTotals> {
    const day = assertCzechDate(date);
    return parseDiarySummary(day, await this.authed(`/user/diary/summary/${day}/get?format=json`));
  }

  async listTemplates(): Promise<NamedItem[]> {
    return this.namedList('/user/templates/list?format=json');
  }

  /** Saves a day of the diary as a reusable template ("Moje jídelníčky"). */
  async createTemplate(args: { title: string; date: string; includeActivities: boolean; includeNotes: boolean }): Promise<void> {
    await this.authed(`/user/templates/diary/${assertCzechDate(args.date)}/create?format=json`, {
      method: 'POST',
      body: { title: args.title, includeActivities: args.includeActivities, includeNotes: args.includeNotes },
    });
  }

  /**
   * Writes a template into the diary on each of the given dates. The write
   * must carry the template's full form: posting the bare list entry, which
   * has no content, is acknowledged as a success but writes nothing.
   */
  async applyTemplate(templateId: string, dates: string[]): Promise<void> {
    const form = (await this.authed(
      `/user/templates/form/${assertGuid(templateId, 'template')}?format=json`,
    )) as Record<string, unknown>;
    if (!Array.isArray(form['times'])) throw new KtError(`template ${templateId} not found`);
    await this.authed('/user/templates/diary/write?format=json', {
      method: 'POST',
      body: { ...form, write: true, share: false, datesToAdd: dates.map(assertCzechDate) },
    });
  }

  async deleteTemplate(templateId: string): Promise<void> {
    const entry = (await this.listTemplatesRaw()).find(t => t['id'] === assertGuid(templateId, 'template'));
    if (!entry) throw new KtError(`template ${templateId} not found`);
    await this.authed('/user/templates/delete?format=json', { method: 'POST', body: entry });
  }

  private async listTemplatesRaw(): Promise<Record<string, unknown>[]> {
    const data = await this.authed('/user/templates/list?format=json');
    return Array.isArray(data) ? data.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
  }

  /**
   * Records body weight for a day. The site keeps one weight per date, so
   * logging again for the same date replaces the value rather than adding a
   * second one. Its form is a free-text field, sent in Czech decimal format.
   */
  async logWeight(args: { kg: number; date?: string }): Promise<void> {
    await this.authed('/user/weight/add?format=json&=', {
      method: 'POST',
      body: {
        weight: formatCzechDecimal(args.kg),
        date: args.date === undefined ? todayCzech() : assertCzechDate(args.date),
      },
    });
  }

  // ---------------------------------------------------------------------
  // Meals (the site's word for a saved recipe)
  // ---------------------------------------------------------------------

  /** The user's saved recipes. */
  async listMeals(): Promise<MealSummary[]> {
    const data = await this.authed('/user/settings/meal/list?format=json&limit=100');
    if (!Array.isArray(data)) throw new KtError('meal list: expected an array');
    return data
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .map(m => ({
        id: String(m['guid']),
        title: String(m['title'] ?? ''),
        energy: parseCzechNumber(m['energy']),
        energyUnit: typeof m['energyUnit'] === 'string' ? m['energyUnit'] : 'kcal',
        portions: parseCzechNumber(m['portions']) ?? 1,
      }));
  }

  /**
   * Builds one ingredient entry for a recipe payload.
   *
   * The site expects each ingredient to carry its own full unit list, so we
   * fetch the food's form and copy it. `count` is a multiple of the chosen
   * unit, not a weight: 2 × "porce (250 ml)" is 500 ml. Defaulting to the
   * food's base unit (multiplier 1) makes `amount` mean grams for solids and
   * millilitres for liquids, which is what a recipe author expects.
   */
  private async buildMealItem(
    index: number,
    ingredient: { foodId: string; amount: number; unitId?: string },
  ): Promise<Record<string, unknown>> {
    const detail = await this.getFoodDetail(ingredient.foodId);
    const unitId = ingredient.unitId ?? baseUnitOf(detail.units);
    if (!detail.units.some(u => u.id === unitId)) {
      throw new KtError(
        `${detail.title}: unit ${unitId} is not valid for this food. Available: ` +
          detail.units.map(u => `${u.title} (${u.id})`).join(', '),
      );
    }
    return {
      selected: true,
      guid: String(index),
      foodstuffGuid: detail.id,
      title: detail.title,
      count: ingredient.amount,
      countOriginal: ingredient.amount,
      // Display-only; the site recomputes the recipe's energy server-side.
      energy: 0,
      energyUnit: 'kcal',
      selectedUnitGuid: unitId,
      selectedUnitGuidOriginal: unitId,
      units: detail.units.map(u => ({ id: u.id, title: u.title, multiplier: u.grams })),
      weight: null,
      time: null,
      favorite: null,
      isLiquid: null,
    };
  }

  /** Creates a saved recipe. Returns the new meal's id. */
  async createMeal(args: {
    title: string;
    ingredients: Array<{ foodId: string; amount: number; unitId?: string }>;
  }): Promise<string> {
    if (args.ingredients.length === 0) throw new KtError('a recipe needs at least one ingredient');

    const foodstuff = [];
    for (const [i, ingredient] of args.ingredients.entries()) {
      foodstuff.push(await this.buildMealItem(i, ingredient));
    }

    const created = await this.authed('/user/meal/create?format=json&=', {
      method: 'POST',
      body: {
        guid: null,
        title: args.title,
        diaryTimeGuid: null,
        diaryTimeOptions: null,
        date: null,
        timeUser: null,
        time: null,
        foodstuff,
      },
    });
    if (typeof created !== 'string') throw new KtError('meal create: no id returned');
    return created;
  }

  /**
   * Logs a whole saved recipe into the diary.
   *
   * Partial portions are deliberately not offered. The meal-add form exposes
   * `count` against portion/percent/gram pseudo-units, but the server ignores
   * it and logs the entire recipe whichever unit is used — measured against a
   * 249 kcal recipe, `count` of 0.5 portions and of half the total weight both
   * added the full 249. Rather than accept a `portions` argument that silently
   * does nothing, log the whole recipe and let the caller log ingredients
   * individually when they ate part of one.
   */
  async logMeal(args: { mealId: string; meal: MealId; date?: string }): Promise<void> {
    const form = (await this.authed(
      `/user/meal/add/form/${encodeURIComponent(args.mealId)}?format=json`,
    )) as Record<string, unknown>;

    // As in logFood: post the form back whole, as the site's frontend does.
    const payload: Record<string, unknown> = { ...form };
    payload['diaryTimeGuid'] = args.meal;
    payload['date'] = args.date === undefined ? todayCzech() : assertCzechDate(args.date);
    payload['selectedUnitGuid'] = PORTION_UNIT;
    payload['count'] = 1;

    await this.authed('/user/meal/add?format=json&=', { method: 'POST', body: payload });
  }

  /** Permanently deletes a saved recipe. */
  async deleteMeal(mealId: string): Promise<void> {
    await this.authed(`/user/settings/meal/delete/${encodeURIComponent(mealId)}?format=json`);
  }
}
