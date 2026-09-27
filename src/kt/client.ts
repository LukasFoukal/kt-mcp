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

  /** The activities logged on one day, with the energy the site computed. */
  async getDayActivities(date?: string): Promise<DiaryActivity[]> {
    const day = date === undefined ? todayCzech() : assertCzechDate(date);
    const diary = (await this.authed(`/user/diary/${day}/get?format=json`)) as Record<string, unknown>;
    const activities = diary['activities'];
    if (!Array.isArray(activities)) throw new KtError('diary: response had no activities list');
    return activities
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
      .map(a => ({
        id: String(a['id']),
        title: String(a['title'] ?? ''),
        duration: String(a['unit'] ?? ''),
        energy: parseCzechNumber(a['energy']),
        energyUnit: typeof a['energyUnit'] === 'string' ? a['energyUnit'] : 'kcal',
      }));
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
